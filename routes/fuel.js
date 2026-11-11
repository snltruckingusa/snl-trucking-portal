// Fuel: record / edit / delete / list.
// Stored cost = gallons x TCS discounted price/gal (computed here, stored).
const express = require('express');
const { query } = require('../db');
const { requireLogin, scopedDriverId, num, isAdmin } = require('../lib/helpers');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const conditions = [];
  const params = [];
  if (scope) { params.push(scope); conditions.push(`f.driver_id = $${params.length}`); }
  if (req.query.driver_id && !scope) { params.push(req.query.driver_id); conditions.push(`f.driver_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`f.fuel_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`f.fuel_date <= $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const r = await query(
    `SELECT f.*, d.name AS driver_name, d.truck_number FROM fuel f
     JOIN drivers d ON d.id = f.driver_id ${where}
     ORDER BY f.fuel_date DESC, f.id DESC`,
    params
  );
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  res.render('fuel', {
    fuel: r.rows, drivers: drivers.rows,
    filters: { from: req.query.from || '', to: req.query.to || '', driver_id: req.query.driver_id || '' },
    isAdmin: isAdmin(req), scopedDriverId: scope,
  });
});

router.post('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id) return res.redirect('/fuel');
  const gallons = num(req.body.gallons);
  const tcs_price = num(req.body.tcs_price);
  const cost = Math.round(gallons * tcs_price * 100) / 100;
  await query(
    'INSERT INTO fuel (driver_id, fuel_date, gallons, pump_price, tcs_price, cost) VALUES ($1,$2,$3,$4,$5,$6)',
    [driver_id, req.body.fuel_date, gallons, num(req.body.pump_price), tcs_price, cost]
  );
  res.redirect('/fuel');
});

router.post('/:id/edit', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM fuel WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/fuel');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const gallons = num(req.body.gallons);
  const tcs_price = num(req.body.tcs_price);
  const cost = Math.round(gallons * tcs_price * 100) / 100;
  await query(
    'UPDATE fuel SET fuel_date=$1, gallons=$2, pump_price=$3, tcs_price=$4, cost=$5 WHERE id=$6',
    [req.body.fuel_date, gallons, num(req.body.pump_price), tcs_price, cost, req.params.id]
  );
  res.redirect('/fuel');
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM fuel WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/fuel');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  await query('DELETE FROM fuel WHERE id = $1', [req.params.id]);
  res.redirect('/fuel');
});

module.exports = router;
