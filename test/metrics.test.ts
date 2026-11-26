import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flushEmf, recordRequest } from '../src/metrics';

test('1초 묶음을 EMF 한 줄로: 요청 수 · 5xx 수 · p95를 1초 해상도 지표로 싣고, 다음 초는 0부터 센다', () => {
  for (let ms = 1; ms <= 20; ms++) recordRequest(ms, ms === 7 ? 503 : 200);
  const line = JSON.parse(flushEmf(1_700_000_000_000));

  // CloudWatch가 로그에서 지표를 뽑으려면 _aws 아래 정의가 있어야 한다 (EMF 규격)
  const [definition] = line._aws.CloudWatchMetrics;
  assert.equal(line._aws.Timestamp, 1_700_000_000_000);
  assert.equal(definition.Namespace, 'HotelBooking/App');
  assert.deepEqual(definition.Dimensions, [['Service']]);
  assert.deepEqual(
    definition.Metrics.map((m: { Name: string; StorageResolution: number }) => [m.Name, m.StorageResolution]),
    [['Requests', 1], ['Errors5xx', 1], ['LatencyP95', 1]],
  );
  assert.equal(line.Service, 'app');
  assert.equal(line.Requests, 20);
  assert.equal(line.Errors5xx, 1);
  assert.equal(line.LatencyP95, 19); // 20건 중 95% 위치(19번째)

  // 요청이 없던 초: 0을 남기고(트래픽이 0으로 떨어진 것도 신호), 값이 없는 p95는 빼서 그래프에 가짜 0이 찍히지 않게
  const idle = JSON.parse(flushEmf());
  assert.equal(idle.Requests, 0);
  assert.equal(idle.Errors5xx, 0);
  assert.equal(idle.LatencyP95, undefined);
  assert.deepEqual(
    idle._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name),
    ['Requests', 'Errors5xx'],
  );
});

test('쿠폰 서버처럼 SERVICE_NAME이 있으면 그 이름으로 남긴다 (서비스별로 나눠 보기)', () => {
  process.env.SERVICE_NAME = 'coupon';
  try {
    assert.equal(JSON.parse(flushEmf()).Service, 'coupon');
  } finally {
    delete process.env.SERVICE_NAME;
  }
  assert.equal(JSON.parse(flushEmf()).Service, 'app');
});
