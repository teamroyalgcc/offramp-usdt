import test from 'node:test';
import assert from 'node:assert/strict';
import { TronWeb } from 'tronweb';
import { formatUsdt, parseUsdt } from './usdt.js';
import { accountXpub, deriveAddressFromXpub, derivePrivateKey } from './hd.js';
import { burnSunNeeded, energyToRent, nettsIdempotencyKey, sweepDueAt, tronNrgTrx } from './energy.js';

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

test('sweep timing: >= threshold now, below it 24 h after the sweep opened', () => {
  const opened = new Date('2026-09-26T00:00:00Z');
  const t100 = 100_000_000n;
  assert.equal(sweepDueAt(t100, t100, opened).getTime(), 0);
  assert.equal(sweepDueAt(250_000_000n, t100, opened).getTime(), 0);
  assert.equal(sweepDueAt(t100 - 1n, t100, opened).toISOString(), '2026-09-27T00:00:00.000Z');
});

test('energy amounts: rent estimate + 5%, never below the Netts minimum', () => {
  assert.equal(energyToRent(64_285), 67_500); // ceil(64285 * 1.05)
  assert.equal(energyToRent(130_285), 136_800);
  assert.equal(energyToRent(30_000), 61_000);
});

test('burn fallback: TRX for the missing energy at the live price, plus 1 TRX for bandwidth', () => {
  assert.equal(burnSunNeeded(64_285, 0, 100), 67_500n * 100n + 1_000_000n); // 7.75 TRX
  assert.equal(burnSunNeeded(64_285, 67_500, 100), 1_000_000n);             // energy already there
  assert.equal(burnSunNeeded(64_285, 70_000, 100), 1_000_000n);
});

test('Netts idempotency key: 64 hex, stable per sweep + attempt, new per attempt', () => {
  const k = nettsIdempotencyKey('sweep-1', 0);
  assert.match(k, /^[a-f0-9]{64}$/);
  assert.equal(k, nettsIdempotencyKey('sweep-1', 0));
  assert.notEqual(k, nettsIdempotencyKey('sweep-1', 1));
});

test('TronNRG price: 16,250 energy per whole TRX, minimum 4 TRX', () => {
  assert.equal(tronNrgTrx(64_285), 4);   // treasury already holds USDT
  assert.equal(tronNrgTrx(65_001), 5);
  assert.equal(tronNrgTrx(130_285), 9);  // empty treasury
  assert.equal(tronNrgTrx(10_000), 4);
});
