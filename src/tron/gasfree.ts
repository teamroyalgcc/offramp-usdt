import { createHmac, randomUUID } from 'node:crypto';
import { utils } from 'tronweb';

// GasFree (TIP-712 permit transfers) client. Spec: https://docs.gasfree.io/ and
// github.com/gasfreeio/gasfree-sdk-js. Domain constants are pinned per network,
// never taken from provider responses.
export const GASFREE_NETWORKS = {
  mainnet: {
    baseUrl: 'https://open.gasfree.io',
    prefix: '/tron',
    chainId: 728126428,
    controller: 'TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U',
  },
  testnet: {
    baseUrl: 'https://open-test.gasfree.io',
    prefix: '/nile',
    chainId: 3448148188,
    controller: 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc',
  },
} as const;

export type GasFreeNetwork = keyof typeof GASFREE_NETWORKS;

export const PERMIT_TYPES = {
  PermitTransfer: [
    { name: 'token', type: 'address' },
    { name: 'serviceProvider', type: 'address' },
    { name: 'user', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export interface Permit {
  token: string;
  serviceProvider: string;
  user: string; // the EOA, not the GasFree address
  receiver: string;
  value: bigint;
  maxFee: bigint;
  deadline: number; // unix seconds
  version: 1;
  nonce: number;
}

export interface GasFreeAccount {
  accountAddress: string;
  gasFreeAddress: string;
  active: boolean;
  nonce: number;
  allowSubmit: boolean;
  activateFee: bigint;
  transferFee: bigint;
  frozen: bigint;
}

export interface GasFreeTransfer {
  id: string;
  state: 'WAITING' | 'INPROGRESS' | 'CONFIRMING' | 'SUCCEED' | 'FAILED';
  txnState?: 'INIT' | 'NOT_ON_CHAIN' | 'ON_CHAIN' | 'SOLIDITY' | 'ON_CHAIN_FAILED';
  txnHash?: string;
  txnTotalFee?: number | string;
  amount?: number | string;
  nonce?: number;
  [k: string]: unknown;
}

/** Provider answered with a definite rejection (code != 200). Safe to act on. */
// Processing fee charged on a deposit: what GasFree will charge to sweep it, plus our margin.
// The one-time activation fee is paid by the address's first sweep, so only the first
// credited deposit of an address carries it.
export function depositFee(acct: Pick<GasFreeAccount, 'active' | 'activateFee' | 'transferFee'>, firstDeposit: boolean, marginRaw: bigint): bigint {
  return acct.transferFee + (!acct.active && firstDeposit ? acct.activateFee : 0n) + marginRaw;
}

export class GasFreeRejected extends Error {
  constructor(public reason: string, message: string, public data?: unknown) {
    super(`${reason}: ${message}`);
  }
}

export function permitDomain(network: GasFreeNetwork) {
  const n = GASFREE_NETWORKS[network];
  return { name: 'GasFreeController', version: 'V1.0.0', chainId: n.chainId, verifyingContract: n.controller };
}

function permitMessage(p: Permit) {
  return { ...p, value: p.value.toString(), maxFee: p.maxFee.toString() };
}

/** Returns signature hex without 0x (r || s || v), as the submit API expects. */
export function signPermit(network: GasFreeNetwork, permit: Permit, privateKey: string): string {
  return utils.typedData.signTypedData(permitDomain(network), PERMIT_TYPES, permitMessage(permit), privateKey).replace(/^0x/, '');
}

/** Recovers the TRON base58 signer; used by tests and as a pre-submit self-check. */
export function recoverPermitSigner(network: GasFreeNetwork, permit: Permit, sig: string): string {
  const hexAddr = utils.typedData.verifyTypedData(permitDomain(network), PERMIT_TYPES, permitMessage(permit), '0x' + sig);
  return utils.address.fromHex('41' + hexAddr.slice(2));
}

/** Header value for a request; exported for tests. String to sign = METHOD + prefix + path + ts. */
export function authHeaders(apiKey: string, apiSecret: string, method: string, prefixedPath: string, ts: number) {
  const sig = createHmac('sha256', apiSecret).update(method + prefixedPath + ts).digest('base64');
  return { Timestamp: String(ts), Authorization: `ApiKey ${apiKey}:${sig}` };
}

export class GasFreeClient {
  constructor(
    private network: GasFreeNetwork,
    private apiKey: string,
    private apiSecret: string,
    private timeoutMs = 10_000,
  ) {
    if (!apiKey || !apiSecret) throw new Error('GASFREE_API_KEY / GASFREE_API_SECRET not configured');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { baseUrl, prefix } = GASFREE_NETWORKS[this.network];
    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders(this.apiKey, this.apiSecret, method, prefix + path, Math.floor(Date.now() / 1000)),
    };
    const res = await fetch(baseUrl + prefix + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // 429/5xx are transient: throw a plain Error so callers treat them as ambiguous/retryable.
    if (res.status === 429 || res.status >= 500) throw new Error(`GasFree HTTP ${res.status}`);
    const json: any = await res.json();
    if (json.code !== 200) {
      throw new GasFreeRejected(json.reason ?? `HTTP_${res.status}`, json.message ?? 'rejected', json.data);
    }
    return json.data as T;
  }

  async getToken(tokenAddress: string) {
    const data = await this.call<{ tokens: any[] }>('GET', '/api/v1/config/token/all');
    return data.tokens.find((t) => t.tokenAddress === tokenAddress && t.supported !== false);
  }

  async getProviders() {
    const data = await this.call<{ providers: any[] }>('GET', '/api/v1/config/provider/all');
    return data.providers as {
      address: string;
      config: { minDeadlineDuration: number; maxDeadlineDuration: number; defaultDeadlineDuration: number };
    }[];
  }

  async getAccount(eoa: string, tokenAddress: string): Promise<GasFreeAccount> {
    const d = await this.call<any>('GET', `/api/v1/address/${eoa}`);
    const asset = (d.assets ?? []).find((a: any) => a.tokenAddress === tokenAddress) ?? {};
    return {
      accountAddress: d.accountAddress,
      gasFreeAddress: d.gasFreeAddress,
      active: Boolean(d.active),
      nonce: Number(d.nonce),
      // docs example spells it allow_submit; field list says allowSubmit
      allowSubmit: Boolean(d.allowSubmit ?? d.allow_submit),
      activateFee: BigInt(asset.activateFee ?? 0),
      transferFee: BigInt(asset.transferFee ?? 0),
      frozen: BigInt(asset.frozen ?? 0),
    };
  }

  async submit(permit: Permit, sig: string): Promise<GasFreeTransfer> {
    return this.call<GasFreeTransfer>('POST', '/api/v1/gasfree/submit', {
      requestId: randomUUID(),
      ...permitMessage(permit),
      sig,
    });
  }

  async getTransfer(traceId: string): Promise<GasFreeTransfer> {
    return this.call<GasFreeTransfer>('GET', `/api/v1/gasfree/${traceId}`);
  }
}
