import { book, call, ctx, newUser, pool, randomDays, useServer } from './helpers';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { kstToday } from '../src/time';

useServer();

// 호스트 계정은 migrate가 만든다(배포 환경). 여기서는 같은 비밀값으로 호스트 토큰을 직접 만든다
function tokenFor(userId: string, role: string): string {
  return jwt.sign({ email: 'staff@test.local', role }, process.env.JWT_SECRET!, {
    subject: userId,
    jwtid: randomUUID(),
    expiresIn: '1h',
    algorithm: 'HS256',
  });
}

async function hostToken(): Promise<string> {
  const [[hotel]] = await pool.query<RowDataPacket[]>('SELECT host_id FROM hotels WHERE id = ?', [ctx.hotelId]);
  return tokenFor(hotel.host_id, 'host');
}

// 오늘 체크인 예약은 다른 테스트 · 반복 실행과 날짜가 겹치므로 날짜 잠금 행 없이 DB에 직접 넣는다
async function todayBooking(guestToken: string, totalPrice: number): Promise<string> {
  const id = randomUUID();
  const tomorrow = new Date(Date.parse(`${kstToday()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO bookings (id, user_id, room_id, check_in_date, check_out_date, guests, total_price, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, (jwt.decode(guestToken) as jwt.JwtPayload).sub, ctx.roomId, kstToday(), tomorrow, totalPrice, id],
  );
  return id;
}

test('호스트가 아니면 호스트 API를 쓸 수 없다', async () => {
  assert.equal((await call('GET', '/host/bookings', { token: await newUser() })).status, 403);
  assert.equal((await call('GET', '/host/bookings')).status, 401);
});

test('호스트는 내 숙소 예약만 손님 이름과 함께 보고, 남의 숙소 예약은 완료할 수 없다', async () => {
  const day = randomDays();
  const created = await book(await newUser(), day(0), day(1));
  const host = await hostToken();
  const [mine] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM hotels WHERE host_id = ?',
    [(jwt.decode(host) as jwt.JwtPayload).sub],
  );
  const myHotels = new Set(mine.map((h) => h.id));

  const list = (await call('GET', '/host/bookings?status=confirmed&limit=50', { token: host })).body.data;
  assert.ok(list.bookings.length > 0);
  for (const b of list.bookings) {
    assert.ok(myHotels.has(b.hotel_id), `남의 숙소 예약이 섞임: ${b.hotel_id}`);
    assert.equal(typeof b.guest_name, 'string');
  }

  const otherHost = tokenFor(randomUUID(), 'host');
  assert.equal((await call('POST', `/host/bookings/${created.body.data.id}/complete`, { token: otherHost })).status, 404);
});

test('미래 예약은 숙박 완료로 바꿀 수 없다 (적립금 찍어내기 방지)', async () => {
  const day = randomDays();
  const created = await book(await newUser(), day(0), day(1));
  const res = await call('POST', `/host/bookings/${created.body.data.id}/complete`, { token: await hostToken() });
  assert.equal(res.status, 400);
});

test('오늘 체크인 예약을 숙박 완료로 바꾸면 결제액의 5%(원 미만 버림)가 한 번만 적립된다', async () => {
  const guest = await newUser();
  const bookingId = await todayBooking(guest, 12_345);
  const host = await hostToken();

  const done = await call('POST', `/host/bookings/${bookingId}/complete`, { token: host });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.points_earned, 617);
  assert.equal((await call('POST', `/host/bookings/${bookingId}/complete`, { token: host })).status, 409, '두 번째 완료');

  const points = (await call('GET', '/points', { token: guest })).body.data;
  assert.equal(points.balance, 617);
  const [[earn]] = await pool.query<RowDataPacket[]>(
    "SELECT session_id FROM point_transactions WHERE booking_id = ? AND type = 'earn'",
    [bookingId],
  );
  assert.equal(earn.session_id, (jwt.decode(host) as jwt.JwtPayload).jti, '누가 완료했는지 호스트 세션 번호가 남는다');
});
