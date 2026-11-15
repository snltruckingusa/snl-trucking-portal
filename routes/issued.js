// Issued items (Eric, 2026-11-15): company property handed to a person —
// Amex employee card, TCS fuel card, tablet, phone, keys, ELD device.
// The point is the return: when a driver leaves, this list says what
// the company still has out. An unreturned item held by an inactive or
// former driver is flagged red. Admin only.
const express = require('express');
const { query } = require('../db');
const { requireLogin, isAdmin, toISODate } = require('../lib/helpers');

const router = express.Router();

const ITEM_TYPES = ['Amex card', 'Fuel card (TCS)', 'Tablet / iPad', 'Phone', 'Keys', 'ELD device', 'Other'];

function adminOnly(req, res) {
  if (!isAdmin(req)) { res.status(403).send('Forbidden.'); return false; }
  return true;
}

router.get('/', requireLogin, async (req, res) => {
  if (!adminOnly(req, res)) return;
  const drivers = (await query('SELECT id, name, truck_number, active FROM drivers ORDER BY active DESC, name')).rows;
  const items = (await query(
    `SELECT i.*, d.name AS driver_name, d.active AS driver_active
     FROM issued_items i LEFT JOIN drivers d ON d.id = i.driver_id
     ORDER BY (i.returned_on IS NULL) DESC, i.issued_on DESC, i.id DESC`
  )).rows;
  res.render('issued', {
    isAdmin: true, drivers, items, itemTypes: ITEM_TYPES,
    notice: req.query.notice || '', todayISO: toISODate(new Date()),
  });
});

router.post('/', requireLogin, async (req, res) => {
  if (!adminOnly(req, res)) return;
  const driverId = req.body.driver_id ? parseInt(req.body.driver_id, 10) : null;
  const holderName = (req.body.holder_name || '').trim() || null;
  const itemType = ITEM_TYPES.includes(req.body.item_type) ? req.body.item_type : 'Other';
  const detail = (req.body.detail || '').trim() || null;
  const issuedOn = req.body.issued_on || null;
  const notes = (req.body.notes || '').trim() || null;
  if (!driverId && !holderName) {
    return res.redirect('/issued?notice=' + encodeURIComponent('Pick a driver or type the holder name.'));
  }
  await query(
    'INSERT INTO issued_items (driver_id, holder_name, item_type, detail, issued_on, notes) VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6)',
    [driverId, driverId ? null : holderName, itemType, detail, issuedOn, notes]
  );
  res.redirect('/issued?notice=' + encodeURIComponent('Item recorded as issued.'));
});

router.post('/:id/return', requireLogin, async (req, res) => {
  if (!adminOnly(req, res)) return;
  await query('UPDATE issued_items SET returned_on = CURRENT_DATE WHERE id = $1', [req.params.id]);
  res.redirect('/issued?notice=' + encodeURIComponent('Marked returned today.'));
});

router.post('/:id/unreturn', requireLogin, async (req, res) => {
  if (!adminOnly(req, res)) return;
  await query('UPDATE issued_items SET returned_on = NULL WHERE id = $1', [req.params.id]);
  res.redirect('/issued?notice=' + encodeURIComponent('Return undone.'));
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  if (!adminOnly(req, res)) return;
  await query('DELETE FROM issued_items WHERE id = $1', [req.params.id]);
  res.redirect('/issued?notice=' + encodeURIComponent('Entry deleted.'));
});

module.exports = router;
