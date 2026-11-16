// CPA overview (Eric, 2026-11-16): the company's accountant gets his
// own login and this read-only page — weekly settlement totals (the
// same computeWeek the owner sees), the PierLink invoice position,
// fuel totals, and money received. From here he can open the
// Settlement, Invoice and Fuel sections (all read-only for his role;
// the server middleware blocks every write) and print driver
// statements. Driver files and personal documents are never visible.
const express = require('express');
const { query } = require('../db');
const { requireLogin, weekStart, toISODate, addDays, num } = require('../lib/helpers');
const { computeWeek } = require('./settlement');

const router = express.Router();

function requireCpaOrAdmin(req, res, next) {
  const u = req.session && req.session.user;
  if (u && (u.role === 'cpa' || u.role === 'admin')) return next();
  return res.status(403).send('Forbidden.');
}

router.get('/', requireLogin, requireCpaOrAdmin, async (req, res) => {
  const thisWs = toISODate(weekStart(new Date()));
  const lastWs = toISODate(addDays(weekStart(new Date()), -7));
  const weeks = [];
  for (const ws of [thisWs, lastWs]) {
    const data = await computeWeek(ws, null);
    weeks.push({
      weekStartISO: data.weekStartISO, weekEndISO: data.weekEndISO,
      totals: data.totals, receiptsTotal: data.receiptsTotal,
      rows: data.rows.map(r => ({
        driver: r.driver, revenue: r.revenue, fuelCost: r.fuelCost,
        insurance: r.insurance, net: r.net, driverPay: r.driverPay,
        companyNet: r.companyNet, saved: r.saved,
      })),
    });
  }

  // PierLink invoice position: everything claimed vs everything paid,
  // plus the latest week's received amount.
  const claimed = await query(
    'SELECT COALESCE(SUM(rate + prepull + reefer + detention + overweight + fsc),0) AS t FROM invoice_lines'
  );
  const paid = await query('SELECT COALESCE(SUM(amount),0) AS t FROM invoice_payments');
  const latestWeek = await query(
    'SELECT * FROM invoice_weeks ORDER BY week_start DESC LIMIT 1'
  );
  const receipts = await query(
    'SELECT * FROM receipts ORDER BY receipt_date DESC, id DESC LIMIT 10'
  );
  const monthStart = toISODate(new Date()).slice(0, 7) + '-01';
  const fuelMonth = await query(
    `SELECT COALESCE(SUM(gallons),0) AS gallons, COALESCE(SUM(cost),0) AS cost
     FROM fuel WHERE fuel_date >= $1`,
    [monthStart]
  );

  res.render('cpa', {
    weeks,
    invoice: {
      claimed: num(claimed.rows[0].t), paid: num(paid.rows[0].t),
      outstanding: Math.round((num(claimed.rows[0].t) - num(paid.rows[0].t)) * 100) / 100,
      latest: latestWeek.rows[0] || null,
    },
    receipts: receipts.rows,
    fuelMonth: {
      gallons: num(fuelMonth.rows[0].gallons), cost: num(fuelMonth.rows[0].cost),
      monthLabel: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    },
    isAdmin: req.session.user.role === 'admin',
  });
});

module.exports = router;
