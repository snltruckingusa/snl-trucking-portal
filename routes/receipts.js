// Broker receipts: PierLink payments received. Admin only.
const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin, num } = require('../lib/helpers');

const router = express.Router();

router.get('/', requireLogin, requireAdmin, async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.from) { params.push(req.query.from); conditions.push(`receipt_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`receipt_date <= $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const r = await query(`SELECT * FROM receipts ${where} ORDER BY receipt_date DESC, id DESC`, params);
  const total = await query('SELECT COALESCE(SUM(amount),0) AS total FROM receipts');
  res.render('receipts', {
    receipts: r.rows, total: parseFloat(total.rows[0].total),
    filters: { from: req.query.from || '', to: req.query.to || '' },
    isAdmin: true, error: null,
  });
});

router.post('/', requireLogin, requireAdmin, async (req, res) => {
  await query(
    'INSERT INTO receipts (receipt_date, amount, reference, payer) VALUES ($1,$2,$3,$4)',
    [req.body.receipt_date, num(req.body.amount), (req.body.reference || '').trim() || null, (req.body.payer || 'PierLink').trim()]
  );
  res.redirect('/receipts');
});

router.post('/:id/edit', requireLogin, requireAdmin, async (req, res) => {
  await query(
    'UPDATE receipts SET receipt_date=$1, amount=$2, reference=$3, payer=$4 WHERE id=$5',
    [req.body.receipt_date, num(req.body.amount), (req.body.reference || '').trim() || null, (req.body.payer || 'PierLink').trim(), req.params.id]
  );
  res.redirect('/receipts');
});

router.post('/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  await query('DELETE FROM receipts WHERE id = $1', [req.params.id]);
  res.redirect('/receipts');
});

module.exports = router;
