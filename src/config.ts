function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 ${name}이(가) 필요합니다.`);
  return value;
}

// 없으면 기본값, 있으면 1 이상의 정수만 받는다 (잘못된 값으로 조용히 0개 연결이 되는 것을 막음)
export function positiveInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`환경 변수 ${name}은(는) 1 이상의 정수여야 합니다: ${value}`);
  return n;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'app',
    password: required('DB_PASSWORD'),
    name: process.env.DB_NAME || 'hotel_booking',
    // 서버 한 대가 여는 DB 연결 수(일반 · 쿠폰 전용). 서버 수 × (둘의 합)이 DB 연결 한도 안이어야 한다.
    // 인프라 시험에서 서버를 늘릴 때 줄여 쓴다 (v2 ADR-074 ②: 8대 × (5 + 1) = 48)
    poolSize: positiveInt('DB_POOL_SIZE', 10),
    couponPoolSize: positiveInt('DB_COUPON_POOL_SIZE', 2),
  },
  jwtSecret: required('JWT_SECRET'),
  // 쿠폰 수량 번호표(Valkey, 인프라 ADR-080). 비우면 쓰지 않고 DB 쿠폰 행이 수량을 지킨다(로컬 · 도쿄)
  // rediss:// = ElastiCache Serverless(항상 클러스터 모드 · TLS 필수) / redis:// = 로컬 · CI의 단일 Valkey
  redisUrl: process.env.REDIS_URL ?? '',
  // 메일 · 카카오톡 링크가 가리킬 사이트 주소
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  // 예약 확정 메일(Amazon SES, 인프라 ADR-037). 보내는 주소가 없으면 보내지 않고 로그에 제목만 남긴다(로컬 기본)
  mail: {
    from: process.env.MAIL_FROM ?? '',
    region: process.env.SES_REGION || 'ap-northeast-2',
  },
  // 카카오톡 "나에게 보내기"(카카오 개발자 앱의 REST API 키). 키가 없으면 연결 버튼을 숨긴다
  kakao: {
    restApiKey: process.env.KAKAO_REST_API_KEY ?? '',
    clientSecret: process.env.KAKAO_CLIENT_SECRET ?? '',
    redirectUri: process.env.KAKAO_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/kakao/callback`,
    authBase: process.env.KAKAO_AUTH_BASE || 'https://kauth.kakao.com',
    apiBase: process.env.KAKAO_API_BASE || 'https://kapi.kakao.com',
  },
  // 데모 결제(토스페이먼츠 테스트 키). 시크릿 키가 없으면 결제 없이 바로 확정한다(키를 넣기 전의 AWS · 이관 부하 시험과 같은 동작).
  // 요청마다 읽으므로 테스트가 값을 바꿀 수 있다
  toss: {
    secretKey: process.env.TOSS_SECRET_KEY ?? '',
    clientKey: process.env.TOSS_CLIENT_KEY ?? '',
    apiBase: process.env.TOSS_API_BASE || 'https://api.tosspayments.com',
  },
};
