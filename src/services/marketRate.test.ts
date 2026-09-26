import test from 'node:test';
import assert from 'node:assert/strict';
import { median, pickRate, resolveRate, STALE_MS, userRate } from './marketRate.js';

test('median ignores junk', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, 0, 5]), 5);
  assert.equal(median([]), null);
});

const src = (b: number | null, o: number | null, c: number | null, w: number | null) =>
  ({ binance_p2p: b, okx_p2p: o, coindcx: c, wazirx: w });

test('market = lowest live source; missing sources skipped; far-apart sources refused', () => {
  const m = pickRate(src(103.3, 98.7, 100.2, 100.0), 1)!;
  assert.equal(m.rate, 98.7); assert.equal(m.source, 'okx_p2p');
  assert.equal(pickRate(src(103.3, null, 100.2, null), 1)!.source, 'coindcx');
  assert.equal(pickRate(src(null, null, null, null), 1), null);
  assert.throws(() => pickRate(src(110, 98, null, null), 1), /disagree/); // 12% apart
});

test('user rate: live = market - spread; manual override capped at market, used alone if live is down, expires', () => {
  const m = pickRate(src(103.3, 98.7, 100.2, 100.0), 0)!;
  const now = Date.now(), later = new Date(now + 1000), earlier = new Date(now - 1);
  assert.equal(userRate(m, 1.5, null, now).rate.toFixed(2), '97.22');
  assert.deepEqual(userRate(m, 1.5, { rate: 97, expiresAt: later }, now), { rate: 97, mode: 'manual' });
  assert.equal(userRate(m, 1.5, { rate: 120, expiresAt: later }, now).rate, 98.7);   // never above market
  assert.equal(userRate(null, 1.5, { rate: 97, expiresAt: later }, now).rate, 97);   // live down
  assert.equal(userRate(m, 1.5, { rate: 97, expiresAt: earlier }, now).mode, 'live'); // expired
  assert.throws(() => userRate(null, 1.5, { rate: 97, expiresAt: earlier }, now), /unavailable/);
});

test('stale rate refused', () => {
  const last = { rate: 104, source: 'binance_p2p' as const, sources: src(104, null, null, null), updatedAt: 0 };
  assert.equal(resolveRate(null, last, STALE_MS).rate, 104);
  assert.throws(() => resolveRate(null, last, STALE_MS + 1), /unavailable/);
  assert.throws(() => resolveRate(null, null, 0), /unavailable/);
});
