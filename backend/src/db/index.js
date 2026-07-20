const { Pool } = require('pg');

// Managed Postgres (Railway, Neon, Supabase) requires SSL; local dev usually doesn't.
const needsSsl = (() => {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require') return true;
  const url = process.env.DATABASE_URL || '';
  return /railway|neon|supabase|render|amazonaws|sslmode=require/i.test(url);
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function many(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// Run `fn` inside a single transaction. `fn` receives a dedicated pooled client
// (use client.query(...)) and its return value is passed through on COMMIT; any
// throw rolls back. Used by the offer portal for the atomic accept/decline and
// counter-offer transitions.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback failure — surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, withTransaction };
