import pg from 'pg';
import config from '../config/index.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
  max: 5, // Supabase free-tier poolers allow few connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// The pooler drops idle connections now and then; the pool replaces them. Do not exit.
pool.on('error', (err) => {
  console.error('[DB] idle client error:', err.message);
});

export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

export const getClient = () => {
  return pool.connect();
};

export default pool;
