import type { NextFunction, Request, Response } from 'express';

// 관제 화면용 1초 지표 (인프라 ADR-061): 1초 동안 모은 요청 수 · 5xx 수 · 응답 시간 p95를 태스크마다 1초에 한 줄,
// CloudWatch EMF(로그에 지표를 싣는 형식)로 남긴다. CloudWatch가 로그에서 지표를 뽑아 1초 해상도로 저장한다(사용자 지표만 가능).
// 태스크로 나누지 않아 지표는 3개. 여러 태스크의 값은 같은 지표에 모여, 요청 · 오류는 합계(Sum), p95는 최댓값(Maximum)으로 본다(근사)
const NAMESPACE = 'HotelBooking/App';

let durations: number[] = [];
let errors = 0;

export function recordRequest(ms: number, status: number): void {
  durations.push(ms);
  if (status >= 500) errors++;
}

// /api 아래에 붙인다. 헬스 체크는 사람의 트래픽이 아니라 뺀다
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/health')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => recordRequest(Number(process.hrtime.bigint() - start) / 1e6, res.statusCode));
  next();
}

// 지난 1초 묶음을 EMF 한 줄(JSON 한 덩어리)로 만들고 비운다. 요청이 0인 초도 남긴다: 관제 화면에서 "0으로 떨어짐"이 장애 신호라서
export function flushEmf(now = Date.now()): string {
  const sorted = durations.sort((a, b) => a - b);
  const metrics: { Name: string; Unit: string; StorageResolution: 1 }[] = [
    { Name: 'Requests', Unit: 'Count', StorageResolution: 1 },
    { Name: 'Errors5xx', Unit: 'Count', StorageResolution: 1 },
  ];
  const values: Record<string, number> = { Requests: sorted.length, Errors5xx: errors };
  if (sorted.length > 0) {
    metrics.push({ Name: 'LatencyP95', Unit: 'Milliseconds', StorageResolution: 1 });
    values.LatencyP95 = Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10;
  }
  durations = [];
  errors = 0;
  return JSON.stringify({
    _aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [['Service']], Metrics: metrics }] },
    // 쿠폰 받기만 처리하는 서버는 인프라가 SERVICE_NAME=coupon을 넣음(쿠폰 격벽, v2 migration.md 회차 6 · 7) → 관제에서 서비스별로 나뉨
    Service: process.env.SERVICE_NAME ?? 'app',
    ...values,
  });
}
