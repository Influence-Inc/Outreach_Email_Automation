const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

module.exports = { pool, query, one, many };
