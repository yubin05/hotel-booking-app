import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config';
import { isDuplicateKey, pool } from '../db';
import { HttpError } from '../errors';
import { uuidv7 } from '../uuidv7';
import { hashPassword, verifyPassword } from './password';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueToken(user: { id: string; email: string; role: string }): string {
  return jwt.sign({ email: user.email, role: user.role }, config.jwtSecret, {
    subject: user.id,
    expiresIn: '1h',
    algorithm: 'HS256',
  });
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, '인증 토큰이 필요합니다.');
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    req.user = { userId: String(payload.sub), email: String(payload.email), role: String(payload.role) };
  } catch {
    throw new HttpError(401, '유효하지 않거나 만료된 토큰입니다.');
  }
  next();
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const { email, password, name, phone } = req.body ?? {};
  if (typeof email !== 'string' || email.length > 255 || !EMAIL.test(email)) {
    throw new HttpError(400, '올바른 이메일을 입력해주세요.');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpError(400, '비밀번호는 8자 이상 128자 이하여야 합니다.');
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new HttpError(400, '이름을 입력해주세요.');
  }
  if (phone != null && (typeof phone !== 'string' || phone.length > 20)) {
    throw new HttpError(400, '전화번호 형식이 올바르지 않습니다.');
  }

  const user = { id: uuidv7(), email: email.toLowerCase(), name: name.trim(), role: 'user' };
  try {
    await pool.query(
      'INSERT INTO users (id, email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, user.email, await hashPassword(password), user.name, phone ?? null, user.role],
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw new HttpError(409, '이미 사용 중인 이메일입니다.');
    throw err;
  }
  res.status(201).json({ success: true, message: '회원가입이 완료되었습니다.', data: { token: issueToken(user), user } });
});

// 계정 단위 로그인 실패 제한 (인프라 ADR-054). WAF는 IP 단위라 IP를 바꿔 가며 한 계정을 노리면 못 막는다
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MINUTES = 15; // 이 시간 안에 MAX_FAILURES번 틀리면
const LOCK_MINUTES = 15; // 이만큼 잠근다. 비밀번호 찾기가 없어 영구 잠금은 쓰지 않는다

// 한 문장으로 센다(동시에 틀려도 행 잠금으로 차례로 반영). MySQL은 SET을 왼쪽부터 계산하므로
// fail_count를 먼저 바꾸고, locked_until은 바뀐 fail_count를, first_failed_at은 마지막에 옛 값을 보고 바꾼다
async function recordFailure(email: string): Promise<void> {
  await pool.query(
    `INSERT INTO login_failures (email, fail_count, first_failed_at) VALUES (?, 1, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       fail_count = IF(first_failed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE, 1, fail_count + 1),
       locked_until = IF(fail_count >= ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE, NULL),
       first_failed_at = IF(first_failed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE, UTC_TIMESTAMP(), first_failed_at)`,
    [email, FAILURE_WINDOW_MINUTES, MAX_FAILURES, LOCK_MINUTES, FAILURE_WINDOW_MINUTES],
  );
}

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 255) {
    throw new HttpError(400, '이메일과 비밀번호를 입력해주세요.');
  }
  const key = email.toLowerCase();

  // 잠긴 동안은 비밀번호 확인(scrypt, 메모리 32MiB)도 하지 않는다
  const [locked] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM login_failures WHERE email = ? AND locked_until > UTC_TIMESTAMP()',
    [key],
  );
  if (locked[0]) throw new HttpError(429, `로그인 시도가 너무 많습니다. ${LOCK_MINUTES}분 뒤 다시 시도해주세요.`);

  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, email, name, role, password_hash FROM users WHERE email = ?',
    [key],
  );
  const found = rows[0];
  if (!found || !(await verifyPassword(password, found.password_hash))) {
    await recordFailure(key);
    throw new HttpError(401, '이메일 또는 비밀번호가 잘못되었습니다.');
  }
  await pool.query('DELETE FROM login_failures WHERE email = ?', [key]); // 성공하면 지난 실패는 지움 (NIST)
  const user = { id: found.id, email: found.email, name: found.name, role: found.role };
  res.json({ success: true, message: '로그인 성공', data: { token: issueToken(user), user } });
});

authRouter.get('/profile', authenticate, async (req, res) => {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, email, name, phone, role, created_at FROM users WHERE id = ?',
    [req.user!.userId],
  );
  if (!rows[0]) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  res.json({ success: true, data: rows[0] });
});
