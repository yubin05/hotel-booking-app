import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { authenticate } from '../auth';
import { couponPool, type DbTiming, inTransaction, isDuplicateKey, isMissingReference, limited, pool } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
import { utcIso } from '../time';
import { uuidv7 } from '../uuidv7';

// 예약 모듈이 직접 호출한다: 본인 쿠폰이고 사용 기한이 남았으면 할인액을 돌려준다.
// 이미 썼는지는 markCouponUsed가 원자적으로 확인한다 (멱등키로 같은 예약을 다시 보낸 경우를 통과시키려고)
export async function findCouponAmount(conn: PoolConnection, userCouponId: string, userId: string): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT c.discount_amount
       FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.id = ? AND uc.user_id = ? AND c.expires_at > UTC_TIMESTAMP()`,
    [userCouponId, userId],
  );
  if (!rows[0]) throw new HttpError(400, '사용할 수 없는 쿠폰입니다.');
  return Number(rows[0].discount_amount);
}

// 아직 쓰지 않은 쿠폰만 사용 처리한다. 조건부 UPDATE라 같은 쿠폰을 동시에 두 예약에 쓸 수 없다
export async function markCouponUsed(conn: PoolConnection, userCouponId: string, bookingId: string): Promise<void> {
  const [result] = await conn.query<ResultSetHeader>(
    'UPDATE user_coupons SET used_booking_id = ? WHERE id = ? AND used_booking_id IS NULL',
    [bookingId, userCouponId],
  );
  if (result.affectedRows === 0) throw new HttpError(409, '이미 사용한 쿠폰입니다.');
}

// 예약을 취소하면 쿠폰을 돌려준다 (사용 기한은 그대로)
export async function releaseCoupon(conn: PoolConnection, bookingId: string): Promise<void> {
  await conn.query('UPDATE user_coupons SET used_booking_id = NULL WHERE used_booking_id = ?', [bookingId]);
}

export const couponRouter = Router();

// 발급 중이거나 발급 예정인 쿠폰
couponRouter.get('/', async (_req, res) => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, name, discount_amount, quantity, issued_count, starts_at, ends_at, expires_at,
            starts_at > UTC_TIMESTAMP() AS upcoming
       FROM coupons WHERE ends_at > UTC_TIMESTAMP() ORDER BY starts_at`,
  );
  const data = rows.map((c) => ({
    id: c.id,
    name: c.name,
    discount_amount: Number(c.discount_amount),
    quantity: c.quantity,
    remaining: c.quantity - c.issued_count,
    status: c.upcoming ? 'upcoming' : c.issued_count >= c.quantity ? 'sold_out' : 'open',
    starts_at: utcIso(c.starts_at),
    ends_at: utcIso(c.ends_at),
    expires_at: utcIso(c.expires_at),
  }));
  res.json({ success: true, data });
});

couponRouter.get('/mine', authenticate, async (req, res) => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT uc.id, uc.coupon_id, c.name, c.discount_amount, c.expires_at, uc.used_booking_id,
            c.expires_at <= UTC_TIMESTAMP() AS expired
       FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_id = ? ORDER BY uc.id DESC`,
    [req.user!.userId],
  );
  const data = rows.map((c) => ({
    id: c.id,
    coupon_id: c.coupon_id,
    name: c.name,
    discount_amount: Number(c.discount_amount),
    expires_at: utcIso(c.expires_at),
    status: c.used_booking_id ? 'used' : c.expired ? 'expired' : 'available',
  }));
  res.json({ success: true, data });
});

// 이 서버가 소진을 한 번 들은 쿠폰. 3,000명 쏠림 진단(v2 migration.md)에서 소진 확인을 통과해 쿠폰 연결 앞에 줄 선 요청이
// 소진 뒤에도 쿠폰 한 행을 하나씩 거치느라 3초 상한(503)에 걸렸다. 소진을 들은 뒤로는 그 쿠폰 요청을 DB에 보내지 않는다
// shortcut: 서버 메모리라 수량을 늘려도 재시작 전까지 소진으로 답함, 수량 변경 기능이 생기면 만료 시간을 둘 것
const soldOut = new Set<string>();
const SOLD_OUT = '쿠폰이 모두 소진되었습니다.';

// 선착순 발급: (쿠폰, 사용자) 유니크로 1인 1매, issued_count < quantity 조건부 UPDATE로 초과 발급 0건
couponRouter.post('/:id/claim', authenticate, async (req, res) => {
  const couponId = String(req.params.id);
  // 쏠림 병목 진단: 소진 확인(공용 연결)과 발급(쿠폰 연결) 각각 연결 대기 · 작업 시간을 한 줄로 남긴다
  // shortcut: 쿠폰 회차마다 누른 사람 수만큼 로그가 남음, 진단이 끝나면 지울지 결정
  const pre: DbTiming = { waitMs: 0, workMs: 0 };
  const tx: DbTiming = { waitMs: 0, workMs: 0 };
  let outcome = 'error';
  try {
    await claim();
    outcome = 'issued';
  } finally {
    const ms = (n: number) => Math.round(n * 10) / 10;
    console.log(
      JSON.stringify({
        log: 'perf',
        event: 'coupon_claim_timing',
        coupon_id: couponId,
        outcome,
        pre_wait_ms: ms(pre.waitMs),
        pre_ms: ms(pre.workMs),
        tx_wait_ms: ms(tx.waitMs),
        tx_ms: ms(tx.workMs),
      }),
    );
  }

  function soldOutError(why: string): HttpError {
    outcome = why;
    return new HttpError(409, SOLD_OUT);
  }

  async function claim(): Promise<void> {
    if (soldOut.has(couponId)) throw soldOutError('sold_out_memory');
    // 시작 전·종료·소진은 잠금 없이 먼저 거른다 (오픈 직전에 몰리는 요청을 가볍게 돌려보낸다)
    const [rows] = await limited(
      pool,
      (c) =>
        c.query<RowDataPacket[]>(
          `SELECT starts_at <= UTC_TIMESTAMP() AS started, ends_at > UTC_TIMESTAMP() AS open,
                  issued_count < quantity AS remaining
             FROM coupons WHERE id = ?`,
          [couponId],
        ),
      pre,
    );
    const coupon = rows[0];
    if (!coupon) throw new HttpError(404, '쿠폰을 찾을 수 없습니다.');
    if (!coupon.started) throw new HttpError(400, '아직 발급이 시작되지 않았습니다.');
    if (!coupon.open) throw new HttpError(400, '발급이 끝난 쿠폰입니다.');
    if (!coupon.remaining) {
      soldOut.add(couponId);
      throw soldOutError('sold_out_precheck');
    }

    const id = uuidv7();
    await limited(couponPool, (c) => {
      // 줄 서 있던 사이에 소진됐으면 BEGIN도 보내지 않고 연결을 다음 요청에 넘긴다
      if (soldOut.has(couponId)) throw soldOutError('sold_out_memory');
      return inTransaction(c, async (conn) => {
        // 쿠폰 행을 먼저 잠근다. 받은 기록 INSERT의 외래 키 검사가 쿠폰 행에 공유 잠금을 걸기 때문에, INSERT를 먼저 하면
        // 동시 요청끼리 공유 잠금을 쥔 채 서로의 배타 잠금을 기다리다 교착(deadlock)이 나 쿠폰이 남아도 거절됐다
        const [result] = await conn.query<ResultSetHeader>(
          `UPDATE coupons SET issued_count = issued_count + 1
            WHERE id = ? AND issued_count < quantity
              AND starts_at <= UTC_TIMESTAMP() AND ends_at > UTC_TIMESTAMP()`,
          [couponId],
        );
        if (result.affectedRows === 0) {
          soldOut.add(couponId); // 연결을 돌려주기 전에 표시해야 바로 뒤에 줄 선 요청이 본다
          throw soldOutError('sold_out_tx');
        }
        try {
          await conn.query('INSERT INTO user_coupons (id, coupon_id, user_id) VALUES (?, ?, ?)', [
            id,
            couponId,
            req.user!.userId,
          ]);
        } catch (err) {
          // 트랜잭션이 되돌아가므로 위에서 올린 발급 수도 원래대로 돌아간다
          if (isDuplicateKey(err)) {
            outcome = 'duplicate';
            throw new HttpError(409, '이미 받은 쿠폰입니다.');
          }
          if (isMissingReference(err)) throw new HttpError(401, '로그인 정보가 유효하지 않습니다. 다시 로그인해주세요.');
          throw err;
        }
      });
    }, tx);
    securityLog('coupon_claimed', req, { coupon_id: couponId }); // 쿠폰 봇(시나리오 3): 가입 직후 · 같은 IP에서 몰리는지 본다
    res.status(201).json({ success: true, message: '쿠폰을 받았습니다.', data: { id } });
  }
});
