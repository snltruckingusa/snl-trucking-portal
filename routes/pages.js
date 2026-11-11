// Dashboard + static content pages: safety education, instructions /
// regulations, benefits. Dashboard: admin sees the week summary + pending
// entries; a driver sees only today's work and this/last week's pay.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, scopedDriverId, isAdmin,
  weekStart, weekEnd, toISODate, addDays,
} = require('../lib/helpers');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const today = toISODate(new Date());
  const ws = weekStart(new Date());
  const wsISO = toISODate(ws);
  const weISO = toISODate(weekEnd(ws));
  const lastWsISO = toISODate(addDays(ws, -7));
  const lastWeISO = toISODate(addDays(ws, -1));

  if (scope) {
    // Driver view: today's work + this/last week's pay.
    const todayLoads = await query(
      `SELECT * FROM loads WHERE driver_id = $1 AND load_date = $2 ORDER BY id DESC`,
      [scope, today]
    );
    const todayFuel = await query(
      `SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(gallons),0) AS gallons
       FROM fuel WHERE driver_id = $1 AND fuel_date = $2`,
      [scope, today]
    );
    const thisWeek = await query(
      'SELECT * FROM settlements WHERE week_start = $1 AND driver_id = $2',
      [wsISO, scope]
    );
    const lastWeek = await query(
      'SELECT * FROM settlements WHERE week_start = $1 AND driver_id = $2',
      [lastWsISO, scope]
    );
    const driver = (await query('SELECT * FROM drivers WHERE id = $1', [scope])).rows[0];
    return res.render('dashboard', {
      isAdmin: false, driver,
      today, todayLoads: todayLoads.rows, todayFuel: todayFuel.rows[0],
      thisWeek: thisWeek.rows[0] || null, lastWeek: lastWeek.rows[0] || null,
      weekStartISO: wsISO, weekEndISO: weISO, lastWeekStartISO: lastWsISO, lastWeekEndISO: lastWeISO,
    });
  }

  // Admin view: week summary + pending entries + receipts.
  const summary = await query(
    `SELECT COUNT(*) FILTER (WHERE status='confirmed') AS confirmed_n,
            COUNT(*) FILTER (WHERE status='pending') AS pending_n,
            COALESCE(SUM(rate + prepull + overweight + fsc) FILTER (WHERE status='confirmed'),0) AS revenue
     FROM loads WHERE load_date >= $1 AND load_date <= $2`,
    [wsISO, weISO]
  );
  const fuel = await query(
    'SELECT COALESCE(SUM(cost),0) AS fuel_cost FROM fuel WHERE fuel_date >= $1 AND fuel_date <= $2',
    [wsISO, weISO]
  );
  const receipts = await query(
    'SELECT COALESCE(SUM(amount),0) AS total FROM receipts WHERE receipt_date >= $1 AND receipt_date <= $2',
    [wsISO, weISO]
  );
  const pending = await query(
    `SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id
     WHERE l.status = 'pending' ORDER BY l.load_date DESC LIMIT 20`
  );
  const drivers = await query("SELECT * FROM drivers WHERE active = TRUE ORDER BY name");
  return res.render('dashboard', {
    isAdmin: true,
    weekStartISO: wsISO, weekEndISO: weISO,
    summary: summary.rows[0], fuelCost: parseFloat(fuel.rows[0].fuel_cost),
    receiptsTotal: parseFloat(receipts.rows[0].total),
    pending: pending.rows, drivers: drivers.rows,
  });
});

router.get('/safety', requireLogin, (req, res) => {
  res.render('safety', { isAdmin: isAdmin(req) });
});

router.get('/instructions', requireLogin, (req, res) => {
  res.render('instructions', { isAdmin: isAdmin(req) });
});

router.get('/benefits', requireLogin, (req, res) => {
  res.render('benefits', { isAdmin: isAdmin(req) });
});

module.exports = router;
