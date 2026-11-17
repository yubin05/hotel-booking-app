import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { authenticate } from '../auth';
import { pool } from '../db';
import { HttpError } from '../errors';
import { utcIso } from '../time';
import { uuidv7 } from '../uuidv7';

// 적립금 (인프라 ADR-058): 거래 내역(point_transactions)에 줄을 쌓기만 하고, 잔액은 그 합계다

// 같은 사용자의 동시 예약이 같은 잔액을 두 번 쓰지 않게 사용자 행을 잠근다. 예약 INSERT보다 먼저 불러야 한다:
// INSERT의 외래 키 검사가 이 행에 공유 잠금을 걸어서, 그 뒤에 잠그면 동시 요청끼리 서로 기다리다 교착된다 (쿠폰 발급과 같은 이유)
export async function lockPointsOwner(conn: PoolConnection, userId: string): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  // 토큰은 유효하지만 사용자가 없다: DB 초기화나 백업 복원 이전에 받은 토큰
  if (!rows[0]) throw new HttpError(401, '로그인 정보가 유효하지 않습니다. 다시 로그인해주세요.');
}

// 잠금 읽기(FOR SHARE)로 합계를 낸다. 기본 격리 수준(REPEATABLE READ)의 일반 SELECT는 트랜잭션 첫 읽기 때의
// 스냅샷을 봐서, 사용자 행 잠금을 기다리는 사이 다른 예약이 쓴 적립금을 못 보고 두 번 쓸 수 있다
// shortcut: 잔액을 매번 내역 합계로 구한다. 한 사람 줄이 많아지면 잔액 표, 전체가 커지면 오래된 줄 아카이브 (ADR-058)
async function balanceOf(conn: PoolConnection, userId: string): Promise<number> {
  const [[row]] = await conn.query<RowDataPacket[]>(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM point_transactions WHERE user_id = ? FOR SHARE',
    [userId],
  );
  return Number(row.balance);
}

// 예약 모듈이 직접 호출한다. 처음 쓰는 예약이면 먼저 lockPointsOwner로 잠가 둬야 한다
export async function usePoints(
  conn: PoolConnection,
  userId: string,
  amount: number,
  bookingId: string,
  sessionId: string | null,
): Promise<void> {
  if ((await balanceOf(conn, userId)) < amount) throw new HttpError(400, '적립금이 부족합니다.');
  await conn.query(
    "INSERT INTO point_transactions (id, user_id, type, amount, booking_id, session_id) VALUES (?, ?, 'use', ?, ?, ?)",
    [uuidv7(), userId, -amount, bookingId, sessionId],
  );
}

const EARN_PERCENT = 5; // 시연용 값 (ADR-058)

// 숙박 완료 때 호스트 모듈이 부른다: 실제 결제액(쿠폰 · 적립금을 뺀 금액)의 5%, 원 미만 버림. 한 번만 부르는 것은 호출 쪽이 상태 전환으로 보장한다
export async function earnPoints(
  conn: PoolConnection,
  userId: string,
  paid: number,
  bookingId: string,
  sessionId: string | null,
): Promise<number> {
  const amount = Math.floor((paid * EARN_PERCENT) / 100);
  if (amount <= 0) return 0;
  await conn.query(
    "INSERT INTO point_transactions (id, user_id, type, amount, booking_id, session_id) VALUES (?, ?, 'earn', ?, ?, ?)",
    [uuidv7(), userId, amount, bookingId, sessionId],
  );
  return amount;
}

// 예약 취소 · 변경: 이 예약에서 아직 되돌리지 않은 사용 줄마다 '환원' 줄을 쓴다. 예약 행을 잠근 채 불러야 한다
export async function refundPoints(conn: PoolConnection, bookingId: string, sessionId: string | null): Promise<void> {
  const [uses] = await conn.query<RowDataPacket[]>(
    `SELECT u.id, u.user_id, u.amount
       FROM point_transactions u LEFT JOIN point_transactions r ON r.reverses_id = u.id
      WHERE u.booking_id = ? AND u.type = 'use' AND r.id IS NULL`,
    [bookingId],
  );
  for (const use of uses) {
    await conn.query(
      `INSERT INTO point_transactions (id, user_id, type, amount, booking_id, session_id, reverses_id)
       VALUES (?, ?, 'refund', ?, ?, ?, ?)`,
      [uuidv7(), use.user_id, -use.amount, bookingId, sessionId, use.id],
    );
  }
}

export const pointRouter = Router();

pointRouter.get('/', authenticate, async (req, res) => {
  const userId = req.user!.userId;
  const [[{ balance }]] = await pool.query<RowDataPacket[]>(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM point_transactions WHERE user_id = ?',
    [userId],
  );
  // shortcut: 최근 50줄만 보여 준다. 더 오래된 내역이 필요해지면 쪽 나누기를 붙인다
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT pt.id, pt.type, pt.amount, pt.booking_id, pt.created_at, h.name AS hotel_name
       FROM point_transactions pt
       LEFT JOIN bookings b ON b.id = pt.booking_id
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN hotels h ON h.id = r.hotel_id
      WHERE pt.user_id = ? ORDER BY pt.id DESC LIMIT 50`,
    [userId],
  );
  res.json({
    success: true,
    data: { balance: Number(balance), transactions: rows.map((t) => ({ ...t, created_at: utcIso(t.created_at) })) },
  });
});
