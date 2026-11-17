import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import { authenticate } from '../auth';
import { findCouponAmount, markCouponUsed, releaseCoupon } from '../coupon';
import { isDuplicateKey, isMissingReference, pool, withTransaction } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
import { findBookableRoom, nightlyPrice } from '../hotel';
import { lockPointsOwner, refundPoints, usePoints } from '../points';
import { notifyBookingConfirmed } from '../notify';
import { createPendingPayment, paymentsEnabled } from '../payments';
import { kstToday, utcIso } from '../time';
import { uuidv7 } from '../uuidv7';

const DAY_MS = 86_400_000;
const MAX_NIGHTS = 30; // 한 요청이 만드는 날짜 행 수를 제한해 과도한 요청을 막는다
const CHANGE_DEADLINE_HOURS = 24;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 변경·취소 마감: 숙소 체크인 시각(한국 시간)의 24시간 전. 시각 형식이 이상하면 15:00으로 본다
export function changeDeadline(checkInDate: string, checkInTime: string): number {
  const time = /^\d{2}:\d{2}$/.test(checkInTime) ? checkInTime : '15:00';
  return Date.parse(`${checkInDate}T${time}:00+09:00`) - CHANGE_DEADLINE_HOURS * 3_600_000;
}

const BOOKING_VIEW = `
  SELECT b.id, b.room_id, b.check_in_date, b.check_out_date, b.guests, b.total_price, b.discount_amount,
         b.status, b.special_requests, b.created_at, b.updated_at,
         r.name AS room_name, r.type AS room_type,
         h.id AS hotel_id, h.name AS hotel_name, h.address AS hotel_address, h.images AS hotel_images,
         h.check_in_time, rv.id AS review_id,
         p.status AS payment_status, p.order_id AS payment_order_id, p.amount AS payment_amount,
         p.expires_at AS payment_expires_at
    FROM bookings b
    JOIN rooms r ON r.id = b.room_id
    JOIN hotels h ON h.id = r.hotel_id
    LEFT JOIN reviews rv ON rv.booking_id = b.id
    LEFT JOIN payments p ON p.booking_id = b.id`;

// 화면이 리뷰 쓰기 버튼을 그릴 수 있게: 취소하지 않았고, 체크아웃했고, 아직 리뷰가 없을 때
function withReviewFlag(row: RowDataPacket) {
  return {
    ...row,
    payment_expires_at: row.payment_expires_at ? utcIso(row.payment_expires_at) : null,
    can_review: row.status !== 'cancelled' && !row.review_id && row.check_out_date <= kstToday(),
  };
}

interface LockedBooking {
  id: string;
  room_id: string;
  check_in_date: string;
  check_out_date: string;
  guests: number;
  status: string;
  check_in_time: string;
  coupon_amount: string | null;
  points_used: string;
}

function toUtcMs(date: unknown): number {
  if (typeof date !== 'string' || !DATE.test(date)) throw new HttpError(400, '날짜는 YYYY-MM-DD 형식이어야 합니다.');
  const ms = Date.parse(`${date}T00:00:00Z`);
  // 2030-02-30처럼 달력에 없는 날짜를 거른다
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, '존재하지 않는 날짜입니다.');
  }
  return ms;
}

// 체크인부터 체크아웃 전날까지, 숙박하는 날짜 목록
function stayNights(checkIn: unknown, checkOut: unknown): string[] {
  const start = toUtcMs(checkIn);
  const end = toUtcMs(checkOut);
  if (end <= start) throw new HttpError(400, '체크아웃 날짜는 체크인 날짜보다 나중이어야 합니다.');
  if (start < toUtcMs(kstToday())) {
    throw new HttpError(400, '체크인 날짜는 오늘 이후여야 합니다.');
  }
  const count = (end - start) / DAY_MS;
  if (count > MAX_NIGHTS) throw new HttpError(400, `최대 ${MAX_NIGHTS}박까지 예약할 수 있습니다.`);
  return Array.from({ length: count }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

function parseGuests(value: unknown, capacity: number): number {
  const guests = Number(value);
  if (!Number.isInteger(guests) || guests < 1) throw new HttpError(400, '인원은 1명 이상이어야 합니다.');
  if (guests > capacity) throw new HttpError(400, `해당 객실의 최대 수용 인원은 ${capacity}명입니다.`);
  return guests;
}

// 객실·날짜마다 한 행을 넣는다. 기본 키(room_id, stay_date)가 겹치면 DB가 거부하므로
// 동시에 요청이 몰려도 이중 예약이 생기지 않는다 (v1은 조회 후 저장이라 경쟁 상태가 있었다)
async function reserveNights(conn: PoolConnection, roomId: string, bookingId: string, nights: string[]) {
  try {
    await conn.query('INSERT INTO booking_nights (room_id, stay_date, booking_id) VALUES ?', [
      nights.map((night) => [roomId, night, bookingId]),
    ]);
  } catch (err) {
    if (isDuplicateKey(err)) throw new HttpError(409, '해당 날짜에 이미 예약이 있습니다.');
    throw err;
  }
}

async function lockOwnBooking(conn: PoolConnection, id: string, userId: string): Promise<LockedBooking> {
  // FOR UPDATE OF b: 예약 행만 잠근다 (객실·숙소 행까지 잠그면 같은 숙소의 취소가 줄을 선다)
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT b.id, b.room_id, b.check_in_date, b.check_out_date, b.guests, b.status, h.check_in_time,
            c.discount_amount AS coupon_amount,
            -- 이 예약에 쓰고 아직 되돌리지 않은 적립금 (사용 -, 환원 · 복구 +)
            (SELECT COALESCE(-SUM(pt.amount), 0) FROM point_transactions pt
              WHERE pt.booking_id = b.id AND pt.type <> 'earn') AS points_used
       FROM bookings b
       JOIN rooms r ON r.id = b.room_id
       JOIN hotels h ON h.id = r.hotel_id
       LEFT JOIN user_coupons uc ON uc.id = b.user_coupon_id
       LEFT JOIN coupons c ON c.id = uc.coupon_id
      WHERE b.id = ? AND b.user_id = ?
        FOR UPDATE OF b`,
    [id, userId],
  );
  if (!rows[0]) throw new HttpError(404, '예약을 찾을 수 없습니다.');
  return rows[0] as LockedBooking;
}

function assertChangeable(booking: LockedBooking): void {
  if (booking.status !== 'confirmed') throw new HttpError(400, '확정된 예약만 변경하거나 취소할 수 있습니다.');
  if (Date.now() > changeDeadline(booking.check_in_date, booking.check_in_time)) {
    throw new HttpError(400, `체크인 ${CHANGE_DEADLINE_HOURS}시간 전부터는 변경하거나 취소할 수 없습니다.`);
  }
}

// 취소: 행은 지우지 않고 상태만 바꾼 뒤 날짜 잠금을 풀고 쿠폰 · 적립금을 돌려준다. 예약 행을 잠근 채 부른다 (관리자 사건 복구도 씀)
export async function cancelBooking(conn: PoolConnection, bookingId: string, sessionId: string | null): Promise<void> {
  await conn.query("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [bookingId]);
  await conn.query('DELETE FROM booking_nights WHERE booking_id = ?', [bookingId]);
  await releaseCoupon(conn, bookingId);
  await refundPoints(conn, bookingId, sessionId);
  // shortcut: 테스트 키라 실제 돈이 오가지 않아 토스 결제 취소(환불) API는 부르지 않고 상태만 바꾼다. 실결제로 바꾸면 환불 API를 붙인다
  await conn.query("UPDATE payments SET status = 'cancelled' WHERE booking_id = ? AND status IN ('pending', 'paid')", [bookingId]);
}

export const bookingRouter = Router();

bookingRouter.use(authenticate);

bookingRouter.post('/', async (req, res) => {
  const userId = req.user!.userId;
  const key = req.get('Idempotency-Key');
  if (!key || key.length > 100) throw new HttpError(400, 'Idempotency-Key 헤더가 필요합니다.');
  const { room_id, check_in_date, check_out_date, guests, special_requests, user_coupon_id, points = 0 } = req.body ?? {};
  if (typeof room_id !== 'string') throw new HttpError(400, '객실을 선택해주세요.');
  if (user_coupon_id != null && typeof user_coupon_id !== 'string') throw new HttpError(400, '쿠폰 형식이 올바르지 않습니다.');
  if (!Number.isSafeInteger(points) || points < 0) throw new HttpError(400, '적립금은 0 이상의 정수여야 합니다.');
  if (special_requests != null && (typeof special_requests !== 'string' || special_requests.length > 1000)) {
    throw new HttpError(400, '요청 사항은 1000자 이하여야 합니다.');
  }
  const nights = stayNights(check_in_date, check_out_date);
  const id = uuidv7();

  const created = await withTransaction(async (conn) => {
    if (points > 0) await lockPointsOwner(conn, userId);
    const room = await findBookableRoom(conn, room_id);
    if (!room) throw new HttpError(404, '객실을 찾을 수 없습니다.');
    const guestCount = parseGuests(guests, room.capacity);
    const subtotal = nightlyPrice(room) * nights.length;
    // 쿠폰 할인은 숙박 금액을 넘지 않는다
    const discount = user_coupon_id ? Math.min(await findCouponAmount(conn, user_coupon_id, userId), subtotal) : 0;
    // 쿠폰을 먼저 빼고, 남은 결제액까지 적립금을 쓸 수 있다
    if (points > subtotal - discount) throw new HttpError(400, '적립금은 결제 금액까지만 쓸 수 있습니다.');
    const total = subtotal - discount - points;
    try {
      await conn.query(
        `INSERT INTO bookings (id, user_id, room_id, check_in_date, check_out_date, guests, total_price,
                               discount_amount, user_coupon_id, special_requests, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, userId, room_id, check_in_date, check_out_date, guestCount, total,
          discount, user_coupon_id ?? null, special_requests ?? null, key,
        ],
      );
    } catch (err) {
      if (isDuplicateKey(err)) return null; // 같은 멱등키로 이미 만든 예약이 있다
      // 토큰은 유효하지만 사용자가 없다: DB 초기화나 백업 복원 이전에 받은 토큰
      if (isMissingReference(err)) throw new HttpError(401, '로그인 정보가 유효하지 않습니다. 다시 로그인해주세요.');
      throw err;
    }
    await reserveNights(conn, room_id, id, nights);
    if (user_coupon_id) await markCouponUsed(conn, user_coupon_id, id);
    // 잔액 확인은 멱등키 중복 확인(INSERT) 뒤에: 이미 처리된 요청을 다시 보내면 잔액이 줄어 있어도 처음 예약을 돌려줘야 한다
    if (points > 0) await usePoints(conn, userId, points, id, req.user!.sessionId);
    // 낼 돈이 있으면 결제 대기(10분). 결제가 꺼져 있거나 쿠폰 · 적립금으로 0원이면 바로 확정
    const payment = paymentsEnabled() && Math.round(total) > 0 ? await createPendingPayment(conn, id, total) : null;
    return {
      id,
      total_price: total,
      discount_amount: discount,
      points_used: points,
      nights: nights.length,
      status: 'confirmed',
      payment,
    };
  });

  if (created) {
    // 남의 적립금으로 예약(시나리오 1): 낯선 IP의 로그인 세션이 적립금을 쓰는지 본다
    securityLog('booking_created', req, {
      booking_id: created.id,
      total_price: created.total_price,
      points_used: created.points_used,
      coupon: Boolean(user_coupon_id),
    });
    if (!created.payment) notifyBookingConfirmed(created.id); // 결제가 있으면 승인 뒤에 보낸다
    res.status(201).json({ success: true, message: '예약이 완료되었습니다.', data: created });
    return;
  }

  // shortcut: 같은 키로 내용이 다른 요청이 와도 처음 예약을 돌려준다. 요청 본문 비교는 필요해지면 추가
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, total_price, discount_amount, check_in_date, check_out_date, status
       FROM bookings WHERE user_id = ? AND idempotency_key = ?`,
    [userId, key],
  );
  const existing = rows[0];
  res.status(200).json({
    success: true,
    message: '이미 처리된 요청입니다.',
    data: {
      id: existing.id,
      total_price: Number(existing.total_price),
      discount_amount: Number(existing.discount_amount),
      nights: (toUtcMs(existing.check_out_date) - toUtcMs(existing.check_in_date)) / DAY_MS,
      status: existing.status,
    },
  });
});

bookingRouter.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where = status ? 'WHERE b.user_id = ? AND b.status = ?' : 'WHERE b.user_id = ?';
  const params = status ? [req.user!.userId, status] : [req.user!.userId];

  // id가 UUIDv7이라 id 역순이 곧 최신순이다
  const [rows] = await pool.query<RowDataPacket[]>(`${BOOKING_VIEW} ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    (page - 1) * limit,
  ]);
  const [[{ total }]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM bookings b ${where}`, params);

  res.json({
    success: true,
    data: { bookings: rows.map(withReviewFlag), pagination: { total, page, limit, total_pages: Math.ceil(total / limit) } },
  });
});

bookingRouter.get('/:id', async (req, res) => {
  const [rows] = await pool.query<RowDataPacket[]>(`${BOOKING_VIEW} WHERE b.id = ? AND b.user_id = ?`, [
    req.params.id,
    req.user!.userId,
  ]);
  if (!rows[0]) throw new HttpError(404, '예약을 찾을 수 없습니다.');
  res.json({ success: true, data: withReviewFlag(rows[0]) });
});

// 날짜·인원 변경: 기존 날짜 행을 지우고 새 날짜 행을 넣는다. 다른 예약과 겹치면 전체를 되돌린다
bookingRouter.patch('/:id', async (req, res) => {
  const data = await withTransaction(async (conn) => {
    const booking = await lockOwnBooking(conn, String(req.params.id), req.user!.userId);
    assertChangeable(booking);
    const checkIn = req.body?.check_in_date ?? booking.check_in_date;
    const checkOut = req.body?.check_out_date ?? booking.check_out_date;
    const nights = stayNights(checkIn, checkOut);
    const room = await findBookableRoom(conn, booking.room_id);
    if (!room) throw new HttpError(409, '이 객실은 더 이상 예약할 수 없습니다.');
    const guests = parseGuests(req.body?.guests ?? booking.guests, room.capacity);
    const subtotal = nightlyPrice(room) * nights.length;
    const discount = Math.min(Number(booking.coupon_amount ?? 0), subtotal);
    const used = Number(booking.points_used);
    const points = Math.min(used, Math.floor(subtotal - discount));
    // shortcut: 데모 결제는 부분 환불 · 추가 결제를 만들지 않아, 결제 중이거나 끝난 예약은 결제 금액이 그대로인 변경만 받는다
    // (같은 박수로 날짜 옮기기 · 인원 바꾸기). 금액이 바뀌는 변경이 필요해지면 차액 결제 · 부분 취소 API를 붙인다
    const [[payment]] = await conn.query<RowDataPacket[]>(
      "SELECT amount FROM payments WHERE booking_id = ? AND status IN ('pending', 'paid') FOR UPDATE",
      [booking.id],
    );
    if (payment && Math.round(subtotal - discount - points) !== payment.amount) {
      throw new HttpError(409, '결제 중이거나 결제한 예약은 금액이 바뀌는 변경을 할 수 없습니다. 취소 후 다시 예약해 주세요.');
    }

    await conn.query('DELETE FROM booking_nights WHERE booking_id = ?', [booking.id]);
    await reserveNights(conn, booking.room_id, booking.id, nights);
    // 숙박이 줄어 쓴 적립금이 새 결제액보다 많으면, 이 트랜잭션 안에서 전부 환원하고 결제액까지만 다시 쓴다.
    // "취소 후 다시 예약"으로 돌리면 그 사이 다른 손님이 객실을 가져갈 수 있다. 환원액 ≥ 다시 쓰는 액이라 잔액은 줄지 않는다
    if (points < used) {
      await refundPoints(conn, booking.id, req.user!.sessionId);
      if (points > 0) await usePoints(conn, req.user!.userId, points, booking.id, req.user!.sessionId);
    }
    await conn.query(
      `UPDATE bookings SET check_in_date = ?, check_out_date = ?, guests = ?, total_price = ?, discount_amount = ?
        WHERE id = ?`,
      [checkIn, checkOut, guests, subtotal - discount - points, discount, booking.id],
    );
    return {
      id: booking.id,
      check_in_date: checkIn,
      check_out_date: checkOut,
      guests,
      total_price: subtotal - discount - points,
      discount_amount: discount,
      points_used: points,
      nights: nights.length,
    };
  });
  res.json({ success: true, message: '예약이 변경되었습니다.', data });
});

// v1 프론트와 맞추려고 DELETE를 쓰지만, 행은 지우지 않고 상태만 바꾼다 (변경분 대조용)
bookingRouter.delete('/:id', async (req, res) => {
  await withTransaction(async (conn) => {
    const booking = await lockOwnBooking(conn, String(req.params.id), req.user!.userId);
    assertChangeable(booking);
    await cancelBooking(conn, booking.id, req.user!.sessionId);
  });
  res.json({ success: true, message: '예약이 취소되었습니다.' });
});
