import { listen } from './app';
import { config } from './config';
import { couponPool, pool } from './db';
import { loadServedBy } from './served-by';

void loadServedBy();

const server = listen(config.port);
server.once('listening', () => console.log(`listening on ${config.port}`));

// ECS는 태스크를 멈출 때 SIGTERM을 보낸다. 처리 중인 요청을 마치고 끝내 배포 중 에러를 줄인다
// 두 로그의 시각 차이가 "종료 신호 → 연결 정리"에 걸린 시간 (배포 때 약 30초 걸린 원인 확인, 인프라 03 CD 실측)
process.on('SIGTERM', () => {
  console.log('SIGTERM 받음: 새 연결을 받지 않고 처리 중인 요청을 마침');
  server.close(() => {
    console.log('연결 모두 닫힘: DB 연결 정리 후 종료');
    void Promise.all([pool.end(), couponPool.end()]).then(() => process.exit(0));
  });
});
