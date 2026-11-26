import Redis, { type Cluster } from 'ioredis';
import { config } from './config';

// 쿠폰 수량 번호표(Valkey, 인프라 ADR-080). 3,000명 쏠림에서 떨어질 사람이 당첨자 발급(쿠폰 행 하나를 한 명씩)이 끝나길
// 기다리다 3초 상한(503)에 걸렸다(v2 migration.md 회차 8). 번호표로 도착하자마자 당첨 · 탈락을 가른다
type Client = Redis | Cluster;
let client: Client | null | undefined;

// 주소가 없으면 null(쓰지 않음). 명령이 0.5초 안에 안 끝나면 실패로 보고 부르는 쪽이 DB 경로로 간다
export function couponRedis(): Client | null {
  if (client !== undefined) return client;
  if (!config.redisUrl) return (client = null);
  const url = new URL(config.redisUrl);
  const options = { commandTimeout: 500, maxRetriesPerRequest: 1 };
  client =
    url.protocol === 'rediss:'
      ? // ElastiCache Serverless: 항상 클러스터 모드 · TLS 필수(AWS 문서). 주소를 IP로 바꾸지 않아야 TLS 인증서 이름이 맞음
        new Redis.Cluster([{ host: url.hostname, port: Number(url.port) || 6379 }], {
          dnsLookup: (address, callback) => callback(null, address),
          redisOptions: { tls: {}, ...options },
        })
      : new Redis(config.redisUrl, options);
  client.on('error', (err: Error) => console.error('Valkey 연결 오류', err.message));
  return client;
}

// 테스트가 끝날 때 연결을 닫음(열린 연결이 남으면 테스트 프로세스가 안 끝남)
export async function closeCouponRedis(): Promise<void> {
  if (client) await client.quit();
  client = undefined;
}

// 키 하나만 쓰는 스크립트라 클러스터에서도 한 번에(원자적) 실행된다. {} 안이 같은 칸(slot)을 정함
const key = (couponId: string) => `coupon:{${couponId}}:tickets`;

// 번호표 받기: 키가 없으면(이벤트 첫 요청 · 캐시가 비었을 때) DB 발급 수로 시작해 1 올린다. 번호 <= 수량이면 당첨
const TAKE = `if redis.call('exists', KEYS[1]) == 0 then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]) end
return redis.call('incr', KEYS[1])`;

export async function takeTicket(redis: Client, couponId: string, issuedInDb: number, ttlSec: number): Promise<number> {
  return Number(await redis.eval(TAKE, 1, key(couponId), issuedInDb, Math.max(60, Math.floor(ttlSec))));
}

// 당첨됐는데 DB에 못 넣었을 때(같은 사람 두 번 · 오류) 번호표를 돌려줘 다음 사람이 받게 한다
export async function returnTicket(redis: Client, couponId: string): Promise<void> {
  await redis.decr(key(couponId));
}
