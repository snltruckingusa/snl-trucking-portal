// Drivers roster: add / edit / delete / list. Admin only.
// Pay split % is per driver (default 50). Drivers are 1099.
// Tenure ladder (2026-11-14): with a hire_date set, the split steps
// 45% (first 3 months) -> 50% -> 55% (after 1 year) automatically at
// settlement; ladder_exempt drivers (Sanders, Harrell) always use
// their flat pay_split.
const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin, num, toISODate } = require('../lib/helpers');
const { effectiveSplitPct, monthsBetween } = require('../lib/tenure');

const router = express.Router();

function withSplit(drivers) {
  const today = toISODate(new Date());
  return drivers.map(d => ({ ...d, current_split: effectiveSplitPct(d, today) }));
}

router.get('/', requireLogin, requireAdmin, async (req, res) => {
  const r = await query('SELECT * FROM drivers ORDER BY active DESC, name');
  res.render('drivers', { drivers: withSplit(r.rows), error: null, isAdmin: true });
});

router.post('/', requireLogin, requireAdmin, async (req, res) => {
  const { name, truck_number, pay_split, hire_date, ladder_exempt, address, phone, dob, email, license_no, license_state } = req.body;
  try {
    if (!name || !name.trim()) throw new Error('Driver name is required.');
    await query(
      'INSERT INTO drivers (name, truck_number, pay_split, hire_date, ladder_exempt, address, phone, dob, email, license_no, license_state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [name.trim(), (truck_number || '').trim(), num(pay_split, 50),
       hire_date || null, ladder_exempt === 'on', (address || '').trim() || null, (phone || '').trim() || null,
       dob || null, (email || '').trim() || null, (license_no || '').trim() || null, (license_state || '').trim() || null]
    );
    res.redirect('/drivers');
  } catch (err) {
    const r = await query('SELECT * FROM drivers ORDER BY active DESC, name');
    res.render('drivers', { drivers: withSplit(r.rows), error: err.message, isAdmin: true });
  }
});

router.post('/:id/edit', requireLogin, requireAdmin, async (req, res) => {
  const { name, truck_number, pay_split, active, hire_date, ladder_exempt, address, phone, dob, email, license_no, license_state } = req.body;
  await query(
    'UPDATE drivers SET name = $1, truck_number = $2, pay_split = $3, active = $4, hire_date = $5, ladder_exempt = $6, address = $7, phone = $8, dob = $9, email = $10, license_no = $11, license_state = $12 WHERE id = $13',
    [name.trim(), (truck_number || '').trim(), num(pay_split, 50), active === 'on',
     hire_date || null, ladder_exempt === 'on', (address || '').trim() || null, (phone || '').trim() || null,
     dob || null, (email || '').trim() || null, (license_no || '').trim() || null, (license_state || '').trim() || null, req.params.id]
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

// ---- Driver Overview (2026-11-15) -------------------------------------
// One driver, whole picture. Everything on this page is READ from where
// it already lives (drivers row + documents) — the overview stores
// nothing of its own (no duplication).
const CHECKLIST = [
  { key: 'cdl', label: 'CDL (license copy)', who: 'Driver' },
  { key: 'medical_card', label: 'DOT Medical Card', who: 'Driver' },
  { key: 'twic', label: 'TWIC Card', who: 'Driver' },
  { key: 'application', label: 'Driver Application', who: 'Driver' },
  { key: 'contract', label: 'Signed Contract', who: 'Driver' },
  { key: 'w9', label: 'W-9', who: 'Driver' },
  { key: 'mvr', label: 'MVR (owner pulls from GA DDS)', who: 'Company' },
  { key: 'clearinghouse', label: 'Clearinghouse Query Result', who: 'Company' },
  { key: 'drug_test', label: 'Drug Test Result', who: 'Company' },
  { key: 'road_test', label: 'Road Test Record', who: 'Company' },
];

function stepLabel(d, todayISO) {
  const flat = parseFloat(d.pay_split || 50);
  if (d.ladder_exempt) return 'Fixed ' + flat + '% (ladder exempt)';
  if (!d.hire_date) return 'Flat ' + flat + '% (no hire date on file)';
  const hireISO = typeof d.hire_date === 'string' ? d.hire_date.slice(0, 10) : toISODate(new Date(d.hire_date));
  const m = monthsBetween(hireISO, todayISO);
  if (m === null) return 'Flat ' + flat + '%';
  if (m < 3) return 'Step 1 of 3 — first 3 months (45%)';
  if (m < 12) return 'Step 2 of 3 — after 3 months (50%)';
  return 'Step 3 of 3 — after 1 year (55%)';
}

async function overviewData(driver) {
  const docs = await query(
    'SELECT id, category, original_name, expires_on, status, uploaded_at FROM documents WHERE driver_id = $1 ORDER BY uploaded_at DESC',
    [driver.id]
  );
  const latest = {};
  for (const doc of docs.rows) if (!latest[doc.category]) latest[doc.category] = doc;
  const checklist = CHECKLIST.map(c => ({ ...c, doc: latest[c.key] || null }));
  return { latest, checklist, missing: checklist.filter(c => !c.doc).length, total: CHECKLIST.length };
}

router.get('/overview', requireLogin, requireAdmin, async (req, res) => {
  const r = await query('SELECT * FROM drivers ORDER BY active DESC, name');
  const drivers = [];
  for (const d of withSplit(r.rows)) {
    const o = await overviewData(d);
    drivers.push({ ...d, missing: o.missing, total: o.total });
  }
  res.render('overview', { picker: true, drivers, isAdmin: true });
});

router.get('/:id/overview', requireLogin, requireAdmin, async (req, res) => {
  const r = await query('SELECT * FROM drivers WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.redirect('/drivers');
  const today = toISODate(new Date());
  const driver = { ...withSplit(r.rows)[0] };
  driver.step_label = stepLabel(driver, today);
  const o = await overviewData(driver);
  res.render('overview', {
    picker: false, driver, latest: o.latest, checklist: o.checklist, isAdmin: true,
  });
});

module.exports = router;
