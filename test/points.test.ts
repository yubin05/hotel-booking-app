import { book, call, ctx, newUser, pool, randomDays, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';

useServer();

// 테스트 객실의 1박 요금 (서버가 뜬 뒤에 읽는다)
async function nightlyPrice(): Promise<number> {
  return (await call('GET', `/hotels/${ctx.hotelId}`)).body.data.rooms[0].discounted_price;
}

const claims = (token: string) => jwt.decode(token) as jwt.JwtPayload;

// 적립(숙박 완료)은 묶음 2라 아직 API가 없어 DB에 직접 넣는다
async function grant(token: string, amount: number): Promise<void> {
  await pool.query("INSERT INTO point_transactions (id, user_id, type, amount) VALUES (?, ?, 'earn', ?)", [
    randomUUID(),
    claims(token).sub,
    amount,
  ]);
}

async function points(token: string): Promise<{ balance: number; transactions: { type: string; amount: number }[] }> {
  return (await call('GET', '/points', { token })).body.data;
}

test('적립금으로 예약하면 잔액이 줄고 세션 번호가 남으며, 취소하면 환원 한 줄로 돌아온다', async () => {
  const nightly = await nightlyPrice();
  const token = await newUser();
  await grant(token, 3000);
  const day = randomDays();

  const created = await book(token, day(0), day(1), { points: 1000 });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.points_used, 1000);
  assert.equal(created.body.data.total_price, nightly - 1000);
  assert.equal((await points(token)).balance, 2000);
  const [[use]] = await pool.query<RowDataPacket[]>(
    "SELECT session_id FROM point_transactions WHERE booking_id = ? AND type = 'use'",
    [created.body.data.id],
  );
  assert.equal(use.session_id, claims(token).jti);

  assert.equal((await call('DELETE', `/bookings/${created.body.data.id}`, { token })).status, 200);
  const after = await points(token);
  assert.equal(after.balance, 3000);
  assert.deepEqual(after.transactions.map((t) => `${t.type} ${t.amount}`).sort(), ['earn 3000', 'refund 1000', 'use -1000']);
});

test('잔액보다 많이, 결제액보다 많이, 음수 · 소수로는 쓸 수 없다', async () => {
  const nightly = await nightlyPrice();
  const token = await newUser();
  await grant(token, nightly + 5000);
  const day = randomDays();
  await grant(await newUser(), 1); // 다른 사람 적립금은 잔액에 섞이지 않는다

  assert.equal((await book(token, day(0), day(1), { points: nightly + 1 })).status, 400, '결제액 초과');
  assert.equal((await book(token, day(0), day(1), { points: -1 })).status, 400, '음수');
  assert.equal((await book(token, day(0), day(1), { points: 1.5 })).status, 400, '소수');
  const poor = await newUser();
  await grant(poor, 100);
  assert.equal((await book(poor, day(0), day(1), { points: 101 })).status, 400, '잔액 초과');
  assert.equal((await points(token)).balance, nightly + 5000);
});

test('같은 사용자가 같은 잔액으로 동시에 5건 예약하면 1건만 되고 잔액은 음수가 되지 않는다', async () => {
  const nightly = await nightlyPrice();
  const token = await newUser();
  const amount = Math.floor(nightly);
  await grant(token, amount);
  const day = randomDays();
  // 날짜를 서로 다르게 해 객실 겹침(409)이 아니라 잔액으로만 갈리게 한다
  const statuses = (await Promise.all([0, 2, 4, 6, 8].map((d) => book(token, day(d), day(d + 1), { points: amount })))).map(
    (r) => r.status,
  );
  assert.equal(statuses.filter((s) => s === 201).length, 1, `응답: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 400).length, 4, `응답: ${statuses}`);
  assert.equal((await points(token)).balance, 0);
});

test('숙박을 줄여 쓴 적립금이 결제액보다 많아지면 같은 요청 안에서 넘친 만큼 돌려받는다', async () => {
  const nightly = await nightlyPrice();
  const token = await newUser();
  const twoNights = Math.floor(nightly * 2);
  await grant(token, twoNights);
  const day = randomDays();
  const created = await book(token, day(0), day(2), { points: twoNights });
  assert.equal(created.status, 201);

  const changed = await call('PATCH', `/bookings/${created.body.data.id}`, {
    token,
    body: { check_in_date: day(0), check_out_date: day(1) },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.points_used, Math.floor(nightly));
  assert.equal((await points(token)).balance, twoNights - Math.floor(nightly));

  // 다시 늘리면 쓴 적립금은 그대로, 늘어난 만큼 결제액이 는다
  const longer = await call('PATCH', `/bookings/${created.body.data.id}`, {
    token,
    body: { check_in_date: day(0), check_out_date: day(3) },
  });
  assert.equal(longer.body.data.points_used, Math.floor(nightly));

  assert.equal((await call('DELETE', `/bookings/${created.body.data.id}`, { token })).status, 200);
  const after = await points(token);
  assert.equal(after.balance, twoNights);
  // 같은 요청이 쓴 환원 · 사용 줄은 id(UUIDv7)의 밀리초가 같아 순서가 바뀔 수 있어 구성만 본다
  assert.deepEqual(after.transactions.map((t) => t.type).sort(), ['earn', 'refund', 'refund', 'use', 'use']);
});

test('한 사용 줄은 두 번 되돌릴 수 없다 (환원 뒤 복구 시도)', async () => {
  const token = await newUser();
  await grant(token, 1000);
  const day = randomDays();
  const created = await book(token, day(0), day(1), { points: 1000 });
  await call('DELETE', `/bookings/${created.body.data.id}`, { token });
  const [[use]] = await pool.query<RowDataPacket[]>(
    "SELECT id, user_id FROM point_transactions WHERE booking_id = ? AND type = 'use'",
    [created.body.data.id],
  );
  await assert.rejects(
    pool.query("INSERT INTO point_transactions (id, user_id, type, amount, reverses_id) VALUES (?, ?, 'restore', 1000, ?)", [
      randomUUID(),
      use.user_id,
      use.id,
    ]),
    { code: 'ER_DUP_ENTRY' },
  );
});
