import { book, call, ctx, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { channels, type BookingNotice } from '../src/notify';

useServer();

// 실제 메일 채널(MAIL_FROM이 없어 보내지 않고 로그만 남김)을 감싸 무엇을 보내려 했는지 모은다
const realEmail = channels.email;
const sent: BookingNotice[] = [];
channels.email = async (n) => {
  sent.push(n);
  return realEmail(n);
};

async function waitFor<T>(find: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('알림이 2초 안에 오지 않음');
}

function captureLogs(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: unknown) => lines.push(String(line)));
  return lines;
}

test('결제 없이 확정된 예약은 응답 뒤에 확정 알림을 보낸다', async () => {
  const email = `n-${randomUUID()}@example.com`;
  const token = (await call('POST', '/auth/register', { body: { email, password: 'password123', name: '알림' } })).body.data.token;
  const day = new Date(Date.UTC(2950, 0, 1) + Math.floor(Math.random() * 3000) * 86_400_000).toISOString().slice(0, 10);
  const out = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const created = await book(token, day, out);
  assert.equal(created.status, 201);

  const notice = await waitFor(() => sent.find((n) => n.bookingId === created.body.data.id));
  const hotel = (await call('GET', `/hotels/${ctx.hotelId}`)).body.data;
  assert.equal(notice.email, email);
  assert.ok(notice.subject.includes(hotel.name));
  assert.ok(notice.url.endsWith('/me/bookings'));
});

test('메일 채널: .local 주소에는 보내지 않고, 보내는 주소(MAIL_FROM)가 없으면 제목만 로그에 남긴다', async (t) => {
  const logs = captureLogs(t);
  const base = { bookingId: 'b', userId: 'u', name: '테스트', text: '본문', url: 'http://x/me/bookings' };
  await realEmail({ ...base, email: 'x@test.local', subject: '로컬 주소' });
  await realEmail({ ...base, email: 'x@example.com', subject: '보통 주소' });
  assert.ok(!logs.some((l) => l.includes('로컬 주소')));
  assert.ok(logs.some((l) => l.includes('[메일 미발송') && l.includes('보통 주소')));
});

test('알림 채널이 실패해도 예약은 성공하고 다른 채널은 보낸다', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  channels.broken = async () => {
    throw new Error('채널 고장');
  };
  t.after(() => delete channels.broken);

  const token = (
    await call('POST', '/auth/register', { body: { email: `n-${randomUUID()}@example.com`, password: 'password123', name: '알림' } })
  ).body.data.token;
  const day = new Date(Date.UTC(2950, 0, 1) + Math.floor(Math.random() * 3000) * 86_400_000).toISOString().slice(0, 10);
  const out = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const created = await book(token, day, out);
  assert.equal(created.status, 201);
  await waitFor(() => sent.find((n) => n.bookingId === created.body.data.id));
  await waitFor(() => errors.find((e) => e.includes('채널 고장')));
});
