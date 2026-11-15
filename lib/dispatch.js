// PierLink dispatch-message parsing (OCR text of the dispatcher's
// WhatsApp order capture). A dispatch bundles TWO gate moves
// (Eric, 2026-11-14) — the pair defines the job type:
//   standard     — EMPTY RETURN (in) + LOAD OUT: container + gate PIN
//                  per leg; the load leg also carries the MBL and the
//                  delivery CITY (the lane key — settlement records
//                  the city only; customer/address stay in the note).
//   in_out_empty — LOAD IN + EMPTY OUT (export drop, empty away).
//   in_out_load  — LOAD IN + LOAD OUT (drop one load, pull another).
// Everything extracted is a SUGGESTION for a human to confirm — the
// rate that pre-fills from the city is the chart default until the
// load-out ticket locks the money facts.
// Everything extracted is a SUGGESTION for a human to confirm — the
// rate that pre-fills from the city is the chart default until the
// load-out ticket locks the money facts.
const { LANES } = require('./rates');

const CITY_LABELS = {
  'DALTON': 'Dalton', 'ADAIRSVILLE': 'Adairsville', 'WHITE': 'White',
  'CALHOUN': 'Calhoun', 'AUBURN': 'Auburn', 'BUFORD': 'Buford',
  'OPELIKA': 'Opelika', 'LANETTE': 'Lanette', 'VALLEY': 'Valley',
  'LA GRANGE': 'La Grange', 'LAGRANGE': 'La Grange', 'DULUTH': 'Duluth',
  'SUWANEE': 'Suwanee', 'DECATUR': 'Decatur', 'ELLABELL': 'Ellabell',
  'RINCON': 'Rincon', 'FOREST PARK': 'Forest Park',
};

function findContainers(text) {
  const out = [];
  const re = /\b([A-Za-z]{4}\s?\d{7})\b/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    const c = m[1].replace(/\s/g, '').toUpperCase();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// Longest lane-key match wins, same rule as lib/rates matchLane.
function findCity(text) {
  const t = (text || '').toUpperCase();
  let best = null;
  for (const key of Object.keys(LANES)) {
    if (t.includes(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? (CITY_LABELS[best] || best) : '';
}

const LEG_MARKERS = [
  { kind: 'empty_in', re: /EMPTY\s*(?:RETURN|IN)/i },
  { kind: 'load_in', re: /LOAD\s*IN/i },
  { kind: 'load_out', re: /LOAD\s*OUT/i },
  { kind: 'empty_out', re: /EMPTY\s*OUT/i },
];

function findLegs(text) {
  const t = text || '';
  const found = [];
  for (const m of LEG_MARKERS) {
    const match = t.match(m.re);
    if (match) found.push({ kind: m.kind, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

function isDispatchText(text) {
  const t = text || '';
  if (findLegs(t).length >= 2) return true;
  return (/EMPTY/i.test(t) && /LOAD\s*OUT/i.test(t)) || (t.match(/PIN/gi) || []).length >= 2;
}

function findPin(text) {
  const m = (text || '').match(/PIN\s*#?\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,11})/i);
  return m ? m[1].toUpperCase() : '';
}

function parseDispatchText(text) {
  const t = (text || '').replace(/\r/g, '\n');
  const out = {
    is_dispatch: isDispatchText(t), job_type: 'standard',
    empty_container: '', empty_pin: '', container_no: '', load_pin: '',
    bol_ref: '', delivery: '', delivery_line: '', appointment: '',
  };
  if (!out.is_dispatch) return out;

  const legs = findLegs(t);
  let leg1, leg2;
  if (legs.length >= 2) {
    leg1 = { kind: legs[0].kind, text: t.slice(legs[0].index, legs[1].index) };
    leg2 = { kind: legs[1].kind, text: t.slice(legs[1].index) };
  } else {
    // Fallback: split at LOAD OUT like the original two-leg read.
    const idx = t.search(/LOAD\s*OUT/i);
    leg1 = { kind: 'empty_in', text: idx >= 0 ? t.slice(0, idx) : '' };
    leg2 = { kind: 'load_out', text: idx >= 0 ? t.slice(idx) : t };
  }
  const legCont = leg => (findContainers(leg.text)[0] || '');
  // The "in slot" (empty_container) holds the first gate move's box
  // when it is not the settled load; the load slot is the settled box.
  const assignIn = leg => { out.empty_container = legCont(leg); out.empty_pin = findPin(leg.text); };
  const assignLoad = leg => { out.container_no = legCont(leg); out.load_pin = findPin(leg.text); };
  let loadLeg = null;
  if (leg1.kind === 'empty_in' && leg2.kind === 'load_out') {
    out.job_type = 'standard'; assignIn(leg1); assignLoad(leg2); loadLeg = leg2;
  } else if (leg1.kind === 'load_in' && leg2.kind === 'empty_out') {
    out.job_type = 'in_out_empty'; assignLoad(leg1);
    out.empty_container = legCont(leg2); out.empty_pin = findPin(leg2.text);
  } else if (leg1.kind === 'load_in' && leg2.kind === 'load_out') {
    out.job_type = 'in_out_load'; assignIn(leg1); assignLoad(leg2); loadLeg = leg2;
  } else {
    assignIn(leg1);
    if (leg2.kind === 'load_out' || leg2.kind === 'load_in') { assignLoad(leg2); loadLeg = leg2; }
  }
  if (!out.empty_container && out.container_no && legs.length < 2) {
    const other = findContainers(t).find(c => c !== out.container_no);
    if (other) out.empty_container = other;
  }
  if (out.container_no && out.container_no === out.empty_container) out.empty_container = '';

  const mbl = t.match(/MBL\s*[:#.]?\s*([A-Z0-9-]{6,17})/i);
  if (mbl) out.bol_ref = mbl[1];

  if (loadLeg) {
    out.delivery = findCity(loadLeg.text) || findCity(t);
    // Raw delivery line (customer + address) — kept as the load's note
    // so the driver keeps the detail without it becoming the city.
    const del = loadLeg.text.match(/(?:DELIVER(?:Y)?|DROP[-\s]?OFF|CONSIGNEE)\s*[:#.]?\s*(.+)/i)
      || loadLeg.text.match(/(?:CUSTOMER|SHIP\s*TO)\s*[:#.]?\s*(.+)/i);
    if (del) out.delivery_line = del[1].trim().slice(0, 200);
  }
  if (out.job_type === 'in_out_empty' && !out.delivery) out.delivery = 'GPA';

  const appt = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)
    || t.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/);
  if (appt) out.appointment = appt[1];

  return out;
}

// Split a raw delivery line ("Qcells-eagle2 3551 Corporate Dr, Dalton
// GA 30721") into company name + street address for labeled display
// (Eric, 2026-11-14: each line on the skeleton needs its own label —
// "Company name:", "Address:", "Appointment:"). The split point is
// the first token that looks like a street number.
function splitDeliveryLine(line) {
  const s = (line || '').trim();
  if (!s) return { company: '', address: '' };
  const tokens = s.split(/\s+/);
  const idx = tokens.findIndex(tok => /^\d{2,6}[A-Za-z]?$/.test(tok));
  if (idx <= 0) return { company: s, address: '' };
  return {
    company: tokens.slice(0, idx).join(' '),
    address: tokens.slice(idx).join(' '),
  };
}

module.exports = { parseDispatchText, isDispatchText, findCity, findContainers, splitDeliveryLine };
