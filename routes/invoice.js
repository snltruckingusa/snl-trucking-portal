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
  return num(l.rate) + num(l.return_fee) + num(l.prepull) + num(l.reefer) + num(l.detention)
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
    `INSERT INTO invoice_lines (load_id, driver_id, claim_week, description, rate, return_fee, prepull, reefer, detention, overweight, fsc)
     SELECT l.id, l.driver_id, $1, l.delivery, l.rate, l.return_fee, l.prepull, l.reefer,
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
// PierLink claim list (2026-11-28) — the Saturday send-sheet, rendered
// the way PierLink's own statements are built: ONE-WAY LEGS (편도).
// Leg 1 = pickup -> delivery (the week of the load's date); leg 2 =
// delivery -> empty return (the week of returned_on). PierLink splits
// a round trip 50/50 across the legs — verified against their Payroll
// Detail statements (reconciliation 2026-11-20: a $1,650 round trip
// pays as $825 + $825; a lone return leg pays $757.50 / $795.00) — so
// the component placement mirrors theirs:
//   halved 50/50 : rate, reefer, overweight, fsc
//                  (leg 2 takes the remainder, so the halves always
//                  sum back to the line total to the cent)
//   leg 1 only   : detention (the wait happens at delivery; the
//                  line amount is already dispatcher-approval-gated
//                  at line creation)
//   leg 2 only   : return_fee (payment for the return movement
//                  itself), prepull (Eric's decision 2026-11-28,
//                  Q2: P/P is claimed with the return leg)
// Help Ins: PierLink books the $15/load subsidy as $7.50 PER LEG
// inside their leg amounts. On our list it is its own Insurance
// column, but it is NOT part of a leg's claim Total — Eric's claim
// totals exclude the subsidy by design (a company subsidy, not load
// money), so Total = claim components, and the Insurance column is
// the memo PierLink adds on their side (it re-enters the money only
// in the footer's "expected deposit" line). Eligibility mirrors the
// invoice footer rule: trucks 100/101/200/201, leg week inside the
// policy window (until 2027-09-30).
//
// Two clocks stay visible: a delivered-but-not-returned load shows
// its leg 1 with real amounts AND a $0 leg-2 placeholder line
// (container number + delivery date/destination, "Empty not returned
// — not claimed yet"), so the outstanding container is never
// forgotten. The placeholder's upcoming leg-2 amount sums into the
// block's "Payment for Next week (Mty Not Return)" line, exactly as
// in Eric's Excel. When the return lands in a later week, the real
// leg-2 line appears in THAT week's list and counts toward that
// block's "Previous unpaid amount (Mty Return)" context.
// ---------------------------------------------------------------------------
const HELP_INS_LEG = 7.5;
const HELP_INS_TRUCKS = ['100', '101', '200', '201'];

// Claim baseline (Eric, 2026-11-28): weeks before 2026-11-22 were
// claimed through Eric's Excel and stay sealed as their own weeks —
// last week's unpaid is last week's, carried in that week's own A/R
// row, and never rolls into a later week's claim as a lump sum. The
// only carry-over is a container whose empty is still out, and its
// return leg is claimed in the week the return actually happens —
// the same shape as PierLink's own statements. Without this cut, the
// November catch-up's entry-date returned_on stamps would sweep
// $21,000 of already-submitted return legs into the baseline week's
// list (a double claim). The one genuine open chain (Darrell
// MRSU6826315 return leg $750 + one Brinceson return leg $787.50)
// re-enters once, as manual lines in the baseline week itself.
const CLAIM_BASELINE_WEEK = '2026-11-22';

function sundayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return null;
  return toISODate(weekStart(d));
}

function half(v) { return Math.round((num(v) / 2) * 100) / 100; }

// Expand one claim line into its legs. `line` is an invoice_lines row;
// `load` is the joined loads row (load_date / returned_on / progress /
// container_no / truck_number / delivery), or null for a manual line.
// Each leg: { leg, dateISO, weekISO (Sunday), pending, components...,
// insurance, claim, total } — claim = component sum (what Eric's Paid
// counts), total = claim + insurance (what PierLink's statement shows
// for the leg). A pending leg 2 carries $0 everywhere (display only).
// Manual lines have no legs: one row in their claim week, no
// insurance (a standalone service claim is not a round trip; PierLink
// pays no subsidy on return-only statement legs either —
// reconciliation 2026-11-20).
function lineLegs(line, load) {
  const base = {
    lineId: line.id, driverId: line.driver_id,
    description: line.description || (load && (load.load_delivery || load.delivery)) || '',
    container: (load && load.container_no) || '',
    truck: (load && load.truck_number) || '',
  };
  if (!load) {
    const claim = lineTotal(line);
    return [{
      ...base, leg: 0, manual: true,
      dateISO: fmtDate(line.claim_week), weekISO: fmtDate(line.claim_week),
      pending: false,
      rate: num(line.rate), returnFee: num(line.return_fee), prepull: num(line.prepull),
      reefer: num(line.reefer), detention: num(line.detention),
      overweight: num(line.overweight), fsc: num(line.fsc),
      insurance: 0, claim, total: claim,
    }];
  }
  const loadISO = fmtDate(load.load_date);
  const retISO = fmtDate(load.returned_on);
  const eligible = HELP_INS_TRUCKS.includes(String(load.truck_number || '').replace(/^#/, ''));
  const insFor = (wkISO) => (eligible && wkISO && wkISO <= HELP_INS_UNTIL ? HELP_INS_LEG : 0);
  const mk = (leg, dateISO, wkISO, comps, pending) => {
    const claim = r2(comps.rate + comps.returnFee + comps.prepull + comps.reefer
      + comps.detention + comps.overweight + comps.fsc);
    const insurance = pending ? 0 : insFor(wkISO);
    return { ...base, leg, manual: false, dateISO, weekISO: wkISO, pending, ...comps,
      insurance, claim, total: r2(claim + insurance) };
  };
  const leg1 = mk(1, loadISO, sundayOf(loadISO), {
    rate: half(line.rate), returnFee: 0, prepull: 0,
    reefer: half(line.reefer), detention: num(line.detention),
    overweight: half(line.overweight), fsc: half(line.fsc),
  }, false);
  const leg2 = mk(2, retISO || loadISO, retISO ? sundayOf(retISO) : null, {
    rate: r2(num(line.rate) - leg1.rate), returnFee: num(line.return_fee),
    prepull: num(line.prepull), reefer: r2(num(line.reefer) - leg1.reefer), detention: 0,
    overweight: r2(num(line.overweight) - leg1.overweight),
    fsc: r2(num(line.fsc) - leg1.fsc),
  }, !retISO);
  return [leg1, leg2];
}

// Assemble the claim list for one week (Sunday key; the page labels
// it by its Saturday). Reads the SAME invoice_lines as the invoice
// pages and A/R — one source, no second copy of the money.
async function buildClaimList(weekISO, canWrite) {
  const ws = new Date(weekISO + 'T00:00:00');
  const weISO = toISODate(weekEnd(ws));
  let week;
  if (canWrite) {
    week = await ensureWeek(weekISO);
    await ensureLines(weekISO, weISO);
  } else {
    // CPA reads stay pure reads (same rule as A/R): no week/line
    // creation on a read-only view.
    const r = await query('SELECT * FROM invoice_weeks WHERE week_start = $1', [weekISO]);
    week = r.rows[0] || { week_start: weekISO, advance_deduct: 500, received: 0, help_ins_override: null, sent_at: null };
  }

  const drivers = (await query('SELECT * FROM drivers ORDER BY name')).rows;
  const lines = (await query(
    `SELECT il.*, l.load_date, l.delivery AS load_delivery, l.progress,
            l.returned_on, l.container_no, l.truck_number
     FROM invoice_lines il LEFT JOIN loads l ON l.id = il.load_id
     ORDER BY il.driver_id, il.id`
  )).rows;

  const blocks = [];
  let totalClaim = 0, totalInsurance = 0, totalGross = 0;
  for (const d of drivers) {
    const rows = [], stillOut = [];
    let prevUnpaid = 0, claim = 0, insurance = 0, holdTotal = 0, stillOutTotal = 0;
    for (const l of lines) {
      if (l.driver_id !== d.id) continue;
      if (fmtDate(l.claim_week) < CLAIM_BASELINE_WEEK) continue; // sealed pre-baseline history (claimed via Excel)
      const legs = lineLegs(l, l.load_id ? l : null);
      for (const leg of legs) {
        if (leg.manual) {
          if (leg.weekISO === weekISO) rows.push(leg);
          continue;
        }
        if (leg.leg === 1) {
          if (leg.weekISO === weekISO) rows.push(leg);
          continue;
        }
        // Leg 2.
        if (!leg.pending) {
          if (leg.weekISO === weekISO) {
            rows.push(leg);
            // A return leg claimed this week for a load delivered in
            // an earlier week is the carried-in "Previous unpaid".
            if (legs[0].weekISO && legs[0].weekISO < weekISO) prevUnpaid = r2(prevUnpaid + leg.claim);
          }
        } else if (legs[0].weekISO === weekISO) {
          // Delivered this week, empty still out: $0 placeholder line
          // in this week's block + its amount in the hold total.
          rows.push(leg);
          holdTotal = r2(holdTotal + leg.claim);
        } else if (legs[0].weekISO && legs[0].weekISO < weekISO) {
          // Still out from an earlier week — stays visible, listed
          // separately so this week's hold line keeps Eric's shape.
          stillOut.push(leg);
          stillOutTotal = r2(stillOutTotal + leg.claim);
        }
      }
    }
    rows.sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.leg - b.leg));
    for (const r of rows) {
      if (r.pending) continue;
      claim = r2(claim + r.claim);
      insurance = r2(insurance + r.insurance);
    }
    if (!rows.length && !stillOut.length) continue;
    totalClaim = r2(totalClaim + claim);
    totalInsurance = r2(totalInsurance + insurance);
    blocks.push({ driver: d, rows, stillOut, prevUnpaid, claim, insurance, holdTotal, stillOutTotal });
  }
  totalGross = r2(totalClaim + totalInsurance);

  const deduct = num(week.advance_deduct);
  const insuranceUsed = (week.help_ins_override !== null && week.help_ins_override !== undefined)
    ? num(week.help_ins_override) : totalInsurance;
  // Received ties to A/R when PierLink deposits are recorded there
  // (the A/R entries are the newer record); the invoice week's own
  // received figure is the fallback.
  let receivedAR = 0;
  try {
    const cust = await query('SELECT id FROM ar_customers WHERE invoice_linked = true ORDER BY id LIMIT 1');
    if (cust.rows.length) {
      const s = await query(
        "SELECT COALESCE(SUM(amount),0) AS s FROM ar_entries WHERE customer_id = $1 AND week_of = $2 AND kind = 'received'",
        [cust.rows[0].id, weekISO]
      );
      receivedAR = num(s.rows[0].s);
    }
  } catch (e) { /* A/R tables predate this page on old DBs — fall back silently. */ }
  const received = receivedAR > 0 ? receivedAR : num(week.received);
  const sTotal = r2(totalClaim - deduct);
  const expectedDeposit = r2(totalClaim + insuranceUsed - deduct);
  const balance = r2(sTotal - received);

  return {
    week, weekISO, weekEndISO: weISO, blocks,
    totalClaim, totalInsurance, insuranceUsed, totalGross,
    deduct, received, receivedAR, sTotal, expectedDeposit, balance,
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

// The PierLink claim list (leg-by-leg send sheet). Any date in the
// week is accepted and snapped to its Sunday; the page labels the
// week by its ending Saturday, like A/R.
router.get('/claim-list', async (req, res) => {
  try {
    let wsISO = req.query.week;
    if (!wsISO || !/^\d{4}-\d{2}-\d{2}$/.test(wsISO) || isNaN(new Date(wsISO + 'T00:00:00'))) {
      wsISO = toISODate(weekStart(new Date()));
    } else {
      wsISO = toISODate(weekStart(new Date(wsISO + 'T00:00:00')));
    }
    const canWrite = req.session.user.role === 'admin';
    const data = await buildClaimList(wsISO, canWrite);
    const wsDate = new Date(wsISO + 'T00:00:00');
    return res.render('invoice-claim-list', {
      ...data, canWrite,
      prevWeek: toISODate(addDays(wsDate, -7)),
      nextWeek: toISODate(addDays(wsDate, 7)),
      weekLabel: 'Week ending Sat ' + data.weekEndISO,
    });
  } catch (e) {
    console.error('invoice claim-list failed:', e);
    return res.status(500).send('Claim list failed to load. Please try again.');
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
      `UPDATE invoice_lines SET description=$1, rate=$2, return_fee=$3, prepull=$4, reefer=$5,
         detention=$6, overweight=$7, fsc=$8 WHERE id=$9`,
      [(req.body.description || '').trim() || null, num(req.body.rate), num(req.body.return_fee),
       num(req.body.prepull), num(req.body.reefer), num(req.body.detention),
       num(req.body.overweight), num(req.body.fsc), req.params.id]
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
      `INSERT INTO invoice_lines (load_id, driver_id, claim_week, description, rate, return_fee, prepull, reefer, detention, overweight, fsc)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [driverId, week, (req.body.description || '').trim() || null,
       num(req.body.rate), num(req.body.return_fee), num(req.body.prepull), num(req.body.reefer),
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
// Exported for A/R (leg-based claimed totals must use the identical
// split — one source) and for tests, same pattern as settlement.js.
module.exports.claimHelpers = { lineLegs, lineTotal, buildClaimList, HELP_INS_LEG, HELP_INS_TRUCKS, CLAIM_BASELINE_WEEK };
