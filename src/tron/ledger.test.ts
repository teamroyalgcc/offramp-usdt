import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Applies db/schema.sql to an empty in-process Postgres (PGlite) and checks every
// money function: deposits (no fee), held credits, sweeps, sell orders, withdrawals.
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
    one(`select record_deposit('tron_mainnet',$1,$2,$3,'TFROM',$4,100,now(),10000000) r`, [a, tx, li, amt]).then((x) => x.r);
  const r = await rec('tx1', 0, '25000000');
  assert.equal(r.status, 'credited'); assert.equal(Number(r.amount), 25);   // full amount, no fee
  assert.equal((await rec('tx1', 0, '25000000')).inserted, false);      // duplicate event
  assert.equal((await rec('tx1', 1, '25000000')).status, 'credited');   // second log, same tx
  assert.equal((await rec('tx2', 0, '9500000')).status, 'review');      // 9.5 < 10
  assert.equal((await rec('tx3', 0, '10000000')).status, 'credited');   // exactly 10
  assert.deepEqual(await acct(), { a: '60.000000', l: '0.000000' });

  // one open sweep; a new deposit wakes a deferred (pending) sweep; conditional claim wins once
  assert.equal((await one(`select count(*)::int c from sweeps where deposit_address_id=$1`, [a])).c, 1);
  await db.query(`update sweeps set next_attempt_at = now() + interval '20 hours'`);
  await rec('tx3b', 0, '10000000');
  assert.equal((await one(`select next_attempt_at <= now() due from sweeps`)).due, true);
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
  assert.deepEqual(await acct(), { a: '99.500000', l: '0.000000' }); // 60 + 10 + 20 + 9.5

  // sell orders: lock -> paid once / refund
  const bank = async (user: string) => (await one(`insert into bank_accounts (user_id, account_holder_name, account_number, ifsc_code) values ($1,'A','1','IFSC0000001') returning id`, [user])).id;
  const myBank = await bank(u);
  const order = (amt: number, b: string | null = myBank) => one(`select create_exchange_order($1,$2,$3,90,$4,$5) r`, [u, amt, amt * 90, b, crypto.randomUUID()]).then((x) => x.r);
  assert.equal((await order(1000)).success, false);
  // the payout bank must be the user's own and not deleted
  const other = (await one(`insert into users (email) values ('x@y.z') returning id`)).id;
  assert.deepEqual(await order(1, await bank(other)), { success: false, message: 'Bank account not found' });
  const deleted = await bank(u);
  await db.query(`update bank_accounts set deleted_at = now() where id = $1`, [deleted]);
  assert.equal((await order(1, deleted)).message, 'Bank account not found');
  assert.equal((await order(1, null)).message, 'Bank account not found');
  await one(`select lock_funds($1, 14.5, 'trim', 'w') r`, [u]); // bring available to 85 for the checks below
  await db.query(`select finalize_withdrawal($1, 14.5, $2)`, [u, crypto.randomUUID()]);
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

  // sell orders: same idempotency key returns the first order; minimum, pause flag, daily limits (IST day)
  await one(`select record_deposit('tron_mainnet',$1,'tx9',0,'TFROM','85000000',101,now(),10000000) r`, [a]);
  assert.deepEqual(await acct(), { a: '100.000000', l: '0.000000' });
  const keyed = (amt: number, key: string) => one(`select create_exchange_order($1,$2,$3,90,$4,$5) r`, [u, amt, amt * 90, myBank, key]).then((x) => x.r);
  const k1 = await keyed(10, 'k1');
  assert.deepEqual(await keyed(10, 'k1'), { success: true, order_id: k1.order_id, duplicate: true });
  assert.deepEqual(await acct(), { a: '90.000000', l: '10.000000' });
  await db.query(`select complete_exchange_order($1, false, 'r')`, [k1.order_id]);
  assert.match((await order(9)).message, /Minimum sell is 10/);
  await db.query(`update system_settings set daily_exchange_usdt = 100`); // today: 50 paid; refunded orders don't count
  assert.match((await order(50.000001)).message, /Daily sell limit is 100/);
  await db.query(`update system_settings set daily_exchange_usdt = 10000, daily_withdrawal_inr = 8000`);  // INR today: 4500
  assert.match((await order(40)).message, /Daily payout limit is 8000 INR/);
  await db.query(`update exchange_orders set created_at = date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' - interval '1 second'`);
  const yesterday = await order(10);                                                   // yesterday (IST) doesn't count
  assert.equal(yesterday.success, true);
  await db.query(`select complete_exchange_order($1, false, 'r')`, [yesterday.order_id]);
  await db.query(`update system_settings set exchanges_enabled = false`);
  assert.equal((await order(10)).message, 'Sells are paused');
  await db.query(`update system_settings set exchanges_enabled = true, daily_withdrawal_inr = 500000`);

  // USDT withdrawals: one transaction (limits + lock + insert); complete/reject exactly once
  const wd = (amt: string, key: string) => one(`select request_withdrawal($1,$2,'TDEST',$3) r`, [u, amt, key]).then((x) => x.r);
  assert.match((await wd('19.999999', 'w0')).message, /Minimum withdrawal amount is 20/);
  assert.equal((await wd('200', 'w0')).message, 'Insufficient balance');
  assert.equal((await one(`select count(*)::int c from usdt_withdrawals`)).c, 0);      // nothing written on failure
  const w1 = await wd('30', 'w1');
  assert.deepEqual([w1.success, w1.withdrawal.fee, w1.withdrawal.net_amount], [true, 5, 25]);
  assert.equal((await wd('30', 'w1')).duplicate, true);                                // retry: same withdrawal, locked once
  assert.deepEqual(await acct(), { a: '70.000000', l: '30.000000' });
  await db.query(`update system_settings set daily_withdrawal_usdt = 50`);
  assert.match((await wd('21', 'w2')).message, /Daily USDT withdrawal limit is 50/);
  await db.query(`update system_settings set daily_withdrawal_usdt = 50000, withdrawals_enabled = false`);
  assert.match((await wd('20', 'w2')).message, /paused/);
  await db.query(`update system_settings set withdrawals_enabled = true`);
  await db.query(`select complete_withdrawal($1, 'hash1')`, [w1.withdrawal.id]);
  await assert.rejects(db.query(`select complete_withdrawal($1, 'hash2')`, [w1.withdrawal.id]), /already completed/);
  await assert.rejects(db.query(`select reject_withdrawal($1, 'x')`, [w1.withdrawal.id]), /already completed/);
  assert.deepEqual(await acct(), { a: '70.000000', l: '0.000000' });
  const w2 = await wd('20', 'w2');
  await db.query(`select reject_withdrawal($1, 'bad address')`, [w2.withdrawal.id]);
  await assert.rejects(db.query(`select reject_withdrawal($1, 'again')`, [w2.withdrawal.id]), /already completed/);
  assert.deepEqual(await acct(), { a: '70.000000', l: '0.000000' });
  assert.deepEqual(await one(`select status, failure_reason from usdt_withdrawals where id=$1`, [w2.withdrawal.id]), { status: 'failed', failure_reason: 'bad address' });

  // the ledger explains the available balance exactly
  const avail = await one(`select sum(case when direction='credit' then amount else -amount end)::text s from ledger_entries where user_id=$1 and balance_type='available'`, [u]);
  assert.equal(avail.s, '70.000000');

  await db.close();
});
