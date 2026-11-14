// Drivers roster: add / edit / delete / list. Admin only.
// Pay split % is per driver (default 50). Drivers are 1099.
// Tenure ladder (2026-11-14): with a hire_date set, the split steps
// 45% (first 3 months) -> 50% -> 55% (after 1 year) automatically at
// settlement; ladder_exempt drivers (Sanders, Harrell) always use
// their flat pay_split.
const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin, num } = require('../lib/helpers');
const { effectiveSplitPct } = require('../lib/tenure');

const router = express.Router();

function withSplit(drivers) {
  const today = new Date().toISOString().slice(0, 10);
  return drivers.map(d => ({ ...d, current_split: effectiveSplitPct(d, today) }));
}

router.get('/', requireLogin, requireAdmin, async (req, res) => {
  const r = await query('SELECT * FROM drivers ORDER BY active DESC, name');
  res.render('drivers', { drivers: withSplit(r.rows), error: null, isAdmin: true });
});

router.post('/', requireLogin, requireAdmin, async (req, res) => {
  const { name, truck_number, pay_split, hire_date, ladder_exempt } = req.body;
  try {
    if (!name || !name.trim()) throw new Error('Driver name is required.');
    await query(
      'INSERT INTO drivers (name, truck_number, pay_split, hire_date, ladder_exempt) VALUES ($1, $2, $3, $4, $5)',
      [name.trim(), (truck_number || '').trim(), num(pay_split, 50),
       hire_date || null, ladder_exempt === 'on']
    );
    res.redirect('/drivers');
  } catch (err) {
    const r = await query('SELECT * FROM drivers ORDER BY active DESC, name');
    res.render('drivers', { drivers: withSplit(r.rows), error: err.message, isAdmin: true });
  }
});

router.post('/:id/edit', requireLogin, requireAdmin, async (req, res) => {
  const { name, truck_number, pay_split, active, hire_date, ladder_exempt } = req.body;
  await query(
    'UPDATE drivers SET name = $1, truck_number = $2, pay_split = $3, active = $4, hire_date = $5, ladder_exempt = $6 WHERE id = $7',
    [name.trim(), (truck_number || '').trim(), num(pay_split, 50), active === 'on',
     hire_date || null, ladder_exempt === 'on', req.params.id]
  );
  res.redirect('/drivers');
});

router.post('/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  // Refuse to delete a driver that still has loads/fuel/settlements.
  const used = await query(
    `SELECT (SELECT COUNT(*) FROM loads WHERE driver_id = $1)
          + (SELECT COUNT(*) FROM fuel WHERE driver_id = $1)
          + (SELECT COUNT(*) FROM settlements WHERE driver_id = $1) AS n`,
    [req.params.id]
  );
  if (parseInt(used.rows[0].n, 10) > 0) {
    const r = await query('SELECT * FROM drivers ORDER BY active DESC, name');
    return res.render('drivers', {
      drivers: withSplit(r.rows), isAdmin: true,
      error: 'Cannot delete: this driver has loads, fuel, or settlement records. Deactivate them instead.',
    });
  }
  await query('DELETE FROM drivers WHERE id = $1', [req.params.id]);
  res.redirect('/drivers');
});

module.exports = router;
