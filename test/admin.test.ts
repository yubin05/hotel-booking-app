import { book, call, newUser, pool, randomDays, staffToken, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';

useServer();

const claims = (token: string) => jwt.decode(token) as jwt.JwtPayload;
const admin = () => staffToken(randomUUID(), 'admin');

// 시나리오 1: 주인이 가입해 쓰는 세션과, 유출된 비밀번호로 공격자가 로그인한 세션이 같은 계정에 있다
async function victimWithAttacker(points: number) {
  const email = `t-${randomUUID()}@test.local`;
  const owner = (await call('POST', '/auth/register', { body: { email, password: 'password123', name: '피해자' } })).body.data.token;
  const attacker = (await call('POST', '/auth/login', { body: { email, password: 'password123' } })).body.data.token;
  await pool.query("INSERT INTO point_transactions (id, user_id, type, amount) VALUES (?, ?, 'earn', ?)", [
    randomUUID(),
    claims(owner).sub,
    points,
  ]);
  return { email, owner, attacker };
}

test('관리자가 아니면 관리자 API를 쓸 수 없다', async () => {
  assert.equal((await call('GET', '/admin/users?email=a@b.c', { token: await newUser() })).status, 403);
  assert.equal((await call('GET', '/admin/users?email=a@b.c', { token: staffToken(randomUUID(), 'host') })).status, 403);
});

test('사건 복구: 공격자 세션이 쓴 적립금만 되돌리고 그 예약을 취소하며, 주인 세션이 쓴 것은 그대로 둔다', async () => {
  const { email, owner, attacker } = await victimWithAttacker(3000);
  const day = randomDays();
  const stolen = await book(attacker, day(0), day(1), { points: 2000 });
  const own = await book(owner, day(3), day(4), { points: 500 });
  assert.equal(stolen.status, 201);
  assert.equal(own.status, 201);

  const found = (await call('GET', `/admin/users?email=${encodeURIComponent(email)}`, { token: admin() })).body.data;
  const attackerSession = claims(attacker).jti;
  assert.ok(found.points.transactions.some((t: { type: string; session_id: string }) => t.type === 'use' && t.session_id === attackerSession));

  const recovered = await call('POST', '/admin/recover', { token: admin(), body: { session_id: attackerSession } });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.restored_amount, 2000);
  assert.deepEqual(recovered.body.data.cancelled_bookings, [stolen.body.data.id]);

  assert.equal((await call('GET', '/points', { token: owner })).body.data.balance, 2500);
  assert.equal((await call('GET', `/bookings/${stolen.body.data.id}`, { token: owner })).body.data.status, 'cancelled');
  assert.equal((await call('GET', `/bookings/${own.body.data.id}`, { token: owner })).body.data.status, 'confirmed');
  assert.equal((await call('POST', '/admin/recover', { token: admin(), body: { session_id: attackerSession } })).status, 404, '두 번 복구');
});
