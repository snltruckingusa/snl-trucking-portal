// A/P — Accounts Payable (admin; CPA reads GET-only, same gate as Invoice).
//
// Money OUT, in named baskets — never one lump:
//   drivers    — per-driver payables. Two kinds stay separate:
//                'company'  = Occ/Acc, parking — the company pays them
//                           directly; the driver is never charged.
//                'recovery' = fuel / insurance — recovered from driver
//                           pay INSIDE Settlement. A/P does NOT
//                           recalculate them; rows here are manual
//                           records only, shown for the full picture.
//   trucks     — truck insurance, loans, registration.
//   taxes      — state / IRS / UCR / IFTA; the due DATE is the point.
//   operations — other fixed costs.
//
// Each item carries a cadence and a maintained next_due date. Marking
// an item paid records an ap_payments row and rolls next_due forward
// by exactly one period (a missed cycle stays visible until it is
// marked paid too — payment history is never silently skipped).
// Marking a 'once' item paid completes it (active = false).
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, num, fmtDate, toISODate,
} = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin);
// Same gate as routes/invoice.js: admin full access, CPA read-only GET
// (his role is fenced again by the server middleware); drivers and the
// mechanic never reach this section.
router.use((req, res, next) => {
  const u = req.session && req.session.user;
  if (u && u.role === 'admin') return next();
  if (u && u.role === 'cpa' && req.method === 'GET') return next();
  return res.status(403).send('Forbidden — admin only.');
});

const BASKETS = ['drivers', 'trucks', 'taxes', 'operations'];
const BASKET_LABELS = {
  drivers: 'Drivers', trucks: 'Trucks & Equipment', taxes: 'Taxes', operations: 'Operations',
};
const CADENCES = ['weekly', 'monthly', 'quarterly', 'annual', 'once'];
const METHODS = ['card', 'zelle', 'ach', 'check', 'cash'];
const KINDS = ['recovery', 'company'];

const r2 = (n) => Math.round(num(n) * 100) / 100;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseISO(s) {
  if (!s || !ISO_RE.test(String(s))) return null;
  const d = new Date(String(s) + 'T00:00:00');
  return isNaN(d) ? null : d;
}
// Normalize any date-ish value (DB Date, ISO string, form string) to
// 'YYYY-MM-DD' without ever feeding a raw string into Date parsing
// (an ISO string would parse as UTC and shift a day in Eastern time).
function asISO(v) {
  if (!v) return null;
  if (v instanceof Date) return fmtDate(v) || null;
  const s = String(v).slice(0, 10);
  if (ISO_RE.test(s)) return s;
  return fmtDate(v) || null;
}
function todayISO() { return toISODate(new Date()); }

// The day an item is due: the autopay day wins when autopay is on.
function effDueDay(item) {
  if (item.autopay && item.autopay_day !== null && item.autopay_day !== undefined && item.autopay_day !== '') {
    const n = parseInt(item.autopay_day, 10);
    if (!isNaN(n)) return n;
  }
  if (item.due_day !== null && item.due_day !== undefined && item.due_day !== '') {
    const n = parseInt(item.due_day, 10);
    if (!isNaN(n)) return n;
  }
  return null;
}
function anchorISO(item) { return asISO(item.due_date); }

function clampDate(y, m0, day) {
  const last = new Date(y, m0 + 1, 0).getDate();
  return new Date(y, m0, Math.min(Math.max(day, 1), last));
}
function addMonths(date, n, dayWanted) {
  const total = date.getFullYear() * 12 + date.getMonth() + n;
  return clampDate(Math.floor(total / 12), ((total % 12) + 12) % 12, dayWanted);
}

// First due date on or after `todayStr` for a (new) item.
// - due_date, when given and not past, IS the first due date (it also
//   anchors the month for quarterly/annual and the day when due_day
//   is blank).
// - weekly: due_day means day of week (0 = Sun .. 6 = Sat).
// - monthly/quarterly/annual: due_day means day of month (clamped).
function firstDue(item, todayStr) {
  const today = parseISO(todayStr);
  if (!today) return null;
  const anchor = anchorISO(item);
  const anchorD = anchor ? parseISO(anchor) : null;
  if (item.cadence === 'once') return anchor;
  if (anchor && anchor >= todayStr) return anchor;
  const day = effDueDay(item);
  if (item.cadence === 'weekly') {
    const wd = (day !== null && day >= 0 && day <= 6) ? day : (anchorD ? anchorD.getDay() : today.getDay());
    const d = new Date(today);
    d.setDate(d.getDate() + ((wd - d.getDay()) + 7) % 7);
    return toISODate(d);
  }
  const dom = day !== null ? day : (anchorD ? anchorD.getDate() : 1);
  if (item.cadence === 'monthly') {
    let cand = clampDate(today.getFullYear(), today.getMonth(), dom);
    if (cand < today) cand = clampDate(today.getFullYear(), today.getMonth() + 1, dom);
    return toISODate(cand);
  }
  if (item.cadence === 'quarterly') {
    const anchorMonth = anchorD ? anchorD.getMonth() : today.getMonth();
    let base = today.getFullYear() * 12 + anchorMonth;
    const todayAbs = today.getFullYear() * 12 + today.getMonth();
    while (base > todayAbs) base -= 3;
    for (let i = 0; i < 8; i++) {
      const cand = clampDate(Math.floor(base / 12), ((base % 12) + 12) % 12, dom);
      if (cand >= today) return toISODate(cand);
      base += 3;
    }
    return null;
  }
  if (item.cadence === 'annual') {
    const anchorMonth = anchorD ? anchorD.getMonth() : today.getMonth();
    let cand = clampDate(today.getFullYear(), anchorMonth, dom);
    if (cand < today) cand = clampDate(today.getFullYear() + 1, anchorMonth, dom);
    return toISODate(cand);
  }
  return anchor;
}

// Roll a due date forward by exactly one period.
function stepDue(item, currentISO) {
  const cur = parseISO(currentISO);
  if (!cur) return firstDue(item, todayISO());
  const anchorD = anchorISO(item) ? parseISO(anchorISO(item)) : null;
  const day = effDueDay(item);
  const dom = day !== null ? day : (anchorD ? anchorD.getDate() : cur.getDate());
  switch (item.cadence) {
    case 'weekly': { const d = new Date(cur); d.setDate(d.getDate() + 7); return toISODate(d); }
    case 'monthly': return toISODate(addMonths(cur, 1, dom));
    case 'quarterly': return toISODate(addMonths(cur, 3, dom));
    case 'annual': return toISODate(addMonths(cur, 12, dom));
    default: return null; // once
  }
}

// How many times an active item falls due inside one calendar month.
// Weekly counts its weekday's occurrences; monthly is always 1;
// quarterly / annual / once count only when next_due lands in the month.
function occurrencesInMonth(item, y, m0) {
  if (!item.active) return 0;
  if (item.cadence === 'weekly') {
    let wd = null;
    const nd = item.next_due ? parseISO(asISO(item.next_due)) : null;
    if (nd) wd = nd.getDay();
    else {
      const day = effDueDay(item);
      if (day !== null && day >= 0 && day <= 6) wd = day;
      else {
        const a = anchorISO(item) ? parseISO(anchorISO(item)) : null;
        if (a) wd = a.getDay();
      }
    }
    if (wd === null) return 0;
    let count = 0;
    const days = new Date(y, m0 + 1, 0).getDate();
    for (let d = 1; d <= days; d++) if (new Date(y, m0, d).getDay() === wd) count++;
    return count;
  }
  if (item.cadence === 'monthly') return 1;
  if (!item.next_due) return 0;
  const nd = parseISO(asISO(item.next_due));
  return (nd && nd.getFullYear() === y && nd.getMonth() === m0) ? 1 : 0;
}
function monthOut(item, y, m0) { return r2(num(item.amount) * occurrencesInMonth(item, y, m0)); }

function dueStatus(item, todayStr) {
  const nd = asISO(item.next_due);
  if (!nd) return { key: 'nodate', label: 'No date set', days: null };
  const days = Math.round((parseISO(nd) - parseISO(todayStr)) / 86400000);
  if (days < 0) return { key: 'overdue', label: 'Overdue ' + (-days) + 'd', days };
  if (days === 0) return { key: 'today', label: 'Due today', days };
  return { key: 'upcoming', label: 'in ' + days + 'd', days };
}

// ---- Form handling -------------------------------------------------------
function cleanDay(v, min, max) {
  if (v === '' || v === undefined || v === null) return null;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < min || n > max) return null;
  return n;
}
function itemFromBody(body) {
  const basket = BASKETS.includes(body.basket) ? body.basket : 'operations';
  const cadence = CADENCES.includes(body.cadence) ? body.cadence : 'monthly';
  const weekly = cadence === 'weekly';
  return {
    name: (body.name || '').trim(),
    basket,
    kind: basket === 'drivers' ? (KINDS.includes(body.kind) ? body.kind : 'company') : null,
    driver_id: body.driver_id ? (parseInt(body.driver_id, 10) || null) : null,
    amount: Math.max(0, num(body.amount)),
    cadence,
    due_day: cleanDay(body.due_day, weekly ? 0 : 1, weekly ? 6 : 31),
    due_date: parseISO(body.due_date) ? String(body.due_date).slice(0, 10) : null,
    autopay: body.autopay === 'on',
    autopay_day: cleanDay(body.autopay_day, 1, 31),
    method: METHODS.includes(body.method) ? body.method : null,
    note: (body.note || '').trim() || null,
  };
}

// ---- Home ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const canWrite = req.session.user.role === 'admin';
    const today = todayISO();
    const now = new Date();
    const y = now.getFullYear(), m0 = now.getMonth();
    const rows = (await query(
      `SELECT i.*, d.name AS driver_name FROM ap_items i
       LEFT JOIN drivers d ON d.id = i.driver_id
       ORDER BY i.name`
    )).rows;
    const drivers = (await query('SELECT id, name FROM drivers ORDER BY name')).rows;

    const items = rows.map(it => ({
      ...it,
      nextDueISO: asISO(it.next_due),
      status: dueStatus(it, today),
      monthOut: monthOut(it, y, m0),
    }));
    const active = items.filter(i => i.active);
    const inactive = items.filter(i => !i.active);
    const upcoming = active.slice().sort((a, b) => {
      if (a.nextDueISO === b.nextDueISO) return a.name.localeCompare(b.name);
      if (a.nextDueISO === null) return 1;
      if (b.nextDueISO === null) return -1;
      return a.nextDueISO < b.nextDueISO ? -1 : 1;
    });
    const basketCards = BASKETS.map(b => {
      const mine = active.filter(i => i.basket === b);
      return {
        key: b, label: BASKET_LABELS[b],
        monthOut: r2(mine.reduce((a, i) => a + i.monthOut, 0)),
        count: mine.length,
        overdue: mine.filter(i => i.status.key === 'overdue').length,
      };
    });
    const totalMonthOut = r2(active.reduce((a, i) => a + i.monthOut, 0));
    const groups = BASKETS.map(b => ({
      key: b, label: BASKET_LABELS[b],
      items: active.filter(i => i.basket === b),
      company: b === 'drivers' ? active.filter(i => i.basket === 'drivers' && i.kind !== 'recovery') : [],
      recovery: b === 'drivers' ? active.filter(i => i.basket === 'drivers' && i.kind === 'recovery') : [],
    }));
    const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return res.render('ap', {
      title: 'A/P', canWrite, todayISO: today, monthLabel,
      totalMonthOut, basketCards, upcoming, groups, inactive, drivers,
      baskets: BASKETS, basketLabels: BASKET_LABELS, cadences: CADENCES, methods: METHODS,
    });
  } catch (e) {
    console.error('ap GET / failed:', e);
    return res.status(500).send('A/P failed to load. Please try again.');
  }
});

// ---- Add item --------------------------------------------------------------
router.post('/items', async (req, res) => {
  try {
    const it = itemFromBody(req.body);
    if (!it.name) return res.redirect('/ap');
    const nextDue = firstDue(it, todayISO());
    await query(
      `INSERT INTO ap_items (name, basket, kind, driver_id, amount, cadence, due_day, due_date,
         autopay, autopay_day, method, next_due, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [it.name, it.basket, it.kind, it.driver_id, it.amount, it.cadence, it.due_day, it.due_date,
       it.autopay, it.autopay_day, it.method, nextDue, it.note]
    );
    return res.redirect('/ap');
  } catch (e) {
    console.error('ap item create failed:', e);
    return res.redirect('/ap');
  }
});

// ---- Mark paid ---------------------------------------------------------------
router.post('/items/:id/pay', async (req, res) => {
  try {
    const item = (await query('SELECT * FROM ap_items WHERE id = $1', [req.params.id])).rows[0];
    if (!item) return res.redirect('/ap');
    const amount = (req.body.amount === '' || req.body.amount === undefined)
      ? num(item.amount) : num(req.body.amount);
    const paidOn = parseISO(req.body.paid_on) ? String(req.body.paid_on).slice(0, 10) : todayISO();
    const method = METHODS.includes(req.body.method) ? req.body.method : item.method;
    if (amount > 0) {
      await query(
        'INSERT INTO ap_payments (ap_item_id, paid_on, amount, method, note) VALUES ($1,$2,$3,$4,$5)',
        [item.id, paidOn, amount, method, (req.body.note || '').trim() || null]
      );
    }
    if (item.cadence === 'once') {
      await query('UPDATE ap_items SET active = false, next_due = NULL WHERE id = $1', [item.id]);
    } else {
      const next = stepDue(item, asISO(item.next_due));
      await query('UPDATE ap_items SET next_due = $1 WHERE id = $2', [next, item.id]);
    }
    return res.redirect('/ap');
  } catch (e) {
    console.error('ap mark paid failed:', e);
    return res.redirect('/ap');
  }
});

// ---- Edit item ---------------------------------------------------------------
router.get('/items/:id/edit', async (req, res) => {
  try {
    const item = (await query('SELECT * FROM ap_items WHERE id = $1', [req.params.id])).rows[0];
    if (!item) return res.redirect('/ap');
    const payments = (await query(
      'SELECT * FROM ap_payments WHERE ap_item_id = $1 ORDER BY paid_on DESC, id DESC LIMIT 50',
      [item.id]
    )).rows;
    const drivers = (await query('SELECT id, name FROM drivers ORDER BY name')).rows;
    return res.render('ap-edit', {
      title: 'A/P Item', canWrite: req.session.user.role === 'admin',
      item: { ...item, due_date: asISO(item.due_date), next_due: asISO(item.next_due) },
      payments, drivers,
      baskets: BASKETS, basketLabels: BASKET_LABELS, cadences: CADENCES, methods: METHODS,
    });
  } catch (e) {
    console.error('ap edit GET failed:', e);
    return res.redirect('/ap');
  }
});

router.post('/items/:id/edit', async (req, res) => {
  try {
    const old = (await query('SELECT * FROM ap_items WHERE id = $1', [req.params.id])).rows[0];
    if (!old) return res.redirect('/ap');
    const it = itemFromBody(req.body);
    if (!it.name) return res.redirect('/ap/items/' + req.params.id + '/edit');
    const active = req.body.active === 'on';
    // Recompute next_due only when the schedule itself changed (or the
    // item is being reactivated with no due date) — a name/amount edit
    // must never silently move a due date.
    const scheduleChanged = it.cadence !== old.cadence
      || it.due_day !== old.due_day
      || it.due_date !== asISO(old.due_date)
      || it.autopay !== old.autopay
      || it.autopay_day !== old.autopay_day;
    let nextDue = asISO(old.next_due);
    if (active && (scheduleChanged || nextDue === null)) nextDue = firstDue(it, todayISO());
    if (!active) nextDue = asISO(old.next_due);
    await query(
      `UPDATE ap_items SET name=$1, basket=$2, kind=$3, driver_id=$4, amount=$5, cadence=$6,
         due_day=$7, due_date=$8, autopay=$9, autopay_day=$10, method=$11, note=$12,
         active=$13, next_due=$14 WHERE id=$15`,
      [it.name, it.basket, it.kind, it.driver_id, it.amount, it.cadence, it.due_day, it.due_date,
       it.autopay, it.autopay_day, it.method, it.note, active, nextDue, req.params.id]
    );
    return res.redirect('/ap');
  } catch (e) {
    console.error('ap item edit failed:', e);
    return res.redirect('/ap');
  }
});

// Delete is offered only while the item has no payment history (same
// rule as invoice line deletes) — history is never destroyed.
router.post('/items/:id/delete', async (req, res) => {
  try {
    const pays = await query('SELECT COUNT(*) AS n FROM ap_payments WHERE ap_item_id = $1', [req.params.id]);
    if (parseInt(pays.rows[0].n, 10) === 0) {
      await query('DELETE FROM ap_items WHERE id = $1', [req.params.id]);
    }
    return res.redirect('/ap');
  } catch (e) {
    console.error('ap item delete failed:', e);
    return res.redirect('/ap');
  }
});

module.exports = router;
// Exported for tests, same pattern as routes/settlement.js computeWeek.
module.exports.apHelpers = {
  firstDue, stepDue, occurrencesInMonth, monthOut, dueStatus, asISO, parseISO,
  BASKETS, BASKET_LABELS, CADENCES, METHODS,
};
