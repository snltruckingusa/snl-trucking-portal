// A/R — Accounts Receivable (admin; CPA reads GET-only, same gate as Invoice).
//
// Money IN, per customer. Customers are generic (ar_customers); the
// first is PierLink, whose claims are read LIVE from the invoice
// system — never copied:
//   Claimed(week) = SUM over the week's claim-list LEGS (the leg
//                   split in routes/invoice.js claimHelpers: leg 1
//                   lands in the delivery week, leg 2 in the return
//                   week; pending leg 2s are not claimed yet). This
//                   matches the PierLink claim list Eric sends AND
//                   PierLink's own leg-by-leg statements, so a week's
//                   difference can be chased container by container.
// Other customers keep manual claim weeks in ar_claims.
//
// Difference decomposition (2026-11-28): a week's difference
// (claimed - received) is shown as explained + unexplained parts.
// Automatic explainers for the invoice-linked customer: the weekly
// advance Deduct (deposits arrive net of it) and the Help Ins legs
// PierLink books on top of our claim. On top of those, Eric can
// record 'adjustment' entries (amount + required note) — a reason
// that stays displayed with the difference. Adjustment entries never
// count in Listed/Received sums. Money received for OLD, non-claim
// items (e.g. the October adjustment debt) does NOT belong in a
// claim week at all: it is booked under its own manual-claims
// customer (e.g. "PierLink — Prior Adjustments"), so claim weeks
// stay clean; a mixed deposit is split into two entries at record
// time (rows for a week already add up).
//
// Weekly remittance matching, at week granularity (Sun–Sat):
//   Claimed  — what we say the week is worth.
//   Listed   — what the customer announced on their weekly deposit
//              list (ar_entries, kind 'listed').
//   Received — deposits that actually landed (ar_entries, 'received').
// A week whose claimed ≠ received stays OPEN with the difference —
// money is accounted for as: claimed = received + still owed, to the
// cent, for every week. Multiple listed/received rows per week SUM
// (partial deposits are normal).
//
// Note: the invoice page ALSO nets a Help-Ins subsidy and a $500/week
// advance deduction in its footer, and records per-line payments for
// its printed claim chain. Those live only on the Invoice page; A/R
// claims are the pure line totals, and the drill-down shows the
// invoice-page payments per claim week as a read-only reference so
// the two views can be reconciled while both are in use.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, num, fmtDate, toISODate, weekStart, weekEnd,
} = require('../lib/helpers');

// The leg split lives in the invoice module (one source of the money
// rules); A/R claimed totals must use the identical split or the two
// sections silently disagree. No require cycle: invoice.js never
// requires this module.
const { claimHelpers } = require('./invoice');
const { lineLegs, CLAIM_BASELINE_WEEK } = claimHelpers;

const router = express.Router();
router.use(requireLogin);
router.use((req, res, next) => {
  const u = req.session && req.session.user;
  if (u && u.role === 'admin') return next();
  if (u && u.role === 'cpa' && req.method === 'GET') return next();
  return res.status(403).send('Forbidden — admin only.');
});

const ENTRY_KINDS = ['listed', 'received', 'adjustment'];
const ENTRY_METHODS = ['ach', 'wire', 'check', 'zelle', 'other'];
const DONUT_COLORS = ['#4f8ff7', '#f5a623', '#3bb273', '#9aa3ad', '#8e6cc8', '#d95f76', '#3aa6a0'];

const r2 = (n) => Math.round(num(n) * 100) / 100;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseISO(s) {
  if (!s || !ISO_RE.test(String(s))) return null;
  const d = new Date(String(s) + 'T00:00:00');
  return isNaN(d) ? null : d;
}
function asISO(v) {
  if (!v) return null;
  if (v instanceof Date) return fmtDate(v) || null;
  const s = String(v).slice(0, 10);
  if (ISO_RE.test(s)) return s;
  return fmtDate(v) || null;
}
function todayISO() { return toISODate(new Date()); }
// Any entered date snaps to its week (Sunday), matching the rest of
// the portal. Returns null for an unparseable date.
function snapWeek(v) {
  const d = parseISO(v);
  if (!d) return null;
  return toISODate(weekStart(d));
}

// Display only (Eric, 2026-11-28): weeks are STORED and matched by
// their Sunday — that is the key invoice_lines.claim_week and
// ar_entries.week_of carry, and it does not change. But Eric's week
// is referred to by its ENDING Saturday (the invoice goes out
// Saturday), because a bare Sunday label is ambiguous — it can be
// read as the Sunday that opens this week or the following Sunday.
// Labels are derived from the stored Sunday at render time; no
// stored data is rewritten.
function weekEndISO(sundayISO) {
  const d = parseISO(sundayISO);
  if (!d) return null;
  return toISODate(weekEnd(d));
}
function weekLabel(sundayISO) {
  const sat = weekEndISO(sundayISO);
  return sat ? ('Week ending Sat ' + sat) : (sundayISO || '');
}

// The PierLink customer row is ensured at runtime (schema.sql carries
// no data inserts). Admin paths only — CPA reads stay pure reads.
async function ensurePierLink() {
  await query(
    "INSERT INTO ar_customers (name, invoice_linked) VALUES ('PierLink', true) ON CONFLICT (name) DO NOTHING"
  );
  await query(
    "UPDATE ar_customers SET invoice_linked = true WHERE name = 'PierLink' AND invoice_linked = false"
  );
}

function weekStatus(w) {
  const diff = r2(w.claimed - w.received);
  if (w.claimed > 0 && Math.abs(diff) <= 0.004) return { key: 'closed', label: 'Closed', diff };
  if (w.claimed <= 0 && w.received > 0) return { key: 'noclaim', label: 'No claim recorded', diff };
  if (w.claimed <= 0 && w.listed > 0) return { key: 'noclaim', label: 'Listed, no claim', diff };
  if (w.received <= 0 && w.claimed > 0) return { key: 'open', label: 'Open', diff };
  if (diff > 0) return { key: 'partial', label: 'Partial', diff };
  return { key: 'over', label: 'Over-received', diff };
}

// Decompose one week's difference (claimed - received) into the
// explained parts + the unexplained remainder. Items are
// { label, amount } in difference orientation — the amount of the
// difference they account for, signed as it appears in the
// difference. Pure function, exported for tests.
function decompose(diff, explainedItems) {
  const explained = r2((explainedItems || []).reduce((a, i) => a + num(i.amount), 0));
  return { explained, unexplained: r2(num(diff) - explained) };
}

// Sealed pre-baseline weeks (Eric, 2026-11-28): for weeks before the
// claim baseline, A/R claimed is NOT recomputed from portal lines —
// the portal's line population for those weeks was rebuilt during
// the November catch-up and does not reproduce what Eric actually
// submitted (line-level gaps of +$100 / −$465 against his workbook).
// The sealed figure is the amount Eric submitted that week, his
// Excel S.Total (Total + Help Ins − Deduct), taken from his workbook
// (Driver_s_Payment, 'Pierlink' sheet footers) and confirmed by Eric
// on 2026-11-28: week ending Sat 2026-11-14 = $27,505.00 (Total
// $27,735 + Help Ins $270 − Deduct $500); week ending Sat 2026-11-21
// = $18,630.00 (Total $18,935 + Help Ins $195 − Deduct $500). The
// automatic difference explainers (advance deduct, Help Ins) do NOT
// apply to a sealed week — both are already inside its S.Total; only
// Eric's recorded adjustment entries explain a sealed difference.
const SEALED_WEEK_CLAIMS = { '2026-11-08': 27505, '2026-11-15': 18630 };

// Build the week-by-week picture for one customer: claims (invoice or
// manual), listed/received sums, deposit dates, recorded difference
// reasons, and — for the invoice-linked customer — the invoice page's
// own per-line payments as a reference.
async function customerWeeks(customer) {
  const byWeek = new Map();
  const row = (wk) => {
    if (!byWeek.has(wk)) byWeek.set(wk, {
      week: wk, claimed: 0, listed: 0, received: 0, invoicePaid: 0,
      helpIns: 0, receivedDates: [], adjustments: [],
    });
    return byWeek.get(wk);
  };
  const deductByWeek = {};
  if (customer.invoice_linked) {
    // Claimed = the week's claim-list legs (identical split to the
    // PierLink claim list — see claimHelpers in routes/invoice.js).
    const lines = (await query(
      `SELECT il.*, l.load_date, l.delivery AS load_delivery, l.progress,
              l.returned_on, l.container_no, l.truck_number
       FROM invoice_lines il LEFT JOIN loads l ON l.id = il.load_id`
    )).rows;
    for (const l of lines) {
      const lineWeek = asISO(l.claim_week);
      if (lineWeek && lineWeek < CLAIM_BASELINE_WEEK) continue; // sealed — see SEALED_WEEK_CLAIMS below
      for (const leg of lineLegs(l, l.load_id ? l : null)) {
        if (leg.pending || !leg.weekISO) continue;
        const w = row(leg.weekISO);
        w.claimed = r2(w.claimed + leg.claim);
        w.helpIns = r2(w.helpIns + leg.insurance);
      }
    }
    // Sealed weeks carry Eric's submitted figures, verbatim.
    for (const [wk, amt] of Object.entries(SEALED_WEEK_CLAIMS)) {
      const w = row(wk);
      w.claimed = r2(amt);
      w.sealed = true;
    }
    const ref = (await query(
      `SELECT il.claim_week AS wk, SUM(ip.amount) AS amt
       FROM invoice_payments ip JOIN invoice_lines il ON il.id = ip.line_id
       GROUP BY il.claim_week`
    )).rows;
    for (const p of ref) row(asISO(p.wk)).invoicePaid = r2(p.amt);
    const iw = (await query('SELECT week_start, advance_deduct FROM invoice_weeks')).rows;
    for (const r of iw) deductByWeek[asISO(r.week_start)] = num(r.advance_deduct);
  } else {
    const claims = (await query(
      'SELECT week_of AS wk, SUM(amount) AS claimed FROM ar_claims WHERE customer_id = $1 GROUP BY week_of',
      [customer.id]
    )).rows;
    for (const c of claims) row(asISO(c.wk)).claimed = r2(c.claimed);
  }
  const entries = (await query(
    'SELECT week_of AS wk, kind, amount, entry_date, note FROM ar_entries WHERE customer_id = $1 ORDER BY entry_date, id',
    [customer.id]
  )).rows;
  for (const e of entries) {
    const w = row(asISO(e.wk));
    if (e.kind === 'listed') {
      w.listed = r2(w.listed + num(e.amount));
    } else if (e.kind === 'received') {
      w.received = r2(w.received + num(e.amount));
      const dISO = asISO(e.entry_date);
      if (dISO && !w.receivedDates.includes(dISO)) w.receivedDates.push(dISO);
    } else if (e.kind === 'adjustment') {
      w.adjustments.push({ amount: r2(e.amount), note: e.note || '', entry_date: asISO(e.entry_date) });
    }
  }
  const weeks = [...byWeek.values()]
    .filter(w => w.week && (w.claimed !== 0 || w.listed !== 0 || w.received !== 0 || w.invoicePaid !== 0 || w.adjustments.length))
    .map(w => {
      let status = weekStatus(w);
      // Difference decomposition: automatic explainers first
      // (invoice-linked weeks), then Eric's recorded reasons.
      const items = [];
      if (customer.invoice_linked && !w.sealed) {
        const ded = deductByWeek[w.week];
        if (ded) items.push({ label: 'Advance deduct — deposits arrive net of it', amount: r2(ded) });
        if (w.helpIns) items.push({ label: 'Help Ins PierLink books on top of our claim', amount: r2(-w.helpIns) });
      }
      for (const a of w.adjustments) items.push({ label: a.note || 'Recorded reason', amount: a.amount });
      const dec = decompose(status.diff, items);
      // A difference that is fully explained is accounted for: it
      // leaves the open list (but stays visible here, with its
      // reasons, on the customer page).
      if (status.key !== 'closed' && status.key !== 'noclaim'
        && Math.abs(status.diff) > 0.004 && Math.abs(dec.unexplained) <= 0.004) {
        status = { ...status, key: 'explained', label: 'Explained' };
      }
      return { ...w, weekLabel: weekLabel(w.week), status,
        explainedItems: items, explained: dec.explained, unexplained: dec.unexplained };
    });
  weeks.sort((a, b) => (a.week < b.week ? 1 : -1)); // newest first
  return weeks;
}

function customerTotals(weeks) {
  const t = { claimed: 0, listed: 0, received: 0, balance: 0, openWeeks: 0 };
  for (const w of weeks) {
    t.claimed = r2(t.claimed + w.claimed);
    t.listed = r2(t.listed + w.listed);
    t.received = r2(t.received + w.received);
    if (w.status.key !== 'closed' && w.status.key !== 'explained' && (w.claimed > 0 || w.received > 0)) t.openWeeks++;
  }
  t.balance = r2(t.claimed - t.received);
  return t;
}

// ---- Home ------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const canWrite = req.session.user.role === 'admin';
    if (canWrite) await ensurePierLink();
    const customers = (await query(
      'SELECT * FROM ar_customers WHERE active ORDER BY invoice_linked DESC, name'
    )).rows;
    const today = todayISO();
    const cards = { receivable: 0, claimed: 0, received: 0, openWeeks: 0 };
    const custRows = [];
    const openDiffs = [];
    for (const c of customers) {
      const weeks = await customerWeeks(c);
      const t = customerTotals(weeks);
      custRows.push({ customer: c, totals: t });
      cards.claimed = r2(cards.claimed + t.claimed);
      cards.received = r2(cards.received + t.received);
      cards.openWeeks += t.openWeeks;
      for (const w of weeks) {
        if (w.status.key !== 'closed' && w.status.key !== 'explained' && (w.claimed > 0 || w.received > 0)) {
          const ageDays = Math.max(0, Math.round((parseISO(today) - parseISO(w.week)) / 86400000));
          openDiffs.push({ customer: c, ...w, ageWeeks: Math.floor(ageDays / 7) });
        }
      }
    }
    cards.receivable = r2(custRows.reduce((a, c) => a + c.totals.balance, 0));
    openDiffs.sort((a, b) => (a.week < b.week ? 1 : -1)); // newest first (Eric, 2026-11-28)

    const receipts = (await query(
      `SELECT e.*, c.name AS customer_name FROM ar_entries e
       JOIN ar_customers c ON c.id = e.customer_id
       WHERE e.kind = 'received' ORDER BY e.entry_date DESC, e.id DESC LIMIT 8`
    )).rows.map(r => {
      const wk = asISO(r.week_of);
      return { ...r, entry_date: asISO(r.entry_date), week_of: wk, weekLabel: weekLabel(wk) };
    });

    // Donut: positive customer balances, center = total receivable.
    const positives = custRows.filter(c => c.totals.balance > 0);
    const posSum = r2(positives.reduce((a, c) => a + c.totals.balance, 0));
    let donut = null;
    if (posSum > 0) {
      let acc = 0;
      donut = {
        total: cards.receivable,
        slices: positives.map((c, i) => {
          const pct = Math.round((c.totals.balance / posSum) * 10000) / 100;
          const seg = { label: c.customer.name, amount: c.totals.balance, pct, color: DONUT_COLORS[i % DONUT_COLORS.length], offset: -acc };
          acc = Math.round((acc + pct) * 100) / 100;
          return seg;
        }),
      };
    }

    return res.render('ar', {
      title: 'A/R', view: 'home', canWrite, todayISO: today,
      claimListWeek: toISODate(weekStart(new Date())),
      cards, custRows, openDiffs: openDiffs.slice(0, 15), openDiffCount: openDiffs.length,
      receipts, donut,
      customer: null, weeks: [], entries: [], claims: [],
    });
  } catch (e) {
    console.error('ar GET / failed:', e);
    return res.status(500).send('A/R failed to load. Please try again.');
  }
});

// ---- Customer drill-down ------------------------------------------------------
router.get('/customer/:id', async (req, res) => {
  try {
    const canWrite = req.session.user.role === 'admin';
    if (canWrite) await ensurePierLink();
    const customer = (await query('SELECT * FROM ar_customers WHERE id = $1', [req.params.id])).rows[0];
    if (!customer) return res.redirect('/ar');
    const weeks = await customerWeeks(customer);
    const totals = customerTotals(weeks);
    const entries = (await query(
      'SELECT * FROM ar_entries WHERE customer_id = $1 ORDER BY entry_date DESC, id DESC LIMIT 100',
      [customer.id]
    )).rows.map(r => {
      const wk = asISO(r.week_of);
      return { ...r, entry_date: asISO(r.entry_date), week_of: wk, weekLabel: weekLabel(wk) };
    });
    let claims = [];
    if (!customer.invoice_linked) {
      claims = (await query(
        'SELECT * FROM ar_claims WHERE customer_id = $1 ORDER BY week_of DESC, id DESC',
        [customer.id]
      )).rows.map(r => {
        const wk = asISO(r.week_of);
        return { ...r, week_of: wk, weekLabel: weekLabel(wk) };
      });
    }
    return res.render('ar', {
      title: 'A/R', view: 'customer', canWrite, todayISO: todayISO(),
      claimListWeek: toISODate(weekStart(new Date())),
      cards: null, custRows: [], openDiffs: [], openDiffCount: 0, receipts: [], donut: null,
      customer: { ...customer, totals }, weeks, entries, claims,
      entryKinds: ENTRY_KINDS, entryMethods: ENTRY_METHODS,
    });
  } catch (e) {
    console.error('ar GET customer failed:', e);
    return res.redirect('/ar');
  }
});

// ---- Writes (admin only — the gate above already blocks CPA POSTs) -----------
router.post('/customers', async (req, res) => {
  try {
    await ensurePierLink();
    const name = (req.body.name || '').trim();
    if (name) {
      await query(
        'INSERT INTO ar_customers (name, invoice_linked, note) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING',
        [name, req.body.invoice_linked === 'on', (req.body.note || '').trim() || null]
      );
    }
    return res.redirect('/ar');
  } catch (e) {
    console.error('ar customer create failed:', e);
    return res.redirect('/ar');
  }
});

router.post('/entries', async (req, res) => {
  const back = '/ar/customer/' + (parseInt(req.body.customer_id, 10) || '');
  try {
    const customerId = parseInt(req.body.customer_id, 10);
    const kind = ENTRY_KINDS.includes(req.body.kind) ? req.body.kind : null;
    const week = snapWeek(req.body.week_of);
    const amount = num(req.body.amount);
    const note = (req.body.note || '').trim() || null;
    const entryDate = parseISO(req.body.entry_date) ? String(req.body.entry_date).slice(0, 10) : todayISO();
    // An 'adjustment' entry is a recorded difference reason: any
    // non-zero amount (signed as it appears in the week's
    // difference), note required, never summed into Listed/Received.
    const acceptable = kind === 'adjustment'
      ? (amount !== 0 && !!note)
      : (amount > 0);
    if (customerId && kind && week && acceptable) {
      await query(
        'INSERT INTO ar_entries (customer_id, week_of, kind, amount, entry_date, method, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [customerId, week, kind, amount, entryDate,
         ENTRY_METHODS.includes(req.body.method) ? req.body.method : null,
         note]
      );
    }
    return res.redirect(back);
  } catch (e) {
    console.error('ar entry create failed:', e);
    return res.redirect(back);
  }
});

router.post('/entries/:id/delete', async (req, res) => {
  try {
    const row = (await query('SELECT customer_id FROM ar_entries WHERE id = $1', [req.params.id])).rows[0];
    await query('DELETE FROM ar_entries WHERE id = $1', [req.params.id]);
    return res.redirect('/ar/customer/' + (row ? row.customer_id : ''));
  } catch (e) {
    console.error('ar entry delete failed:', e);
    return res.redirect('/ar');
  }
});

router.post('/claims', async (req, res) => {
  const back = '/ar/customer/' + (parseInt(req.body.customer_id, 10) || '');
  try {
    const customerId = parseInt(req.body.customer_id, 10);
    const week = snapWeek(req.body.week_of);
    const amount = num(req.body.amount);
    const customer = customerId
      ? (await query('SELECT * FROM ar_customers WHERE id = $1', [customerId])).rows[0] : null;
    // Manual claims exist only for customers NOT linked to the invoice
    // system — a linked customer's claims are its invoice lines, full stop.
    if (customer && !customer.invoice_linked && week && amount > 0) {
      await query(
        'INSERT INTO ar_claims (customer_id, week_of, amount, note) VALUES ($1,$2,$3,$4)',
        [customerId, week, amount, (req.body.note || '').trim() || null]
      );
    }
    return res.redirect(back);
  } catch (e) {
    console.error('ar claim create failed:', e);
    return res.redirect(back);
  }
});

router.post('/claims/:id/delete', async (req, res) => {
  try {
    const row = (await query('SELECT customer_id FROM ar_claims WHERE id = $1', [req.params.id])).rows[0];
    await query('DELETE FROM ar_claims WHERE id = $1', [req.params.id]);
    return res.redirect('/ar/customer/' + (row ? row.customer_id : ''));
  } catch (e) {
    console.error('ar claim delete failed:', e);
    return res.redirect('/ar');
  }
});

module.exports = router;
// Exported for tests, same pattern as routes/settlement.js computeWeek.
module.exports.arHelpers = { weekStatus, customerTotals, snapWeek, asISO, parseISO, weekEndISO, weekLabel, decompose, customerWeeks };
