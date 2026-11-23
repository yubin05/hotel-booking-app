import { call, captureSecurityLogs, ctx, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { accountKey } from '../src/log';

useServer();

// CloudFront → ALB를 거친 것처럼: 손님이 보낸 가짜 값, CloudFront가 덧붙인 손님 IP, ALB가 덧붙인 CloudFront IP
function login(email: string, password: string) {
  return fetch(`${ctx.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9, 203.0.113.7, 10.0.0.1' },
    body: JSON.stringify({ email, password }),
  });
}

test('로그인 실패는 이메일 원문 대신 해시를, 성공은 토큰과 같은 세션 번호를 남기고, IP는 가짜 값이 아닌 손님 IP다', async (t) => {
  const email = `t-${randomUUID()}@test.local`;
  await call('POST', '/auth/register', { body: { email, password: 'password123', name: '테스트' } });
  const logs = captureSecurityLogs(t);

  assert.equal((await login(email, 'wrong-password')).status, 401);
  const ok = await login(email, 'password123');
  const token = (await ok.json()).data.token;

  const failed = logs.find((l) => l.event === 'login_failed')!;
  assert.equal(failed.account, accountKey(email));
  assert.equal(failed.reason, 'wrong_password');
  assert.ok(!JSON.stringify(logs).includes(email), '로그에 이메일 원문이 남음');

  const succeeded = logs.find((l) => l.event === 'login_succeeded')!;
  assert.equal(succeeded.session_id, (jwt.decode(token) as jwt.JwtPayload).jti);
  assert.equal(succeeded.ip, '203.0.113.7');
});
