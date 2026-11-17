import { createHash } from 'node:crypto';
import type { Request } from 'express';

// 탐지용 보안 이벤트 로그 (인프라 ADR-058 · 6단계): 한 줄 JSON이라 CloudWatch Logs Insights가 필드로 바로 센다.
// ip는 CloudFront → ALB 뒤에서 trust proxy로 고른 손님 IP(app.ts), session_id는 토큰 jti라 적립금 내역 줄과 이어진다
export function securityLog(event: string, req: Request, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      log: 'security',
      event,
      ip: req.ip,
      ua: req.get('user-agent')?.slice(0, 200), // 세션 도중 IP · 브라우저가 바뀌면 토큰 탈취 신호 (OWASP 세션 관리)
      user_id: req.user?.userId,
      session_id: req.user?.sessionId,
      ...fields,
    }),
  );
}

// 로그인 실패는 입력한 이메일 원문 대신 해시 앞 16자를 남긴다: 계정별로 세는 데는 충분하고, 로그에 개인정보와
// (이메일 칸에 잘못 친) 비밀번호가 남지 않는다. 사건 때는 의심 계정 이메일을 같은 방식으로 해시해 맞춰 본다
export function accountKey(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
}
