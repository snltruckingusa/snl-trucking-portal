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
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, requireAdmin, num, weekStart, weekEnd, toISODate, addDays, fmtDate,
} = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin, requireAdmin);

const HELP_INS_PER_LOAD = 15;
const HELP_INS_UNTIL = '2027-09-30';
const ADVANCE_BASELINE_WEEK = '2026-11-16';
const ADVANCE_BASELINE_REMAINING = 2000;

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

router.get('/', async (req, res) => {
  let wsISO = req.query.week;
  if (!wsISO) wsISO = toISODate(weekStart(new Date()));
  const data = await buildInvoice(wsISO);
  res.render('invoice', {
    ...data, isAdmin: true,
    prevWeek: toISODate(addDays(new Date(wsISO + 'T00:00:00'), -7)),
    nextWeek: toISODate(addDays(new Date(wsISO + 'T00:00:00'), 7)),
  });
});

// Edit a claim line's components (claims are independent of settlement).
router.post('/lines/:id/edit', async (req, res) => {
  await query(
    `UPDATE invoice_lines SET description=$1, rate=$2, prepull=$3, reefer=$4,
       detention=$5, overweight=$6, fsc=$7 WHERE id=$8`,
    [(req.body.description || '').trim() || null, num(req.body.rate), num(req.body.prepull),
     num(req.body.reefer), num(req.body.detention), num(req.body.overweight),
     num(req.body.fsc), req.params.id]
  );
  res.redirect('/invoice?week=' + (req.body.week || ''));
});

// Record a payment toward a line in a given invoice week.
// Blank amount = pay the remaining balance in full.
router.post('/lines/:id/pay', async (req, res) => {
  const week = req.body.week;
  const line = (await query('SELECT * FROM invoice_lines WHERE id = $1', [req.params.id])).rows[0];
  if (!line) return res.redirect('/invoice?week=' + (week || ''));
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
  res.redirect('/invoice?week=' + (week || ''));
});

// Remove the most recent payment recorded for a line in this week (undo).
router.post('/lines/:id/unpay', async (req, res) => {
  const week = req.body.week;
  await query(
    `DELETE FROM invoice_payments WHERE id = (
       SELECT id FROM invoice_payments WHERE line_id = $1 AND week_start = $2
       ORDER BY id DESC LIMIT 1)`,
    [req.params.id, week]
  );
  res.redirect('/invoice?week=' + (week || ''));
});

// Manual claim line (no matching load — e.g. a standalone leg claim).
router.post('/lines', async (req, res) => {
  const week = req.body.week;
  await query(
    `INSERT INTO invoice_lines (load_id, driver_id, claim_week, description, rate, prepull, reefer, detention, overweight, fsc)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [parseInt(req.body.driver_id, 10), week, (req.body.description || '').trim() || null,
     num(req.body.rate), num(req.body.prepull), num(req.body.reefer),
     num(req.body.detention), num(req.body.overweight), num(req.body.fsc)]
  );
  res.redirect('/invoice?week=' + (week || ''));
});

router.post('/lines/:id/delete', async (req, res) => {
  const pays = await query('SELECT COUNT(*) AS n FROM invoice_payments WHERE line_id = $1', [req.params.id]);
  if (parseInt(pays.rows[0].n, 10) === 0) {
    await query('DELETE FROM invoice_lines WHERE id = $1', [req.params.id]);
  }
  res.redirect('/invoice?week=' + (req.body.week || ''));
});

// Week header: help-ins override, advance chain, received, sent mark.
router.post('/week', async (req, res) => {
  const week = req.body.week;
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
});

module.exports = router;
