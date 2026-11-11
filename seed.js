// First-run seeding: creates tables (from schema.sql) if missing,
// seeds the 5 drivers and the admin login.
// Runs automatically on server start. Safe to run repeatedly (idempotent).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { query } = require('./db');

const SEED_DRIVERS = [
  { name: 'Green', truck_number: '101', pay_split: 50 },
  { name: 'Darrell', truck_number: '201', pay_split: 50 },
  { name: 'Brinceson', truck_number: '200', pay_split: 50 },
  { name: 'Harrell', truck_number: '100', pay_split: 50 },
  { name: 'Dong Sung Lee', truck_number: '100', pay_split: 50 },
];

async function ensureSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);
}

async function seed() {
  await ensureSchema();

  // Drivers (idempotent by name).
  for (const d of SEED_DRIVERS) {
    const existing = await query('SELECT id FROM drivers WHERE name = $1', [d.name]);
    if (existing.rows.length === 0) {
      await query(
        'INSERT INTO drivers (name, truck_number, pay_split) VALUES ($1, $2, $3)',
        [d.name, d.truck_number, d.pay_split]
      );
      console.log(`[seed] driver added: ${d.name} (#${d.truck_number})`);
    }
  }

  // Admin account. Default password is 'changeme123' unless ADMIN_PASSWORD
  // is set in the environment. The admin is forced to change it on first login.
  const adminCount = await query("SELECT id FROM users WHERE role = 'admin'");
  if (adminCount.rows.length === 0) {
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = await bcrypt.hash(password, 10);
    await query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', $1, 'admin', TRUE)",
      [hash]
    );
    console.log('[seed] admin account created (username: admin). Change the password on first login.');
  }
}

module.exports = { seed };
