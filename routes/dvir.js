// DVIR (Daily Vehicle Inspection Reports) + mechanic logs.
const express = require('express');
const { query } = require('../db');
const { requireLogin, scopedDriverId, isAdmin, num } = require('../lib/helpers');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const conditions = [];
  const params = [];
  if (scope) { params.push(scope); conditions.push(`driver_id = $${params.length}`); }
  if (req.query.driver_id && !scope) { params.push(req.query.driver_id); conditions.push(`driver_id = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const dvir = await query(
    `SELECT v.*, d.name AS driver_name FROM dvir v JOIN drivers d ON d.id = v.driver_id
     ${where} ORDER BY v.inspection_date DESC, v.id DESC LIMIT 100`, params
  );
  const logs = await query(
    'SELECT * FROM mechanic_logs ORDER BY log_date DESC, id DESC LIMIT 100'
  );
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  res.render('dvir', {
    dvir: dvir.rows, logs: logs.rows, drivers: drivers.rows,
    isAdmin: isAdmin(req), scopedDriverId: scope,
    filterDriver: req.query.driver_id || '',
  });
});

router.post('/dvir', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id) return res.redirect('/dvir');
  await query(
    'INSERT INTO dvir (driver_id, inspection_date, truck_number, defects, safe_to_operate) VALUES ($1,$2,$3,$4,$5)',
    [driver_id, req.body.inspection_date, (req.body.truck_number || '').trim() || null,
     (req.body.defects || '').trim() || null, req.body.safe_to_operate === 'on']
  );
  res.redirect('/dvir');
});

router.post('/dvir/:id/delete', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM dvir WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/dvir');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  await query('DELETE FROM dvir WHERE id = $1', [req.params.id]);
  res.redirect('/dvir');
});

router.post('/mechanic', requireLogin, async (req, res) => {
  await query(
    'INSERT INTO mechanic_logs (truck_number, log_date, description, cost, mechanic) VALUES ($1,$2,$3,$4,$5)',
    [(req.body.truck_number || '').trim(), req.body.log_date, (req.body.description || '').trim(),
     num(req.body.cost), (req.body.mechanic || '').trim() || null]
  );
  res.redirect('/dvir');
});

router.post('/mechanic/:id/delete', requireLogin, async (req, res) => {
  await query('DELETE FROM mechanic_logs WHERE id = $1', [req.params.id]);
  res.redirect('/dvir');
});

module.exports = router;
