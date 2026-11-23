import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { authenticate, requireRole } from '../auth';
import { cancelBooking } from '../booking';
import { pool, withTransaction } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
import { pointHistory, restoreSessionPoints } from '../points';
import { utcIso } from '../time';

// 운영자(관리자) API (인프라 ADR-058 · ADR-060): 계정 조회와 사건 복구. 세션 끊기 · 잠금 · 알림은 보안 강화 단계
export const adminRouter = Router();

adminRouter.use(authenticate, requireRole('admin'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 이메일로 계정 찾기 → 적립금 잔액 · 내역(세션 번호 포함). 어느 세션이 썼는지 보고 복구할 세션을 고른다
adminRouter.get('/users', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.toLowerCase() : '';
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, email, name, phone, role, created_at FROM users WHERE email = ?',
    [email],
  );
  const user = rows[0];
  if (!user) throw new HttpError(404, '계정을 찾을 수 없습니다.');
  securityLog('admin_user_viewed', req, { target_user_id: user.id }); // 관리자가 개인정보를 본 기록
  res.json({ success: true, data: { user, points: await pointHistory(user.id, 100) } });
});

// 사건 복구: 공격자 세션이 쓴 적립금을 '복구' 줄로 되돌리고, 그 적립금으로 만든 확정 예약을 취소한다
adminRouter.post('/recover', async (req, res) => {
  const sessionId = req.body?.session_id;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new HttpError(400, '세션 번호 형식이 올바르지 않습니다.');

  const data = await withTransaction(async (conn) => {
    // 예약 행을 먼저 잠근다: 손님이 같은 예약을 동시에 취소(환원)하면 한 사용을 두 번 되돌리려다 유니크 키에 막힌다
    // shortcut: 적립금을 쓰지 않은 공격자 예약은 DB에 세션 번호가 없어 여기서 못 찾는다. 로그(booking_created)로 찾아 따로 취소
    const [bookings] = await conn.query<RowDataPacket[]>(
      `SELECT id, status FROM bookings
        WHERE id IN (SELECT booking_id FROM point_transactions WHERE session_id = ? AND type = 'use')
          FOR UPDATE`,
      [sessionId],
    );
    const restored = await restoreSessionPoints(conn, sessionId, req.user!.sessionId);
    if (restored.length === 0) throw new HttpError(404, '이 세션이 쓰고 아직 되돌리지 않은 적립금이 없습니다.');
    // 이미 숙박을 마친 예약은 취소할 수 없어 적립금만 돌려준다
    const cancelled = bookings.filter((b) => b.status === 'confirmed').map((b) => String(b.id));
    for (const id of cancelled) await cancelBooking(conn, id, req.user!.sessionId);
    return { restored_amount: restored.reduce((sum, r) => sum + r.amount, 0), restored_count: restored.length, cancelled_bookings: cancelled };
  });
  securityLog('incident_recovered', req, { target_session_id: sessionId, ...data });
  res.json({ success: true, message: '복구했습니다.', data });
});

// 오탐 처리 (인프라 ADR-072): 운영자가 영향을 확인한 뒤 세션의 적립금 사용 보류를 푼다. 풀린 세션의 환경은 다시 평소 환경으로 친다.
// 보류 시각 · 이유는 행에서 지우고 로그(hold_released)에 남긴다
adminRouter.post('/release-hold', async (req, res) => {
  const sessionId = req.body?.session_id;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new HttpError(400, '세션 번호 형식이 올바르지 않습니다.');

  const data = await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT user_id, held_at, hold_reason FROM sessions WHERE id = ? AND held_at IS NOT NULL FOR UPDATE',
      [sessionId],
    );
    if (!rows[0]) throw new HttpError(404, '보류된 세션이 아닙니다.');
    await conn.query('UPDATE sessions SET held_at = NULL, hold_reason = NULL WHERE id = ?', [sessionId]);
    return { user_id: rows[0].user_id, held_at: utcIso(rows[0].held_at), hold_reason: rows[0].hold_reason };
  });
  securityLog('hold_released', req, { target_session_id: sessionId, ...data });
  res.json({ success: true, message: '보류를 풀었습니다.', data });
});
