import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { authenticate } from '../auth';
import { cancelBooking } from '../booking';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
import { uuidv7 } from '../uuidv7';

// 데모 결제 (docs/decisions.md APP-001): 예약하면 객실을 잡아 두고 결제 대기, 10분 안에 토스 결제를 승인받으면 확정.
// 안 하면 정리 작업이 예약을 취소해 객실을 푼다. 봇이 예약만 잔뜩 해 객실을 묶어 두는 문제를 줄인다

const HOLD_MINUTES = 10;

export const paymentsEnabled = () => config.toss.secretKey !== '';

// 예약 모듈이 예약을 만든 트랜잭션 안에서 부른다
export async function createPendingPayment(conn: PoolConnection, bookingId: string, total: number) {
  // shortcut: 원 미만은 반올림해 청구한다. 객실 요금은 원 단위라 지금은 차이가 없다
  const payment = {
    order_id: uuidv7(), // 토스 규칙: 6~64자, 영문 · 숫자 · -_=
    amount: Math.round(total),
    expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000),
  };
  await conn.query('INSERT INTO payments (booking_id, order_id, amount, expires_at) VALUES (?, ?, ?, ?)', [
    bookingId,
    payment.order_id,
    payment.amount,
    payment.expires_at,
  ]);
  return { ...payment, expires_at: payment.expires_at.toISOString() };
}

// 토스 결제 승인 API. 카드 번호는 토스 결제창에만 입력되고, 서버는 결제 키로 승인만 요청한다
async function tossConfirm(paymentKey: string, orderId: string, amount: number): Promise<void> {
  const res = await fetch(`${config.toss.apiBase}/v1/payments/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.toss.secretKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paymentKey, orderId, amount }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
  if (!res.ok || body.status !== 'DONE') throw new HttpError(400, body.message ?? '결제 승인에 실패했습니다.');
}

// 10분이 지난 결제 대기 예약을 취소한다. 서버마다 1분 간격으로 돈다(여러 대가 동시에 돌아도 조건부 UPDATE라 한 번만 처리)
export async function expirePendingPayments(): Promise<number> {
  const [due] = await pool.query<RowDataPacket[]>(
    "SELECT booking_id FROM payments WHERE status = 'pending' AND expires_at < UTC_TIMESTAMP() LIMIT 100",
  );
  let expired = 0;
  for (const { booking_id } of due) {
    const done = await withTransaction(async (conn) => {
      // 예약 → 결제 순서로 잠근다 (손님의 취소 · 결제 승인과 같은 순서라 서로 교착하지 않음)
      await conn.query('SELECT id FROM bookings WHERE id = ? FOR UPDATE', [booking_id]);
      const [result] = await conn.query<ResultSetHeader>(
        "UPDATE payments SET status = 'expired' WHERE booking_id = ? AND status = 'pending' AND expires_at < UTC_TIMESTAMP()",
        [booking_id],
      );
      if (result.affectedRows === 0) return false; // 그 사이에 결제했거나 취소함
      await cancelBooking(conn, booking_id, null);
      return true;
    });
    if (done) expired++;
  }
  return expired;
}

export const paymentRouter = Router();

// 화면이 결제창을 띄울 때 쓰는 공개 키. 클라이언트 키는 공개해도 되는 값이다 (시크릿 키는 서버에만)
paymentRouter.get('/config', (_req, res) => {
  res.json({ success: true, data: { enabled: paymentsEnabled(), client_key: config.toss.clientKey || null } });
});

// 토스 결제창이 successUrl로 돌려준 값으로 승인한다
paymentRouter.post('/confirm', authenticate, async (req, res) => {
  const { paymentKey, orderId, amount } = req.body ?? {};
  if (typeof paymentKey !== 'string' || paymentKey.length > 200 || typeof orderId !== 'string' || !Number.isSafeInteger(amount)) {
    throw new HttpError(400, '결제 정보가 올바르지 않습니다.');
  }
  if (!paymentsEnabled()) throw new HttpError(503, '결제가 설정되지 않았습니다.');

  const data = await withTransaction(async (conn) => {
    const [[found]] = await conn.query<RowDataPacket[]>(
      'SELECT p.booking_id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.order_id = ? AND b.user_id = ?',
      [orderId, req.user!.userId],
    );
    if (!found) throw new HttpError(404, '주문을 찾을 수 없습니다.');
    await conn.query('SELECT id FROM bookings WHERE id = ? FOR UPDATE', [found.booking_id]);
    const [[payment]] = await conn.query<RowDataPacket[]>(
      'SELECT status, amount, payment_key, expires_at < UTC_TIMESTAMP() AS expired FROM payments WHERE booking_id = ? FOR UPDATE',
      [found.booking_id],
    );
    // 결제 완료 화면을 새로 고쳐 같은 승인을 다시 보내도 한 번만 처리
    if (payment.status === 'paid' && payment.payment_key === paymentKey) return { booking_id: found.booking_id, newly: false };
    if (payment.status !== 'pending') throw new HttpError(409, '결제할 수 없는 예약입니다(시간이 지나 취소됐거나 이미 결제함).');
    if (payment.expired) throw new HttpError(409, `결제 시간(${HOLD_MINUTES}분)이 지났습니다. 다시 예약해 주세요.`);
    if (amount !== payment.amount) throw new HttpError(400, '결제 금액이 예약 금액과 다릅니다.');
    // shortcut: 승인 API를 부르는 동안(최대 10초) 예약 · 결제 행을 잠가 둔다. 그 사이 만료 정리가 같은 예약을 취소하지 못하게.
    // 손님이 몰리면 연결을 오래 쥐므로, 그때는 "승인 중" 상태를 먼저 커밋하고 승인 뒤 갱신하는 두 단계로 바꾼다
    await tossConfirm(paymentKey, orderId, amount);
    await conn.query("UPDATE payments SET status = 'paid', payment_key = ?, paid_at = UTC_TIMESTAMP() WHERE booking_id = ?", [
      paymentKey,
      found.booking_id,
    ]);
    return { booking_id: found.booking_id, newly: true };
  });

  if (data.newly) securityLog('payment_confirmed', req, { booking_id: data.booking_id, amount });
  res.json({ success: true, message: '결제가 완료되었습니다.', data: { booking_id: data.booking_id, status: 'paid' } });
});
