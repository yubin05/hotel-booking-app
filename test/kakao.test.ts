import { book, call, ctx, newUser, randomDays, useServer } from './helpers';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { config } from '../src/config';

useServer();

// 카카오 인증 서버 · 메시지 API 대역. code가 'no-consent'면 메시지 동의 없이 토큰을 주고,
// memoStatus를 401로 바꾸면 손님이 연결을 끊은 것처럼 답한다
const memos: { auth: string; template: { text: string; link: { web_url: string } } }[] = [];
let memoStatus = 200;
const kakao = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const form = new URLSearchParams(raw);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') {
      const ok = form.get('grant_type') === 'authorization_code' && form.get('client_id') === 'rest-key';
      res.writeHead(ok ? 200 : 400);
      const scope = form.get('code') === 'no-consent' ? 'profile_nickname' : 'talk_message profile_nickname';
      const token = { access_token: `at-${form.get('code')}`, expires_in: 43199, ...(form.get('code') === 'no-scope' ? {} : { scope }) };
      res.end(JSON.stringify(ok ? token : { error: 'invalid_grant' }));
      return;
    }
    if (req.url === '/v2/api/talk/memo/default/send') {
      memos.push({ auth: String(req.headers.authorization), template: JSON.parse(form.get('template_object') ?? '{}') });
      res.writeHead(memoStatus);
      // 실제 카카오 응답 모양 (2026-11-18 로컬에서 받은 403): {"msg":"insufficient scopes.","code":-402,...}
      const failure = memoStatus === 403 ? { code: -402, msg: 'insufficient scopes.' } : { code: -401, msg: 'this access token does not exist' };
      res.end(JSON.stringify(memoStatus === 200 ? { result_code: 0 } : failure));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
});

before(async () => {
  await new Promise<void>((resolve) => kakao.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(kakao.address() as AddressInfo).port}`;
  Object.assign(config.kakao, { restApiKey: 'rest-key', authBase: base, apiBase: base });
});
after(() => kakao.close());

async function connect(token: string, code: string) {
  const url = new URL((await call('GET', '/kakao/connect', { token })).body.data.url);
  assert.equal(url.searchParams.get('client_id'), 'rest-key');
  assert.equal(url.searchParams.get('scope'), 'talk_message');
  return call('POST', '/kakao/callback', { token, body: { code, state: url.searchParams.get('state') } });
}

async function waitForMemo(auth: string) {
  for (let i = 0; i < 100; i++) {
    const memo = memos.find((m) => m.auth === auth);
    if (memo) return memo;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('카카오톡 발송이 2초 안에 오지 않음');
}

test('카카오를 연결하면 예약 확정이 본인 카톡으로 가고, 해제하면 연결이 사라진다', async () => {
  const token = await newUser();
  assert.equal((await connect(token, 'c1')).status, 200);
  assert.equal((await call('GET', '/kakao', { token })).body.data.connected, true);

  const day = randomDays();
  assert.equal((await book(token, day(0), day(1))).status, 201);
  const memo = await waitForMemo('Bearer at-c1');
  const hotel = (await call('GET', `/hotels/${ctx.hotelId}`)).body.data;
  assert.ok(memo.template.text.includes(hotel.name));
  assert.ok(memo.template.text.length <= 200);
  assert.ok(memo.template.link.web_url.endsWith('/me/bookings'));

  assert.equal((await call('DELETE', '/kakao', { token })).status, 200);
  assert.equal((await call('GET', '/kakao', { token })).body.data.connected, false);
});

test('다른 사용자에게 서명해 준 state로는 연결할 수 없다 (CSRF)', async () => {
  const victim = await newUser();
  const attacker = await newUser();
  const url = new URL((await call('GET', '/kakao/connect', { token: attacker })).body.data.url);
  const res = await call('POST', '/kakao/callback', { token: victim, body: { code: 'c2', state: url.searchParams.get('state') } });
  assert.equal(res.status, 400);
  assert.equal((await call('GET', '/kakao', { token: victim })).body.data.connected, false);
});

test('메시지 전송에 동의하지 않았거나 토큰에 동의 범위가 없으면 연결하지 않는다', async () => {
  const token = await newUser();
  assert.equal((await connect(token, 'no-consent')).status, 400);
  assert.equal((await connect(token, 'no-scope')).status, 400);
  assert.equal((await call('GET', '/kakao', { token })).body.data.connected, false);
});

for (const [status, code, why] of [
  [401, 'c3', '토큰을 거절'],
  [403, 'c4', '메시지 동의가 없다고(-402)'],
] as const) test(`카카오가 ${why} 답하면 연결을 지워 다음부터 보내지 않는다`, async (t) => {
  t.mock.method(console, 'error', () => {});
  const token = await newUser();
  await connect(token, code);
  memoStatus = status;
  t.after(() => (memoStatus = 200));
  const day = randomDays();
  await book(token, day(0), day(1));
  await waitForMemo(`Bearer at-${code}`);
  for (let i = 0; i < 100 && (await call('GET', '/kakao', { token })).body.data.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await call('GET', '/kakao', { token })).body.data.connected, false);
});
