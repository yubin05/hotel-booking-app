// 이 파일을 helpers보다 먼저 import한 테스트는 쿠폰 번호표(Valkey) 경로로 돈다. CI는 Valkey 컨테이너(ci.yml), 로컬은 6379에 Valkey가 있어야 함
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
