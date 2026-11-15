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
const os = require('os');
const path = require('path');
const multer = require('multer');
const { query } = require('../db');
const {
  requireLogin, requireAdmin, scopedDriverId, num, fmtDate, isAdmin, nextProgress,
  weekStart, toISODate,
} = require('../lib/helpers');
const { matchLane } = require('../lib/rates');
const { parseEIR } = require('../lib/eir');

const router = express.Router();

const imageFilter = (req, file, cb) => {
  if (/^image\//.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only image files are accepted.'));
};

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads', 'tickets'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFilter,
});

// Evidence photos are kept in the database (durable across redeploys),
// so uploads for evidence use memory storage.
const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFilter,
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

// ---- Round 2 helpers: evidence, change log, settlement lock ----

// OCR a photo held in memory (evidence uploads): spill to a temp file
// for the worker process, then clean up.
async function ocrBuffer(buffer) {
  const tmp = path.join(os.tmpdir(), 'eir-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.img');
  try {
    fs.writeFileSync(tmp, buffer);
    return await ocrImage(tmp);
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// Save one evidence photo for a load: bytes into the DB + OCR + EIR parse.
// Returns the parsed EIR fields (possibly all-empty when OCR failed).
async function saveEvidence(loadId, stage, file, username) {
  let extracted = null;
  let ocrText = null;
  if (file && file.buffer) {
    const { text, ok } = await ocrBuffer(file.buffer);
    if (ok) {
      ocrText = text;
      extracted = parseEIR(text);
    }
  }
  const r = await query(
    `INSERT INTO load_evidence (load_id, stage, photo_data, mime_type, ocr_text, extracted, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [loadId, stage, file ? file.buffer : null, file ? file.mimetype : null,
     ocrText, extracted ? JSON.stringify(extracted) : null, username || null]
  );
  return { id: r.rows[0].id, extracted };
}

// Is the settlement for this driver's week of `dateISO` already closed?
// After Friday close-out, driver entries for that week lock (correction
// policy 2026-11-13): corrections go through the owner, or land as a
// next-week adjustment.
async function weekClosed(driverId, dateISO) {
  if (!dateISO) return false;
  const wsISO = toISODate(weekStart(new Date(dateISO + 'T00:00:00')));
  const r = await query(
    "SELECT status FROM settlements WHERE week_start = $1 AND driver_id = $2",
    [wsISO, driverId]
  );
  return r.rows.length > 0 && r.rows[0].status === 'closed';
}

const LOG_FIELDS = ['load_date', 'container_no', 'bol_ref', 'delivery', 'rate', 'prepull',
  'reefer', 'detention', 'overweight', 'fsc', 'miles', 'status'];
const MONEY_FIELDS = ['rate', 'prepull', 'reefer', 'detention', 'overweight', 'fsc'];

// Record old -> new for every tracked field that changed. Returns true
// when at least one money/identity field changed.
async function logChanges(loadId, username, oldRow, newVals) {
  let changed = false;
  for (const f of LOG_FIELDS) {
    if (!(f in newVals)) continue;
    const oldV = oldRow[f] === null || oldRow[f] === undefined ? '' : String(oldRow[f]).slice(0, 60);
    const newV = newVals[f] === null || newVals[f] === undefined ? '' : String(newVals[f]).slice(0, 60);
    const norm = (f === 'load_date') ? (s) => s.slice(0, 10) : (s) => s;
    if (norm(oldV) !== norm(newV)) {
      changed = true;
      await query(
        'INSERT INTO load_changes (load_id, changed_by, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
        [loadId, username || null, f, norm(oldV) || null, norm(newV) || null]
      );
    }
  }
  return changed;
}

// Evidence summary per load for list/dashboard display:
// { loadId: { load_out: n, pod: n, empty_in: n, ow: bool, items: [...] } }
async function evidenceSummary(loadIds) {
  const map = {};
  if (!loadIds.length) return map;
  const r = await query(
    `SELECT id, load_id, stage, extracted, created_at
     FROM load_evidence WHERE load_id = ANY($1) ORDER BY created_at`,
    [loadIds]
  );
  for (const row of r.rows) {
    if (!map[row.load_id]) map[row.load_id] = { load_out: 0, pod: 0, empty_in: 0, detention: 0, other: 0, ow: false, items: [] };
    map[row.load_id][row.stage] += 1;
    if (row.extracted && row.extracted.overweight) map[row.load_id].ow = true;
    map[row.load_id].items.push(row);
  }
  return map;
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
  const evidence = await evidenceSummary(r.rows.map(l => l.id));
  res.render('loads', {
    loads: r.rows, drivers: drivers.rows, evidence,
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
  const eir = ok ? parseEIR(text) : null;
  const drivers = await query('SELECT * FROM drivers ORDER BY name');
  const { where, params } = loadWhere(req);
  const r = await query(
    `SELECT l.*, d.name AS driver_name, d.truck_number FROM loads l
     JOIN drivers d ON d.id = l.driver_id ${where}
     ORDER BY l.load_date DESC, l.id DESC`,
    params
  );
  const evidence = await evidenceSummary(r.rows.map(l => l.id));
  let notice = ok
    ? 'OCR suggestions below — please review and correct them before saving. (0/O and 1/I can be mixed up.)'
    : 'OCR is unavailable right now, so no values were extracted. Fill the form in manually — the photo is attached.';
  if (eir && eir.overweight) {
    notice += ` ⚠ Overweight detected on the ticket: CARGO ${Math.round(eir.cargo_wt).toLocaleString()} lb over the ${eir.ow_limit.toLocaleString()} lb limit — check the Overweight field.`;
  }
  res.render('loads', {
    loads: r.rows, drivers: drivers.rows, evidence,
    filters: { from: '', to: '', driver_id: '', status: '' },
    isAdmin: isAdmin(req), scopedDriverId: scopedDriverId(req),
    ocr: { ...extracted, ticket_photo: photoPath },
    ocrNotice: notice,
  });
});

router.post('/', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const driver_id = scope || parseInt(req.body.driver_id, 10);
  if (!driver_id) return res.redirect('/loads');
  // Correction policy: drivers cannot add entries into a closed week.
  if (scope && await weekClosed(driver_id, req.body.load_date)) {
    return res.status(403).send('This week is already settled (closed). Ask the owner to add or correct entries.');
  }
  const appointment = req.body.appointment ? new Date(req.body.appointment) : null;
  const delivery = (req.body.delivery || '').trim() || null;
  let rate = num(req.body.rate), fsc = num(req.body.fsc), miles = num(req.body.miles);
  // Lane chart suggestion: when money/miles were left blank, prefill from
  // the rate chart for the delivery city. These are defaults only — the
  // dispatcher sometimes prices per load and the actual amount governs.
  if (rate === 0 && fsc === 0 && miles === 0) {
    const lane = matchLane(delivery);
    if (lane) {
      if (lane.rate) rate = lane.rate;
      if (lane.fsc) fsc = lane.fsc;
      if (lane.miles) miles = lane.miles;
    }
  }
  const detentionAmt = num(req.body.detention);
  // Driver-entered detention is a CLAIM: pending until the owner approves.
  const detentionStatus = detentionAmt > 0 ? (scope ? 'pending' : 'approved') : 'none';
  await query(
    `INSERT INTO loads (driver_id, load_date, container_no, bol_ref, pickup, delivery,
       appointment, rate, prepull, reefer, detention, detention_status, overweight, fsc, miles, status, ticket_photo, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [driver_id, req.body.load_date, (req.body.container_no || '').trim() || null,
     (req.body.bol_ref || '').trim() || null, (req.body.pickup || '').trim() || null,
     delivery,
     appointment && !isNaN(appointment) ? appointment : null,
     rate, num(req.body.prepull), num(req.body.reefer), detentionAmt, detentionStatus,
     num(req.body.overweight), fsc,
     miles, req.body.status === 'confirmed' ? 'confirmed' : 'pending',
     req.body.ticket_photo || null, (req.body.notes || '').trim() || null]
  );
  res.redirect('/loads');
});

router.post('/:id/edit', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  const old = existing.rows[0];
  if (scope && old.driver_id !== scope) return res.status(403).send('Forbidden.');
  // Correction policy: after Friday close-out the week locks for drivers.
  if (scope && await weekClosed(old.driver_id, fmtDate(old.load_date))) {
    return res.status(403).send('This week is already settled (closed). Corrections go through the owner.');
  }
  const appointment = req.body.appointment ? new Date(req.body.appointment) : null;
  const newVals = {
    load_date: req.body.load_date,
    container_no: (req.body.container_no || '').trim() || null,
    bol_ref: (req.body.bol_ref || '').trim() || null,
    delivery: (req.body.delivery || '').trim() || null,
    rate: num(req.body.rate), prepull: num(req.body.prepull), reefer: num(req.body.reefer),
    detention: num(req.body.detention), overweight: num(req.body.overweight),
    fsc: num(req.body.fsc), miles: num(req.body.miles),
    status: req.body.status === 'confirmed' ? 'confirmed' : 'pending',
  };
  const changed = await logChanges(old.id, req.session.user.username, old, newVals);
  // Correction policy: a DRIVER editing a confirmed load returns it to
  // pending for the owner's re-review. The owner editing keeps the
  // submitted status (his edit is the review) but is still logged.
  let status = newVals.status;
  if (scope && old.status === 'confirmed' && changed) {
    status = 'pending';
    await query(
      'INSERT INTO load_changes (load_id, changed_by, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
      [old.id, req.session.user.username, 'status', 'confirmed', 'pending (driver edit — re-review)']
    );
  }
  // Detention edited by a driver becomes a pending claim again.
  let detentionStatus = old.detention_status;
  if (newVals.detention !== num(old.detention)) {
    detentionStatus = newVals.detention > 0 ? (scope ? 'pending' : 'approved') : 'none';
  }
  await query(
    `UPDATE loads SET load_date=$1, container_no=$2, bol_ref=$3, pickup=$4, delivery=$5,
       appointment=$6, rate=$7, prepull=$8, reefer=$9, detention=$10, detention_status=$11,
       overweight=$12, fsc=$13, miles=$14, status=$15, notes=$16
     WHERE id=$17`,
    [newVals.load_date, newVals.container_no, newVals.bol_ref,
     (req.body.pickup || '').trim() || null, newVals.delivery,
     appointment && !isNaN(appointment) ? appointment : null,
     newVals.rate, newVals.prepull, newVals.reefer, newVals.detention, detentionStatus,
     newVals.overweight, newVals.fsc,
     newVals.miles, status,
     (req.body.notes || '').trim() || null, req.params.id]
  );
  res.redirect('/loads');
});

// Advance the execution progress by one step:
// scheduled → picked → delivered → returned.
// A driver may only advance their own loads. The step's evidence photo
// (LOAD OUT ticket / POD / EMPTY IN ticket) may be attached with the same
// tap — it is stored durably in the database and OCR-parsed.
// Stage reached -> evidence stage name.
const PROGRESS_EVIDENCE = { picked: 'load_out', delivered: 'pod', returned: 'empty_in' };

router.post('/:id/progress', requireLogin, uploadMem.single('evidence'), async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const next = nextProgress(existing.rows[0].progress);
  if (next === 'returned' && !existing.rows[0].returned_on) {
    await query('UPDATE loads SET progress = $1, returned_on = CURRENT_DATE WHERE id = $2', [next, req.params.id]);
  } else {
    await query('UPDATE loads SET progress = $1 WHERE id = $2', [next, req.params.id]);
  }
  if (req.file && PROGRESS_EVIDENCE[next]) {
    await saveEvidence(existing.rows[0].id, PROGRESS_EVIDENCE[next], req.file, req.session.user.username);
  }
  res.redirect(req.get('Referrer') || '/');
});

// Attach an evidence photo to a load at any time (a stage the driver
// already passed, a substitute return/prepull ticket, and so on).
router.post('/:id/evidence', requireLogin, uploadMem.single('photo'), async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const stage = ['load_out', 'pod', 'empty_in', 'detention', 'other'].includes(req.body.stage)
    ? req.body.stage : 'other';
  if (req.file) {
    await saveEvidence(existing.rows[0].id, stage, req.file, req.session.user.username);
  }
  res.redirect(req.get('Referrer') || '/loads');
});

// Serve a stored evidence photo (bytes from the DB, or the legacy
// on-disk path for rows saved before round 2).
router.get('/evidence/:eid/photo', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const r = await query(
    `SELECT e.*, l.driver_id FROM load_evidence e JOIN loads l ON l.id = e.load_id WHERE e.id = $1`,
    [req.params.eid]
  );
  if (!r.rows.length) return res.status(404).send('Not found.');
  const ev = r.rows[0];
  if (scope && ev.driver_id !== scope) return res.status(403).send('Forbidden.');
  if (ev.photo_data) {
    res.type(ev.mime_type || 'image/jpeg');
    return res.send(ev.photo_data);
  }
  if (ev.photo_path) {
    const p = path.join(__dirname, '..', ev.photo_path);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  return res.status(404).send('Photo not available.');
});

// List evidence rows for one load (admin + owning driver) as JSON —
// used by the loads page to show what has been uploaded.
router.get('/:id/evidence', requireLogin, async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.status(404).json([]);
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const r = await query(
    'SELECT id, stage, mime_type, extracted, uploaded_by, created_at FROM load_evidence WHERE load_id = $1 ORDER BY created_at',
    [req.params.id]
  );
  res.json(r.rows);
});

// Detention claim: the driver enters the amount from the dispatcher's
// confirmation message and attaches that message as evidence. The claim
// stays 'pending' (excluded from settlement) until the owner approves.
router.post('/:id/detention', requireLogin, uploadMem.single('photo'), async (req, res) => {
  const scope = scopedDriverId(req);
  const existing = await query('SELECT * FROM loads WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.redirect('/loads');
  if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
  const amount = num(req.body.amount);
  if (amount <= 0) return res.redirect(req.get('Referrer') || '/loads');
  const status = scope ? 'pending' : 'approved';
  await query('UPDATE loads SET detention = $1, detention_status = $2 WHERE id = $3',
    [amount, status, req.params.id]);
  await query(
    'INSERT INTO load_changes (load_id, changed_by, field, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, req.session.user.username, 'detention_claim', String(num(existing.rows[0].detention)), `${amount} (${status})`]
  );
  if (req.file) {
    await saveEvidence(existing.rows[0].id, 'detention', req.file, req.session.user.username);
  }
  res.redirect(req.get('Referrer') || '/loads');
});

// Owner decision on a detention claim.
router.post('/:id/detention-approve', requireLogin, requireAdmin, async (req, res) => {
  await query("UPDATE loads SET detention_status = 'approved' WHERE id = $1", [req.params.id]);
  res.redirect(req.get('Referrer') || '/loads');
});
router.post('/:id/detention-reject', requireLogin, requireAdmin, async (req, res) => {
  await query("UPDATE loads SET detention_status = 'rejected' WHERE id = $1", [req.params.id]);
  res.redirect(req.get('Referrer') || '/loads');
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
