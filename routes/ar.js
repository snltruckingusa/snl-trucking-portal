// A/R — Accounts Receivable (admin; CPA reads GET-only, same gate as Invoice).
//
// Money IN, per customer. Customers are generic (ar_customers); the
// first is PierLink, whose claims are read LIVE from the invoice
// system — never copied:
//   Claimed(week) = SUM over invoice_lines of that claim_week of
//                   (rate + prepull + reefer + detention + overweight
//                    + fsc)   — the same lineTotal as routes/invoice.js.
// Other customers keep manual claim weeks in ar_claims.
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
  requireLogin, num, fmtDate, toISODate, weekStart,
} = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin);
router.use((req, res, next) => {
  const u = req.session && req.session.user;
  if (u && u.role === 'admin') return next();
  if (u && u.role === 'cpa' && req.method === 'GET') return next();
  return res.status(403).send('Forbidden — admin only.');
});

const ENTRY_KINDS = ['listed', 'received'];
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

// Build the week-by-week picture for one customer: claims (invoice or
// manual), listed/received sums, and — for the invoice-linked
// customer — the invoice page's own per-line payments as a reference.
async function customerWeeks(customer) {
  const byWeek = new Map();
  const row = (wk) => {
    if (!byWeek.has(wk)) byWeek.set(wk, { week: wk, claimed: 0, listed: 0, received: 0, invoicePaid: 0 });
    return byWeek.get(wk);
  };
  if (customer.invoice_linked) {
    const claims = (await query(
      `SELECT claim_week AS wk, SUM(rate + prepull + reefer + detention + overweight + fsc) AS claimed
       FROM invoice_lines GROUP BY claim_week`
    )).rows;
    for (const c of claims) row(asISO(c.wk)).claimed = r2(c.claimed);
    const ref = (await query(
      `SELECT il.claim_week AS wk, SUM(ip.amount) AS amt
       FROM invoice_payments ip JOIN invoice_lines il ON il.id = ip.line_id
       GROUP BY il.claim_week`
    )).rows;
    for (const p of ref) row(asISO(p.wk)).invoicePaid = r2(p.amt);
  } else {
    const claims = (await query(
      'SELECT week_of AS wk, SUM(amount) AS claimed FROM ar_claims WHERE customer_id = $1 GROUP BY week_of',
      [customer.id]
    )).rows;
    for (const c of claims) row(asISO(c.wk)).claimed = r2(c.claimed);
  }
  const entries = (await query(
    'SELECT week_of AS wk, kind, SUM(amount) AS amt FROM ar_entries WHERE customer_id = $1 GROUP BY week_of, kind',
    [customer.id]
  )).rows;
  for (const e of entries) {
    const w = row(asISO(e.wk));
    if (e.kind === 'listed') w.listed = r2(e.amt);
    else if (e.kind === 'received') w.received = r2(e.amt);
  }
  const weeks = [...byWeek.values()]
    .filter(w => w.week && (w.claimed !== 0 || w.listed !== 0 || w.received !== 0 || w.invoicePaid !== 0))
    .map(w => ({ ...w, status: weekStatus(w) }));
  weeks.sort((a, b) => (a.week < b.week ? 1 : -1)); // newest first
  return weeks;
}

function customerTotals(weeks) {
  const t = { claimed: 0, listed: 0, received: 0, balance: 0, openWeeks: 0 };
  for (const w of weeks) {
    t.claimed = r2(t.claimed + w.claimed);
    t.listed = r2(t.listed + w.listed);
    t.received = r2(t.received + w.received);
    if (w.status.key !== 'closed' && (w.claimed > 0 || w.received > 0)) t.openWeeks++;
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
        if (w.status.key !== 'closed' && (w.claimed > 0 || w.received > 0)) {
          const ageDays = Math.max(0, Math.round((parseISO(today) - parseISO(w.week)) / 86400000));
          openDiffs.push({ customer: c, ...w, ageWeeks: Math.floor(ageDays / 7) });
        }
      }
    }
    cards.receivable = r2(custRows.reduce((a, c) => a + c.totals.balance, 0));
    openDiffs.sort((a, b) => (a.week < b.week ? -1 : 1)); // oldest first

    const receipts = (await query(
      `SELECT e.*, c.name AS customer_name FROM ar_entries e
       JOIN ar_customers c ON c.id = e.customer_id
       WHERE e.kind = 'received' ORDER BY e.entry_date DESC, e.id DESC LIMIT 8`
    )).rows.map(r => ({ ...r, entry_date: asISO(r.entry_date), week_of: asISO(r.week_of) }));

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
    )).rows.map(r => ({ ...r, entry_date: asISO(r.entry_date), week_of: asISO(r.week_of) }));
    let claims = [];
    if (!customer.invoice_linked) {
      claims = (await query(
        'SELECT * FROM ar_claims WHERE customer_id = $1 ORDER BY week_of DESC, id DESC',
        [customer.id]
      )).rows.map(r => ({ ...r, week_of: asISO(r.week_of) }));
    }
    return res.render('ar', {
      title: 'A/R', view: 'customer', canWrite, todayISO: todayISO(),
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
    const entryDate = parseISO(req.body.entry_date) ? String(req.body.entry_date).slice(0, 10) : todayISO();
    if (customerId && kind && week && amount > 0) {
      await query(
        'INSERT INTO ar_entries (customer_id, week_of, kind, amount, entry_date, method, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [customerId, week, kind, amount, entryDate,
         ENTRY_METHODS.includes(req.body.method) ? req.body.method : null,
         (req.body.note || '').trim() || null]
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
module.exports.arHelpers = { weekStatus, customerTotals, snapWeek, asISO, parseISO };
