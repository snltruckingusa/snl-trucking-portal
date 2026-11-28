// Weekly settlement (Mon-Sun) + MPG.
// Per driver, per week:
//   revenue  = sum(rate + prepull + reefer + detention + overweight + FSC)
//              over DELIVERED loads (driver clock = delivery — Eric,
//              2026-11-28: pay follows delivery, NOT ticket confirmation;
//              confirmation is a document control for the PierLink
//              claim clock only)
//   fuel     = sum(cost) over fuel purchases in the week
//   insurance = $100 x days worked (distinct dates with a delivered load)
//   net      = revenue - fuel - insurance
//   driver pay = net x pay_split%   (default 50%)
//   company net = net - driver pay
//   MPG = miles / gallons (flag < 6.0 as "MPG needs improvement")
// Friday close-out: close/reopen a week's settlement (snapshot stored in
// settlements table). Week summary: delivered revenue, driver pay, fuel,
// company net, receipts, pending entries awaiting review.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, requireAdmin, scopedDriverId, isAdmin,
  weekStart, weekEnd, toISODate, addDays, num, INSURANCE_PER_DAY, LOAD_MONEY_SQL, loadTotal,
} = require('../lib/helpers');
const { computeWeekend } = require('../lib/weekend');
const { effectiveSplitPct } = require('../lib/tenure');
const { matchLane } = require('../lib/rates');

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
      `SELECT COALESCE(SUM(${LOAD_MONEY_SQL}),0) AS revenue,
              COALESCE(SUM(miles),0) AS miles,
              COUNT(DISTINCT load_date) AS days_worked
       FROM loads WHERE driver_id = $1 AND progress IN ('delivered', 'returned')
         AND load_date >= $2 AND load_date <= $3`,
      [d.id, wsISO, weISO]
    );
    // Statement detail: this driver's delivered loads for the week,
    // one row per load (Rate / Prepull / Reefer / Detention / OW / FSC).
    const loadRows = await query(
      `SELECT * FROM loads WHERE driver_id = $1 AND progress IN ('delivered', 'returned')
         AND load_date >= $2 AND load_date <= $3
       ORDER BY load_date, id`,
      [d.id, wsISO, weISO]
    );
    const fuel = await query(
      `SELECT COALESCE(SUM(cost),0) AS fuel_cost, COALESCE(SUM(gallons),0) AS gallons
       FROM fuel WHERE driver_id = $1 AND fuel_date >= $2 AND fuel_date <= $3`,
      [d.id, wsISO, weISO]
    );
    let revenue = parseFloat(loads.rows[0].revenue);
    // Approved prepull work (Eric, 2026-11-14): doing another driver's
    // leg pays +$60 (empty return) / +$75 (load out) into THIS driver's
    // week income — everything splits from total income. The matching
    // deduction sits on the owner's load, so the week stays balanced.
    const ppRes = await query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM prepulls
        WHERE driver_id = $1 AND status = 'approved' AND work_date >= $2 AND work_date <= $3`,
      [d.id, wsISO, weISO]
    );
    const prepullCredit = parseFloat(ppRes.rows[0].total);
    revenue += prepullCredit;
    // Downtime / other pay (Eric, 2026-11-21): paid in full on top of
    // the split pay — a breakdown is not the driver's fault, so it is
    // never split and never reduced by fuel or insurance.
    let downtimeRows = [];
    try {
      const dtRes = await query(
        `SELECT * FROM downtime_pay WHERE driver_id = $1 AND pay_date >= $2 AND pay_date <= $3 ORDER BY pay_date, id`,
        [d.id, wsISO, weISO]
      );
      downtimeRows = dtRes.rows.map(r => ({ ...r, amount: parseFloat(r.amount) }));
    } catch (e) {
      console.error('downtime_pay query failed (treated as 0):', e.message);
    }
    const downtimeTotal = Math.round(downtimeRows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
    const miles = parseFloat(loads.rows[0].miles);
    const daysWorked = parseInt(loads.rows[0].days_worked, 10);
    const fuelCost = parseFloat(fuel.rows[0].fuel_cost);
    const gallons = parseFloat(fuel.rows[0].gallons);
    const insurance = daysWorked * INSURANCE_PER_DAY;
    const net = revenue - fuelCost - insurance;
    // Tenure ladder split (45/50/55 by hire date; exempt drivers and
    // drivers without a hire date use their flat pay_split).
    const splitPct = effectiveSplitPct(d, wsISO);
    const split = splitPct / 100;
    let driverPay = Math.round(net * split * 100) / 100;
    const mpg = gallons > 0 ? Math.round((miles / gallons) * 100) / 100 : null;
    // Fuel standard comparison (Eric's awareness chart): standard gallons
    // per lane vs actual gallons bought, priced at the week's average
    // $/gal. Shown on the statement so the driver sees his own numbers.
    let stdGallons = 0, stdMatched = 0;
    for (const l of loadRows.rows) {
      const lane = matchLane(l.delivery);
      if (lane && lane.gallons) { stdGallons += lane.gallons; stdMatched += 1; }
    }
    const stdComplete = loadRows.rows.length > 0 && stdMatched === loadRows.rows.length;
    let fuelStd = null;
    if (stdComplete && stdGallons > 0 && gallons > 0) {
      const excessGal = Math.round((gallons - stdGallons) * 100) / 100;
      const avgPrice = fuelCost / gallons;
      const excessCost = Math.round(excessGal * avgPrice * 100) / 100;
      fuelStd = {
        stdGallons, excessGal, excessCost,
        driverShare: Math.round(excessCost * split * 100) / 100,
      };
    }
    // Two-week rolling MPG (fill-timing noise makes single weeks jump).
    const prevWsISO = toISODate(addDays(ws, -7));
    const prevFuel = await query(
      `SELECT COALESCE(SUM(gallons),0) AS gallons FROM fuel
       WHERE driver_id = $1 AND fuel_date >= $2 AND fuel_date < $3`,
      [d.id, prevWsISO, wsISO]
    );
    const prevLoads = await query(
      `SELECT COALESCE(SUM(miles),0) AS miles FROM loads WHERE driver_id = $1
         AND progress IN ('delivered', 'returned') AND load_date >= $2 AND load_date < $3`,
      [d.id, prevWsISO, wsISO]
    );
    const twoGal = gallons + parseFloat(prevFuel.rows[0].gallons);
    const twoMiles = miles + parseFloat(prevLoads.rows[0].miles);
    const mpg2w = twoGal > 0 ? Math.round((twoMiles / twoGal) * 100) / 100 : null;
    const saved = await query(
      'SELECT * FROM settlements WHERE week_start = $1 AND driver_id = $2',
      [wsISO, d.id]
    );
    // Weekend (Sat/Sun) 70% rule: per-day nets, auto condition from work
    // records (delivered load on every Mon-Fri of this week and next).
    const fuelByDay = await query(
      `SELECT fuel_date::text AS d, COALESCE(SUM(cost),0) AS c FROM fuel
       WHERE driver_id = $1 AND fuel_date >= $2 AND fuel_date <= $3 GROUP BY fuel_date`,
      [d.id, wsISO, weISO]
    );
    const fuelMap = {};
    fuelByDay.rows.forEach(r => { fuelMap[r.d] = parseFloat(r.c); });
    const revMap = {};
    loadRows.rows.forEach(l => {
      const k = toISODate(new Date(l.load_date));
      revMap[k] = (revMap[k] || 0) + loadTotal(l);
    });
    const weekDates = [];
    for (let i = 0; i < 7; i++) weekDates.push(toISODate(addDays(ws, i)));
    const dayList = weekDates.map(date => ({
      date, revenue: revMap[date] || 0, fuel: fuelMap[date] || 0, hasLoad: date in revMap,
    }));
    const nextWsISO = toISODate(addDays(ws, 7));
    const nextWeISO = toISODate(addDays(ws, 13));
    const nextLoads = await query(
      `SELECT DISTINCT load_date::text AS d FROM loads WHERE driver_id = $1
         AND progress IN ('delivered', 'returned') AND load_date >= $2 AND load_date <= $3`,
      [d.id, nextWsISO, nextWeISO]
    );
    const weekend = computeWeekend({
      days: dayList, weekDates,
      nextWeekLoadDates: nextLoads.rows.map(r => r.d), split,
    });
    const savedRow = saved.rows[0] || null;
    const weekendApplied = !!(savedRow && savedRow.weekend_applied && weekend.conditionMet && weekend.hasWeekend);
    if (weekendApplied) driverPay = weekend.adjustedPay;
    if (downtimeTotal) driverPay = Math.round((driverPay + downtimeTotal) * 100) / 100;
    const companyNet = Math.round((net - driverPay) * 100) / 100;
    rows.push({
      driver: d, revenue, prepullCredit, fuelCost, insurance, net, driverPay, companyNet,
      miles, gallons, mpg, mpg2w, daysWorked,
      splitPct, fuelStd, downtime: downtimeTotal, downtimeRows,
      loads: loadRows.rows,
      mpgFlag: mpg !== null && mpg < 6.0,
      saved: savedRow,
      weekend, weekendApplied,
    });
  }

  const totals = rows.reduce((acc, r) => ({
    revenue: acc.revenue + r.revenue,
    fuelCost: acc.fuelCost + r.fuelCost,
    insurance: acc.insurance + r.insurance,
    net: acc.net + r.net,
    driverPay: acc.driverPay + r.driverPay,
    companyNet: acc.companyNet + r.companyNet,
    downtime: acc.downtime + (r.downtime || 0),
  }), { revenue: 0, fuelCost: 0, insurance: 0, net: 0, driverPay: 0, companyNet: 0, downtime: 0 });

  const receipts = await query(
    'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM receipts WHERE receipt_date >= $1 AND receipt_date <= $2',
    [wsISO, weISO]
  );
  const pending = await query(
    `SELECT COUNT(*) AS n FROM loads WHERE progress NOT IN ('delivered', 'returned') AND load_date >= $1 AND load_date <= $2
     ${driverFilter ? 'AND driver_id = $3' : ''}`,
    driverFilter ? [wsISO, weISO, driverFilter] : [wsISO, weISO]
  );
  const pendingDet = await query(
    `SELECT COUNT(*) AS n FROM loads WHERE detention_status = 'pending' AND load_date >= $1 AND load_date <= $2
     ${driverFilter ? 'AND driver_id = $3' : ''}`,
    driverFilter ? [wsISO, weISO, driverFilter] : [wsISO, weISO]
  );

  return {
    weekStart: ws, weekEnd: we, weekStartISO: wsISO, weekEndISO: weISO,
    rows, totals,
    receiptsTotal: parseFloat(receipts.rows[0].total),
    receiptsCount: parseInt(receipts.rows[0].n, 10),
    pendingCount: parseInt(pending.rows[0].n, 10),
    pendingDetentionCount: parseInt(pendingDet.rows[0].n, 10),
  };
}

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  let wsISO = req.query.week;
  if (!wsISO) wsISO = toISODate(weekStart(new Date()));
  const data = await computeWeek(wsISO, scope || null);
  // Driver confirmations for this week (2026-11-28) — guarded like
  // the downtime read in computeWeek: a missing table must never
  // take the settlement page down.
  let confirms = {};
  try {
    const cf = await query(
      'SELECT driver_id, confirmed_at, note, note_at FROM settlement_confirms WHERE week_start = $1',
      [data.weekStartISO]
    );
    cf.rows.forEach(function (r) { confirms[r.driver_id] = r; });
  } catch (e) { confirms = {}; }
  const prevWeek = toISODate(addDays(data.weekStart, -7));
  const nextWeek = toISODate(addDays(data.weekStart, 7));
  res.render('settlement', {
    ...data, prevWeek, nextWeek,
    isAdmin: isAdmin(req), scopedDriverId: scope, confirms,
  });
});

// Friday close-out: close a week's settlement for one driver (or all).
router.post('/close', requireLogin, requireAdmin, async (req, res) => {
  const { week, driver_id } = req.body;
  const data = await computeWeek(week, driver_id ? parseInt(driver_id, 10) : null);
  for (const r of data.rows) {
    await query(
      `INSERT INTO settlements (week_start, driver_id, revenue, fuel_cost, insurance, net,
         driver_pay, company_net, miles, gallons, mpg, status, closed_at, weekend_applied, weekend_net, split_applied)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'closed', NOW(), $12, $13, $14)
       ON CONFLICT (week_start, driver_id) DO UPDATE SET
         revenue=EXCLUDED.revenue, fuel_cost=EXCLUDED.fuel_cost, insurance=EXCLUDED.insurance,
         net=EXCLUDED.net, driver_pay=EXCLUDED.driver_pay, company_net=EXCLUDED.company_net,
         miles=EXCLUDED.miles, gallons=EXCLUDED.gallons, mpg=EXCLUDED.mpg,
         status='closed', closed_at=NOW(),
         weekend_applied=EXCLUDED.weekend_applied, weekend_net=EXCLUDED.weekend_net,
         split_applied=EXCLUDED.split_applied`,
      [data.weekStartISO, r.driver.id, r.revenue, r.fuelCost, r.insurance, r.net,
       r.driverPay, r.companyNet, r.miles, r.gallons, r.mpg,
       !!r.weekendApplied, r.weekend ? r.weekend.weekendNet : 0, r.splitPct]
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

// Weekend 70% rule: owner confirms (or cancels) application for one
// driver-week after reviewing. The flag lives on the settlements row.
router.post('/weekend-confirm', requireLogin, requireAdmin, async (req, res) => {
  const { week, driver_id } = req.body;
  const data = await computeWeek(week, driver_id ? parseInt(driver_id, 10) : null);
  for (const r of data.rows) {
    await query(
      `INSERT INTO settlements (week_start, driver_id, revenue, fuel_cost, insurance, net,
         driver_pay, company_net, miles, gallons, mpg, status, weekend_applied, weekend_net)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open', TRUE, $12)
       ON CONFLICT (week_start, driver_id) DO UPDATE SET
         weekend_applied = TRUE, weekend_net = EXCLUDED.weekend_net`,
      [data.weekStartISO, r.driver.id, r.revenue, r.fuelCost, r.insurance, r.net,
       r.driverPay, r.companyNet, r.miles, r.gallons, r.mpg,
       r.weekend ? r.weekend.weekendNet : 0]
    );
  }
  res.redirect('/settlement?week=' + week);
});

router.post('/weekend-unconfirm', requireLogin, requireAdmin, async (req, res) => {
  const { week, driver_id } = req.body;
  await query(
    'UPDATE settlements SET weekend_applied = FALSE WHERE week_start = $1 AND driver_id = $2',
    [week, parseInt(driver_id, 10)]
  );
  res.redirect('/settlement?week=' + week);
});

// Driver settlement confirmation (2026-11-28): the driver reviews
// his own week in the portal and confirms it here — this replaces
// the old send-the-invoice-and-ask flow. A question note clears the
// confirmation until the driver confirms again. Driver-scoped only:
// an admin cannot confirm on a driver's behalf.
router.post('/confirm', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  if (!scope) return res.redirect('/settlement');
  const d = new Date((req.body.week || '') + 'T00:00:00');
  const wsISO = isNaN(d) ? toISODate(weekStart(new Date())) : toISODate(weekStart(d));
  try {
    await query(
      `INSERT INTO settlement_confirms (driver_id, week_start, confirmed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (driver_id, week_start) DO UPDATE SET confirmed_at = NOW()`,
      [scope, wsISO]
    );
  } catch (e) { /* table missing — never block the driver */ }
  res.redirect('/settlement?week=' + wsISO);
});

router.post('/question', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  if (!scope) return res.redirect('/settlement');
  const d = new Date((req.body.week || '') + 'T00:00:00');
  const wsISO = isNaN(d) ? toISODate(weekStart(new Date())) : toISODate(weekStart(d));
  const note = (req.body.note || '').trim();
  if (note) {
    try {
      await query(
        `INSERT INTO settlement_confirms (driver_id, week_start, note, note_at, confirmed_at)
         VALUES ($1, $2, $3, NOW(), NULL)
         ON CONFLICT (driver_id, week_start) DO UPDATE SET
           note = EXCLUDED.note, note_at = NOW(), confirmed_at = NULL`,
        [scope, wsISO, note]
      );
    } catch (e) { /* table missing — never block the driver */ }
  }
  res.redirect('/settlement?week=' + wsISO);
});

// Printable weekly statement (one driver) — the driver saves/prints it
// as a PDF from the browser. A driver sees only his own; the admin can
// print any driver's.
router.get('/statement', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driverId = scope || parseInt(req.query.driver_id, 10);
  if (!driverId) return res.redirect('/settlement');
  let wsISO = toISODate(weekStart(new Date()));
  if (req.query.week) {
    const d = new Date(req.query.week + 'T00:00:00');
    if (!isNaN(d)) wsISO = toISODate(weekStart(d));
  }
  const data = await computeWeek(wsISO, driverId);
  if (!data.rows.length) return res.redirect('/settlement');
  // Statement extras (driver-statement audit, 2026-11-28): the same
  // week's not-yet-delivered loads for this driver (registered but
  // not delivered — the printout lists them as "not counted yet" so the
  // driver can see nothing is missing) and the week's fuel purchases
  // itemized (the exact rows summed into the Fuel line, so the
  // driver can verify the deduction). Display only — computeWeek
  // math is untouched. A failure here must never break the
  // statement itself, so both queries degrade to empty lists (the
  // downtime_pay try/catch precedent in computeWeek above).
  let pendingLoads = [], fuelEntries = [];
  try {
    pendingLoads = (await query(
      `SELECT * FROM loads WHERE driver_id = $1 AND progress NOT IN ('delivered', 'returned')
         AND load_date >= $2 AND load_date <= $3 ORDER BY load_date, id`,
      [driverId, data.weekStartISO, data.weekEndISO]
    )).rows;
    fuelEntries = (await query(
      `SELECT * FROM fuel WHERE driver_id = $1 AND fuel_date >= $2 AND fuel_date <= $3
       ORDER BY fuel_date, id`,
      [driverId, data.weekStartISO, data.weekEndISO]
    )).rows;
  } catch (e) {
    console.error('statement extras failed (statement renders without them):', e.message);
  }
  // Pay day (Eric's statement format): the Friday of the following
  // week — settlements are paid 1 week in arrears.
  const payDayISO = toISODate(addDays(new Date(data.weekEndISO + 'T00:00:00'), 6));
  res.render('statement-print', {
    r: data.rows[0], weekStartISO: data.weekStartISO, weekEndISO: data.weekEndISO,
    generatedOn: toISODate(new Date()), payDayISO,
    pendingLoads, fuelEntries,
  });
});

// Printable monthly summary (one driver): the Sun–Sat settlement weeks
// that overlap the month, totaled. The weekly statements remain the pay
// documents; this is the driver's monthly record.
router.get('/monthly', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driverId = scope || parseInt(req.query.driver_id, 10);
  if (!driverId) return res.redirect('/settlement');
  const mParam = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : toISODate(new Date()).slice(0, 7);
  const first = new Date(mParam + '-01T00:00:00');
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = [];
  let ws = weekStart(first);
  while (ws <= lastDay) {
    const data = await computeWeek(toISODate(ws), driverId);
    if (data.rows.length) weeks.push({ weekStartISO: data.weekStartISO, weekEndISO: data.weekEndISO, r: data.rows[0] });
    ws = addDays(ws, 7);
  }
  const drv = await query('SELECT * FROM drivers WHERE id = $1', [driverId]);
  if (!drv.rows.length) return res.redirect('/settlement');
  const totals = weeks.reduce((a, w) => ({
    revenue: a.revenue + w.r.revenue, fuelCost: a.fuelCost + w.r.fuelCost,
    insurance: a.insurance + w.r.insurance, net: a.net + w.r.net,
    driverPay: a.driverPay + w.r.driverPay, miles: a.miles + w.r.miles,
    gallons: a.gallons + w.r.gallons, daysWorked: a.daysWorked + w.r.daysWorked,
    loads: a.loads + w.r.loads.length,
  }), { revenue: 0, fuelCost: 0, insurance: 0, net: 0, driverPay: 0, miles: 0, gallons: 0, daysWorked: 0, loads: 0 });
  res.render('monthly-print', {
    driver: drv.rows[0], monthLabel: first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    weeks, totals, generatedOn: toISODate(new Date()),
  });
});

// Downtime / other pay entry (admin only). computeWeek picks entries
// up automatically, so the week's settlement and statements show them.
router.post('/downtime', requireLogin, requireAdmin, async (req, res) => {
  const driverId = parseInt(req.body.driver_id, 10);
  const payDate = String(req.body.pay_date || '').slice(0, 10);
  const amount = num(req.body.amount);
  const reason = String(req.body.reason || '').trim() || null;
  if (!driverId || !/^\d{4}-\d{2}-\d{2}$/.test(payDate) || !amount) return res.redirect('/settlement');
  await query('INSERT INTO downtime_pay (driver_id, pay_date, amount, reason) VALUES ($1,$2,$3,$4)',
    [driverId, payDate, amount, reason]);
  res.redirect('/settlement?week=' + toISODate(weekStart(new Date(payDate + 'T00:00:00'))));
});

router.post('/downtime/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  const row = (await query('SELECT pay_date FROM downtime_pay WHERE id = $1', [req.params.id])).rows[0];
  await query('DELETE FROM downtime_pay WHERE id = $1', [req.params.id]);
  const back = row ? '/settlement?week=' + toISODate(weekStart(new Date(row.pay_date))) : '/settlement';
  res.redirect(back);
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
// The CPA overview reuses the exact settlement math (no second copy
// of the money rules to drift out of sync).
module.exports.computeWeek = computeWeek;
