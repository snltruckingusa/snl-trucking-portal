const express = require('express');
const { query } = require('../db');
const { requireLogin, isAdmin, scopedDriverId, toISODate } = require('../lib/helpers');

const router = express.Router();

// Shared company calendar (Eric, 2026-11-23): ONE calendar for everyone.
// Drivers enter only their own days off; the office can add entries for
// anyone, plus truck schedules (PM service, inspections) and company
// notices. Everyone signed in as admin or driver sees everything — the
// shared visibility is the point — but a driver can delete only the
// entries they created. (Mechanic and CPA roles never reach this page:
// the server.js role fences bounce them before routing.)

const KINDS = {
  dayoff: 'Day off',
  vacation: 'Vacation',
  truck: 'Truck schedule',
  notice: 'Company notice',
};

const normTruck = (s) => String(s || '').trim().replace(/^#/, '');
async function truckList() {
  const r = await query(
    `SELECT truck_number FROM (
       SELECT regexp_replace(truck_number, '^#', '') AS truck_number FROM vehicles
       UNION SELECT regexp_replace(truck_number, '^#', '') FROM drivers WHERE truck_number IS NOT NULL AND truck_number <> ''
       UNION SELECT regexp_replace(truck_number, '^#', '') FROM vehicle_docs
       UNION SELECT regexp_replace(truck_number, '^#', '') FROM mechanic_logs
     ) t WHERE truck_number <> '' ORDER BY truck_number`
  );
  return r.rows.map((x) => x.truck_number);
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function parseMonth(s) {
  const now = new Date();
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10);
    const m = parseInt(s.slice(5, 7), 10) - 1;
    if (m >= 0 && m <= 11) return { y, m };
  }
  return { y: now.getFullYear(), m: now.getMonth() };
}

const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null;

function decorate(rows) {
  return rows.map((e) => ({
    ...e,
    start: toISODate(e.start_date),
    end: toISODate(e.end_date) || toISODate(e.start_date),
    kindLabel: KINDS[e.kind] || e.kind,
    who: e.driver_name ? e.driver_name.split(' ')[0] : (e.truck_number ? '#' + normTruck(e.truck_number) : ''),
  }));
}

router.get('/', requireLogin, async (req, res) => {
  const u = req.session.user;
  if (u.role !== 'admin' && u.role !== 'driver') return res.redirect('/');
  const admin = isAdmin(req);
  const myDriverId = scopedDriverId(req);
  const { y, m } = parseMonth(req.query.m);
  const first = ymd(y, m, 1);
  const lastDay = new Date(y, m + 1, 0).getDate();
  const last = ymd(y, m, lastDay);

  const r = await query(
    `SELECT e.*, d.name AS driver_name FROM calendar_events e
     LEFT JOIN drivers d ON d.id = e.driver_id
     WHERE e.start_date <= $1 AND COALESCE(e.end_date, e.start_date) >= $2
     ORDER BY e.start_date, e.id`,
    [last, first]
  );
  const events = decorate(r.rows);

  // Month grid, weeks starting Sunday.
  const offset = new Date(y, m, 1).getDay();
  const cellCount = Math.ceil((offset + lastDay) / 7) * 7;
  const cells = [];
  for (let i = 0; i < cellCount; i++) {
    const d = new Date(y, m, 1 - offset + i);
    const ds = ymd(d.getFullYear(), d.getMonth(), d.getDate());
    cells.push({
      date: ds,
      day: d.getDate(),
      inMonth: d.getMonth() === m,
      events: events.filter((e) => e.start <= ds && ds <= e.end),
    });
  }

  const now = new Date();
  const today = ymd(now.getFullYear(), now.getMonth(), now.getDate());
  const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 45);
  const horizonStr = ymd(horizon.getFullYear(), horizon.getMonth(), horizon.getDate());
  const up = await query(
    `SELECT e.*, d.name AS driver_name FROM calendar_events e
     LEFT JOIN drivers d ON d.id = e.driver_id
     WHERE COALESCE(e.end_date, e.start_date) >= $1 AND e.start_date <= $2
     ORDER BY e.start_date, e.id`,
    [today, horizonStr]
  );

  const prev = new Date(y, m - 1, 1);
  const next = new Date(y, m + 1, 1);
  const drivers = admin ? (await query('SELECT * FROM drivers ORDER BY name')).rows : [];
  const trucks = admin ? await truckList() : [];

  res.render('calendar', {
    title: 'Calendar',
    cells, events, upcoming: decorate(up.rows),
    monthLabel: `${MONTH_NAMES[m]} ${y}`,
    prevM: `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`,
    nextM: `${next.getFullYear()}-${pad(next.getMonth() + 1)}`,
    thisM: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
    today, kinds: KINDS, isAdmin: admin, myDriverId, drivers, trucks,
  });
});

router.post('/', requireLogin, async (req, res) => {
  const u = req.session.user;
  if (u.role !== 'admin' && u.role !== 'driver') return res.redirect('/');
  const admin = isAdmin(req);
  const myDriverId = scopedDriverId(req);

  let kind = String(req.body.kind || 'dayoff');
  if (!KINDS[kind]) kind = 'dayoff';
  let driver_id = null;
  let truck_number = null;
  let createdByName = 'Office';
  let createdByDriverId = null;

  if (admin) {
    if (req.body.driver_id) driver_id = parseInt(req.body.driver_id, 10) || null;
    truck_number = normTruck(req.body.truck_number) || null;
    if (kind === 'notice') { driver_id = null; truck_number = null; }
    if (kind === 'truck') driver_id = null;
  } else {
    if (kind !== 'dayoff' && kind !== 'vacation') kind = 'dayoff';
    driver_id = myDriverId;
    createdByDriverId = myDriverId;
    const me = await query('SELECT name FROM drivers WHERE id = $1', [myDriverId]);
    createdByName = me.rows.length ? me.rows[0].name : 'Driver';
  }

  const start = validDate(req.body.start_date);
  if (!start) return res.redirect('/calendar');
  let end = validDate(req.body.end_date) || start;
  if (end < start) end = start;

  let title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) title = KINDS[kind];
  const note = String(req.body.note || '').trim().slice(0, 300);

  await query(
    `INSERT INTO calendar_events (start_date, end_date, kind, driver_id, truck_number, title, note, created_by_name, created_by_driver_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [start, end === start ? null : end, kind, driver_id, truck_number, title, note, createdByName, createdByDriverId]
  );
  res.redirect('/calendar?m=' + start.slice(0, 7));
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  const u = req.session.user;
  if (u.role !== 'admin' && u.role !== 'driver') return res.redirect('/');
  const admin = isAdmin(req);
  const myDriverId = scopedDriverId(req);
  const r = await query('SELECT * FROM calendar_events WHERE id = $1', [req.params.id]);
  if (r.rows.length) {
    const e = r.rows[0];
    if (admin || (myDriverId && e.created_by_driver_id === myDriverId)) {
      await query('DELETE FROM calendar_events WHERE id = $1', [req.params.id]);
    }
  }
  res.redirect('/calendar');
});

module.exports = router;
