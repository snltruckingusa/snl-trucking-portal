// My File (Eric, 2026-11-14): the driver's own section of the portal.
//   1. Profile — the driver keeps his own address / phone / emergency
//      contact current. Saving does NOT take effect immediately: the
//      change waits as 'pending' until the owner confirms it (the
//      approval chain — entered once, at the bottom, flows up).
//   2. My Documents — the DQF folder: CDL, medical card, TWIC, MVR,
//      contract, W-9 and the rest, each with its expiry date. Files
//      are stored IN the database (the old disk uploads vanished on
//      every redeploy). A driver's upload lands 'pending' until the
//      owner confirms it; the owner's uploads are confirmed at once.
//   3. Training Records — safety topics completed, with dates.
//   4. Company Records — status lines read off the documents the
//      company keeps (latest MVR / drug test / Clearinghouse dates).
// Admin view: the same page becomes the review desk — pending profile
// changes and pending documents wait at the top, then the per-driver
// folder browser. Drivers only ever see their own file.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('../db');
const { requireLogin, scopedDriverId, isAdmin, toISODate } = require('../lib/helpers');
const { SAFETY_TOPICS } = require('../lib/safety');

const router = express.Router();

const CATEGORIES = {
  cdl: 'CDL',
  medical_card: 'Medical Card',
  twic: 'TWIC Card',
  mvr: 'MVR',
  contract: 'Contract',
  w9: 'W-9',
  drug_test: 'Drug Test Result',
  clearinghouse: 'Clearinghouse Query',
  road_test: 'Road Test Record',
  application: 'Application',
  registration: 'Registration',
  other: 'Other',
};

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
}

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const notice = req.query.notice || '';
  const todayISO = toISODate(new Date());

  if (scope) {
    const driver = (await query('SELECT * FROM drivers WHERE id = $1', [scope])).rows[0];
    const docs = (await query(
      'SELECT id, driver_id, category, original_name, mime_type, size_bytes, expires_on, status, uploaded_at FROM documents WHERE driver_id = $1 ORDER BY category, uploaded_at DESC',
      [scope]
    )).rows;
    const pendingChange = (await query(
      "SELECT * FROM profile_changes WHERE driver_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [scope]
    )).rows[0] || null;
    const ackRows = (await query('SELECT topic, acked_at FROM safety_acks WHERE driver_id = $1', [scope])).rows;
    const ackMap = {};
    ackRows.forEach((r) => { ackMap[r.topic] = r.acked_at; });
    const training = SAFETY_TOPICS.map((t) => ({ key: t.key, title: t.title, acked_at: ackMap[t.key] || null }));
    const comp = (await query(
      `SELECT DISTINCT ON (category) category, uploaded_at FROM documents
       WHERE driver_id = $1 AND category IN ('mvr', 'drug_test', 'clearinghouse')
       ORDER BY category, uploaded_at DESC`,
      [scope]
    )).rows;
    const companyRecords = { mvr: null, drug_test: null, clearinghouse: null };
    comp.forEach((r) => { companyRecords[r.category] = r.uploaded_at; });
    return res.render('documents', {
      mode: 'driver', isAdmin: false, scopedDriverId: scope,
      driver, docs, pendingChange, training, companyRecords,
      categories: CATEGORIES, notice, todayISO,
    });
  }

  // Admin: review desk + folder browser.
  const drivers = (await query('SELECT * FROM drivers ORDER BY name')).rows;
  const driverId = req.query.driver_id ? parseInt(req.query.driver_id, 10) : null;
  let docs = [];
  let driver = null;
  if (driverId) {
    driver = drivers.find((d) => d.id === driverId) || null;
    if (driver) {
      docs = (await query(
        'SELECT id, driver_id, category, original_name, mime_type, size_bytes, expires_on, status, uploaded_at FROM documents WHERE driver_id = $1 ORDER BY category, uploaded_at DESC',
        [driverId]
      )).rows;
    }
  }
  const pendingChanges = (await query(
    `SELECT pc.*, d.name AS driver_name, d.truck_number
     FROM profile_changes pc JOIN drivers d ON d.id = pc.driver_id
     WHERE pc.status = 'pending' ORDER BY pc.created_at ASC`
  )).rows;
  const pendingDocs = (await query(
    `SELECT doc.id, doc.category, doc.original_name, doc.uploaded_at, doc.expires_on,
            d.name AS driver_name, d.truck_number
     FROM documents doc JOIN drivers d ON d.id = doc.driver_id
     WHERE doc.status = 'pending' ORDER BY doc.uploaded_at ASC`
  )).rows;
  res.render('documents', {
    mode: 'admin', isAdmin: true, scopedDriverId: null,
    drivers, docs, driver, categories: CATEGORIES,
    pendingChanges, pendingDocs, notice, todayISO,
  });
});

// Driver submits profile changes — they wait for the owner's review.
router.post('/profile', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  if (!scope) return res.status(403).send('Forbidden.');
  const vals = {
    address: clean(req.body.address),
    phone: clean(req.body.phone),
    emergency_name: clean(req.body.emergency_name),
    emergency_phone: clean(req.body.emergency_phone),
  };
  const existing = (await query(
    "SELECT id FROM profile_changes WHERE driver_id = $1 AND status = 'pending' LIMIT 1",
    [scope]
  )).rows[0];
  if (existing) {
    await query(
      'UPDATE profile_changes SET address = $1, phone = $2, emergency_name = $3, emergency_phone = $4, created_at = now() WHERE id = $5',
      [vals.address, vals.phone, vals.emergency_name, vals.emergency_phone, existing.id]
    );
  } else {
    await query(
      'INSERT INTO profile_changes (driver_id, address, phone, emergency_name, emergency_phone) VALUES ($1, $2, $3, $4, $5)',
      [scope, vals.address, vals.phone, vals.emergency_name, vals.emergency_phone]
    );
  }
  res.redirect('/documents?notice=' + encodeURIComponent('Saved — your changes are waiting for the owner to review them.'));
});

router.post('/profile-changes/:id/approve', requireLogin, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  const row = (await query('SELECT * FROM profile_changes WHERE id = $1', [req.params.id])).rows[0];
  if (row && row.status === 'pending') {
    await query(
      'UPDATE drivers SET address = $1, phone = $2, emergency_name = $3, emergency_phone = $4 WHERE id = $5',
      [row.address, row.phone, row.emergency_name, row.emergency_phone, row.driver_id]
    );
    await query("UPDATE profile_changes SET status = 'approved', decided_at = now() WHERE id = $1", [row.id]);
  }
  res.redirect('/documents?notice=' + encodeURIComponent('Profile change approved.'));
});

router.post('/profile-changes/:id/reject', requireLogin, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  await query(
    "UPDATE profile_changes SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending'",
    [req.params.id]
  );
  res.redirect('/documents?notice=' + encodeURIComponent('Profile change rejected.'));
});

router.post('/upload', requireLogin, uploadMem.single('file'), async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id || !req.file) return res.redirect('/documents');
  const expiresOn = req.body.expires_on && /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on)
    ? req.body.expires_on : null;
  const category = CATEGORIES[req.body.category] ? req.body.category : 'other';
  const status = scope ? 'pending' : 'confirmed';
  await query(
    `INSERT INTO documents (driver_id, category, filename, original_name, mime_type, size_bytes, expires_on, file_data, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [driver_id, category, req.file.originalname, req.file.originalname, req.file.mimetype, req.file.size, expiresOn, req.file.buffer, status]
  );
  const note = scope
    ? 'Document uploaded — it is marked Pending until the owner checks it.'
    : 'Document uploaded.';
  res.redirect('/documents?driver_id=' + driver_id + '&notice=' + encodeURIComponent(note));
});

router.post('/:id/confirm', requireLogin, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  const r = await query("UPDATE documents SET status = 'confirmed' WHERE id = $1 RETURNING driver_id", [req.params.id]);
  const back = r.rows.length ? '?driver_id=' + r.rows[0].driver_id : '';
  res.redirect('/documents' + back + (back ? '&' : '?') + 'notice=' + encodeURIComponent('Document confirmed.'));
});

router.get('/:id/download', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).send('Not found.');
  const doc = r.rows[0];
  if (scope && doc.driver_id !== scope) return res.status(403).send('Forbidden.');
  if (doc.file_data) {
    const safeName = String(doc.original_name || 'document').replace(/"/g, '');
    res.set('Content-Type', doc.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + safeName + '"');
    return res.send(doc.file_data);
  }
  // Legacy rows: the file lived on the instance disk.
  const file = path.join(__dirname, '..', 'uploads', 'documents', doc.filename);
  res.download(file, doc.original_name);
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.redirect('/documents');
  if (scope && r.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  if (!r.rows[0].file_data) {
    const file = path.join(__dirname, '..', 'uploads', 'documents', r.rows[0].filename);
    fs.unlink(file, () => {});
  }
  await query('DELETE FROM documents WHERE id = $1', [req.params.id]);
  res.redirect('/documents?driver_id=' + r.rows[0].driver_id);
});

module.exports = router;
