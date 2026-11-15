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
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { query } = require('../db');
const { requireLogin, scopedDriverId, isAdmin, toISODate } = require('../lib/helpers');
const { SAFETY_TOPICS } = require('../lib/safety');
const { docChecklist, profileChecklist, contractChain } = require('../lib/checklists');

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
  annual_review: 'Annual Review',
  clearinghouse_consent: 'Clearinghouse Consent',
  safety_history: 'Safety Performance History',
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
      'SELECT id, driver_id, category, original_name, mime_type, size_bytes, expires_on, status, uploaded_at, is_duplicate, signed_by, signed_at FROM documents WHERE driver_id = $1 ORDER BY category, uploaded_at DESC',
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
      checklist: docChecklist(docs), profileItems: profileChecklist(driver),
      chain: contractChain(docs),
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
        'SELECT id, driver_id, category, original_name, mime_type, size_bytes, expires_on, status, uploaded_at, is_duplicate, signed_by, signed_at FROM documents WHERE driver_id = $1 ORDER BY category, uploaded_at DESC',
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
    chain: contractChain(docs),
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
  if (!driver_id || !req.file) return res.redirect('/documents?notice=' + encodeURIComponent('Upload did not go through — please choose the file and try again.'));
  const expiresOn = req.body.expires_on && /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on)
    ? req.body.expires_on : null;
  const category = CATEGORIES[req.body.category] ? req.body.category : 'other';
  const status = scope ? 'pending' : 'confirmed';
  try {
    await query(
      `INSERT INTO documents (driver_id, category, filename, original_name, mime_type, size_bytes, expires_on, file_data, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [driver_id, category, req.file.originalname, req.file.originalname, req.file.mimetype, req.file.size, expiresOn, req.file.buffer, status]
    );
  } catch (e) {
    // Never let a failed insert crash the request (an unhandled async
    // error takes the whole process down and every upload looks lost).
    return res.redirect('/documents?driver_id=' + driver_id + '&notice=' +
      encodeURIComponent('Upload did not go through — nothing was saved. Please try again.'));
  }
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

// Load a document's PDF bytes (DB first, legacy disk rows second) after
// the same permission check the download route uses. Returns null when
// the document does not exist; throws { code: 403 } when not allowed.
async function docBytesForUser(req, id) {
  const scope = scopedDriverId(req);
  const r = await query('SELECT * FROM documents WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  const doc = r.rows[0];
  if (scope && doc.driver_id !== scope) { const e = new Error('Forbidden.'); e.code = 403; throw e; }
  if (doc.file_data) return { doc, bytes: doc.file_data };
  const file = path.join(__dirname, '..', 'uploads', 'documents', doc.filename);
  return { doc, bytes: fs.readFileSync(file) };
}

// Inline copy for the signing page's PDF viewer (same checks as download).
router.get('/:id/raw', requireLogin, async (req, res) => {
  try {
    const got = await docBytesForUser(req, req.params.id);
    if (!got) return res.status(404).send('Not found.');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline');
    return res.send(got.bytes);
  } catch (e) {
    return res.status(e.code || 500).send(e.code === 403 ? 'Forbidden.' : 'Could not load the document.');
  }
});

// Signing page: tap where the signature goes, draw it, stamp it.
router.get('/:id/sign', requireLogin, async (req, res) => {
  try {
    const got = await docBytesForUser(req, req.params.id);
    if (!got) return res.status(404).send('Not found.');
    const { doc } = got;
    const isPdf = (doc.mime_type || '').indexOf('pdf') !== -1 || /\.pdf$/i.test(doc.original_name || '');
    if (!isPdf) {
      return res.redirect('/documents?driver_id=' + doc.driver_id + '&notice=' +
        encodeURIComponent('Signing works on PDF documents only.'));
    }
    const driver = (await query('SELECT id, name FROM drivers WHERE id = $1', [doc.driver_id])).rows[0];
    const back = isAdmin(req) ? '/documents?driver_id=' + doc.driver_id : '/documents';
    return res.render('sign', {
      title: 'Sign document', doc, driver,
      categoryLabel: CATEGORIES[doc.category] || doc.category, back,
    });
  } catch (e) {
    return res.status(e.code || 500).send(e.code === 403 ? 'Forbidden.' : 'Could not load the document.');
  }
});

// Stamp the drawn signature onto a copy of the PDF and save the copy as
// a NEW document row (the original is never touched). The signed copy
// becomes the current record for its category; signed_by / signed_at
// keep the audit trail. Admin signatures land confirmed; a driver's own
// signature lands pending like their uploads do.
router.post('/:id/sign', requireLogin, async (req, res) => {
  let doc;
  try {
    const got = await docBytesForUser(req, req.params.id);
    if (!got) return res.redirect('/documents');
    doc = got.doc;
    const sig = String(req.body.sig || '');
    if (!sig.startsWith('data:image/png;base64,')) throw new Error('no signature');
    const pageNo = Math.max(1, parseInt(req.body.page, 10) || 1);
    const fx = Math.min(1, Math.max(0, parseFloat(req.body.x)));
    const fy = Math.min(1, Math.max(0, parseFloat(req.body.y)));
    if (!isFinite(fx) || !isFinite(fy)) throw new Error('no placement');

    const pdf = await PDFDocument.load(got.bytes);
    const pages = pdf.getPages();
    const page = pages[Math.min(pageNo - 1, pages.length - 1)];
    const { width: W, height: H } = page.getSize();
    const png = await pdf.embedPng(Buffer.from(sig.split(',')[1], 'base64'));
    const sigW = W * 0.30;
    const sigH = sigW * (png.height / png.width);
    let xPt = fx * W - sigW / 2;
    let yPt = H - fy * H - sigH * 0.30; // click sits on the signature line
    xPt = Math.min(Math.max(xPt, 6), W - sigW - 6);
    yPt = Math.min(Math.max(yPt, 18), H - sigH - 6);
    page.drawImage(png, { x: xPt, y: yPt, width: sigW, height: sigH });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const now = new Date();
    const dateStr = (now.getMonth() + 1) + '/' + now.getDate() + '/' + now.getFullYear();
    page.drawText(dateStr, { x: xPt, y: yPt - 13, size: 9, font, color: rgb(0, 0, 0) });
    const out = Buffer.from(await pdf.save());

    const base = String(doc.original_name || 'document.pdf').replace(/\.pdf$/i, '');
    const signedName = base + ' (signed).pdf';
    const status = isAdmin(req) ? 'confirmed' : 'pending';
    await query(
      `INSERT INTO documents (driver_id, category, filename, original_name, mime_type, size_bytes, expires_on, file_data, status, signed_by, signed_at)
       VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8, $9, now())`,
      [doc.driver_id, doc.category, signedName, signedName, out.length, doc.expires_on, out, status,
       (req.session.user && req.session.user.username) || 'unknown']
    );
    const note = status === 'confirmed'
      ? 'Signed copy saved — it is now the current record.'
      : 'Signed copy saved — it is marked Pending until the owner checks it.';
    const backQ = isAdmin(req) ? '?driver_id=' + doc.driver_id + '&' : '?';
    return res.redirect('/documents' + backQ + 'notice=' + encodeURIComponent(note));
  } catch (e) {
    const backQ = doc && isAdmin(req) ? '?driver_id=' + doc.driver_id + '&' : '?';
    return res.redirect('/documents' + backQ + 'notice=' +
      encodeURIComponent('Signing did not go through — nothing was changed. Please try again.'));
  }
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

// Admin: flag/unflag a document as a duplicate. A duplicate stays in the
// folder for the record but never becomes the checklist record for its
// category (lib/checklists latestByCategory skips it).
router.post('/:id/duplicate', requireLogin, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  const r = await query(
    'UPDATE documents SET is_duplicate = NOT is_duplicate WHERE id = $1 RETURNING driver_id, is_duplicate',
    [req.params.id]
  );
  if (!r.rows.length) return res.redirect('/documents');
  const note = r.rows[0].is_duplicate ? 'Marked as duplicate — it no longer counts as the record.' : 'Duplicate flag removed.';
  res.redirect('/documents?driver_id=' + r.rows[0].driver_id + '&notice=' + encodeURIComponent(note));
});

module.exports = router;
