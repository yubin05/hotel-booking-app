import { Router } from 'express';
import type { Request } from 'express';
import type { RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { authenticate } from '../auth';
import { pool } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
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

// 계정 탈취 탐지 · 세션 보류 (인프라 ADR-072, 시나리오 A). 임계값은 모두 가설: 정상 사례가 걸리면 고친다
const LOOKBACK_DAYS = 30; // 평소 접속 환경으로 보는 기간
const RECENT_LOGIN_MINUTES = 10; // 로그인 직후
const LARGE_SHARE = 0.5; // 사용 전 잔액에서 이번 사용액의 비율
const RELOGIN_HOURS = 24; // 다른 세션이 이 시간 안에 보류됐으면 새 환경의 새 세션도 막는다 (공격자 재로그인)
const USUAL_MIN_HOURS = 24; // 이만큼 지난 세션만 평소 환경: 공격자가 두 번 로그인해 두 세션이 서로를 평소로 만드는 우회를 막는다

interface SessionRow extends RowDataPacket {
  id: string;
  ip: string | null;
  ua: string | null;
  held: number;
  held_recently: number | null;
  age_s: number;
}

// 같은 회원의 최근 세션. 잠금 읽기: 사용자 행 잠금을 기다리는 사이 커밋된 보류를 봐야 한다 (balanceOf와 같은 이유)
async function recentSessions(conn: PoolConnection, userId: string): Promise<SessionRow[]> {
  const [rows] = await conn.query<SessionRow[]>(
    `SELECT id, ip, ua, held_at IS NOT NULL AS held, held_at > UTC_TIMESTAMP() - INTERVAL ? HOUR AS held_recently,
            TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP()) AS age_s
       FROM sessions WHERE user_id = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ? DAY FOR SHARE`,
    [RELOGIN_HOURS, userId, LOOKBACK_DAYS],
  );
  return rows;
}

// 새 환경: 이 세션의 IP와 브라우저가 둘 다 평소 환경에 없다. 평소 환경 = 같은 회원의 24시간 넘은 다른 세션 중 보류되지 않았고
// 보류된 세션과 IP · 브라우저가 겹치지 않는 것(공격자가 다시 로그인한 세션을 평소로 치지 않게).
// 비교할 세션이 없으면(첫 로그인 · 배포 직후) 새 환경으로 보지 않는다: 기준 없이 "새롭다"고 하면 모든 회원의 첫 세션이 걸린다
function isNewEnvironment(me: SessionRow, sessions: SessionRow[]): boolean {
  const held = sessions.filter((s) => s.held);
  const usual = sessions.filter(
    (s) => s.id !== me.id && s.age_s >= USUAL_MIN_HOURS * 3600 && !s.held && !held.some((h) => h.ip === s.ip || h.ua === s.ua),
  );
  return usual.length > 0 && usual.every((s) => s.ip !== me.ip && s.ua !== me.ua);
}

// 보류 검사: 이 세션이 보류됐거나, 다른 세션이 24시간 안에 보류됐는데 이 세션도 새 환경이면 쓸 수 없다.
// 세션 행이 없으면(배포 전에 받은 토큰, 최대 1시간) 검사하지 않는다
async function assertNotHeld(conn: PoolConnection, req: Request, amount: number, bookingId: string): Promise<void> {
  const sessions = await recentSessions(conn, req.user!.userId);
  const me = sessions.find((s) => s.id === req.user!.sessionId);
  if (!me) return;
  const reason = me.held ? 'held' : sessions.some((s) => s.held_recently) && isNewEnvironment(me, sessions) ? 'relogin' : null;
  if (!reason) return;
  securityLog('points_hold_blocked', req, { reason, points: amount, booking_id: bookingId });
  // 예외가 트랜잭션을 되돌려 이 요청의 예약 · 날짜 잠금 · 쿠폰 사용도 함께 취소된다
  throw new HttpError(403, '보안을 위해 이 로그인에서는 적립금 사용이 보류되었습니다. 고객센터에 문의해주세요.');
}

// 예약 모듈이 직접 호출한다. 적립금을 깎는 길은 이 함수 하나라 보류 검사도 여기서 한다.
// 먼저 lockPointsOwner로 잠가 둬야 한다. 사용 전 잔액을 돌려준다 (탐지가 씀)
export async function usePoints(conn: PoolConnection, req: Request, amount: number, bookingId: string): Promise<number> {
  const userId = req.user!.userId;
  await assertNotHeld(conn, req, amount, bookingId);
  const balance = await balanceOf(conn, userId);
  if (balance < amount) throw new HttpError(400, '적립금이 부족합니다.');
  await conn.query(
    "INSERT INTO point_transactions (id, user_id, type, amount, booking_id, session_id) VALUES (?, ?, 'use', ?, ?, ?)",
    [uuidv7(), userId, -amount, bookingId, req.user!.sessionId],
  );
  return balance;
}

// 탐지: 새 환경 · 로그인 10분 안 · 사용 전 잔액의 50% 이상이 모두 맞으면 이 세션을 보류한다. 새 예약에서 usePoints 바로 뒤에 부른다.
// 이번 사용(첫 거래)은 통과시키고, 같은 트랜잭션에서 보류를 기록해 커밋과 동시에 다음 사용부터 막는다. 보류했으면 경보 로그 필드를 돌려준다
export async function holdIfSuspicious(conn: PoolConnection, req: Request, amount: number, balanceBefore: number) {
  const sessions = await recentSessions(conn, req.user!.userId);
  const me = sessions.find((s) => s.id === req.user!.sessionId);
  if (!me || me.age_s > RECENT_LOGIN_MINUTES * 60 || amount < balanceBefore * LARGE_SHARE || !isNewEnvironment(me, sessions)) {
    return null;
  }
  const minutes = Math.floor(me.age_s / 60);
  const share = Math.round((amount / balanceBefore) * 100);
  await conn.query('UPDATE sessions SET held_at = UTC_TIMESTAMP(), hold_reason = ? WHERE id = ?', [
    `새 IP · 새 브라우저 · 로그인 ${minutes}분 뒤 · 잔액의 ${share}%`,
    me.id,
  ]);
  return { balance_before: balanceBefore, minutes_since_login: minutes, new_ip: true, new_ua: true };
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

// 아직 되돌리지 않은 사용 줄마다 되돌림 줄(환원 · 복구)을 쓴다. reverses_id가 유니크라 같은 사용을 두 번 되돌릴 수 없다
async function reverseUses(
  conn: PoolConnection,
  by: 'booking_id' | 'session_id',
  value: string,
  type: 'refund' | 'restore',
  sessionId: string | null,
): Promise<{ booking_id: string; amount: number }[]> {
  const [uses] = await conn.query<RowDataPacket[]>(
    `SELECT u.id, u.user_id, u.amount, u.booking_id
       FROM point_transactions u LEFT JOIN point_transactions r ON r.reverses_id = u.id
      WHERE u.${by} = ? AND u.type = 'use' AND r.id IS NULL`,
    [value],
  );
  for (const use of uses) {
    await conn.query(
      `INSERT INTO point_transactions (id, user_id, type, amount, booking_id, session_id, reverses_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(), use.user_id, type, -use.amount, use.booking_id, sessionId, use.id],
    );
  }
  return uses.map((u) => ({ booking_id: u.booking_id, amount: -u.amount }));
}

// 예약 취소 · 변경: 이 예약에 쓴 적립금을 '환원'. 예약 행을 잠근 채 불러야 한다
export async function refundPoints(conn: PoolConnection, bookingId: string, sessionId: string | null): Promise<void> {
  await reverseUses(conn, 'booking_id', bookingId, 'refund', sessionId);
}

// 관리자 사건 복구: 공격자 세션이 쓴 적립금을 '복구'. 관련 예약 행을 잠근 채 불러야 한다 (손님의 취소와 겹치지 않게)
// shortcut: session_id에 색인이 없어 내역 전체를 훑는다. 사건 때만 쓰는 기능이라 두고, 느려지면 (session_id) 색인
export function restoreSessionPoints(conn: PoolConnection, attackerSessionId: string, adminSessionId: string | null) {
  return reverseUses(conn, 'session_id', attackerSessionId, 'restore', adminSessionId);
}

// 잔액과 최근 내역. 손님 화면과 관리자 화면이 같이 쓴다
// shortcut: 최근 limit줄만 보여 준다. 더 오래된 내역이 필요해지면 쪽 나누기를 붙인다
export async function pointHistory(userId: string, limit: number) {
  const [[{ balance }]] = await pool.query<RowDataPacket[]>(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM point_transactions WHERE user_id = ?',
    [userId],
  );
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT pt.id, pt.type, pt.amount, pt.booking_id, pt.session_id, pt.created_at,
            EXISTS (SELECT 1 FROM point_transactions r WHERE r.reverses_id = pt.id) AS reversed,
            b.status AS booking_status, h.name AS hotel_name
       FROM point_transactions pt
       LEFT JOIN bookings b ON b.id = pt.booking_id
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN hotels h ON h.id = r.hotel_id
      WHERE pt.user_id = ? ORDER BY pt.id DESC LIMIT ?`,
    [userId, limit],
  );
  return {
    balance: Number(balance),
    transactions: rows.map((t) => ({ ...t, reversed: Boolean(t.reversed), created_at: utcIso(t.created_at) })),
  };
}

export const pointRouter = Router();

pointRouter.get('/', authenticate, async (req, res) => {
  res.json({ success: true, data: await pointHistory(req.user!.userId, 50) });
});
