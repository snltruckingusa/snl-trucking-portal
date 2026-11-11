// Weekly settlement (Mon-Sun) + MPG.
// Per driver, per week:
//   revenue  = sum(rate + prepull + overweight + FSC) over CONFIRMED loads
//   fuel     = sum(cost) over fuel purchases in the week
//   insurance = $100 x days worked (distinct dates with a confirmed load)
//   net      = revenue - fuel - insurance
//   driver pay = net x pay_split%   (default 50%)
//   company net = net - driver pay
//   MPG = miles / gallons (flag < 6.0 as "연비 개선 필요")
// Friday close-out: close/reopen a week's settlement (snapshot stored in
// settlements table). Week summary: confirmed revenue, driver pay, fuel,
// company net, receipts, pending entries awaiting review.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, requireAdmin, scopedDriverId, isAdmin,
  weekStart, weekEnd, toISODate, addDays, num, INSURANCE_PER_DAY,
} = require('../lib/helpers');

const router = express.Router();

async function computeWeek(weekStartISO, driverFilter) {
  const ws = new Date(weekStartISO + 'T00:00:00');
  const we = weekEnd(ws);
  const wsISO = toISODate(ws);
  const weISO = toISODate(we);

  const driversRes = driverFilter
    ? await query('SELECT * FROM drivers WHERE id = $1', [driverFilter])
    : await query("SELECT * FROM drivers WHERE active = TRUE ORDER BY name");
  const drivers = driversRes.rows;

  const rows = [];
  for (const d of drivers) {
    const loads = await query(
      `SELECT COALESCE(SUM(rate + prepull + overweight + fsc),0) AS revenue,
              COALESCE(SUM(miles),0) AS miles,
              COUNT(DISTINCT load_date) AS days_worked
       FROM loads WHERE driver_id = $1 AND status = 'confirmed'
         AND load_date >= $2 AND load_date <= $3`,
      [d.id, wsISO, weISO]
    );
    const fuel = await query(
      `SELECT COALESCE(SUM(cost),0) AS fuel_cost, COALESCE(SUM(gallons),0) AS gallons
       FROM fuel WHERE driver_id = $1 AND fuel_date >= $2 AND fuel_date <= $3`,
      [d.id, wsISO, weISO]
    );
    const revenue = parseFloat(loads.rows[0].revenue);
    const miles = parseFloat(loads.rows[0].miles);
    const daysWorked = parseInt(loads.rows[0].days_worked, 10);
    const fuelCost = parseFloat(fuel.rows[0].fuel_cost);
    const gallons = parseFloat(fuel.rows[0].gallons);
    const insurance = daysWorked * INSURANCE_PER_DAY;
    const net = revenue - fuelCost - insurance;
    const split = num(d.pay_split, 50) / 100;
    const driverPay = Math.round(net * split * 100) / 100;
    const companyNet = Math.round((net - driverPay) * 100) / 100;
    const mpg = gallons > 0 ? Math.round((miles / gallons) * 100) / 100 : null;
    const saved = await query(
      'SELECT * FROM settlements WHERE week_start = $1 AND driver_id = $2',
      [wsISO, d.id]
    );
    rows.push({
      driver: d, revenue, fuelCost, insurance, net, driverPay, companyNet,
      miles, gallons, mpg, daysWorked,
      mpgFlag: mpg !== null && mpg < 6.0,
      saved: saved.rows[0] || null,
    });
  }

  const totals = rows.reduce((acc, r) => ({
    revenue: acc.revenue + r.revenue,
    fuelCost: acc.fuelCost + r.fuelCost,
    insurance: acc.insurance + r.insurance,
    net: acc.net + r.net,
    driverPay: acc.driverPay + r.driverPay,
    companyNet: acc.companyNet + r.companyNet,
  }), { revenue: 0, fuelCost: 0, insurance: 0, net: 0, driverPay: 0, companyNet: 0 });

  const receipts = await query(
    'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM receipts WHERE receipt_date >= $1 AND receipt_date <= $2',
    [wsISO, weISO]
  );
  const pending = await query(
    `SELECT COUNT(*) AS n FROM loads WHERE status = 'pending' AND load_date >= $1 AND load_date <= $2
     ${driverFilter ? 'AND driver_id = $3' : ''}`,
    driverFilter ? [wsISO, weISO, driverFilter] : [wsISO, weISO]
  );

  return {
    weekStart: ws, weekEnd: we, weekStartISO: wsISO, weekEndISO: weISO,
    rows, totals,
    receiptsTotal: parseFloat(receipts.rows[0].total),
    receiptsCount: parseInt(receipts.rows[0].n, 10),
    pendingCount: parseInt(pending.rows[0].n, 10),
  };
}

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  let wsISO = req.query.week;
  if (!wsISO) wsISO = toISODate(weekStart(new Date()));
  const data = await computeWeek(wsISO, scope || null);
  const prevWeek = toISODate(addDays(data.weekStart, -7));
  const nextWeek = toISODate(addDays(data.weekStart, 7));
  res.render('settlement', {
    ...data, prevWeek, nextWeek,
    isAdmin: isAdmin(req), scopedDriverId: scope,
  });
});

// Friday close-out: close a week's settlement for one driver (or all).
router.post('/close', requireLogin, requireAdmin, async (req, res) => {
  const { week, driver_id } = req.body;
  const data = await computeWeek(week, driver_id ? parseInt(driver_id, 10) : null);
  for (const r of data.rows) {
    await query(
      `INSERT INTO settlements (week_start, driver_id, revenue, fuel_cost, insurance, net,
         driver_pay, company_net, miles, gallons, mpg, status, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'closed', NOW())
       ON CONFLICT (week_start, driver_id) DO UPDATE SET
         revenue=EXCLUDED.revenue, fuel_cost=EXCLUDED.fuel_cost, insurance=EXCLUDED.insurance,
         net=EXCLUDED.net, driver_pay=EXCLUDED.driver_pay, company_net=EXCLUDED.company_net,
         miles=EXCLUDED.miles, gallons=EXCLUDED.gallons, mpg=EXCLUDED.mpg,
         status='closed', closed_at=NOW()`,
      [data.weekStartISO, r.driver.id, r.revenue, r.fuelCost, r.insurance, r.net,
       r.driverPay, r.companyNet, r.miles, r.gallons, r.mpg]
    );
  }
  res.redirect('/settlement?week=' + week);
});

router.post('/reopen', requireLogin, requireAdmin, async (req, res) => {
  const { week, driver_id } = req.body;
  if (driver_id) {
    await query("UPDATE settlements SET status='open', closed_at=NULL WHERE week_start=$1 AND driver_id=$2", [week, driver_id]);
  } else {
    await query("UPDATE settlements SET status='open', closed_at=NULL WHERE week_start=$1", [week]);
  }
  res.redirect('/settlement?week=' + week);
});

// MPG history (per driver, per week).
router.get('/mpg', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driversRes = scope
    ? await query('SELECT * FROM drivers WHERE id = $1', [scope])
    : await query("SELECT * FROM drivers WHERE active = TRUE ORDER BY name");
  const weeks = [];
  const now = weekStart(new Date());
  for (let i = 0; i < 8; i++) {
    const ws = addDays(now, -7 * i);
    weeks.push(toISODate(ws));
  }
  const table = [];
  for (const wsISO of weeks) {
    const data = await computeWeek(wsISO, scope || null);
    table.push({ weekStartISO: wsISO, rows: data.rows });
  }
  res.render('mpg', { drivers: driversRes.rows, table, isAdmin: isAdmin(req) });
});

module.exports = router;
