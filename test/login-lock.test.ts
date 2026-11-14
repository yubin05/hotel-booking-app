import { call, pool, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RowDataPacket } from 'mysql2';

// 계정(입력한 이메일) 단위 로그인 실패 제한: 15분 안에 5번 틀리면 15분 잠금 (인프라 ADR-054)
useServer();

const PASSWORD = 'password123';
const login = (email: string, password: string) => call('POST', '/auth/login', { body: { email, password } });

async function register(): Promise<string> {
  const email = `lock-${randomUUID()}@test.local`;
  const res = await call('POST', '/auth/register', { body: { email, password: PASSWORD, name: '잠금' } });
  assert.equal(res.status, 201);
  return email;
}

async function failTimes(email: string, n: number): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await login(email, 'wrong-password')).status);
  return codes;
}

test('5번 틀리면 6번째는 맞는 비밀번호여도 429', async () => {
  const email = await register();
  assert.deepEqual(await failTimes(email, 5), [401, 401, 401, 401, 401]);
  assert.equal((await login(email, PASSWORD)).status, 429);
});

test('성공하면 실패 기록이 지워져 다시 5번까지 틀릴 수 있다', async () => {
  const email = await register();
  await failTimes(email, 4);
  assert.equal((await login(email, PASSWORD)).status, 200);
  assert.deepEqual(await failTimes(email, 4), [401, 401, 401, 401]);
  assert.equal((await login(email, PASSWORD)).status, 200);
});

test('없는 계정도 똑같이 잠겨 잠금 응답으로 회원인지 알 수 없다', async () => {
  const email = `nobody-${randomUUID()}@test.local`;
  assert.deepEqual(await failTimes(email, 5), [401, 401, 401, 401, 401]);
  assert.equal((await login(email, PASSWORD)).status, 429);
});

test('대소문자만 바꾼 이메일도 같은 계정으로 센다', async () => {
  const email = await register();
  await failTimes(email, 5);
  assert.equal((await login(email.toUpperCase(), PASSWORD)).status, 429);
});

test('잠금 시간이 지나면 다시 로그인되고, 15분이 지난 실패는 새로 센다', async () => {
  const email = await register();
  await failTimes(email, 5);
  // 시간을 기다리는 대신 기록을 과거로 옮긴다
  await pool.query(
    `UPDATE login_failures SET locked_until = UTC_TIMESTAMP() - INTERVAL 1 SECOND,
            first_failed_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE email = ?`,
    [email],
  );
  assert.equal((await login(email, 'wrong-password')).status, 401);
  const [[row]] = await pool.query<RowDataPacket[]>(
    'SELECT fail_count, locked_until FROM login_failures WHERE email = ?',
    [email],
  );
  assert.equal(row.fail_count, 1);
  assert.equal(row.locked_until, null);
  assert.equal((await login(email, PASSWORD)).status, 200);
});
