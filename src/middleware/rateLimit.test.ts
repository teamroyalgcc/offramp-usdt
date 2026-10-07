import test from 'node:test';
import assert from 'node:assert/strict';
import { overLimit } from './rateLimit.js';

test('rate limit: max hits per window, per key, resets after the window', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(overLimit('k', 5, 60_000, t0), false);
  assert.equal(overLimit('k', 5, 60_000, t0 + 1), true);
  assert.equal(overLimit('other', 5, 60_000, t0 + 1), false);
  assert.equal(overLimit('k', 5, 60_000, t0 + 60_000), false);
});
