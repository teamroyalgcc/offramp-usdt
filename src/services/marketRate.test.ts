import test from 'node:test';
import assert from 'node:assert/strict';
import { median, pickRate, resolveRate, STALE_MS } from './marketRate.js';

test('median ignores junk', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, 0, 5]), 5);
  assert.equal(median([]), null);
});

test('P2P preferred, exchanges fallback, disagreement refused', () => {
  assert.deepEqual(pickRate(104.4, 100.2, 1), { rate: 104.4, source: 'binance_p2p', updatedAt: 1 });
  assert.deepEqual(pickRate(null, 100.2, 1), { rate: 100.2, source: 'exchanges', updatedAt: 1 });
  assert.equal(pickRate(null, null, 1), null);
  assert.throws(() => pickRate(110, 100, 1), /disagree/);
});

test('stale rate refused', () => {
  const last = { rate: 104, source: 'binance_p2p', updatedAt: 0 };
  assert.equal(resolveRate(null, last, STALE_MS).rate, 104);
  assert.throws(() => resolveRate(null, last, STALE_MS + 1), /unavailable/);
  assert.throws(() => resolveRate(null, null, 0), /unavailable/);
});
