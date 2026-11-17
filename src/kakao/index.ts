import { Router } from 'express';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { authenticate } from '../auth';
import { config } from '../config';
import { pool } from '../db';
import { HttpError } from '../errors';
import { securityLog } from '../log';
import type { BookingNotice } from '../notify';

// 카카오톡 "나에게 보내기" (인프라 ADR-037, docs/decisions.md APP-003). 실제 숙박 서비스는 알림톡(사업자 채널 · 템플릿 심사 · 유료)을
// 쓰지만 개인 포트폴리오는 사업자가 없어, 손님 본인의 "나와의 채팅방"으로 보내는 API로 대신한다

const enabled = () => config.kakao.restApiKey !== '';
const FORM = 'application/x-www-form-urlencoded;charset=utf-8';

// 알림 모듈의 카카오톡 채널. 연결이 없거나 만료됐으면 보내지 않는다
export async function sendKakaoMemo(n: BookingNotice): Promise<void> {
  if (!enabled()) return;
  const [[link]] = await pool.query<RowDataPacket[]>(
    'SELECT access_token FROM kakao_links WHERE user_id = ? AND access_expires_at > UTC_TIMESTAMP()',
    [n.userId],
  );
  if (!link) return;
  const template = {
    object_type: 'text',
    text: n.text.slice(0, 200), // 카카오 기본 텍스트 템플릿은 200자까지
    link: { web_url: n.url, mobile_web_url: n.url },
    button_title: '예약 보기',
  };
  const res = await fetch(`${config.kakao.apiBase}/v2/api/talk/memo/default/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${link.access_token}`, 'Content-Type': FORM },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    // 손님이 카카오에서 연결을 끊었거나 토큰이 무효: 다음부터 시도하지 않게 연결을 지운다
    await pool.query('DELETE FROM kakao_links WHERE user_id = ?', [n.userId]);
    throw new Error('카카오 토큰이 무효라 연결을 지움');
  }
  const data = (await res.json().catch(() => ({}))) as { result_code?: number };
  if (!res.ok || data.result_code !== 0) throw new Error(`카카오톡 발송 실패 (HTTP ${res.status})`);
}

export const kakaoRouter = Router();

kakaoRouter.use(authenticate);

kakaoRouter.get('/', async (req, res) => {
  const [[link]] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM kakao_links WHERE user_id = ? AND access_expires_at > UTC_TIMESTAMP()',
    [req.user!.userId],
  );
  res.json({ success: true, data: { enabled: enabled(), connected: Boolean(link) } });
});

// 카카오 동의 화면 주소. state는 이 사용자에게 서명해 준 10분짜리 값이라, 남이 만든 연결 요청을 끼워 넣지 못한다(CSRF)
kakaoRouter.get('/connect', (req, res) => {
  if (!enabled()) throw new HttpError(503, '카카오 연동이 설정되지 않았습니다.');
  const state = jwt.sign({ purpose: 'kakao' }, config.jwtSecret, { subject: req.user!.userId, expiresIn: '10m', algorithm: 'HS256' });
  const params = new URLSearchParams({
    client_id: config.kakao.restApiKey,
    redirect_uri: config.kakao.redirectUri,
    response_type: 'code',
    scope: 'talk_message',
    state,
  });
  res.json({ success: true, data: { url: `${config.kakao.authBase}/oauth/authorize?${params}` } });
});

// 카카오가 redirect_uri(화면)로 돌려준 code를 받아 토큰으로 바꾼다
kakaoRouter.post('/callback', async (req, res) => {
  const { code, state } = req.body ?? {};
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 500) throw new HttpError(400, '연결 정보가 올바르지 않습니다.');
  if (!enabled()) throw new HttpError(503, '카카오 연동이 설정되지 않았습니다.');
  try {
    const payload = jwt.verify(state, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.purpose !== 'kakao' || payload.sub !== req.user!.userId) throw new Error('다른 사용자의 state');
  } catch {
    throw new HttpError(400, '연결 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.kakao.restApiKey,
    redirect_uri: config.kakao.redirectUri,
    code,
  });
  if (config.kakao.clientSecret) body.set('client_secret', config.kakao.clientSecret);
  const tokenRes = await fetch(`${config.kakao.authBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': FORM },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; scope?: string };
  if (!tokenRes.ok || !token.access_token || !token.expires_in) throw new HttpError(400, '카카오 연결에 실패했습니다.');
  if (token.scope && !token.scope.split(/[ ,]/).includes('talk_message')) {
    throw new HttpError(400, '카카오톡 메시지 전송에 동의해야 알림을 받을 수 있어요.');
  }

  // shortcut: 접근 토큰을 DB에 그대로 둔다(RDS 저장 암호화에 기댐). 갱신 토큰까지 오래 들고 있게 되면 앱 수준 암호화를 붙인다
  await pool.query(
    `INSERT INTO kakao_links (user_id, access_token, access_expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? SECOND) AS new
     ON DUPLICATE KEY UPDATE access_token = new.access_token, access_expires_at = new.access_expires_at`,
    [req.user!.userId, token.access_token, token.expires_in],
  );
  securityLog('kakao_linked', req);
  res.json({ success: true, message: '카카오톡 알림을 연결했습니다.', data: { connected: true } });
});

kakaoRouter.delete('/', async (req, res) => {
  await pool.query('DELETE FROM kakao_links WHERE user_id = ?', [req.user!.userId]);
  res.json({ success: true, message: '카카오톡 알림 연결을 해제했습니다.', data: { connected: false } });
});
