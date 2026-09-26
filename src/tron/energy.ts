import { createHash } from 'node:crypto';

// Energy for sweeps. Providers in order: Netts rental (prepaid, API, IP whitelist),
// TronNRG (paid on-chain from the operating wallet, no account or whitelist), then
// burn (operating wallet sends TRX to the deposit address, which burns it for energy).
// No config import here, so tests can load this file without env vars.

const NETTS = 'https://netts.io/apiv2';
export const NETTS_MIN_ENERGY = 61_000; // /order5m bounds: 61,000..650,000
export const SWEEP_ENERGY_HEADROOM = 1.05;
const SUN = 1_000_000n;

/** Energy to rent for a transfer that the node estimates at `estimate`. */
export const energyToRent = (estimate: number) => Math.max(NETTS_MIN_ENERGY, Math.ceil(estimate * SWEEP_ENERGY_HEADROOM));

/** TRX (sun) the address needs to burn for the missing energy, +1 TRX for bandwidth if the free 600/day is used up. */
export function burnSunNeeded(energyNeeded: number, energyHave: number, feeSunPerEnergy: number): bigint {
  const missing = Math.max(0, Math.ceil(energyNeeded * SWEEP_ENERGY_HEADROOM) - energyHave);
  return BigInt(missing) * BigInt(feeSunPerEnergy) + SUN;
}

/**
 * Sweep timing: at or above `immediateRaw` sweep now, otherwise when the sweep
 * row is 24 h old. Returns the time the sweep becomes due.
 */
export function sweepDueAt(balanceRaw: bigint, immediateRaw: bigint, openedAt: Date): Date {
  return balanceRaw >= immediateRaw ? new Date(0) : new Date(openedAt.getTime() + 24 * 60 * 60_000);
}

export const sunToTrx = (sun: bigint) => Number(sun) / 1e6;

/** Deterministic per sweep + attempt, so a retried request can never be charged twice by Netts. */
export const nettsIdempotencyKey = (sweepId: string, attempt: number) =>
  createHash('sha256').update(`${sweepId}:${attempt}`).digest('hex');

let egressIp: { ip: string; at: number } | null = null;

/** Netts wants a whitelisted IP in X-Real-IP; send the one Render actually leaves from. */
async function currentEgressIp(): Promise<string> {
  if (egressIp && Date.now() - egressIp.at < 5 * 60_000) return egressIp.ip;
  const ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })).text()).trim();
  egressIp = { ip, at: Date.now() };
  return ip;
}

async function netts(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown, idemKey?: string) {
  const res = await fetch(NETTS + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
      'X-Real-IP': await currentEgressIp(),
      ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* error pages are not JSON */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

/**
 * Rents energy for 5 minutes, delegated to `receiver` (Netts activates it if needed).
 * Returns only after delegation. Throws on any failure; 208 (cached duplicate) counts as success.
 */
export async function nettsRent5m(apiKey: string, receiver: string, amount: number, idemKey: string) {
  const r = await netts(apiKey, 'POST', '/order5m', { amount, receiveAddress: receiver }, idemKey);
  const d = r.json?.detail;
  if ((r.status === 200 || r.status === 208) && d?.code === 10000) {
    return { orderId: String(d.data.orderId), paidTrx: Number(d.data.paidTRX) };
  }
  throw new Error(`netts_${r.status}: ${r.text}`);
}

// TronNRG: https://support.tronnrg.com/en/developer-docs/api-reference/
const TRONNRG = 'https://api.tronnrg.com';
export const TRONNRG_PAY_TO = 'TFqUiCu1JwLHHnBNeaaVKH7Csm4aA3YhZx'; // API payment address (not the manual one)
const TRONNRG_ENERGY_PER_TRX = 16_250;

/** Whole TRX to pay TronNRG for `estimate` energy: linear 16,250 energy/TRX, minimum 4 TRX. */
export const tronNrgTrx = (estimate: number) => Math.max(4, Math.ceil(estimate / TRONNRG_ENERGY_PER_TRX));

/**
 * Pays TronNRG from the operating wallet and claims the delegation to `receiver`.
 * `receiver` must already be activated. Throws with `paidTxId` on the error when TRX left
 * the wallet but the claim did not succeed (TronNRG refunds on its own failed delegations).
 */
export async function tronNrgRent(tronWeb: any, operatingKey: string, receiver: string, trx: number) {
  const pay = await tronWeb.trx.sendTransaction(TRONNRG_PAY_TO, trx * 1_000_000, { privateKey: operatingKey });
  if (!pay?.result || !pay.txid) throw new Error(`tronnrg payment rejected: ${pay?.code ?? ''}`);
  const signature = await tronWeb.trx.signMessageV2(`${pay.txid}:${receiver}`, operatingKey);

  let last = '';
  // The payment needs a few seconds to be indexed: 404 payment_verification_failed means retry.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${TRONNRG}/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: pay.txid, delegate_to: receiver, signature }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => ({ status: 0, text: async () => e.message }) as any);
    const text = await res.text();
    if (res.status === 200) {
      const j = JSON.parse(text);
      if (j.status === 'delegated') return { orderId: String(j.ref ?? pay.txid), paidTrx: trx };
    }
    last = `tronnrg_${res.status}: ${text.slice(0, 200)}`;
    if (res.status !== 404 && res.status !== 429 && res.status !== 0) break;
  }
  throw Object.assign(new Error(last), { paidTxId: pay.txid, paidTrx: trx });
}

/** Prepaid Netts balance in TRX. */
export async function nettsBalanceTrx(apiKey: string): Promise<number> {
  const r = await netts(apiKey, 'GET', '/userinfo');
  if (r.status !== 200 || r.json?.status !== 'success') throw new Error(`netts_${r.status}: ${r.text}`);
  return Number(r.json.stats?.balance);
}
