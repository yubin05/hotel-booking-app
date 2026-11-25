import './env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { positiveInt } from '../src/config';

// 서버당 DB 연결 수(DB_POOL_SIZE · DB_COUPON_POOL_SIZE)를 환경 변수로 받는다 (v2 ADR-074 ②)
test('positiveInt: 없으면 기본값, 1 이상의 정수만 받고 그 밖은 시작 때 멈춘다', () => {
  delete process.env.TEST_POOL;
  assert.equal(positiveInt('TEST_POOL', 10), 10);
  process.env.TEST_POOL = '';
  assert.equal(positiveInt('TEST_POOL', 10), 10);
  process.env.TEST_POOL = '5';
  assert.equal(positiveInt('TEST_POOL', 10), 5);
  for (const bad of ['0', '-1', '2.5', 'abc']) {
    process.env.TEST_POOL = bad;
    assert.throws(() => positiveInt('TEST_POOL', 10), /1 이상의 정수/);
  }
  delete process.env.TEST_POOL;
});
