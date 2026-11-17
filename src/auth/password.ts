import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// 로그인(auth)과 스키마 태스크(migrate, 호스트 · 관리자 계정)가 함께 쓴다. migrate는 JWT 비밀값이 없어 auth/index를 못 불러온다

// OWASP 권장과 같은 강도의 scrypt 설정(N=2^15, r=8, p=3). 해시 1번에 메모리 약 32MiB
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptKey(password, Buffer.from(salt, 'base64'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
