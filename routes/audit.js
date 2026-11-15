// Audit page (Eric, 2026-11-15): the owner's one-screen answer to
// "what would an auditor find?" — every driver's qualification packet
// and every truck's document register, read off the SAME checklist
// definitions as My File / My Truck (lib/checklists.js), so the answer
// here can never disagree with what the driver sees. Read-only.
const express = require('express');
const { query } = require('../db');
const { requireLogin, isAdmin, toISODate, daysUntil } = require('../lib/helpers');
const { docChecklist, profileChecklist, vehicleChecklist, DRIVER_DOC_CHECKLIST } = require('../lib/checklists');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden.');
  const todayISO = toISODate(new Date());

  const drivers = (await query('SELECT * FROM drivers ORDER BY active DESC, name')).rows;
  const driverRows = [];
  let fleetMissing = 0, fleetExpiring = 0, fleetPending = 0, completeDrivers = 0;
  for (const d of drivers) {
    const docs = (await query(
      'SELECT id, category, status, expires_on, uploaded_at, is_duplicate FROM documents WHERE driver_id = $1 ORDER BY uploaded_at DESC',
      [d.id]
    )).rows;
    const checklist = docChecklist(docs);
    const missing = [], expired = [], expiring = [];
    let have = 0;
    for (const c of checklist) {
      if (!c.doc) { missing.push(c.label); continue; }
      have++;
      if (c.expires && c.doc.expires_on) {
        const days = daysUntil(c.doc.expires_on);
        if (days !== null && days < 0) expired.push(c.label);
        else if (days !== null && days <= 60) expiring.push({ label: c.label, days });
      }
    }
    const profile = profileChecklist(d);
    const profileMissing = profile.filter((i) => !i.done).map((i) => i.label);
    const pending = docs.filter((x) => x.status === 'pending').length;
    if (d.active) {
      fleetMissing += missing.length;
      fleetExpiring += expired.length + expiring.length;
      fleetPending += pending;
      if (!missing.length && !expired.length && !profileMissing.length) completeDrivers++;
    }
    driverRows.push({
      driver: d, have, total: DRIVER_DOC_CHECKLIST.length,
      missing, expired, expiring, profileMissing, pending,
    });
  }

  // Vehicles: the register rows plus each truck's document checklist.
  const vehicles = (await query('SELECT * FROM vehicles ORDER BY truck_number')).rows;
  const truckNums = new Set(vehicles.map((v) => String(v.truck_number).replace(/#/g, '').trim()));
  drivers.forEach((d) => { if (d.truck_number) truckNums.add(String(d.truck_number).replace(/#/g, '').trim()); });
  const vehicleRows = [];
  for (const t of [...truckNums].sort()) {
    const vdocs = (await query(
      `SELECT id, category, original_name, expires_on, uploaded_at, status FROM vehicle_docs
       WHERE REPLACE(truck_number, '#', '') = $1 ORDER BY uploaded_at DESC`, [t]
    )).rows;
    const checklist = vehicleChecklist(vdocs);
    const reg = checklist.find((c) => c.key === 'registration');
    const insp = checklist.find((c) => c.key === 'annual_inspection');
    const missing = checklist.filter((c) => !c.optional && !c.doc).map((c) => c.label);
    const veh = vehicles.find((v) => String(v.truck_number).replace(/#/g, '').trim() === t) || null;
    vehicleRows.push({ truck: t, vehicle: veh, reg, insp, missing });
  }

  res.render('audit', {
    isAdmin: true, todayISO, driverRows, vehicleRows,
    summary: {
      activeDrivers: drivers.filter((d) => d.active).length,
      completeDrivers, fleetMissing, fleetExpiring, fleetPending,
    },
  });
});

module.exports = router;
