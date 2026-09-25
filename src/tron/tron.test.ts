import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { TronWeb } from 'tronweb';
import { formatUsdt, parseUsdt } from './usdt.js';
import { accountXpub, deriveAddressFromXpub, derivePrivateKey } from './hd.js';
import { authHeaders, Permit, recoverPermitSigner, signPermit } from './gasfree.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('usdt amounts are exact', () => {
  assert.equal(parseUsdt('10'), 10_000_000n);
  assert.equal(parseUsdt('0.000001'), 1n);
  assert.equal(parseUsdt('12.5'), 12_500_000n);
  assert.equal(formatUsdt(12_500_000n), '12.5');
  assert.equal(formatUsdt(-1n), '-0.000001');
  assert.equal(formatUsdt(parseUsdt('123456789.123456')), '123456789.123456');
  for (const bad of ['1.0000001', '-1', '1e3', '', 'abc', '0x10']) assert.throws(() => parseUsdt(bad));
});

test('xpub derivation matches seed derivation and tronweb', () => {
  const xpub = accountXpub(PHRASE);
  for (const i of [0, 1, 7, 1000]) {
    const fromXpub = deriveAddressFromXpub(xpub, i);
    const tw = TronWeb.fromMnemonic(PHRASE, `m/44'/195'/0'/0/${i}`);
    assert.equal(fromXpub, tw.address, `index ${i}`);
    assert.equal(derivePrivateKey(PHRASE, i, fromXpub), tw.privateKey.replace(/^0x/, ''));
  }
});

test('derivePrivateKey refuses a mismatched EOA', () => {
  const other = deriveAddressFromXpub(accountXpub(PHRASE), 1);
  assert.throws(() => derivePrivateKey(PHRASE, 0, other), /does not match/);
});

test('xpub must be account level', () => {
  const tooDeep = TronWeb.fromMnemonic(PHRASE); // not an xpub at all
  assert.throws(() => deriveAddressFromXpub(tooDeep.publicKey, 0));
});

test('TIP-712 permit signature recovers the EOA on its own network only', () => {
  const eoa = deriveAddressFromXpub(accountXpub(PHRASE), 0);
  const pk = derivePrivateKey(PHRASE, 0, eoa);
  const permit: Permit = {
    token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E',
    user: eoa,
    receiver: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
    value: 98_000_000n,
    maxFee: 2_000_000n,
    deadline: 1_900_000_000,
    version: 1,
    nonce: 0,
  };
  const sig = signPermit('mainnet', permit, pk);
  assert.match(sig, /^[0-9a-f]{130}$/);
  assert.equal(recoverPermitSigner('mainnet', permit, sig), eoa);
  assert.notEqual(recoverPermitSigner('testnet', permit, sig), eoa);
  assert.notEqual(recoverPermitSigner('mainnet', { ...permit, value: permit.value + 1n }, sig), eoa);
});

test('GasFree auth header signs METHOD + prefixed path + timestamp', () => {
  const h = authHeaders('key', 'secret', 'GET', '/tron/api/v1/address/TXXX', 1731912286);
  const expected = createHmac('sha256', 'secret').update('GET/tron/api/v1/address/TXXX1731912286').digest('base64');
  assert.deepEqual(h, { Timestamp: '1731912286', Authorization: `ApiKey key:${expected}` });
});
