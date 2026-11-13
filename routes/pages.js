// Dashboard + static content pages: safety education, instructions /
// regulations, benefits, and the driver's "More" index.
// Dashboard (redesign 2026-11): a driver sees today's loads as progress
// cards, quick actions, this week's pay (small), and badges for pending
// confirmations and expiring documents. The admin sees a "To check today"
// card above the week summary.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, scopedDriverId, isAdmin,
  weekStart, weekEnd, toISODate, addDays, LOAD_MONEY_SQL,
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
    // Driver view: today's load cards + quick actions + this/last week's pay.
    const todayLoads = await query(
      `SELECT * FROM loads WHERE driver_id = $1 AND load_date = $2 ORDER BY id DESC`,
      [scope, today]
    );
    const todayFuel = await query(
      `SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(gallons),0) AS gallons
       FROM fuel WHERE driver_id = $1 AND fuel_date = $2`,
      [scope, today]
    );
    const pendingOwn = await query(
      "SELECT COUNT(*) AS n FROM loads WHERE driver_id = $1 AND status = 'pending'",
      [scope]
    );
    const expiringOwn = await query(
      `SELECT COUNT(*) AS n FROM documents
       WHERE driver_id = $1 AND expires_on IS NOT NULL AND expires_on <= CURRENT_DATE + 30`,
      [scope]
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
      pendingCount: parseInt(pendingOwn.rows[0].n, 10),
      expiringCount: parseInt(expiringOwn.rows[0].n, 10),
      thisWeek: thisWeek.rows[0] || null, lastWeek: lastWeek.rows[0] || null,
      weekStartISO: wsISO, weekEndISO: weISO, lastWeekStartISO: lastWsISO, lastWeekEndISO: lastWeISO,
    });
  }

  // Admin view: "To check today" + week summary + receipts.
  const summary = await query(
    `SELECT COUNT(*) FILTER (WHERE status='confirmed') AS confirmed_n,
            COUNT(*) FILTER (WHERE status='pending') AS pending_n,
            COALESCE(SUM(${LOAD_MONEY_SQL}) FILTER (WHERE status='confirmed'),0) AS revenue
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
  const idleDrivers = await query(
    `SELECT d.* FROM drivers d WHERE d.active = TRUE
       AND NOT EXISTS (SELECT 1 FROM loads l WHERE l.driver_id = d.id AND l.load_date = $1)
     ORDER BY d.name`,
    [today]
  );
  const expiringDocs = await query(
    `SELECT doc.*, d.name AS driver_name FROM documents doc JOIN drivers d ON d.id = doc.driver_id
     WHERE doc.expires_on IS NOT NULL AND doc.expires_on <= CURRENT_DATE + 30
     ORDER BY doc.expires_on ASC LIMIT 20`
  );
  const mpgFlags = await query(
    `SELECT s.*, d.name AS driver_name
     FROM (SELECT DISTINCT ON (driver_id) * FROM settlements
           ORDER BY driver_id, week_start DESC) s
     JOIN drivers d ON d.id = s.driver_id
     WHERE s.mpg IS NOT NULL AND s.mpg < 6.0
     ORDER BY d.name`
  );
  const drivers = await query("SELECT * FROM drivers WHERE active = TRUE ORDER BY name");
  return res.render('dashboard', {
    isAdmin: true,
    today,
    weekStartISO: wsISO, weekEndISO: weISO,
    summary: summary.rows[0], fuelCost: parseFloat(fuel.rows[0].fuel_cost),
    receiptsTotal: parseFloat(receipts.rows[0].total),
    pending: pending.rows, drivers: drivers.rows,
    idleDrivers: idleDrivers.rows, expiringDocs: expiringDocs.rows, mpgFlags: mpgFlags.rows,
  });
});

router.get('/more', requireLogin, (req, res) => {
  res.render('more', { isAdmin: isAdmin(req) });
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
