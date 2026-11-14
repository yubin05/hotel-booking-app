import awsCaBundle from 'aws-ssl-profiles';

// DB_TLS=rds: RDS 인증서 묶음으로 서버 인증서와 주소(호스트 이름)까지 확인하는 TLS 접속 (인프라 ADR-045)
// mysql2는 verifyIdentity를 주지 않으면 호스트 이름을 확인하지 않는다. 로컬 · CI MySQL은 RDS 인증서가 없어 끈다
export const dbTls = process.env.DB_TLS === 'rds' ? { ca: awsCaBundle.ca, verifyIdentity: true } : undefined;
