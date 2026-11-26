// PierLink weekly invoice — the company-side ledger (admin only).
//
// The driver's settlement runs on DELIVERY; PierLink pays on EMPTY
// RETURN. This module rebuilds Eric's Excel invoice from portal data:
//   - one CLAIM line per delivered load (components copied from the load,
//     then owner-adjustable — a claim can differ from driver settlement,
//     e.g. an overweight claimed here that the driver was not paid);
//   - payments are recorded per week; an unpaid line balance carries
//     into later invoices ("Previous unpaid / Mty Not Return" chain);
//   - footer: Total (paid this invoice) + Help Ins - Deduct = expected,
//     minus what actually arrived (Receive) = Balance still owed.
//
// Help Ins: $15 per delivered load, current 4 trucks only, and only
// until the insurance renewal at the end of the policy period
// (2027-09-30). Deduct: the $5,000 PierLink advance is repaid at
// $500/week — as of the 2026-11-09 invoice, 6 deductions are done and
// $2,000 (4 weeks) remains, so the portal chain starts at the
// 2026-11-16 invoice week with advance_before = 2000.
//
// Invoice HOME (redesign, 2026-11-26): /invoice with no driver selected
// is a weekly briefing — three money-flow donuts (prev / this / next
// week), summary cards, and a driver list. The money-flow numbers come
// from settlement's computeWeek (the exact same function the Settlement
// page and the CPA overview use — no second copy of the money rules).
// Clicking a driver drills into that driver's invoice detail, which is
// the original page body for that one driver; ?driver=all renders the
// original all-drivers page (the full print view). Every write below
// redirects back to the driver the line belongs to, so recording a
// payment never loses the driver's context.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, requireAdmin, num, weekStart, weekEnd, toISODate, addDays, fmtDate,
} = require('../lib/helpers');
// Settlement math is reused, never duplicated (same pattern as the CPA
// overview). routes/settlement.js exports computeWeek alongside its
// router; there is no require cycle (settlement never requires this
// module).
const { computeWeek } = require('./settlement');

const router = express.Router();
router.use(requireLogin);
// The CPA reads this section (GET only — his role is fenced again by
// the server middleware); every write stays owner-only.
router.use((req, res, next) => {
  const u = req.session && req.session.user;
  if (u && u.role === 'admin') return next();
  if (u && u.role === 'cpa' && req.method === 'GET') return next();
  return res.status(403).send('Forbidden — admin only.');
});

const HELP_INS_PER_LOAD = 15;
const HELP_INS_UNTIL = '2027-09-30';
const ADVANCE_BASELINE_WEEK = '2026-11-16';
const ADVANCE_BASELINE_REMAINING = 2000;

const r2 = (n) => Math.round(num(n) * 100) / 100;

function lineTotal(l) {
  return num(l.rate) + num(l.prepull) + num(l.reefer) + num(l.detention)
    + num(l.overweight) + num(l.fsc);
}

async function ensureWeek(weekISO) {
  const existing = await query('SELECT * FROM invoice_weeks WHERE week_start = $1', [weekISO]);
  if (existing.rows.length) return existing.rows[0];
  // Chain the advance balance from the latest earlier invoice week.
  const prev = await query(
    'SELECT * FROM invoice_weeks WHERE week_start < $1 ORDER BY week_start DESC LIMIT 1',
    [weekISO]
  );
  let advanceBefore = null;
  if (prev.rows.length && prev.rows[0].advance_before !== null) {
    advanceBefore = Math.max(0, num(prev.rows[0].advance_before) - num(prev.rows[0].advance_deduct));
  } else if (weekISO === ADVANCE_BASELINE_WEEK) {
    advanceBefore = ADVANCE_BASELINE_REMAINING;
  }
  const deduct = advanceBefore === null ? 500 : Math.min(500, advanceBefore);
  await query(
    'INSERT INTO invoice_weeks (week_start, advance_before, advance_deduct) VALUES ($1,$2,$3) ON CONFLICT (week_start) DO NOTHING',
    [weekISO, advanceBefore, deduct]
  );
  const r = await query('SELECT * FROM invoice_weeks WHERE week_start = $1', [weekISO]);
  return r.rows[0];
}

// Auto-create claim lines for confirmed loads delivered this week that
// do not have a line yet. Detention is claimed only when approved
// (same money rule as settlement).
async function ensureLines(weekISO, weekEndISO) {
  await query(
    `INSERT INTO invoice_lines (load_id, driver_id, claim_week, description, rate, prepull, reefer, detention, overweight, fsc)
     SELECT l.id, l.driver_id, $1, l.delivery, l.rate, l.prepull, l.reefer,
            CASE WHEN l.detention_status IN ('pending','rejected') THEN 0 ELSE l.detention END,
            l.overweight, l.fsc
     FROM loads l
     WHERE l.status = 'confirmed' AND l.load_date >= $1 AND l.load_date <= $2
       AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.load_id = l.id)`,
    [weekISO, weekEndISO]
  );
}

async function buildInvoice(weekISO) {
  const ws = new Date(weekISO + 'T00:00:00');
  const weISO = toISODate(weekEnd(ws));
  const week = await ensureWeek(weekISO);
  await ensureLines(weekISO, weISO);

  const drivers = (await query('SELECT * FROM drivers ORDER BY name')).rows;
  const lines = (await query(
    `SELECT il.*, l.load_date, l.delivery AS load_delivery, l.progress, l.returned_on, l.container_no
     FROM invoice_lines il LEFT JOIN loads l ON l.id = il.load_id
     ORDER BY il.driver_id, il.claim_week, il.id`
  )).rows;
  const pays = (await query('SELECT * FROM invoice_payments')).rows;
  const payByLine = {};
  for (const p of pays) {
    if (!payByLine[p.line_id]) payByLine[p.line_id] = [];
    payByLine[p.line_id].push(p);
  }
  const sumPays = (lineId, pred) => (payByLine[lineId] || [])
    .filter(pred).reduce((a, p) => a + num(p.amount), 0);

  const blocks = [];
  let totalPaidWeek = 0;
  for (const d of drivers) {
    const mine = lines.filter(l => l.driver_id === d.id);
    if (!mine.length) continue;
    const prevLines = [], weekLines = [];
    let prevUnpaid = 0, paidWeek = 0, carryOut = 0;
    for (const l of mine) {
      const claim = lineTotal(l);
      const paidBefore = sumPays(l.id, p => fmtDate(p.week_start) < weekISO);
      const paidThis = sumPays(l.id, p => fmtDate(p.week_start) === weekISO);
      const paidEarlierWeeksTotal = paidBefore;
      const balanceNow = Math.round((claim - paidBefore - paidThis) * 100) / 100;
      const row = {
        ...l, claim,
        paidBefore, paidThis,
        balanceAtStart: Math.round((claim - paidEarlierWeeksTotal) * 100) / 100,
        balanceNow,
        returned: l.progress === 'returned' || !!l.returned_on,
      };
      paidWeek += paidThis;
      if (fmtDate(l.claim_week) < weekISO) {
        if (row.balanceAtStart > 0.004 || paidThis > 0) prevLines.push(row);
        prevUnpaid += Math.max(0, row.balanceAtStart);
      } else if (fmtDate(l.claim_week) === weekISO) {
        weekLines.push(row);
      }
      if (balanceNow > 0.004) carryOut += balanceNow;
    }
    totalPaidWeek += paidWeek;
    if (!prevLines.length && !weekLines.length) continue;
    blocks.push({ driver: d, prevLines, weekLines, prevUnpaid, paidWeek, carryOut });
  }

  // Help Ins: $15 x loads delivered (confirmed) this week, within the
  // subsidy window. Owner override wins when set.
  const delivered = await query(
    "SELECT COUNT(*) AS n FROM loads WHERE status = 'confirmed' AND load_date >= $1 AND load_date <= $2",
    [weekISO, weISO]
  );
  const deliveredCount = parseInt(delivered.rows[0].n, 10);
  const helpInsAuto = weekISO <= HELP_INS_UNTIL ? deliveredCount * HELP_INS_PER_LOAD : 0;
  const helpIns = week.help_ins_override !== null && week.help_ins_override !== undefined
    ? num(week.help_ins_override) : helpInsAuto;
  const deduct = num(week.advance_deduct);
  const received = num(week.received);
  const expected = Math.round((totalPaidWeek + helpIns - deduct) * 100) / 100;
  const balance = Math.round((expected - received) * 100) / 100;

  return {
    week, weekISO, weekEndISO: weISO, blocks,
    totalPaidWeek, deliveredCount, helpInsAuto, helpIns, deduct,
    received, expected, balance,
  };
}

// ---------------------------------------------------------------------------
// Invoice home: money flow for one week, from settlement's computeWeek.
// Returns null when the week cannot be computed — the home then renders
// an empty donut / dashed cards instead of failing the whole page.
// ---------------------------------------------------------------------------
async function weekMoney(iso) {
  try {
    const d = await computeWeek(iso, null);
    const t = d.totals;
    return {
      total: r2(t.revenue),
      driverPay: r2(t.driverPay),
      fuel: r2(t.fuelCost),
      insurance: r2(t.insurance),
      company: r2(t.companyNet),
    };
  } catch (e) {
    console.error('invoice home: computeWeek failed for ' + iso + ':', e.message);
    return null;
  }
}

const DONUT_SLICES = [
  { key: 'driverPay', label: 'Driver pay', color: '#4f8ff7' },
  { key: 'fuel', label: 'Fuel', color: '#f5a623' },
  { key: 'insurance', label: 'Insurance', color: '#9aa3ad' },
  { key: 'company', label: 'Company share', color: '#3bb273' },
];

// Turn a weekMoney result into donut segments (percent of the week's
// total, pathLength=100 style). Null when there is nothing to show.
function donutFor(money) {
  if (!money || !(money.total > 0)) return null;
  let acc = 0;
  const slices = DONUT_SLICES.map(s => {
    const amount = r2(money[s.key]);
    const pct = Math.round((amount / money.total) * 10000) / 100;
    const seg = { key: s.key, label: s.label, color: s.color, amount, pct, offset: -acc };
    acc = Math.round((acc + pct) * 100) / 100;
    return seg;
  });
  return { total: money.total, slices };
}

router.get('/', async (req, res) => {
  try {
    let wsISO = req.query.week;
    // Guard: a malformed ?week= must never reach toISODate/week math
    // as an Invalid Date — fall back to the current week instead.
    if (!wsISO || !/^\d{4}-\d{2}-\d{2}$/.test(wsISO) || isNaN(new Date(wsISO + 'T00:00:00'))) {
      wsISO = toISODate(weekStart(new Date()));
    }
    const driverParam = (req.query.driver || '').toString();
    const data = await buildInvoice(wsISO);
    const wsDate = new Date(wsISO + 'T00:00:00');
    const prevWeek = toISODate(addDays(wsDate, -7));
    const nextWeek = toISODate(addDays(wsDate, 7));
    const base = {
      ...data, isAdmin: true, prevWeek, nextWeek,
      view: 'home', driverParam: '',
      donuts: null, cards: null, driverList: [], selectedBlock: null,
    };

    // Full original page (all drivers + totals) — the print view.
    if (driverParam === 'all') {
      return res.render('invoice', { ...base, view: 'all', driverParam: 'all' });
    }

    // One driver's detail (the original block, reached by drill-down).
    if (driverParam) {
      const block = data.blocks.find(b => b.driver.id === parseInt(driverParam, 10));
      if (block) {
        return res.render('invoice', { ...base, view: 'driver', selectedBlock: block, driverParam });
      }
      return res.redirect('/invoice?week=' + wsISO);
    }

    // Home: weekly briefing.
    const [prevMoney, curMoney, nextMoney] = await Promise.all([
      weekMoney(prevWeek), weekMoney(wsISO), weekMoney(nextWeek),
    ]);
    const driverList = data.blocks.map(b => ({
      driver: b.driver,
      weekClaim: r2(b.weekLines.reduce((a, l) => a + num(l.claim), 0)),
      prevUnpaid: r2(b.prevUnpaid),
      paidWeek: r2(b.paidWeek),
      carryOut: r2(b.carryOut),
    }));
    const cards = {
      totalClaim: r2(driverList.reduce((a, d) => a + d.weekClaim, 0)),
      unpaidTotal: r2(driverList.reduce((a, d) => a + d.prevUnpaid, 0)),
      driverPay: curMoney ? curMoney.driverPay : null,
      companyProfit: curMoney ? curMoney.company : null,
    };
    return res.render('invoice', {
      ...base, view: 'home', cards, driverList,
      donuts: { prev: donutFor(prevMoney), cur: donutFor(curMoney), next: donutFor(nextMoney) },
    });
  } catch (e) {
    console.error('invoice GET failed:', e);
    return res.status(500).send('Invoice failed to load. Please try again.');
  }
});

// Back to the driver a line belongs to (keeps the drill-down context
// after a write). Falls back to the week home when unknown.
function driverBack(week, driverId) {
  return '/invoice?week=' + (week || '') + (driverId ? '&driver=' + driverId : '');
}

async function lineDriverId(lineId) {
  const r = await query('SELECT driver_id FROM invoice_lines WHERE id = $1', [lineId]);
  return r.rows.length ? r.rows[0].driver_id : null;
}

// Edit a claim line's components (claims are independent of settlement).
router.post('/lines/:id/edit', async (req, res) => {
  const week = req.body.week || '';
  try {
    const driverId = await lineDriverId(req.params.id);
    await query(
      `UPDATE invoice_lines SET description=$1, rate=$2, prepull=$3, reefer=$4,
         detention=$5, overweight=$6, fsc=$7 WHERE id=$8`,
      [(req.body.description || '').trim() || null, num(req.body.rate), num(req.body.prepull),
       num(req.body.reefer), num(req.body.detention), num(req.body.overweight),
       num(req.body.fsc), req.params.id]
    );
    res.redirect(driverBack(week, driverId));
  } catch (e) {
    console.error('invoice line edit failed:', e);
    res.redirect('/invoice?week=' + week);
  }
});

// Record a payment toward a line in a given invoice week.
// Blank amount = pay the remaining balance in full.
router.post('/lines/:id/pay', async (req, res) => {
  const week = req.body.week || '';
  try {
    const line = (await query('SELECT * FROM invoice_lines WHERE id = $1', [req.params.id])).rows[0];
    if (!line) return res.redirect('/invoice?week=' + week);
    const paid = await query(
      'SELECT COALESCE(SUM(amount),0) AS s FROM invoice_payments WHERE line_id = $1', [line.id]
    );
    const balance = Math.round((lineTotal(line) - num(paid.rows[0].s)) * 100) / 100;
    let amount = req.body.amount === '' || req.body.amount === undefined
      ? balance : num(req.body.amount);
    if (amount > balance) amount = balance;
    if (amount > 0) {
      await query('INSERT INTO invoice_payments (line_id, week_start, amount) VALUES ($1,$2,$3)',
        [line.id, week, amount]);
    }
    res.redirect(driverBack(week, line.driver_id));
  } catch (e) {
    console.error('invoice line pay failed:', e);
    res.redirect('/invoice?week=' + week);
  }
});

// Remove the most recent payment recorded for a line in this week (undo).
router.post('/lines/:id/unpay', async (req, res) => {
  const week = req.body.week || '';
  try {
    const driverId = await lineDriverId(req.params.id);
    await query(
      `DELETE FROM invoice_payments WHERE id = (
         SELECT id FROM invoice_payments WHERE line_id = $1 AND week_start = $2
         ORDER BY id DESC LIMIT 1)`,
      [req.params.id, week]
    );
    res.redirect(driverBack(week, driverId));
  } catch (e) {
    console.error('invoice line unpay failed:', e);
    res.redirect('/invoice?week=' + week);
  }
});

// Manual claim line (no matching load — e.g. a standalone leg claim).
router.post('/lines', async (req, res) => {
  const week = req.body.week || '';
  const driverId = parseInt(req.body.driver_id, 10) || null;
  try {
    await query(
      `INSERT INTO invoice_lines (load_id, driver_id, claim_week, description, rate, prepull, reefer, detention, overweight, fsc)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [driverId, week, (req.body.description || '').trim() || null,
       num(req.body.rate), num(req.body.prepull), num(req.body.reefer),
       num(req.body.detention), num(req.body.overweight), num(req.body.fsc)]
    );
    res.redirect(driverBack(week, driverId));
  } catch (e) {
    console.error('invoice manual line failed:', e);
    res.redirect('/invoice?week=' + week);
  }
});

router.post('/lines/:id/delete', async (req, res) => {
  const week = req.body.week || '';
  try {
    const driverId = await lineDriverId(req.params.id);
    const pays = await query('SELECT COUNT(*) AS n FROM invoice_payments WHERE line_id = $1', [req.params.id]);
    if (parseInt(pays.rows[0].n, 10) === 0) {
      await query('DELETE FROM invoice_lines WHERE id = $1', [req.params.id]);
    }
    res.redirect(driverBack(week, driverId));
  } catch (e) {
    console.error('invoice line delete failed:', e);
    res.redirect('/invoice?week=' + week);
  }
});

// Week header: help-ins override, advance chain, received, sent mark.
router.post('/week', async (req, res) => {
  const week = req.body.week || '';
  try {
    await ensureWeek(week);
    const helpOverride = req.body.help_ins_override === '' || req.body.help_ins_override === undefined
      ? null : num(req.body.help_ins_override);
    await query(
      `UPDATE invoice_weeks SET help_ins_override=$1, advance_before=$2, advance_deduct=$3,
         received=$4, sent_at = CASE WHEN $5 = 'on' THEN COALESCE(sent_at, NOW()) ELSE sent_at END
       WHERE week_start=$6`,
      [helpOverride,
       req.body.advance_before === '' ? null : num(req.body.advance_before),
       num(req.body.advance_deduct, 500), num(req.body.received),
       req.body.mark_sent || '', week]
    );
    res.redirect('/invoice?week=' + week);
  } catch (e) {
    console.error('invoice week save failed:', e);
    res.redirect('/invoice?week=' + week);
  }
});

module.exports = router;
