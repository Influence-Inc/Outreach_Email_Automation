// Destructive: drops all tables and recreates the schema.
// Only meant for local dev or first-time setup after a schema-breaking change.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

(async () => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_RESET !== 'yes') {
    console.error('Refusing to reset in production. Set ALLOW_RESET=yes to override.');
    process.exit(1);
  }
  console.log('Dropping tables...');
  await pool.query(`
    DROP TABLE IF EXISTS email_events CASCADE;
    DROP TABLE IF EXISTS creators CASCADE;
    DROP TABLE IF EXISTS campaigns CASCADE;
    DROP TABLE IF EXISTS brands CASCADE;
    DROP TABLE IF EXISTS oauth_tokens CASCADE;
  `);
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Reset complete.');
  await pool.end();
})().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
