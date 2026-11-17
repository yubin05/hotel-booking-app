import { book, call, ctx, newUser, pool, randomDays, staffToken, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { config } from '../src/config';
import { expirePendingPayments } from '../src/payments';
import { kstToday } from '../src/time';

useServer();

const SECRET = 'test_sk_fake';
const userId = (token: string) => String((jwt.decode(token) as jwt.JwtPayload).sub);

// 토스 승인 API 대역: 시크릿 키로 인증했는지 보고, paymentKey가 'declined'면 카드사 거절처럼 답한다
const confirms: { paymentKey: string; orderId: string; amount: number }[] = [];
const toss = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const data = JSON.parse(raw || '{}');
    confirms.push(data);
    const authorized = req.headers.authorization === `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`;
    const ok = authorized && req.url === '/v1/payments/confirm' && data.paymentKey !== 'declined';
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'DONE', ...data } : { code: 'REJECT_CARD_PAYMENT', message: '카드사에서 거절했습니다.' }));
  });
});

// 이 파일만 결제를 켠다 (테스트 파일마다 프로세스가 따로라 다른 테스트는 결제 없이 돈다)
before(async () => {
  await new Promise<void>((resolve) => toss.listen(0, '127.0.0.1', resolve));
  config.toss.secretKey = SECRET;
  config.toss.apiBase = `http://127.0.0.1:${(toss.address() as AddressInfo).port}`;
});
after(() => toss.close());

const confirm = (token: string, body: Record<string, unknown>) => call('POST', '/payments/confirm', { token, body });
const bookingOf = async (token: string, id: string) => (await call('GET', `/bookings/${id}`, { token })).body.data;

test('결제가 켜져 있으면 예약은 결제 대기로 만들어지고, 승인하면 결제 완료, 같은 승인을 다시 보내도 토스는 한 번만 부른다', async () => {
  const token = await newUser();
  const day = randomDays();
  const created = await book(token, day(0), day(1));
  assert.equal(created.status, 201);
  const payment = created.body.data.payment;
  assert.equal(payment.amount, Math.round(created.body.data.total_price));
  assert.equal((await bookingOf(token, created.body.data.id)).payment_status, 'pending');

  const body = { paymentKey: `pk-${randomUUID()}`, orderId: payment.order_id, amount: payment.amount };
  assert.equal((await confirm(token, body)).status, 200);
  assert.equal((await confirm(token, body)).status, 200, '결제 완료 화면 새로 고침');
  assert.equal(confirms.filter((c) => c.orderId === payment.order_id).length, 1);
  assert.equal((await bookingOf(token, created.body.data.id)).payment_status, 'paid');
});

test('금액이 다르거나 남의 주문이거나 토스가 거절하면 승인되지 않고 결제 대기로 남는다', async () => {
  const token = await newUser();
  const day = randomDays();
  const created = await book(token, day(0), day(1));
  const { order_id: orderId, amount } = created.body.data.payment;

  assert.equal((await confirm(token, { paymentKey: 'pk', orderId, amount: amount + 1 })).status, 400, '금액 바꿔치기');
  assert.equal((await confirm(await newUser(), { paymentKey: 'pk', orderId, amount })).status, 404, '남의 주문');
  assert.equal((await confirm(token, { paymentKey: 'declined', orderId, amount })).status, 400, '카드사 거절');
  assert.equal((await bookingOf(token, created.body.data.id)).payment_status, 'pending');
});

test('10분이 지난 결제 대기 예약은 정리 작업이 취소해 날짜를 풀고 적립금을 돌려주며, 그 뒤에는 승인할 수 없다', async () => {
  const token = await newUser();
  await pool.query("INSERT INTO point_transactions (id, user_id, type, amount) VALUES (?, ?, 'earn', 1000)", [
    randomUUID(),
    userId(token),
  ]);
  const day = randomDays();
  const created = await book(token, day(0), day(1), { points: 1000 });
  await pool.query('UPDATE payments SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE booking_id = ?', [
    created.body.data.id,
  ]);

  assert.ok((await expirePendingPayments()) >= 1);
  const expired = await bookingOf(token, created.body.data.id);
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.payment_status, 'expired');
  assert.equal((await book(token, day(0), day(1))).status, 201, '풀린 날짜를 다시 예약');
  assert.equal((await call('GET', '/points', { token })).body.data.balance, 1000);

  const { order_id: orderId, amount } = created.body.data.payment;
  assert.equal((await confirm(token, { paymentKey: 'pk', orderId, amount })).status, 409);
});

test('적립금으로 낼 돈이 0원이면 결제 없이 바로 확정된다', async (t) => {
  const nightly = (await call('GET', `/hotels/${ctx.hotelId}`)).body.data.rooms[0].discounted_price;
  if (!Number.isInteger(nightly)) return t.skip('1박 요금에 원 미만이 있어 0원을 만들 수 없음');
  const token = await newUser();
  await pool.query("INSERT INTO point_transactions (id, user_id, type, amount) VALUES (?, ?, 'earn', ?)", [
    randomUUID(),
    userId(token),
    nightly,
  ]);
  const day = randomDays();
  const created = await book(token, day(0), day(1), { points: nightly });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.payment, null);
  assert.equal((await bookingOf(token, created.body.data.id)).payment_status, null);
});

test('결제 대기 · 완료 예약은 금액이 바뀌는 변경은 거절하고, 같은 박수로 날짜를 옮기는 변경은 받는다', async () => {
  const token = await newUser();
  const day = randomDays();
  const id = (await book(token, day(0), day(1))).body.data.id;
  const longer = await call('PATCH', `/bookings/${id}`, { token, body: { check_in_date: day(0), check_out_date: day(2) } });
  assert.equal(longer.status, 409);
  const moved = await call('PATCH', `/bookings/${id}`, { token, body: { check_in_date: day(3), check_out_date: day(4) } });
  assert.equal(moved.status, 200);
});

test('결제 대기 중인 예약은 호스트가 숙박 완료로 바꿀 수 없다 (돈 안 낸 예약에 적립 방지)', async () => {
  const guest = await newUser();
  const id = randomUUID();
  const tomorrow = new Date(Date.parse(`${kstToday()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO bookings (id, user_id, room_id, check_in_date, check_out_date, guests, total_price, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 1, 10000, ?)`,
    [id, userId(guest), ctx.roomId, kstToday(), tomorrow, id],
  );
  await pool.query(
    'INSERT INTO payments (booking_id, order_id, amount, expires_at) VALUES (?, ?, 10000, UTC_TIMESTAMP() + INTERVAL 10 MINUTE)',
    [id, randomUUID()],
  );
  const [[hotel]] = await pool.query<RowDataPacket[]>('SELECT host_id FROM hotels WHERE id = ?', [ctx.hotelId]);
  const res = await call('POST', `/host/bookings/${id}/complete`, { token: staffToken(hotel.host_id, 'host') });
  assert.equal(res.status, 409);
});
