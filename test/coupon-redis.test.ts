import './use-redis'; // 앱보다 먼저: REDIS_URL을 넣어 번호표 경로로 돈다
import { call, newUser, pool, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RowDataPacket } from 'mysql2';

useServer();

async function createCoupon(quantity: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO coupons (id, name, discount_amount, quantity, starts_at, ends_at, expires_at)
     VALUES (?, '번호표 시험 쿠폰', 5000, ?, UTC_TIMESTAMP() - INTERVAL 1 MINUTE,
             UTC_TIMESTAMP() + INTERVAL 1 DAY, UTC_TIMESTAMP() + INTERVAL 2 DAY)`,
    [id, quantity],
  );
  return id;
}

const claim = (token: string, couponId: string) => call('POST', `/coupons/${couponId}/claim`, { token });

async function issued(couponId: string): Promise<{ issued_count: number; owners: number }> {
  const [[row]] = await pool.query<RowDataPacket[]>(
    'SELECT issued_count, (SELECT COUNT(*) FROM user_coupons WHERE coupon_id = ?) AS owners FROM coupons WHERE id = ?',
    [couponId, couponId],
  );
  return { issued_count: Number(row.issued_count), owners: Number(row.owners) };
}

// 인프라 ADR-080: 수량은 Valkey 번호표가 지키고, 떨어진 사람은 쿠폰 행에 가지 않는다
test('번호표: 30명이 동시에 10장을 받으면 정확히 10장, 떨어진 사람은 번호표에서 바로 소진', async (t) => {
  const couponId = await createCoupon(10);
  const tokens = await Promise.all(Array.from({ length: 30 }, () => newUser()));
  const log = t.mock.method(console, 'log');
  const statuses = (await Promise.all(tokens.map((token) => claim(token, couponId)))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 10, `응답: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, 20, `응답: ${statuses}`);
  assert.deepEqual(await issued(couponId), { issued_count: 10, owners: 10 });

  const outcomes = log.mock.calls
    .map((c) => String(c.arguments[0]))
    .filter((line) => line.includes('"coupon_claim_timing"') && line.includes(couponId))
    .map((line) => JSON.parse(line).outcome);
  assert(outcomes.includes('sold_out_ticket'), `번호표 경로를 안 탐: ${outcomes}`);
  assert(!outcomes.includes('sold_out_tx'), `쿠폰 행 UPDATE로 소진을 들은 요청이 있음: ${outcomes}`);
});

test('번호표: 쿠폰 행이 잠겨 있어도 번호표 밖 요청은 잠금을 기다리지 않고 바로 소진으로 답한다', async () => {
  const couponId = await createCoupon(2);
  const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
  assert.equal((await claim(a, couponId)).status, 201); // 번호 1

  // 다른 연결이 쿠폰 행을 잠가 두면 당첨자의 받은 기록 INSERT(외래 키 검사)는 잠금을 기다린다
  const locker = await pool.getConnection();
  await locker.beginTransaction();
  await locker.query('SELECT id FROM coupons WHERE id = ? FOR UPDATE', [couponId]);
  const pending = [claim(b, couponId), claim(c, couponId)]; // 둘 중 하나가 번호 2(당첨), 하나는 번호 3(탈락)
  const first = await Promise.race([...pending, new Promise<null>((resolve) => setTimeout(resolve, 1500, null))]);
  await locker.rollback();
  locker.release();

  assert.equal(first?.status, 409, '탈락자가 잠금 때문에 1.5초 안에 답을 못 받음');
  const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.deepEqual(await issued(couponId), { issued_count: 2, owners: 2 });
});

test('번호표: 같은 사람이 두 번 누르면 번호표를 돌려줘 다음 사람이 받는다', async () => {
  const couponId = await createCoupon(2);
  const [a, b] = await Promise.all([newUser(), newUser()]);
  // a가 번호 1로 받고, 또 누르면 번호 2(당첨)인데 이미 받은 사람이라 409 → 번호표 반납. 그래서 b가 번호 2로 받는다
  assert.equal((await claim(a, couponId)).status, 201);
  const again = await claim(a, couponId);
  assert.equal(again.status, 409);
  assert.equal(again.body.message, '이미 받은 쿠폰입니다.');
  assert.equal((await claim(b, couponId)).status, 201);
  assert.deepEqual(await issued(couponId), { issued_count: 2, owners: 2 });
});
