import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { TronWeb } from 'tronweb';
import { TronChain } from '../tron/chain.js';

const SCHEMA = fs.readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ADDR = 'TWPt2tyjuCgDM882QWDRCoBCRzY7Qh6A1M';

// The worker reads config at import time; give it a test env, then run its SQL on PGlite.
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'x', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'x' });
const { default: pool } = await import('../utils/db.js');
const { default: wsService } = await import('../services/wsService.js');
const { DepositWorker } = await import('./depositWorker.js');
wsService.sendToUser = () => {};
wsService.pushDashboardUpdate = async () => {};

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(SCHEMA);
(pool as any).query = (text: string, params?: unknown[]) => db.query(text, params as any[]);
const one = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0];

test('TronChain drops 0-USDT transfer logs (address poisoning)', async () => {
  const h20 = (a: string) => TronWeb.address.toHex(a).slice(2);
  const topic = (a: string) => '0'.repeat(24) + h20(a);
  const log = (amount: bigint) => ({
    address: h20(USDT),
    topics: ['ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(USDT), topic(ADDR)],
    data: amount.toString(16).padStart(64, '0'),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: 'tx', blockNumber: 1, blockTimeStamp: 0, receipt: { result: 'SUCCESS' }, log: [log(0n), log(5_000_000n)],
  }))) as any;
  try {
    const out = await new TronChain({ fullNode: 'http://x', solidityNode: 'http://x' }).solidTransfersTo('tx', USDT, ADDR);
    assert.deepEqual(out.map((t) => [t.logIndex, t.amountRaw]), [[1, 5_000_000n]]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a log that fails to record does not block other deposits; the poll retries it', async () => {
  const u = (await one(`insert into users (email) values ('a@b.c') returning id`)).id;
  const a = (await one(
    `insert into deposit_addresses (user_id, tron_address, eoa_address, derivation_index) values ($1,$2,$2,0) returning id, tron_address, created_at`,
    [u, ADDR],
  ));
  const w = new DepositWorker() as any;
  const transfer = (txId: string, amountRaw: bigint) => ({ txId, logIndex: 0, from: 'TFROM', to: ADDR, amountRaw, blockNumber: 1, blockTs: new Date() });
  w.chain = {
    incomingTxIds: async () => ['bad', 'good'],
    solidTransfersTo: async (txId: string) => [transfer(txId, txId === 'bad' ? 0n : 20_000_000n)], // 0 violates amount_raw > 0
  };
  await assert.rejects(w.pollAddress({ ...a, last_polled_at: null, hot_until: null }), /amount_raw|check/i);
  assert.equal((await one(`select count(*)::int n from deposits where tx_id = 'good'`)).n, 1);
  assert.equal((await one(`select last_polled_at from deposit_addresses where id = $1`, [a.id])).last_polled_at, null);
});

test('daily audit: an address that cannot be read is reported, a failing run waits an hour', async () => {
  const w = new DepositWorker() as any;
  w.chain = { usdtBalance: async () => { throw new Error('TronGrid HTTP 429'); } };
  const report = await w.runAudit('manual');
  assert.equal(report.issues[0].kind, 'check_failed');

  let runs = 0;
  w.runAudit = async () => { runs++; throw new Error('boom'); };
  await assert.rejects(w.dailyAudit(), /boom/);
  await w.dailyAudit(); // next tick: skipped, not re-run every 5 s
  assert.equal(runs, 1);
});
