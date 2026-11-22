// Business documents (Eric, 2026-11-22): bank and card statements and
// other company financial documents. The owner uploads; the CPA can
// view and download them read-only from his fenced account (the
// server.js CPA fence allows GETs on /bizdocs). Drivers never see
// this section. Files are stored IN the database — disk uploads
// vanish on every redeploy (same rule as driver documents).
const express = require('express');
const multer = require('multer');
const { query } = require('../db');
const { requireLogin, requireAdmin } = require('../lib/helpers');

const router = express.Router();

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const CATEGORIES = ['Bank Statement', 'Card Statement', 'Tax Document', 'Other'];

function requireCpaOrAdmin(req, res, next) {
  const u = req.session && req.session.user;
  if (u && (u.role === 'cpa' || u.role === 'admin')) return next();
  return res.status(403).send('Forbidden.');
}

router.get('/', requireLogin, requireCpaOrAdmin, async (req, res) => {
  const r = await query(
    'SELECT id, title, category, period_label, original_name, mime_type, size_bytes, uploaded_at FROM business_documents ORDER BY uploaded_at DESC'
  );
  res.render('bizdocs', {
    docs: r.rows, categories: CATEGORIES,
    isAdmin: req.session.user.role === 'admin',
    error: req.query.error || null, notice: req.query.notice || null,
  });
});

router.post('/upload', requireLogin, requireAdmin, uploadMem.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/bizdocs?error=' + encodeURIComponent('No file chosen.'));
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
    const title = (req.body.title || '').trim() || req.file.originalname;
    await query(
      `INSERT INTO business_documents (title, category, period_label, original_name, mime_type, size_bytes, file_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [title, category, (req.body.period_label || '').trim() || null,
        req.file.originalname, req.file.mimetype || null, req.file.size, req.file.buffer]
    );
    return res.redirect('/bizdocs?notice=' + encodeURIComponent('Document uploaded.'));
  } catch (e) {
    // A failed insert must never take the process down.
    console.error('business document upload failed:', e.message);
    return res.redirect('/bizdocs?error=' + encodeURIComponent('Upload failed — please try again.'));
  }
});

router.get('/:id/file', requireLogin, requireCpaOrAdmin, async (req, res) => {
  const r = await query('SELECT original_name, mime_type, file_data FROM business_documents WHERE id = $1', [req.params.id]);
  const doc = r.rows[0];
  if (!doc || !doc.file_data) return res.status(404).send('Not found.');
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + String(doc.original_name || 'document').replace(/"/g, '') + '"');
  return res.send(doc.file_data);
});

router.post('/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  await query('DELETE FROM business_documents WHERE id = $1', [req.params.id]);
  res.redirect('/bizdocs?notice=' + encodeURIComponent('Document deleted.'));
});

module.exports = router;
