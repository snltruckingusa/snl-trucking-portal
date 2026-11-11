// Auth: login / logout / change password / admin user management.
// Session-based auth, bcrypt password hashes. Driver accounts are linked
// to a driver row; a driver only ever sees their own data (enforced in
// each route via helpers.scopedDriverId).
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { requireLogin, requireAdmin, isAdmin } = require('../lib/helpers');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await query(
      `SELECT u.*, d.name AS driver_name, d.truck_number
       FROM users u LEFT JOIN drivers d ON d.id = u.driver_id
       WHERE u.username = $1`,
      [(username || '').trim()]
    );
    const user = r.rows[0];
    if (!user) return res.render('login', { error: 'Invalid username or password.' });
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.render('login', { error: 'Invalid username or password.' });
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      driver_id: user.driver_id,
      driver_name: user.driver_name,
      truck_number: user.truck_number,
    };
    if (user.must_change_password) return res.redirect('/change-password');
    return res.redirect('/');
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.render('login', { error: 'Database error. Please try again.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Change own password ----
router.get('/change-password', requireLogin, (req, res) => {
  res.render('change-password', { error: null, mustChange: req.session.user && req.query.force !== undefined });
});

router.post('/change-password', requireLogin, async (req, res) => {
  const { current, password, confirm } = req.body;
  try {
    const r = await query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = r.rows[0];
    if (!user) return res.redirect('/login');
    const ok = await bcrypt.compare(current || '', user.password_hash);
    if (!ok) return res.render('change-password', { error: 'Current password is wrong.', mustChange: false });
    if (!password || password.length < 8) {
      return res.render('change-password', { error: 'New password must be at least 8 characters.', mustChange: false });
    }
    if (password !== confirm) {
      return res.render('change-password', { error: 'New passwords do not match.', mustChange: false });
    }
    const hash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [hash, user.id]);
    return res.redirect('/');
  } catch (err) {
    console.error('[auth] change-password error:', err.message);
    return res.render('change-password', { error: 'Database error. Please try again.', mustChange: false });
  }
});

// ---- Admin: user accounts ----
router.get('/users', requireLogin, requireAdmin, async (req, res) => {
  const users = await query(
    `SELECT u.*, d.name AS driver_name FROM users u
     LEFT JOIN drivers d ON d.id = u.driver_id ORDER BY u.role, u.username`
  );
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  res.render('users', { users: users.rows, drivers: drivers.rows, error: null, isAdmin: true });
});

router.post('/users', requireLogin, requireAdmin, async (req, res) => {
  const { username, password, role, driver_id } = req.body;
  try {
    if (!username || !password || password.length < 8) {
      throw new Error('Username and a password of at least 8 characters are required.');
    }
    const hash = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO users (username, password_hash, role, driver_id) VALUES ($1, $2, $3, $4)',
      [username.trim(), hash, role === 'driver' ? 'driver' : 'admin', driver_id || null]
    );
    return res.redirect('/users');
  } catch (err) {
    console.error('[auth] create user error:', err.message);
    const users = await query(
      `SELECT u.*, d.name AS driver_name FROM users u
       LEFT JOIN drivers d ON d.id = u.driver_id ORDER BY u.role, u.username`
    );
    const drivers = await query('SELECT * FROM drivers ORDER BY name');
    return res.render('users', {
      users: users.rows, drivers: drivers.rows, isAdmin: true,
      error: err.message.includes('duplicate') ? 'That username is already taken.' : err.message,
    });
  }
});

router.post('/users/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.user.id) return res.redirect('/users');
  await query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.redirect('/users');
});

router.post('/users/:id/reset', requireLogin, requireAdmin, async (req, res) => {
  // Reset to a temporary password; the user must change it on next login.
  const temp = 'temp' + Math.floor(1000 + Math.random() * 9000);
  const hash = await bcrypt.hash(temp, 10);
  await query('UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2', [hash, req.params.id]);
  const users = await query(
    `SELECT u.*, d.name AS driver_name FROM users u
     LEFT JOIN drivers d ON d.id = u.driver_id ORDER BY u.role, u.username`
  );
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  res.render('users', {
    users: users.rows, drivers: drivers.rows, isAdmin: true,
    error: null, notice: `Temporary password for that account: ${temp} — give it to the driver; they must change it on first login.`,
  });
});

module.exports = router;
