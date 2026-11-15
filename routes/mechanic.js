// Mechanic entry (Eric, 2026-11-14): the shared shop login. One
// account ("mechanic") that any shop can use to enter a repair —
// truck, shop name, what was fixed, the cost, who paid, and the
// invoice photo. The account sees ONLY this page: a server-level
// gate bounces every other address back here, and a shop can never
// edit an entry after submitting it (corrections happen at the
// owner's review). Every entry lands 'pending'; the owner marks it
// Reviewed & Recorded on the Maintenance page, and it joins the
// truck's history.
const express = require('express');
const multer = require('multer');
const { query } = require('../db');
const { requireLogin, num, toISODate } = require('../lib/helpers');

const router = express.Router();

const PAID_BY = {
  company_card: 'Company card',
  driver_paid: 'Driver paid — reimburse',
  on_account: 'On account / Dave',
};

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function requireMechanic(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'mechanic') return next();
  return res.redirect('/');
}

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
}

router.get('/', requireLogin, requireMechanic, async (req, res) => {
  const enteredBy = 'Mechanic (' + req.session.user.username + ')';
  const trucks = (await query(
    "SELECT DISTINCT truck_number FROM drivers WHERE truck_number IS NOT NULL AND truck_number <> '' ORDER BY truck_number"
  )).rows.map((r) => r.truck_number);
  const mine = (await query(
    'SELECT * FROM mechanic_logs WHERE entered_by = $1 ORDER BY log_date DESC, id DESC LIMIT 20',
    [enteredBy]
  )).rows;
  res.render('mechanic', {
    isAdmin: false, trucks, mine, paidBy: PAID_BY,
    notice: req.query.notice || '', todayISO: toISODate(new Date()),
  });
});

router.post('/', requireLogin, requireMechanic, uploadMem.single('photo'), async (req, res) => {
  const truck = clean(req.body.truck_number);
  const shop = clean(req.body.shop);
  const description = clean(req.body.description);
  if (!truck || !shop || !description) {
    return res.redirect('/mechanic?notice=' + encodeURIComponent('Please fill in the truck #, your shop name, and what was fixed.'));
  }
  if (!req.file) {
    return res.redirect('/mechanic?notice=' + encodeURIComponent('An invoice photo is required — please photograph the invoice and try again.'));
  }
  const logDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.log_date || '') ? req.body.log_date : toISODate(new Date());
  const odometer = req.body.odometer && /^\d+$/.test(String(req.body.odometer).trim())
    ? parseInt(req.body.odometer, 10) : null;
  const paidBy = PAID_BY[req.body.paid_by] ? req.body.paid_by : null;
  await query(
    `INSERT INTO mechanic_logs
       (truck_number, log_date, description, cost, mechanic, odometer, shop, paid_by,
        photo_data, photo_mime, status, entered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)`,
    [truck, logDate, description, num(req.body.cost), shop, odometer, shop, paidBy,
     req.file.buffer, req.file.mimetype, 'Mechanic (' + req.session.user.username + ')']
  );
  res.redirect('/mechanic?notice=' + encodeURIComponent('Saved. Thank you — the entry is with the owner for review.'));
});

module.exports = router;
