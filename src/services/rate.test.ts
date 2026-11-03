import test from 'node:test';
import assert from 'node:assert/strict';
import { userRate, NO_RATE_MESSAGE } from './rate.js';

test('user rate: the admin rate as set; none or expired pauses exchanges', () => {
  const now = Date.now(), later = new Date(now + 1000), earlier = new Date(now - 1);
  assert.deepEqual(userRate({ rate: 97, expiresAt: null }, now), { rate: 97, mode: 'manual' });
  assert.deepEqual(userRate({ rate: 120.5, expiresAt: later }, now), { rate: 120.5, mode: 'manual' });
  assert.throws(() => userRate({ rate: 97, expiresAt: earlier }, now), new RegExp(NO_RATE_MESSAGE));
  assert.throws(() => userRate({ rate: 0, expiresAt: null }, now), /No exchange rate/);
  assert.throws(() => userRate(null, now), /No exchange rate/);
});
