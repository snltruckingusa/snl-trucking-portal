// Fuel: record / edit / delete / weekly briefing home + filtered list.
//
// Entry (Eric, 2026-11-24): the form takes Gallons + Total $ — the
// server stores cost = the entered Total exactly and auto-computes
// tcs_price = total / gallons (4 decimals). (The old flow stored
// gallons x a hand-typed TCS price, whose rounding drifted a few cents
// from Excel.) There is NO Pump $/gal input anymore (2026-11-26):
// totals kept getting typed into that box and corrupted the column, so
// new rows store pump_price = 0; the column remains on the detail list
// only for pre-2026-11-24 history.
//
// Home (redesign, 2026-11-26): /fuel with no from/to keys in the query
// is a weekly briefing in the invoice-home design language — one
// Sun–Sat week, a cost donut by driver (or by truck with ?view=truck),
// summary cards, and a breakdown whose rows drill into the filtered
// list for that driver/truck and week. Under the breakdown, the week's
// individual entries are listed too ("This week's entries", newest
// first) so whoever is entering fuel can spot duplicates or missing
// rows without leaving the dashboard (Eric, 2026-11-26). The original
// flat list (From/To/Driver/Truck filters + Delete) is unchanged and
// renders whenever a from/to key is present in the query.
const express = require('express');
const { query } = require('../db');
const {
  requireLogin, scopedDriverId, num, isAdmin,
  weekStart, weekEnd, toISODate, addDays,
} = require('../lib/helpers');

const router = express.Router();

// Driver/truck split (Eric, 2026-11-23): a fuel record names the truck it
// went into, frozen at entry time. drivers.truck_number is only the
// driver's CURRENT assignment (form default). Truck choices come from the
// registered trucks only — never free-typed.
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
async function defaultTruck(driverId) {
  if (!driverId) return '';
  const r = await query('SELECT truck_number FROM drivers WHERE id = $1', [driverId]);
  return r.rows.length ? normTruck(r.rows[0].truck_number) : '';
}

const r2 = (n) => Math.round(num(n) * 100) / 100;

// Donut palette: the invoice family first, extended for extra drivers.
const PALETTE = ['#4f8ff7', '#f5a623', '#9aa3ad', '#3bb273', '#8e6cc8', '#d95f76', '#3aa6a0'];

// Turn breakdown groups into donut segments (percent of the week's
// total cost, pathLength=100 style — same technique as the invoice
// home). Null when there is nothing to show.
function donutForBreakdown(breakdown, total) {
  if (!(total > 0) || !breakdown.length) return null;
  let acc = 0;
  const slices = breakdown.map(b => {
    const pct = Math.round((b.cost / total) * 10000) / 100;
    const seg = { label: b.label, color: b.color, amount: b.cost, pct, offset: -acc };
    acc = Math.round((acc + pct) * 100) / 100;
    return seg;
  });
  return { total, slices };
}

router.get('/', requireLogin, async (req, res) => {
  try {
    const scope = scopedDriverId(req);
    const drivers = (await query('SELECT * FROM drivers ORDER BY name')).rows;
    const trucks = await truckList();
    const base = {
      drivers, trucks,
      isAdmin: isAdmin(req), scopedDriverId: scope,
      filters: { from: '', to: '', driver_id: '', truck: '' },
      mode: 'dashboard', fuel: [], weekRows: [],
      weekISO: '', weekEndISO: '', prevWeek: '', nextWeek: '',
      viewMode: 'driver', donut: null, cards: null, breakdown: [],
    };

    // ---- Detail mode: the original flat list -------------------------
    // Reached whenever a from/to key is in the query. The filter form
    // always submits both keys, so refining a search stays in the list;
    // the dashboard's drill-down links land here too.
    if ('from' in req.query || 'to' in req.query) {
      const conditions = [];
      const params = [];
      if (scope) { params.push(scope); conditions.push(`f.driver_id = $${params.length}`); }
      if (req.query.driver_id && !scope) { params.push(req.query.driver_id); conditions.push(`f.driver_id = $${params.length}`); }
      if (req.query.from) { params.push(req.query.from); conditions.push(`f.fuel_date >= $${params.length}`); }
      if (req.query.to) { params.push(req.query.to); conditions.push(`f.fuel_date <= $${params.length}`); }
      if (req.query.truck) { params.push(normTruck(req.query.truck)); conditions.push(`f.truck_number = $${params.length}`); }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const r = await query(
        `SELECT f.*, d.name AS driver_name, d.truck_number AS driver_truck FROM fuel f
         JOIN drivers d ON d.id = f.driver_id ${where}
         ORDER BY f.fuel_date DESC, f.id DESC`,
        params
      );
      return res.render('fuel', {
        ...base, mode: 'list', fuel: r.rows,
        filters: {
          from: req.query.from || '', to: req.query.to || '',
          driver_id: req.query.driver_id || '', truck: req.query.truck || '',
        },
      });
    }

    // ---- Dashboard mode: one Sun–Sat week ----------------------------
    // Guard: a malformed ?week= must never reach the date math as an
    // Invalid Date — fall back to the current week (invoice pattern).
    // A valid date is snapped to the Sunday of its week.
    let wsISO = req.query.week;
    if (!wsISO || !/^\d{4}-\d{2}-\d{2}$/.test(wsISO) || isNaN(new Date(wsISO + 'T00:00:00'))) {
      wsISO = toISODate(weekStart(new Date()));
    } else {
      wsISO = toISODate(weekStart(new Date(wsISO + 'T00:00:00')));
    }
    const wsDate = new Date(wsISO + 'T00:00:00');
    const weISO = toISODate(weekEnd(wsDate));
    const viewMode = req.query.view === 'truck' ? 'truck' : 'driver';

    // A logged-in driver is scoped to their own rows, so every number
    // below (totals, donut, breakdown) is their own week only.
    const conditions = ['f.fuel_date >= $1', 'f.fuel_date <= $2'];
    const params = [wsISO, weISO];
    if (scope) { params.push(scope); conditions.push(`f.driver_id = $${params.length}`); }
    const r = await query(
      `SELECT f.*, d.name AS driver_name, d.truck_number AS driver_truck FROM fuel f
       JOIN drivers d ON d.id = f.driver_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY f.fuel_date DESC, f.id DESC`,
      params
    );

    let totalCost = 0, totalGallons = 0;
    const groups = new Map();
    for (const row of r.rows) {
      const c = num(row.cost), g = num(row.gallons);
      totalCost += c; totalGallons += g;
      let key, label, href;
      if (viewMode === 'truck') {
        // Group by the truck frozen on the row (fall back to the
        // driver's current truck, same as the list displays).
        const tk = normTruck(row.truck_number || row.driver_truck || '');
        key = 't:' + tk;
        label = tk ? '#' + tk : 'No truck recorded';
        href = '/fuel?from=' + wsISO + '&to=' + weISO + (tk ? '&truck=' + encodeURIComponent(tk) : '');
      } else {
        key = 'd:' + row.driver_id;
        label = row.driver_name;
        href = '/fuel?from=' + wsISO + '&to=' + weISO + (scope ? '' : '&driver_id=' + row.driver_id);
      }
      if (!groups.has(key)) groups.set(key, { key, label, href, gallons: 0, cost: 0 });
      const grp = groups.get(key);
      grp.gallons += g; grp.cost += c;
    }
    totalCost = r2(totalCost); totalGallons = r2(totalGallons);
    const breakdown = [...groups.values()]
      .sort((a, b) => b.cost - a.cost)
      .map((grp, i) => ({
        ...grp,
        gallons: r2(grp.gallons), cost: r2(grp.cost),
        share: totalCost > 0 ? Math.round((grp.cost / totalCost) * 1000) / 10 : 0,
        color: PALETTE[i % PALETTE.length],
      }));
    const cards = {
      totalCost, totalGallons,
      avgPrice: totalGallons > 0 ? Math.round((totalCost / totalGallons) * 10000) / 10000 : null,
      entries: r.rows.length,
    };
    // The week's individual entries, newest first, for the table under
    // the breakdown. Same conditions (and driver scoping) as the
    // aggregate query above, so a logged-in driver sees only their own
    // rows here too; admins/CPA see all.
    const weekRows = (await query(
      `SELECT f.*, d.name AS driver_name, d.truck_number AS driver_truck FROM fuel f
       JOIN drivers d ON d.id = f.driver_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY f.fuel_date DESC, f.id DESC`,
      params
    )).rows;
    return res.render('fuel', {
      ...base, mode: 'dashboard',
      weekISO: wsISO, weekEndISO: weISO,
      prevWeek: toISODate(addDays(wsDate, -7)), nextWeek: toISODate(addDays(wsDate, 7)),
      viewMode, cards, breakdown, weekRows,
      donut: donutForBreakdown(breakdown, totalCost),
    });
  } catch (e) {
    console.error('fuel GET failed:', e);
    return res.status(500).send('Fuel failed to load. Please try again.');
  }
});

router.post('/', requireLogin, async (req, res) => {
  try {
    const scope = scopedDriverId(req);
    const driver_id = scope || parseInt(req.body.driver_id, 10);
    if (!driver_id) return res.redirect('/fuel');
    const gallons = num(req.body.gallons);
    let tcs_price = num(req.body.tcs_price);
    let cost = Math.round(gallons * tcs_price * 100) / 100;
    const enteredCost = num(req.body.cost);
    if (enteredCost > 0 && gallons > 0) {
      cost = Math.round(enteredCost * 100) / 100;
      tcs_price = Math.round((cost / gallons) * 10000) / 10000;
    }
    let truck_number = normTruck(req.body.truck_number);
    if (!truck_number) truck_number = await defaultTruck(driver_id);
    await query(
      'INSERT INTO fuel (driver_id, fuel_date, gallons, pump_price, tcs_price, cost, truck_number) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [driver_id, req.body.fuel_date, gallons, num(req.body.pump_price), tcs_price, cost, truck_number || null]
    );
    res.redirect('/fuel');
  } catch (e) {
    console.error('fuel POST failed:', e);
    res.redirect('/fuel');
  }
});

router.post('/:id/edit', requireLogin, async (req, res) => {
  try {
    const scope = scopedDriverId(req);
    const existing = await query('SELECT * FROM fuel WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.redirect('/fuel');
    if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
    const gallons = num(req.body.gallons);
    let tcs_price = num(req.body.tcs_price);
    let cost = Math.round(gallons * tcs_price * 100) / 100;
    const enteredCost = num(req.body.cost);
    if (enteredCost > 0 && gallons > 0) {
      cost = Math.round(enteredCost * 100) / 100;
      tcs_price = Math.round((cost / gallons) * 10000) / 10000;
    }
    const truck_number = normTruck(req.body.truck_number) || normTruck(existing.rows[0].truck_number) || await defaultTruck(existing.rows[0].driver_id);
    await query(
      'UPDATE fuel SET fuel_date=$1, gallons=$2, pump_price=$3, tcs_price=$4, cost=$5, truck_number=$6 WHERE id=$7',
      [req.body.fuel_date, gallons, num(req.body.pump_price), tcs_price, cost, truck_number || null, req.params.id]
    );
    res.redirect('/fuel');
  } catch (e) {
    console.error('fuel edit failed:', e);
    res.redirect('/fuel');
  }
});

router.post('/:id/delete', requireLogin, async (req, res) => {
  try {
    const scope = scopedDriverId(req);
    const existing = await query('SELECT * FROM fuel WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.redirect('/fuel');
    if (scope && existing.rows[0].driver_id !== scope) return res.status(403).send('Forbidden.');
    await query('DELETE FROM fuel WHERE id = $1', [req.params.id]);
    res.redirect('/fuel');
  } catch (e) {
    console.error('fuel delete failed:', e);
    res.redirect('/fuel');
  }
});

module.exports = router;
