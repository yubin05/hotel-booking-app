function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 ${name}이(가) 필요합니다.`);
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'app',
    password: required('DB_PASSWORD'),
    name: process.env.DB_NAME || 'hotel_booking',
  },
  jwtSecret: required('JWT_SECRET'),
  // 메일 · 카카오톡 링크가 가리킬 사이트 주소
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  // 예약 확정 메일(Amazon SES, 인프라 ADR-037). 보내는 주소가 없으면 보내지 않고 로그에 제목만 남긴다(로컬 기본)
  mail: {
    from: process.env.MAIL_FROM ?? '',
    region: process.env.SES_REGION || 'ap-northeast-2',
  },
  // 데모 결제(토스페이먼츠 테스트 키). 시크릿 키가 없으면 결제 없이 바로 확정한다(키를 넣기 전의 AWS · 이관 부하 시험과 같은 동작).
  // 요청마다 읽으므로 테스트가 값을 바꿀 수 있다
  toss: {
    secretKey: process.env.TOSS_SECRET_KEY ?? '',
    clientKey: process.env.TOSS_CLIENT_KEY ?? '',
    apiBase: process.env.TOSS_API_BASE || 'https://api.tosspayments.com',
  },
};
