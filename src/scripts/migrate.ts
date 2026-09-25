import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

// Applies db/schema.sql (idempotent) to DATABASE_URL. Alternative: paste the file into the Supabase SQL Editor.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(fs.readFileSync(path.resolve(__dirname, '../../db/schema.sql'), 'utf8'));
  console.log('✅ db/schema.sql applied');
} finally {
  await client.end();
}
