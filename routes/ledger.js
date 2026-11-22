// Ledger — the company's categorized bank/card transactions, kept the
// way a CPA works: income, business expenses by chart-of-accounts
// category, transfers (card payments — NOT expenses, they would double
// count), owner/personal items kept separate, and capital movements.
// The owner imports statement CSVs (Bora prepares the categorized file);
// the CPA reads everything read-only. Amounts: income positive,
// money out negative.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../lib/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const BASKETS = ['income', 'expense', 'transfer', 'personal', 'capital', 'review'];
const BASKET_LABELS = {
  income: 'Income', expense: 'Business expenses', transfer: 'Transfers (not expenses)',
  personal: 'Owner / personal', capital: 'Capital & loans', review: 'Needs review',
};
const PRESETS = [
  'income|Freight Income',
  'expense|Driver Pay', 'expense|Fuel', 'expense|Fuel (TCS prepaid)', 'expense|Insurance',
  'expense|Truck Payments', 'expense|Repairs & Maintenance', 'expense|Parts & Supplies',
  'expense|Parking & Tolls', 'expense|Taxes, Licenses & Fees', 'expense|Professional Fees',
  'expense|Communications', 'expense|Meals', 'expense|Bank Fees', 'expense|Office & Postage',
  'transfer|Card Payment',
  'personal|Owner Draw', 'personal|Personal Purchases', 'personal|Health Insurance (personal)',
  'capital|Owner Contribution', 'capital|Owner Distribution', 'capital|Truck Purchase', 'capital|Loan / Funds Returned',
  'review|Needs Review',
];
const PALETTE = ['#2e7d32', '#1565c0', '#6a1b9a', '#ef6c00', '#00838f', '#4e342e',
  '#ad1457', '#283593', '#558b2f', '#795548', '#455a64', '#7cb342'];

// Minimal CSV parser (quoted fields, commas, doubled quotes).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const yearsRes = await db.query(
      `SELECT DISTINCT date_part('year', txn_date)::int AS y FROM ledger_transactions ORDER BY 1 DESC`);
    const years = yearsRes.rows.map((r) => r.y);
    const year = parseInt(req.query.year, 10) || years[0] || new Date().getFullYear();

    const monthlyRes = await db.query(
      `SELECT to_char(txn_date, 'YYYY-MM') AS ym, basket, COALESCE(SUM(amount), 0)::float AS total
         FROM ledger_transactions WHERE date_part('year', txn_date) = $1
        GROUP BY 1, 2`, [year]);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      const inc = monthlyRes.rows.find((r) => r.ym === key && r.basket === 'income');
      const exp = monthlyRes.rows.find((r) => r.ym === key && r.basket === 'expense');
      const income = inc ? inc.total : 0;
      const expense = exp ? exp.total : 0; // negative
      months.push({ key, m, income, expense, net: income + expense });
    }
    const maxMonthly = Math.max(1, ...months.map((x) => Math.max(x.income, Math.abs(x.expense))));

    const basketRes = await db.query(
      `SELECT basket, COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS n
         FROM ledger_transactions WHERE date_part('year', txn_date) = $1 GROUP BY 1`, [year]);
    const basketTotals = {};
    for (const b of BASKETS) basketTotals[b] = { total: 0, n: 0 };
    for (const r of basketRes.rows) basketTotals[r.basket] = { total: r.total, n: r.n };

    const catRes = await db.query(
      `SELECT category, COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS n
         FROM ledger_transactions
        WHERE basket = 'expense' AND date_part('year', txn_date) = $1
        GROUP BY 1 ORDER BY total ASC`, [year]);
    const catTotals = catRes.rows.map((r) => ({ category: r.category, total: r.total, n: r.n, abs: Math.abs(r.total) }));
    const expenseTotalAbs = catTotals.reduce((a, c) => a + c.abs, 0) || 1;
    // Donut segments (SVG stroke-dasharray on r=70, C≈439.82).
    const C = 439.82;
    let acc = 0;
    const segments = catTotals.map((c, i) => {
      const frac = c.abs / expenseTotalAbs;
      const seg = { label: c.category, value: c.abs, pct: frac * 100, color: PALETTE[i % PALETTE.length], dash: frac * C, offset: -acc * C };
      acc += frac;
      return seg;
    });

    const filters = { basket: '', category: '', month: '' };
    const where = [];
    const params = [];
    if (BASKETS.includes(req.query.basket)) { filters.basket = req.query.basket; params.push(req.query.basket); where.push(`basket = $${params.length}`); }
    if (req.query.category) { filters.category = String(req.query.category).slice(0, 80); params.push(filters.category); where.push(`category = $${params.length}`); }
    if (/^\d{4}-\d{2}$/.test(req.query.month || '')) { filters.month = req.query.month; params.push(filters.month); where.push(`to_char(txn_date, 'YYYY-MM') = $${params.length}`); }
    if (!where.length) { params.push(year); where.push(`date_part('year', txn_date) = $${params.length}`); }
    const txnRes = await db.query(
      `SELECT id, txn_date, account, description, amount::float AS amount, eric_label, basket, category
         FROM ledger_transactions WHERE ${where.join(' AND ')}
        ORDER BY txn_date DESC, id DESC LIMIT 300`, params);

    res.render('ledger', {
      title: 'Ledger', isAdmin: req.session.user.role === 'admin',
      notice: req.query.notice || null, error: req.query.error || null,
      years, year, months, maxMonthly, basketTotals, basketLabels: BASKET_LABELS,
      catTotals, segments, expenseTotalAbs,
      txns: txnRes.rows, filters, presets: PRESETS,
    });
  } catch (err) { next(err); }
});

// Import a categorized CSV (columns: date, account, description, amount,
// eric_label, basket, cpa_category). Exact duplicates are skipped, so a
// file can be re-imported safely. Admin only — the CPA never writes.
router.post('/import', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/ledger?error=' + encodeURIComponent('Choose a CSV file first.'));
    const rows = parseCsv(req.file.buffer.toString('utf8'));
    let inserted = 0, skipped = 0, bad = 0;
    for (let i = 1; i < rows.length; i++) {
      const [date, account, description, amountRaw, label, basketRaw, category] = rows[i];
      const amount = parseFloat(amountRaw);
      const basket = String(basketRaw || 'review').trim().toLowerCase();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(amount) || !BASKETS.includes(basket)) { bad++; continue; }
      const r = await db.query(
        `INSERT INTO ledger_transactions (txn_date, account, description, amount, eric_label, basket, category)
         SELECT $1, $2, $3, $4, $5, $6, $7
          WHERE NOT EXISTS (SELECT 1 FROM ledger_transactions
                             WHERE txn_date = $1 AND account = $2 AND description = $3
                               AND amount = $4 AND eric_label = $5)
         RETURNING id`,
        [date, String(account || '').slice(0, 60), String(description || '').slice(0, 300), amount,
         String(label || '').slice(0, 120), basket, String(category || 'Needs Review').slice(0, 80)]);
      if (r.rows.length) inserted++; else skipped++;
    }
    res.redirect('/ledger?notice=' + encodeURIComponent(`Import done: ${inserted} added, ${skipped} duplicates skipped, ${bad} rows ignored.`));
  } catch (err) {
    res.redirect('/ledger?error=' + encodeURIComponent('Import failed: ' + err.message));
  }
});

// Fix one transaction's basket/category (the Needs-review cleanup). Admin only.
router.post('/:id/categorize', requireAdmin, async (req, res) => {
  try {
    const [basket, category] = String(req.body.preset || '').split('|');
    if (BASKETS.includes(basket) && category) {
      await db.query('UPDATE ledger_transactions SET basket = $1, category = $2 WHERE id = $3',
        [basket, category.slice(0, 80), req.params.id]);
    }
    res.redirect(req.body.back || '/ledger?basket=review');
  } catch (err) {
    res.redirect('/ledger?error=' + encodeURIComponent('Save failed: ' + err.message));
  }
});

module.exports = router;
