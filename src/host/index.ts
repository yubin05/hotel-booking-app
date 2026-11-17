import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { authenticate, requireRole } from '../auth';
import { pool, withTransaction } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
import { earnPoints } from '../points';
import { kstToday } from '../time';

// 숙소 주인(호스트) 화면용 API (인프라 ADR-058): 내 숙소 예약 목록과 숙박 완료(체크아웃)
export const hostRouter = Router();

hostRouter.use(authenticate, requireRole('host'));

const STATUSES = new Set(['confirmed', 'completed', 'cancelled']);

// 손님 이름 · 연락처가 들어 있다. 털린 호스트 계정이 가장 먼저 빼 가는 정보라 6단계 탐지의 기준점이 된다
hostRouter.get('/bookings', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const status = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status : null;
  const where = `WHERE h.host_id = ?${status ? ' AND b.status = ?' : ''}`;
  const params = status ? [req.user!.userId, status] : [req.user!.userId];
  const from = 'FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN hotels h ON h.id = r.hotel_id';

  // shortcut: 숙소 → 객실 → 예약 색인을 따라가 정렬한다. 운영 규모 시드(예약 10만 건이 한 호스트)에서 느려지면 (호스트, 체크인) 색인을 둔 표로
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT b.id, b.check_in_date, b.check_out_date, b.guests, b.total_price, b.status, b.special_requests,
            r.name AS room_name, h.id AS hotel_id, h.name AS hotel_name,
            u.name AS guest_name, u.phone AS guest_phone, u.email AS guest_email
       ${from} JOIN users u ON u.id = b.user_id
      ${where} ORDER BY b.check_in_date DESC, b.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  const [[{ total }]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total ${from} ${where}`, params);
  const today = kstToday();
  // 손님 정보 대량 조회(시나리오 2): 세션별로 본 건수 · 쪽 수를 센다
  securityLog('host_bookings_viewed', req, { count: rows.length, page, status });
  res.json({
    success: true,
    data: {
      bookings: rows.map((b) => ({ ...b, can_complete: b.status === 'confirmed' && b.check_in_date <= today })),
      pagination: { total, page, limit, total_pages: Math.ceil(total / limit) },
    },
  });
});

// 숙박 완료: 체크인 날짜가 오늘이거나 지난 확정 예약만. 손님에게 결제액의 5%를 적립한다
hostRouter.post('/bookings/:id/complete', async (req, res) => {
  const data = await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT b.id, b.user_id, b.status, b.check_in_date, b.total_price
         FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN hotels h ON h.id = r.hotel_id
        WHERE b.id = ? AND h.host_id = ?
          FOR UPDATE OF b`,
      [req.params.id, req.user!.userId],
    );
    const booking = rows[0];
    if (!booking) throw new HttpError(404, '예약을 찾을 수 없습니다.');
    // 행을 잠근 채 상태를 보므로 두 번 눌러도 적립은 한 번
    if (booking.status !== 'confirmed') throw new HttpError(409, '확정된 예약만 숙박 완료로 바꿀 수 있습니다.');
    // 털린 호스트 계정이 미래 예약을 완료로 바꿔 적립금을 찍어내지 못하게 (ADR-058)
    if (booking.check_in_date > kstToday()) throw new HttpError(400, '체크인 날짜부터 숙박 완료로 바꿀 수 있습니다.');
    // 돈을 내지 않은 예약에 적립금이 쌓이지 않게 (데모 결제, APP-001)
    const [[unpaid]] = await conn.query<RowDataPacket[]>("SELECT 1 FROM payments WHERE booking_id = ? AND status = 'pending'", [booking.id]);
    if (unpaid) throw new HttpError(409, '결제 대기 중인 예약은 숙박 완료로 바꿀 수 없습니다.');
    // shortcut: 조기 체크아웃이어도 남은 날짜 잠금(booking_nights)은 풀지 않는다. 빈 방을 다시 팔아야 하면 오늘 이후 행을 지운다
    await conn.query("UPDATE bookings SET status = 'completed' WHERE id = ?", [booking.id]);
    const earned = await earnPoints(conn, booking.user_id, Number(booking.total_price), booking.id, req.user!.sessionId);
    return { id: booking.id, status: 'completed', points_earned: earned };
  });
  securityLog('stay_completed', req, { booking_id: data.id, points_earned: data.points_earned });
  res.json({ success: true, message: '숙박 완료로 바꿨습니다.', data });
});
