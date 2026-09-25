import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPin, hashPin, isValidPin, MAX_PIN_FAILURES } from './pin.js';

test('transaction PIN: required, wrong refused, lockout', async () => {
  const hash = await hashPin('123456');
  assert.equal(isValidPin('12345'), false);
  assert.equal(isValidPin('12345a'), false);
  assert.match((await checkPin('u1', '123456', null))!, /Set a transaction PIN/);   // no PIN set
  assert.match((await checkPin('u1', undefined, hash))!, /6-digit/);                // PIN missing
  assert.equal(await checkPin('u1', '123456', hash), null);                         // correct

  for (let i = 1; i < MAX_PIN_FAILURES; i++) assert.match((await checkPin('u1', '000000', hash))!, /Wrong PIN/);
  assert.match((await checkPin('u1', '000000', hash))!, /locked for 15 minutes/);
  assert.match((await checkPin('u1', '123456', hash))!, /Too many wrong PIN/);      // even the right PIN waits
  assert.equal(await checkPin('u2', '123456', hash), null);                         // other users unaffected
});
