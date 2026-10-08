import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUser } from './publicUser.js';

test('publicUser: never returns hashes, codes or tokens', () => {
  const row = {
    id: 'u1', email: 'a@b.c', kyc_status: 'approved', password_hash: 'x', transaction_pin_hash: 'x', pin_code_hash: 'x',
    pin_code_expires: 'x', email_otp: '123456', email_otp_expires: 'x', email_verification_token: 'x', google_id: 'x',
    aadhaar_number: '1234', pin_failures: 2,
  };
  assert.deepEqual(publicUser(row), { id: 'u1', email: 'a@b.c', kyc_status: 'approved', has_pin: true });
  assert.equal(publicUser({ id: 'u2' }).has_pin, false);
});
