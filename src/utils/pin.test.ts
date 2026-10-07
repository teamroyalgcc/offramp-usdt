import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { checkPin, hashPin, isValidPin, MAX_PIN_FAILURES, PIN_LOCK_MINUTES, PinCounter } from './pin.js';

const SCHEMA = fs.readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');

test('transaction PIN: DB counter, parallel guesses, lock survives restart', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SCHEMA);
  const counter: PinCounter = {   // same SQL functions the backend calls through supabase.rpc
    begin: async (id) => (await db.query<any>(`select begin_pin_attempt($1) n`, [id])).rows[0]?.n ?? 0,
    end: async (id, ok) => { await db.query(`select end_pin_attempt($1,$2,$3,$4)`, [id, ok, MAX_PIN_FAILURES, PIN_LOCK_MINUTES]); },
  };
  const user = async (email: string) => (await db.query<any>(`insert into users (email) values ($1) returning id`, [email])).rows[0].id;
  const u1 = await user('a@b.c'), u2 = await user('d@e.f'), u3 = await user('g@h.i');
  const hash = await hashPin('123456');

  assert.equal(isValidPin('12345'), false);
  assert.equal(isValidPin('12345a'), false);
  assert.match((await checkPin(counter, u1, '123456', null))!, /Set a transaction PIN/);
  assert.match((await checkPin(counter, u1, undefined, hash))!, /6-digit/);
  assert.equal(await checkPin(counter, u1, '123456', hash), null);

  // sequential: a success resets the count, then 5 wrong guesses lock
  assert.match((await checkPin(counter, u1, '000000', hash))!, /4 attempts left/);
  assert.equal(await checkPin(counter, u1, '123456', hash), null);
  for (let i = 1; i < MAX_PIN_FAILURES; i++) assert.match((await checkPin(counter, u1, '000000', hash))!, /Wrong/);
  assert.match((await checkPin(counter, u1, '000000', hash))!, /locked for 15 minutes/);
  assert.match((await checkPin(counter, u1, '123456', hash))!, /Too many/);   // even the right PIN waits

  // "restart": a fresh counter over the same DB still sees the lock
  const restarted: PinCounter = { ...counter };
  assert.match((await checkPin(restarted, u1, '123456', hash))!, /Too many/);
  assert.equal(await checkPin(counter, u2, '123456', hash), null);           // other users unaffected

  // parallel: 20 wrong guesses at once compare at most 5 times, then the account is locked
  const results = await Promise.all(Array.from({ length: 20 }, () => checkPin(counter, u3, '000000', hash)));
  assert.equal(results.filter((r) => /Wrong|locked for 15/.test(r!)).length, MAX_PIN_FAILURES);
  assert.match((await checkPin(counter, u3, '123456', hash))!, /Too many/);

  // lock expiry: the next attempt starts a fresh count
  await db.query(`update users set pin_locked_until = now() - interval '1 second' where id = $1`, [u3]);
  assert.equal(await checkPin(counter, u3, '123456', hash), null);
  assert.equal((await db.query<any>(`select pin_failures, pin_locked_until from users where id=$1`, [u3])).rows[0].pin_failures, 0);
});
