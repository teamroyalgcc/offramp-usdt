import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptGooglePayload, googleAudiences, verifyGoogleToken } from './google.js';

test('google sign-in: fails closed without client IDs, requires verified email', async () => {
  assert.deepEqual(googleAudiences(undefined), []);
  assert.deepEqual(googleAudiences(' web.apps , android.apps ,'), ['web.apps', 'android.apps']);

  delete process.env.GOOGLE_CLIENT_ID;
  await assert.rejects(verifyGoogleToken('any.token.here'), /not configured/);

  const base = { iss: 'accounts.google.com', aud: 'x', iat: 0, exp: 0, sub: '1', email: 'a@b.c' };
  assert.equal(acceptGooglePayload(undefined), null);
  assert.equal(acceptGooglePayload(base), null);                                // email_verified missing
  assert.equal(acceptGooglePayload({ ...base, email_verified: false }), null);
  assert.equal(acceptGooglePayload({ ...base, email: undefined, email_verified: true }), null);
  assert.ok(acceptGooglePayload({ ...base, email_verified: true }));
});
