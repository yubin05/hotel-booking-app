import { book, call, captureSecurityLogs, ctx, pool, randomDays, staffToken, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { purgeOldSessions } from '../src/auth';

// 시나리오 A 계정 탈취 탐지 · 세션 보류 (인프라 ADR-072, docs/v3-scenario-a.md 3-7 표)
// 시험 요청은 모두 127.0.0.1 · 같은 브라우저라, 세션 행의 IP · 브라우저 · 로그인 시각을 직접 고쳐 접속 환경을 만든다
useServer();

const claims = (token: string) => jwt.decode(token) as jwt.JwtPayload;
const admin = () => staffToken(randomUUID(), 'admin');
const USUAL = { ip: '203.0.113.10', ua: 'usual-phone' };
const NEW = { ip: '198.51.100.7', ua: 'new-laptop' };
type Env = typeof USUAL;

async function setSession(token: string, env: Env, minutesAgo: number): Promise<void> {
  await pool.query('UPDATE sessions SET ip = ?, ua = ?, created_at = UTC_TIMESTAMP() - INTERVAL ? MINUTE WHERE id = ?', [
    env.ip,
    env.ua,
    minutesAgo,
    claims(token).jti,
  ]);
}

// 이틀 전 평소 환경으로 가입한 회원(적립금 = 1박 요금)과, 같은 계정에 다른 환경으로 로그인하는 함수
async function member() {
  const email = `t-${randomUUID()}@test.local`;
  const owner = (await call('POST', '/auth/register', { body: { email, password: 'password123', name: '회원' } })).body.data.token;
  await setSession(owner, USUAL, 2 * 24 * 60);
  const balance = Math.floor((await call('GET', `/hotels/${ctx.hotelId}`)).body.data.rooms[0].discounted_price);
  await pool.query("INSERT INTO point_transactions (id, user_id, type, amount) VALUES (?, ?, 'earn', ?)", [
    randomUUID(),
    claims(owner).sub,
    balance,
  ]);
  const login = async (env: Env, minutesAgo: number) => {
    const token = (await call('POST', '/auth/login', { body: { email, password: 'password123' } })).body.data.token;
    await setSession(token, env, minutesAgo);
    return token;
  };
  return { owner, login, balance, pct: (p: number) => Math.floor((balance * p) / 100) };
}

async function session(token: string) {
  const [[row]] = await pool.query<RowDataPacket[]>('SELECT held_at, hold_reason FROM sessions WHERE id = ?', [claims(token).jti]);
  return row;
}

// 예약 수와 원장 줄 수 (A2: 막힌 요청이 아무것도 남기지 않았는지)
async function footprint(token: string) {
  const [[row]] = await pool.query<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM bookings WHERE user_id = ?) AS bookings,
            (SELECT COUNT(*) FROM point_transactions WHERE user_id = ?) AS ledger_lines`,
    [claims(token).sub, claims(token).sub],
  );
  return row;
}

const balanceOf = async (token: string) => (await call('GET', '/points', { token })).body.data.balance;

test('정상: 여행 중(N1) · 폰을 바꾸고 2시간 뒤(N2) · 새 환경에서 소액(N3)은 통과하고 보류되지 않는다', async () => {
  const day = randomDays();
  const cases: [string, Env, number, number][] = [
    ['N1', { ip: NEW.ip, ua: USUAL.ua }, 5, 80],
    ['N2', NEW, 120, 60],
    ['N3', NEW, 3, 10],
  ];
  for (const [i, [name, env, minutes, percent]] of cases.entries()) {
    const m = await member();
    const token = await m.login(env, minutes);
    // 같은 객실을 쓰므로 경우마다 날짜를 달리한다
    assert.equal((await book(token, day(i * 2), day(i * 2 + 1), { points: m.pct(percent) })).status, 201, name);
    assert.equal((await session(token)).held_at, null, name);
  }
});

test('이상: 첫 사용은 통과 + 보류 + 경보 로그(A1), 같은 세션은 403에 흔적 없음(A2), 평소 세션은 통과(N4), 재로그인은 403(A4), 복구는 한 번만(R1 · R2)', async (t) => {
  const logs = captureSecurityLogs(t);
  const m = await member();
  const attacker = await m.login(NEW, 3);
  const day = randomDays();

  // A1
  const first = await book(attacker, day(0), day(1), { points: m.pct(60) });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.hold, undefined, '응답에 탐지 사실을 알리지 않는다');
  const held = await session(attacker);
  assert.ok(held.held_at);
  assert.match(held.hold_reason, /로그인 3분 뒤 · 잔액의 60%/);
  const alert = logs.find((l) => l.event === 'points_hold_applied')!;
  assert.deepEqual(
    [alert.booking_id, alert.points_used, alert.balance_before, alert.minutes_since_login, alert.new_ip, alert.new_ua],
    [first.body.data.id, m.pct(60), m.balance, 3, true, true],
  );

  // A2
  const before = await footprint(attacker);
  assert.equal((await book(attacker, day(2), day(3), { points: m.pct(10) })).status, 403);
  assert.deepEqual(await footprint(attacker), before);
  assert.equal(logs.find((l) => l.event === 'points_hold_blocked')!.reason, 'held');

  // N4
  assert.equal((await book(m.owner, day(4), day(5), { points: m.pct(10) })).status, 201);

  // A4: 같은 새 환경에서 다시 로그인해도, 한 번 더 로그인해도 막힌다
  for (const minutes of [1, 0]) {
    const again = await m.login(NEW, minutes);
    assert.equal((await book(again, day(6), day(7), { points: m.pct(30) })).status, 403, `재로그인 ${minutes}분`);
  }
  assert.equal(logs.filter((l) => l.event === 'points_hold_blocked' && l.reason === 'relogin').length, 2);

  // R1 · R2
  const balance = await balanceOf(m.owner);
  const recovered = await call('POST', '/admin/recover', { token: admin(), body: { session_id: claims(attacker).jti } });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.restored_amount, m.pct(60));
  assert.deepEqual(recovered.body.data.cancelled_bookings, [first.body.data.id]);
  assert.equal(await balanceOf(m.owner), balance + m.pct(60));
  assert.equal((await call('POST', '/admin/recover', { token: admin(), body: { session_id: claims(attacker).jti } })).status, 404);
  assert.equal(await balanceOf(m.owner), balance + m.pct(60));
});

// 3-7 표는 "각 40%"였으나, 확정 규칙(사용 전 잔액의 50% 이상)에서는 40%가 걸리지 않아 동시성을 시험하지 못한다. 60%로 시험한다
test('A3: 새 환경의 첫 사용을 동시에 2건 보내면 1건만 통과한다', async () => {
  const m = await member();
  const attacker = await m.login(NEW, 3);
  const day = randomDays();
  const statuses = (await Promise.all([0, 2].map((d) => book(attacker, day(d), day(d + 1), { points: m.pct(60) })))).map(
    (r) => r.status,
  );
  assert.deepEqual(statuses.sort(), [201, 403]);
  const [[{ uses }]] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS uses FROM point_transactions WHERE session_id = ? AND type = 'use'",
    [claims(attacker).jti],
  );
  assert.equal(uses, 1);
});

test('우회 시도: 공격자가 두 번 로그인해 두고 두 번째 세션만 써도 보류된다 (갓 만든 세션은 평소 환경이 아님)', async () => {
  const m = await member();
  await m.login(NEW, 5);
  const second = await m.login(NEW, 3);
  const day = randomDays();
  assert.equal((await book(second, day(0), day(1), { points: m.pct(60) })).status, 201);
  assert.ok((await session(second)).held_at);
  assert.equal((await book(second, day(2), day(3), { points: m.pct(10) })).status, 403);
});

test('오탐 처리: 운영자가 보류를 풀면 그 세션은 다시 쓸 수 있고, 운영자만 풀 수 있으며, 두 번 풀면 404', async () => {
  const m = await member();
  const newPhone = await m.login(NEW, 3);
  const day = randomDays();
  assert.equal((await book(newPhone, day(0), day(1), { points: m.pct(60) })).status, 201);
  assert.ok((await session(newPhone)).held_at);

  const body = { session_id: claims(newPhone).jti };
  assert.equal((await call('POST', '/admin/release-hold', { token: m.owner, body })).status, 403);
  const released = await call('POST', '/admin/release-hold', { token: admin(), body });
  assert.equal(released.status, 200);
  assert.match(released.body.data.hold_reason, /잔액의 60%/);
  assert.equal((await session(newPhone)).held_at, null);
  assert.equal((await book(newPhone, day(2), day(3), { points: m.pct(10) })).status, 201);
  assert.equal((await call('POST', '/admin/release-hold', { token: admin(), body })).status, 404);
});

test('로그인 기록은 90일이 지난 것만 지운다', async () => {
  const m = await member();
  const recent = await m.login(NEW, 0);
  await setSession(m.owner, USUAL, 91 * 24 * 60);
  assert.ok((await purgeOldSessions()) >= 1);
  assert.equal(await session(m.owner), undefined);
  assert.ok(await session(recent));
});
