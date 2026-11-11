// Driver document folders: MVR, medical card, CDL, registration, contracts.
// File upload / list / delete, per driver. Drivers see only their own folder.
// NOTE: Render's filesystem is ephemeral — uploaded files live on the
// instance disk and are lost on redeploy. For durable storage, move to
// S3 / Cloudinary later (see README).
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('../db');
const { requireLogin, scopedDriverId, isAdmin } = require('../lib/helpers');

const router = express.Router();

const CATEGORIES = {
  mvr: 'MVR (운전 기록)',
  medical_card: 'Medical Card (건강 카드)',
  cdl: 'CDL (상용 운전면허)',
  registration: 'Registration (차량 등록)',
  contract: 'Contract (계약서)',
  other: 'Other (기타)',
};

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads', 'documents'),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.get('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driverId = scope || (req.query.driver_id ? parseInt(req.query.driver_id, 10) : null);
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  let docs = [];
  let driver = null;
  if (driverId) {
    driver = (await query('SELECT * FROM drivers WHERE id = $1', [driverId])).rows[0];
    const r = await query('SELECT * FROM documents WHERE driver_id = $1 ORDER BY category, uploaded_at DESC', [driverId]);
    docs = r.rows;
  }
  res.render('documents', {
    drivers: drivers.rows, docs, driver, categories: CATEGORIES,
    isAdmin: isAdmin(req), scopedDriverId: scope,
  });
});

router.post('/upload', requireLogin, upload.single('file'), async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id || !req.file) return res.redirect('/documents');
  await query(
    'INSERT INTO documents (driver_id, category, filename, original_name, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)',
    [driver_id, req.body.category || 'other', req.file.filename, req.file.originalname, req.file.mimetype, req.file.size]
  );
  res.redirect('/documents?driver_id=' + driver_id);
});

router.get('/:id/download', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).send('Not found.');
  if (scope && r.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const file = path.join(__dirname, '..', 'uploads', 'documents', r.rows[0].filename);
  res.download(file, r.rows[0].original_name);
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.redirect('/documents');
  if (scope && r.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const file = path.join(__dirname, '..', 'uploads', 'documents', r.rows[0].filename);
  fs.unlink(file, () => {});
  await query('DELETE FROM documents WHERE id = $1', [req.params.id]);
  res.redirect('/documents?driver_id=' + r.rows[0].driver_id);
});

module.exports = router;
