// Loads: create / edit / delete / list.
// Only CONFIRMED loads count in settlement. List between two dates,
// newest first, optionally per driver. Drivers see only their own loads.
// Includes ticket-photo OCR: a POD / gate in-out ticket photo is run
// through Tesseract.js (optional dependency) and the extracted values
// prefill the entry form as SUGGESTIONS ONLY — a human must confirm
// before saving. If OCR is unavailable, the photo is still attached and
// the form is filled in manually.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('../db');
const { requireLogin, scopedDriverId, num, fmtDate, isAdmin, nextProgress } = require('../lib/helpers');

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads', 'tickets'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are accepted.'));
  },
});

// ---- OCR text parsing (best-effort regex extraction) ----
function parseTicketText(text) {
  const t = (text || '').replace(/\r/g, '\n');
  const out = { container_no: '', bol_ref: '', return_location: '', pickup: '', delivery: '', appointment: '' };

  // Container #: ISO format, 4 letters + 7 digits (e.g. MSKU3613700).
  // OCR often returns mixed case, so match case-insensitively and normalize.
  const cont = t.match(/\b([A-Za-z]{4}\s?\d{7})\b/);
  if (cont) out.container_no = cont[1].replace(/\s/g, '').toUpperCase();

  // BOL / reference: a 6-8 digit number near REF / BOL / Booking / Reference
  const ref = t.match(/(?:REF(?:ERENCE)?|BOL|BOOKING|B\/L)\s*[:#.]?\s*([A-Z0-9-]{5,12})/i)
    || t.match(/\b(\d{7})\b/);
  if (ref) out.bol_ref = ref[1];

  // Empty return location: line after "Return" / "Empty Return" / "Off-hire"
  const ret = t.match(/(?:EMPTY\s*RETURN|RETURN\s*(?:TO|LOCATION)|OFF[-\s]?HIRE)\s*[:#.]?\s*(.+)/i);
  if (ret) out.return_location = ret[1].trim().slice(0, 200);

  const pick = t.match(/PICK[-\s]?UP\s*[:#.]?\s*(.+)/i);
  if (pick) out.pickup = pick[1].trim().slice(0, 200);
  const del = t.match(/(?:DELIVER(?:Y)?|DROP[-\s]?OFF)\s*[:#.]?\s*(.+)/i);
  if (del) out.delivery = del[1].trim().slice(0, 200);

  // Appointment: date + time, e.g. 11/15/2026 10:30 AM or 2026-11-15 10:30
  const appt = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)
    || t.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/);
  if (appt) out.appointment = appt[1];

  return out;
}

const { spawn } = require('child_process');

// OCR runs in a SEPARATE child process (lib/ocr-worker.js) so that a
// tesseract worker failure can never crash the main server. Any failure
// (crash, timeout, missing language data) resolves as { ok: false } and
// the caller falls back to manual entry with the photo attached.
function ocrImage(filePath) {
  return new Promise((resolve) => {
    const worker = path.join(__dirname, '..', 'lib', 'ocr-worker.js');
    const child = spawn(process.execPath, [worker, filePath], { timeout: 60000 });
    let out = '';
    let err = '';
    let settled = false;
    const done = (ok, text) => {
      if (settled) return;
      settled = true;
      resolve({ text, ok });
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => done(false, ''));
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(out);
          return done(true, parsed.text || '');
        } catch (e) {
          return done(false, '');
        }
      }
      console.error('[ocr] worker failed:', String(err).slice(0, 300));
      return done(false, '');
    });
    // Backstop in case the spawn timeout does not fire.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      done(false, '');
    }, 65000).unref();
  });
}

function loadWhere(req) {
  const scope = scopedDriverId(req);
  const conditions = [];
  const params = [];
  if (scope) { params.push(scope); conditions.push(`driver_id = $${params.length}`); }
  if (req.query.driver_id && !scope) { params.push(req.query.driver_id); conditions.push(`driver_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`load_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`load_date <= $${params.length}`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`status = $${params.length}`); }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}

router.get('/', requireLogin, async (req, res) => {
  const { where, params } = loadWhere(req);
  const r = await query(
    `SELECT l.*, d.name AS driver_name, d.truck_number FROM loads l
     JOIN drivers d ON d.id = l.driver_id ${where}
     ORDER BY l.load_date DESC, l.id DESC`,
    params
  );
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  res.render('loads', {
    loads: r.rows, drivers: drivers.rows,
    filters: { from: req.query.from || '', to: req.query.to || '', driver_id: req.query.driver_id || '', status: req.query.status || '' },
    isAdmin: isAdmin(req), scopedDriverId: scopedDriverId(req),
    ocr: null, ocrNotice: null,
  });
});

// OCR upload: photo -> extracted suggestions -> prefill form (not saved yet).
router.post('/ocr', requireLogin, upload.single('ticket'), async (req, res) => {
  if (!req.file) return res.redirect('/loads');
  const photoPath = '/uploads/tickets/' + req.file.filename;
  const { text, ok } = await ocrImage(req.file.path);
  const extracted = ok ? parseTicketText(text) : { container_no: '', bol_ref: '', return_location: '', pickup: '', delivery: '', appointment: '' };
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  const { where, params } = loadWhere(req);
  const r = await query(
    `SELECT l.*, d.name AS driver_name, d.truck_number FROM loads l
     JOIN drivers d ON d.id = l.driver_id ${where}
     ORDER BY l.load_date DESC, l.id DESC`,
    params
  );
  res.render('loads', {
    loads: r.rows, drivers: drivers.rows,
    filters: { from: '', to: '', driver_id: '', status: '' },
    isAdmin: isAdmin(req), scopedDriverId: scopedDriverId(req),
    ocr: { ...extracted, ticket_photo: photoPath },
    ocrNotice: ok
      ? 'OCR suggestions below — please review and correct them before saving. (0/O and 1/I can be mixed up.)'
      : 'OCR is unavailable right now, so no values were extracted. Fill the form in manually — the photo is attached.',
  });
});

router.post('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id) return res.redirect('/loads');
  const appointment = req.body.appointment ? new Date(req.body.appointment) : null;
  await query(
    `INSERT INTO loads (driver_id, load_date, container_no, bol_ref, pickup, delivery,
       appointment, rate, prepull, reefer, detention, overweight, fsc, miles, status, ticket_photo, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [driver_id, req.body.load_date, (req.body.container_no || '').trim() || null,
     (req.body.bol_ref || '').trim() || null, (req.body.pickup || '').trim() || null,
     (req.body.delivery || '').trim() || null,
     appointment && !isNaN(appointment) ? appointment : null,
     num(req.body.rate), num(req.body.prepull), num(req.body.reefer), num(req.body.detention),
     num(req.body.overweight), num(req.body.fsc),
     num(req.body.miles), req.body.status === 'confirmed' ? 'confirmed' : 'pending',
     req.body.ticket_photo || null, (req.body.notes || '').trim() || null]
  );
  res.redirect('/loads');
});

router.post('/:id/edit', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const appointment = req.body.appointment ? new Date(req.body.appointment) : null;
  await query(
    `UPDATE loads SET load_date=$1, container_no=$2, bol_ref=$3, pickup=$4, delivery=$5,
       appointment=$6, rate=$7, prepull=$8, reefer=$9, detention=$10, overweight=$11, fsc=$12,
       miles=$13, status=$14, notes=$15
     WHERE id=$16`,
    [req.body.load_date, (req.body.container_no || '').trim() || null,
     (req.body.bol_ref || '').trim() || null, (req.body.pickup || '').trim() || null,
     (req.body.delivery || '').trim() || null,
     appointment && !isNaN(appointment) ? appointment : null,
     num(req.body.rate), num(req.body.prepull), num(req.body.reefer), num(req.body.detention),
     num(req.body.overweight), num(req.body.fsc),
     num(req.body.miles), req.body.status === 'confirmed' ? 'confirmed' : 'pending',
     (req.body.notes || '').trim() || null, req.params.id]
  );
  res.redirect('/loads');
});

// Advance the execution progress by one step:
// 예정(scheduled) → 픽업 완료(picked) → 배송 완료(delivered) → 반납 완료(returned).
// A driver may only advance their own loads.
router.post('/:id/progress', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const next = nextProgress(existing.rows[0].progress);
  await query('UPDATE loads SET progress = $1 WHERE id = $2', [next, req.params.id]);
  res.redirect(req.get('Referrer') || '/');
});

router.post('/:id/confirm', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  await query("UPDATE loads SET status = 'confirmed' WHERE id = $1", [req.params.id]);
  res.redirect('/loads');
});

// Delete confirmation page (no JS dialog, so it works everywhere).
router.get('/:id/delete-form', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query(
    `SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = $1`,
    [req.params.id]
  );
  if (!r.rows.length) return res.redirect('/loads');
  if (scope && r.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  res.render('load-delete', { load: r.rows[0], isAdmin: isAdmin(req) });
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  if (existing.rows[0].ticket_photo) {
    const p = path.join(__dirname, '..', existing.rows[0].ticket_photo);
    fs.unlink(p, () => {});
  }
  await query('DELETE FROM loads WHERE id = $1', [req.params.id]);
  res.redirect('/loads');
});

module.exports = router;
