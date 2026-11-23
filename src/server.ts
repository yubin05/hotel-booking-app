import { listen } from './app';
import { purgeOldSessions } from './auth';
import { config } from './config';
import { couponPool, pool } from './db';
import { flushEmf } from './metrics';
import { expirePendingPayments } from './payments';
import { loadServedBy } from './served-by';

void loadServedBy();

const server = listen(config.port);
server.once('listening', () => console.log(`listening on ${config.port}`));

// 10분이 지난 결제 대기 예약을 1분마다 취소한다 (데모 결제, APP-001). 실패해도 다음 분에 다시 하므로 로그만 남김
const expiryTimer = setInterval(() => {
  expirePendingPayments().then(
    (n) => n > 0 && console.log(`결제 대기 만료로 예약 ${n}건 취소`),
    (err) => console.error('결제 대기 만료 정리 실패:', err instanceof Error ? err.message : err),
  );
}, 60_000);

// 90일 지난 로그인 기록을 1시간마다 지운다 (인프라 ADR-072). 배포로 태스크가 자주 바뀌어도 돌도록 하루가 아닌 1시간
const sessionPurgeTimer = setInterval(() => {
  purgeOldSessions().then(
    (n) => n > 0 && console.log(`90일 지난 로그인 기록 ${n}건 삭제`),
    (err) => console.error('로그인 기록 정리 실패:', err instanceof Error ? err.message : err),
  );
}, 3_600_000);

// 관제 화면용 1초 지표를 1초마다 EMF 한 줄로 남긴다 (ADR-061, METRICS_EMF=1일 때만)
const metricsTimer = process.env.METRICS_EMF === '1' ? setInterval(() => console.log(flushEmf()), 1000) : undefined;

// ECS는 태스크를 멈출 때 SIGTERM을 보낸다. 처리 중인 요청을 마치고 끝내 배포 중 에러를 줄인다
// 두 로그의 시각 차이가 "종료 신호 → 연결 정리"에 걸린 시간 (배포 때 약 30초 걸린 원인 확인, 인프라 03 CD 실측)
process.on('SIGTERM', () => {
  console.log('SIGTERM 받음: 새 연결을 받지 않고 처리 중인 요청을 마침');
  clearInterval(expiryTimer);
  clearInterval(sessionPurgeTimer);
  clearInterval(metricsTimer);
  server.close(() => {
    console.log('연결 모두 닫힘: DB 연결 정리 후 종료');
    void Promise.all([pool.end(), couponPool.end()]).then(() => process.exit(0));
  });
});
