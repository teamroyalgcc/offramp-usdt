import test from 'node:test';
import assert from 'node:assert/strict';
import { requireKyc } from './requireKyc.js';

test('requireKyc: only approved KYC passes', () => {
  for (const kycStatus of ['approved', 'pending', 'rejected', 'not_submitted', undefined]) {
    let status = 0, passed = false;
    const res: any = { status: (s: number) => { status = s; return res; }, json: () => res };
    requireKyc({ user: { id: 'u', kycStatus } } as any, res, () => { passed = true; });
    assert.equal(passed, kycStatus === 'approved', String(kycStatus));
    assert.equal(status, kycStatus === 'approved' ? 0 : 403);
  }
});
