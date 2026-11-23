const express = require('express');
const { query } = require('../db');
const { requireLogin, isAdmin, scopedDriverId, fmtDate } = require('../lib/helpers');
const { TOPICS, getTopic, stepCount, checkAnswers } = require('../lib/training-topics');

const router = express.Router();

// Safety training (Eric, 2026-11-23): short listen-first topics in the
// portal. A driver opens a topic and the whole flow — listen screens,
// tap-to-match check, multiple choice, signature — runs on ONE player
// page with no navigation in between. Progress auto-saves so a driver
// who gets interrupted resumes where they stopped. Completion is only
// recorded when the server re-verifies every check answer and has a
// signature on file. Admin sees a driver × topic completion matrix.
// (Mechanic and CPA roles never reach this router: the server.js role
// fences bounce them before routing, and /training is in neither
// role's allowlist.)
//
// Every handler is wrapped in try/catch on purpose: an unhandled
// rejection in an async handler exits the whole Node process, so a
// training bug must never be able to take the portal down.

// A drawn signature from the sign canvas (1120x360 PNG) is normally
// 20–80 KB as a data URL. Cap what we store so a bad client cannot
// stuff megabytes into the row (the global JSON body limit is 10 MB).
const MAX_SIGNATURE_CHARS = 400000;

function roleOk(req) {
  const u = req.session && req.session.user;
  return !!u && (u.role === 'admin' || u.role === 'driver');
}

// answers must be a plain object before it goes anywhere near the DB.
function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function statusOf(rec) {
  if (!rec) return { key: 'none', label: 'Not started' };
  if (rec.completed_at) return { key: 'done', label: 'Completed · ' + fmtDate(rec.completed_at) };
  return { key: 'progress', label: 'In progress' };
}

router.get('/', requireLogin, async (req, res) => {
  try {
    if (!roleOk(req)) return res.redirect('/');
    const admin = isAdmin(req);
    const myDriverId = scopedDriverId(req);

    if (!admin) {
      const r = await query('SELECT * FROM training_records WHERE driver_id = $1', [myDriverId]);
      const byTopic = {};
      r.rows.forEach((rec) => { byTopic[rec.topic_id] = rec; });
      const topics = TOPICS.map((t) => ({ id: t.id, title: t.title, subtitle: t.subtitle, status: statusOf(byTopic[t.id]) }));
      return res.render('training', { title: 'Safety Training', isAdmin: false, topics, drivers: null, matrix: null });
    }

    const dr = await query('SELECT id, name FROM drivers ORDER BY name');
    const rr = await query('SELECT * FROM training_records');
    const recOf = {};
    rr.rows.forEach((rec) => { recOf[rec.driver_id + ':' + rec.topic_id] = rec; });
    const matrix = dr.rows.map((d) => ({
      driver: d,
      cells: TOPICS.map((t) => statusOf(recOf[d.id + ':' + t.id])),
    }));
    const topics = TOPICS.map((t) => ({ id: t.id, title: t.title, subtitle: t.subtitle }));
    res.render('training', { title: 'Safety Training', isAdmin: true, topics, drivers: dr.rows, matrix });
  } catch (err) {
    console.error('[training] GET / failed:', err);
    res.status(500).send('Training could not be loaded. Please tell the office.');
  }
});

router.get('/:topicId', requireLogin, async (req, res) => {
  try {
    if (!roleOk(req)) return res.redirect('/');
    const topic = getTopic(req.params.topicId);
    if (!topic) return res.redirect('/training');
    const admin = isAdmin(req);
    const myDriverId = scopedDriverId(req);

    let record = null;
    if (!admin) {
      if (!myDriverId) return res.redirect('/');
      const r = await query(
        'SELECT step, answers, completed_at FROM training_records WHERE driver_id = $1 AND topic_id = $2',
        [myDriverId, topic.id]
      );
      if (r.rows.length) {
        const rec = r.rows[0];
        record = {
          step: rec.step || 0,
          answers: plainObject(rec.answers) || {},
          completedAt: rec.completed_at ? fmtDate(rec.completed_at) : null,
        };
      }
    }

    res.render('training-play', {
      title: topic.title,
      topic, record, preview: admin,
      totalSteps: stepCount(topic),
    });
  } catch (err) {
    console.error('[training] GET player failed:', err);
    res.status(500).send('Training could not be loaded. Please tell the office.');
  }
});

router.post('/:topicId/progress', requireLogin, async (req, res) => {
  try {
    if (!roleOk(req)) return res.status(403).json({ ok: false });
    if (isAdmin(req)) return res.status(403).json({ ok: false }); // preview writes nothing
    const topic = getTopic(req.params.topicId);
    if (!topic) return res.status(404).json({ ok: false });
    const myDriverId = scopedDriverId(req);
    if (!myDriverId) return res.status(403).json({ ok: false });

    const body = plainObject(req.body) || {};
    let step = parseInt(body.step, 10);
    if (isNaN(step) || step < 0) step = 0;
    if (step > stepCount(topic)) step = stepCount(topic);
    const answers = plainObject(body.answers);

    await query(
      `INSERT INTO training_records (driver_id, topic_id, step, answers, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (driver_id, topic_id) DO UPDATE
         SET step = EXCLUDED.step,
             answers = COALESCE(EXCLUDED.answers, training_records.answers),
             updated_at = now()
         WHERE training_records.completed_at IS NULL`,
      [myDriverId, topic.id, step, answers ? JSON.stringify(answers) : null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[training] progress failed:', err);
    res.status(500).json({ ok: false });
  }
});

router.post('/:topicId/complete', requireLogin, async (req, res) => {
  try {
    if (!roleOk(req)) return res.status(403).json({ ok: false });
    if (isAdmin(req)) return res.status(403).json({ ok: false });
    const topic = getTopic(req.params.topicId);
    if (!topic) return res.status(404).json({ ok: false });
    const myDriverId = scopedDriverId(req);
    if (!myDriverId) return res.status(403).json({ ok: false });

    const body = plainObject(req.body) || {};
    const answers = plainObject(body.answers) || {};
    const verdict = checkAnswers(topic, answers);
    if (!verdict.ok) return res.status(422).json({ ok: false, failed: verdict.failed });

    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!signature.startsWith('data:image/png;base64,') || signature.length > MAX_SIGNATURE_CHARS) {
      return res.status(400).json({ ok: false, failed: ['signature'] });
    }
    const printName = String(body.name || '').trim().slice(0, 120);
    if (!printName) return res.status(400).json({ ok: false, failed: ['name'] });

    // The printed name rides inside the answers JSON (the record's
    // evidence bundle) so the schema stays exactly as designed.
    const stored = Object.assign({}, answers, { printName });
    await query(
      `INSERT INTO training_records (driver_id, topic_id, step, answers, signature, completed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (driver_id, topic_id) DO UPDATE
         SET step = EXCLUDED.step, answers = EXCLUDED.answers,
             signature = EXCLUDED.signature, completed_at = now(), updated_at = now()`,
      [myDriverId, topic.id, stepCount(topic), JSON.stringify(stored), signature]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[training] complete failed:', err);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
