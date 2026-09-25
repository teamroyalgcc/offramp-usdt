import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Applies db/schema.sql to an empty in-process Postgres (PGlite) and checks every
// money function: deposits, held credits, sweeps, sell orders, withdrawals.
const SCHEMA = fs.readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');

test('schema.sql money functions', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SCHEMA);
  await db.exec(SCHEMA); // re-runnable

  const one = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0];
  const u = (await one(`insert into users (email) values ('a@b.c') returning id`)).id;
  const acct = () => one(`select available_balance::text a, locked_balance::text l from ledger_accounts where user_id=$1`, [u]);

  // first admin, bcrypt via pgcrypto (bcryptjs-compatible $2a$ hash)
  const admin = await one(`insert into admins (username, password_hash, role) values ('o', crypt('pw', gen_salt('bf', 10)), 'superadmin') returning password_hash`);
  assert.match(admin.password_hash, /^\$2a\$10\$/);

  // deposit address + deposits
  assert.equal(Number((await one(`select next_derivation_index() i`)).i), 0);
  const a = (await one(`insert into deposit_addresses (user_id, tron_address, eoa_address, derivation_index) values ($1,'TGF1','TEOA1',0) returning id`, [u])).id;
  await assert.rejects(db.query(`insert into deposit_addresses (user_id, tron_address, eoa_address, derivation_index) values ($1,'TGF2','TEOA2',1)`, [u]), /duplicate key/);
  const rec = (tx: string, li: number, amt: string) =>
    one(`select record_deposit('tron_mainnet',$1,$2,$3,'TFROM',$4,100,now(),10000000,1500000) r`, [a, tx, li, amt]).then((x) => x.r);
  const r = await rec('tx1', 0, '25000000');
  assert.equal(r.status, 'credited'); assert.equal(Number(r.net), 23.5);
  assert.equal((await rec('tx1', 0, '25000000')).inserted, false);      // duplicate event
  assert.equal((await rec('tx1', 1, '25000000')).status, 'credited');   // second log, same tx
  assert.equal((await rec('tx2', 0, '11000000')).status, 'review');     // net 9.5 < 10
  assert.equal((await rec('tx3', 0, '11500000')).status, 'credited');   // net exactly 10
  assert.deepEqual(await acct(), { a: '57.000000', l: '0.000000' });

  // one open sweep; conditional claim wins once
  assert.equal((await one(`select count(*)::int c from sweeps where deposit_address_id=$1`, [a])).c, 1);
  await db.query(`update sweeps set status='confirmed'`);
  await rec('tx4', 0, '20000000');
  const sid = (await one(`select id from sweeps where status='pending'`)).id;
  const claim = () => db.query(`UPDATE sweeps SET status='submitted' WHERE id=$1 AND status='pending' RETURNING id`, [sid]);
  const [c1, c2] = [await claim(), await claim()];
  assert.equal(c1.rows.length + c2.rows.length, 1);

  // admin "credit anyway": once only, never negative
  const held = (await one(`select id from deposits where status='review'`)).id;
  assert.equal(Number((await one(`select credit_held_deposit($1) r`, [held])).r.credited), 9.5);
  await assert.rejects(db.query(`select credit_held_deposit($1)`, [held]), /not waiting for review/);
  const tiny = await rec('tx5', 0, '1000000');
  assert.equal(Number((await one(`select credit_held_deposit($1) r`, [tiny.deposit_id])).r.credited), 0);
  assert.deepEqual(await acct(), { a: '85.000000', l: '0.000000' }); // 57 + 18.5 + 9.5

  // sell orders: lock -> paid once / refund
  const order = (amt: number) => one(`select create_exchange_order($1,$2,$3,90,null,$4) r`, [u, amt, amt * 90, crypto.randomUUID()]).then((x) => x.r);
  assert.equal((await order(1000)).success, false);
  const o1 = await order(50);
  assert.deepEqual(await acct(), { a: '35.000000', l: '50.000000' });
  await db.query(`select complete_exchange_order($1, true, 'UTR123')`, [o1.order_id]);
  assert.deepEqual(await acct(), { a: '35.000000', l: '0.000000' });
  await assert.rejects(db.query(`select complete_exchange_order($1, false, 'x')`, [o1.order_id]), /already completed/);
  const o2 = await order(35);
  await db.query(`select complete_exchange_order($1, false, 'bank rejected')`, [o2.order_id]);
  assert.deepEqual(await acct(), { a: '35.000000', l: '0.000000' });
  assert.deepEqual(await one(`select status, payout_reference from exchange_orders where id=$1`, [o1.order_id]), { status: 'SUCCESS', payout_reference: 'UTR123' });

  // withdrawals: lock -> finalize / fail
  const w = crypto.randomUUID();
  assert.equal((await one(`select lock_funds($1, 20, $2, 'w') r`, [u, w])).r.success, true);
  assert.deepEqual(await acct(), { a: '15.000000', l: '20.000000' });
  await db.query(`select finalize_withdrawal($1, 20, $2)`, [u, w]);
  assert.deepEqual(await acct(), { a: '15.000000', l: '0.000000' });
  assert.equal((await one(`select lock_funds($1, 100, 'x', 'w') r`, [u])).r.success, false);
  await one(`select lock_funds($1, 10, 'y', 'w') r`, [u]);
  await db.query(`select fail_withdrawal($1, 10, $2)`, [u, crypto.randomUUID()]);
  assert.deepEqual(await acct(), { a: '15.000000', l: '0.000000' });

  // the ledger explains the available balance exactly
  const avail = await one(`select sum(case when direction='credit' then amount else -amount end)::text s from ledger_entries where user_id=$1 and balance_type='available'`, [u]);
  assert.equal(avail.s, '15.000000');

  await db.close();
});
