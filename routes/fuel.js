// Fuel: record / edit / delete / list.
// Stored cost = gallons x TCS discounted price/gal (computed here, stored).
const express = require('express');
const { query } = require('../db');
const { requireLogin, scopedDriverId, num, isAdmin } = require('../lib/helpers');

const router = express.Router();

// Driver/truck split (Eric, 2026-11-23): a fuel record names the truck it
// went into, frozen at entry time. drivers.truck_number is only the
// driver's CURRENT assignment (form default). Truck choices come from the
// registered trucks only — never free-typed.
const normTruck = (s) => String(s || '').trim().replace(/^#/, '');
async function truckList() {
  const r = await query(
    `SELECT truck_number FROM (
       SELECT regexp_replace(truck_number, '^#', '') AS truck_number FROM vehicles
       UNION SELECT regexp_replace(truck_number, '^#', '') FROM drivers WHERE truck_number IS NOT NULL AND truck_number <> ''
       UNION SELECT regexp_replace(truck_number, '^#', '') FROM vehicle_docs
       UNION SELECT regexp_replace(truck_number, '^#', '') FROM mechanic_logs
     ) t WHERE truck_number <> '' ORDER BY truck_number`
  );
  return r.rows.map((x) => x.truck_number);
}
async function defaultTruck(driverId) {
  if (!driverId) return '';
  const r = await query('SELECT truck_number FROM drivers WHERE id = $1', [driverId]);
  return r.rows.length ? normTruck(r.rows[0].truck_number) : '';
}

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const conditions = [];
  const params = [];
  if (scope) { params.push(scope); conditions.push(`f.driver_id = $${params.length}`); }
  if (req.query.driver_id && !scope) { params.push(req.query.driver_id); conditions.push(`f.driver_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`f.fuel_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`f.fuel_date <= $${params.length}`); }
  if (req.query.truck) { params.push(normTruck(req.query.truck)); conditions.push(`f.truck_number = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const r = await query(
    `SELECT f.*, d.name AS driver_name, d.truck_number AS driver_truck FROM fuel f
     JOIN drivers d ON d.id = f.driver_id ${where}
     ORDER BY f.fuel_date DESC, f.id DESC`,
    params
  );
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  const trucks = await truckList();
  res.render('fuel', {
    fuel: r.rows, drivers: drivers.rows, trucks,
    filters: { from: req.query.from || '', to: req.query.to || '', driver_id: req.query.driver_id || '', truck: req.query.truck || '' },
    isAdmin: isAdmin(req), scopedDriverId: scope,
  });
});

router.post('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id) return res.redirect('/fuel');
  const gallons = num(req.body.gallons);
  let tcs_price = num(req.body.tcs_price);
  let cost = Math.round(gallons * tcs_price * 100) / 100;
  const enteredCost = num(req.body.cost);
  if (enteredCost > 0 && gallons > 0) {
    cost = Math.round(enteredCost * 100) / 100;
    tcs_price = Math.round((cost / gallons) * 10000) / 10000;
  }
  let truck_number = normTruck(req.body.truck_number);
  if (!truck_number) truck_number = await defaultTruck(driver_id);
  await query(
    'INSERT INTO fuel (driver_id, fuel_date, gallons, pump_price, tcs_price, cost, truck_number) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [driver_id, req.body.fuel_date, gallons, num(req.body.pump_price), tcs_price, cost, truck_number || null]
  );
  res.redirect('/fuel');
});

router.post('/:id/edit', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM fuel WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/fuel');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const gallons = num(req.body.gallons);
  let tcs_price = num(req.body.tcs_price);
  let cost = Math.round(gallons * tcs_price * 100) / 100;
  const enteredCost = num(req.body.cost);
  if (enteredCost > 0 && gallons > 0) {
    cost = Math.round(enteredCost * 100) / 100;
    tcs_price = Math.round((cost / gallons) * 10000) / 10000;
  }
  const truck_number = normTruck(req.body.truck_number) || normTruck(existing.rows[0].truck_number) || await defaultTruck(existing.rows[0].driver_id);
  await query(
    'UPDATE fuel SET fuel_date=$1, gallons=$2, pump_price=$3, tcs_price=$4, cost=$5, truck_number=$6 WHERE id=$7',
    [req.body.fuel_date, gallons, num(req.body.pump_price), tcs_price, cost, truck_number || null, req.params.id]
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
