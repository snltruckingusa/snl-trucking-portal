// My Truck (Eric, 2026-11-14): a top-level section for the truck
// itself — its documents (registration, annual inspection, insurance,
// permits), its repair history, and its inspection record. The data
// lives once, in the maintenance records; this page is the driver's
// window on his own truck, and the owner's register for every truck.
//
// Repair entry follows the house rules: entered once, at the bottom
// of the chain. A driver enters a repair done at any shop — shop
// name, one line of what was fixed, the cost, who paid, and the
// invoice photo (no photo, no entry). It waits as 'pending' until
// the owner reviews it; then it is Reviewed & Recorded and shows in
// the truck's history. The owner entering a repair records it at
// once.
const express = require('express');
const multer = require('multer');
const { query } = require('../db');
const { requireLogin, scopedDriverId, isAdmin, num, toISODate } = require('../lib/helpers');

const router = express.Router();

const VD_CATEGORIES = {
  registration: 'Registration / Cab Card',
  annual_inspection: 'Annual Inspection',
  insurance: 'Insurance',
  permit: 'Overweight Permit',
  title_lease: 'Title / Lease',
  other: 'Other',
};

const PAID_BY = {
  company_card: 'Company card',
  driver_paid: 'Driver paid — reimburse',
  on_account: 'On account / Dave',
};

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
}

// Truck numbers get typed with and without a leading '#'.
const SAME_TRUCK = "REPLACE(truck_number, '#', '') = REPLACE($1, '#', '')";

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const notice = req.query.notice || '';
  const todayISO = toISODate(new Date());

  if (scope) {
    const driver = (await query('SELECT * FROM drivers WHERE id = $1', [scope])).rows[0];
    const truck = driver.truck_number || '';
    const vdocs = truck ? (await query(
      `SELECT id, category, original_name, mime_type, expires_on, uploaded_at FROM vehicle_docs
       WHERE ${SAME_TRUCK} ORDER BY category, uploaded_at DESC`, [truck]
    )).rows : [];
    const repairs = truck ? (await query(
      `SELECT * FROM mechanic_logs
       WHERE ${SAME_TRUCK} AND (status = 'recorded' OR driver_id = $2)
       ORDER BY log_date DESC, id DESC LIMIT 50`, [truck, scope]
    )).rows : [];
    const dvir = (await query(
      'SELECT * FROM dvir WHERE driver_id = $1 ORDER BY inspection_date DESC, id DESC LIMIT 20',
      [scope]
    )).rows;
    return res.render('mytruck', {
      mode: 'driver', isAdmin: false, driver, truck, vdocs, repairs, dvir,
      vdCategories: VD_CATEGORIES, paidBy: PAID_BY, notice, todayISO,
    });
  }

  // Admin: pick a truck, manage its documents and records.
  const truckRows = (await query(
    `SELECT truck_number FROM (
       SELECT truck_number FROM drivers WHERE truck_number IS NOT NULL AND truck_number <> ''
       UNION SELECT truck_number FROM vehicle_docs
       UNION SELECT truck_number FROM mechanic_logs
     ) t ORDER BY truck_number`
  )).rows;
  const trucks = truckRows.map((r) => r.truck_number);
  const truck = req.query.truck || trucks[0] || '';
  const vdocs = truck ? (await query(
    `SELECT id, category, original_name, mime_type, expires_on, uploaded_at FROM vehicle_docs
     WHERE ${SAME_TRUCK} ORDER BY category, uploaded_at DESC`, [truck]
  )).rows : [];
  const repairs = truck ? (await query(
    `SELECT * FROM mechanic_logs WHERE ${SAME_TRUCK} ORDER BY log_date DESC, id DESC LIMIT 100`, [truck]
  )).rows : [];
  res.render('mytruck', {
    mode: 'admin', isAdmin: true, trucks, truck, vdocs, repairs,
    vdCategories: VD_CATEGORIES, paidBy: PAID_BY, notice, todayISO,
  });
});

router.post('/repairs', requireLogin, uploadMem.single('photo'), async (req, res) => {
  const scope = scopedDriverId(req);
  const admin = isAdmin(req);
  if (!scope && !admin) return res.status(403).send('Forbidden.');

  let truck = null;
  let driverId = null;
  let enteredBy = null;
  if (scope) {
    const driver = (await query('SELECT * FROM drivers WHERE id = $1', [scope])).rows[0];
    truck = driver.truck_number;
    driverId = scope;
    enteredBy = driver.name;
    if (!req.file) {
      return res.redirect('/mytruck?notice=' + encodeURIComponent('An invoice photo is required — no photo, no entry. Photograph the shop invoice and try again.'));
    }
  } else {
    truck = clean(req.body.truck_number);
    enteredBy = 'Owner';
  }
  const description = clean(req.body.description);
  const shop = clean(req.body.shop);
  if (!truck || !description || !shop) {
    return res.redirect('/mytruck?notice=' + encodeURIComponent('A repair entry needs the truck, the shop name, and one line on what was fixed.'));
  }
  const logDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.log_date || '') ? req.body.log_date : toISODate(new Date());
  const odometer = req.body.odometer && /^\d+$/.test(String(req.body.odometer).trim())
    ? parseInt(req.body.odometer, 10) : null;
  const paidBy = PAID_BY[req.body.paid_by] ? req.body.paid_by : null;
  await query(
    `INSERT INTO mechanic_logs
       (truck_number, log_date, description, cost, mechanic, odometer, shop, paid_by,
        photo_data, photo_mime, status, entered_by, driver_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [truck, logDate, description, num(req.body.cost), shop, odometer, shop, paidBy,
     req.file ? req.file.buffer : null, req.file ? req.file.mimetype : null,
     scope ? 'pending' : 'recorded', enteredBy, driverId]
  );
  const note = scope
    ? 'Repair saved — it shows in your history once the owner reviews it.'
    : 'Repair recorded.';
  res.redirect('/mytruck' + (admin && truck ? '?truck=' + encodeURIComponent(truck) + '&' : '?') + 'notice=' + encodeURIComponent(note));
});

router.get('/repairs/:id/photo', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM mechanic_logs WHERE id = $1', [req.params.id]);
  if (!r.rows.length || !r.rows[0].photo_data) return res.status(404).send('Not found.');
  const row = r.rows[0];
  if (scope) {
    const driver = (await query('SELECT * FROM drivers WHERE id = $1', [scope])).rows[0];
    const mine = driver && String(driver.truck_number || '').replace('#', '') === String(row.truck_number || '').replace('#', '');
    if (!mine && row.driver_id !== scope) return res.status(403).send('Forbidden.');
  }
  res.set('Content-Type', row.photo_mime || 'application/octet-stream');
  res.send(row.photo_data);
});

router.post('/vehicle-docs/upload', requireLogin, uploadMem.single('file'), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  const truck = clean(req.body.truck_number);
  if (!truck || !req.file) return res.redirect('/mytruck');
  const category = VD_CATEGORIES[req.body.category] ? req.body.category : 'other';
  const expiresOn = req.body.expires_on && /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on)
    ? req.body.expires_on : null;
  await query(
    `INSERT INTO vehicle_docs (truck_number, category, original_name, mime_type, size_bytes, file_data, expires_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [truck, category, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, expiresOn]
  );
  res.redirect('/mytruck?truck=' + encodeURIComponent(truck) + '&notice=' + encodeURIComponent('Truck document saved.'));
});

router.get('/vehicle-docs/:id/download', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM vehicle_docs WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).send('Not found.');
  const doc = r.rows[0];
  if (scope) {
    const driver = (await query('SELECT * FROM drivers WHERE id = $1', [scope])).rows[0];
    const mine = driver && String(driver.truck_number || '').replace('#', '') === String(doc.truck_number || '').replace('#', '');
    if (!mine) return res.status(403).send('Forbidden.');
  }
  if (!doc.file_data) return res.status(404).send('Not found.');
  const safeName = String(doc.original_name || 'document').replace(/"/g, '');
  res.set('Content-Type', doc.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="' + safeName + '"');
  res.send(doc.file_data);
});

router.post('/vehicle-docs/:id/delete', requireLogin, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  const r = await query('DELETE FROM vehicle_docs WHERE id = $1 RETURNING truck_number', [req.params.id]);
  const back = r.rows.length ? '?truck=' + encodeURIComponent(r.rows[0].truck_number) : '';
  res.redirect('/mytruck' + back);
});

module.exports = router;
