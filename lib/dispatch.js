// PierLink dispatch-message parsing (OCR text of the dispatcher's
// WhatsApp order capture). The bundled dispatch has two legs
// (Eric, 2026-11-14):
//   EMPTY RETURN — container number + gate PIN (the driver needs the
//                  PIN at the terminal; Eric's flow sheet shows both).
//   LOAD OUT     — container number + PIN + MBL, and the delivery
//                  CITY. The city is the lane key: settlement records
//                  the city only, never the customer name/address
//                  (those stay in the note).
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

function isDispatchText(text) {
  const t = text || '';
  return (/EMPTY/i.test(t) && /LOAD\s*OUT/i.test(t)) || (t.match(/PIN/gi) || []).length >= 2;
}

function findPin(text) {
  const m = (text || '').match(/PIN\s*#?\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,11})/i);
  return m ? m[1].toUpperCase() : '';
}

function parseDispatchText(text) {
  const t = (text || '').replace(/\r/g, '\n');
  const out = {
    is_dispatch: isDispatchText(t),
    empty_container: '', empty_pin: '', container_no: '', load_pin: '',
    bol_ref: '', delivery: '', delivery_line: '', appointment: '',
  };
  if (!out.is_dispatch) return out;

  // The dispatch lists the EMPTY RETURN leg first, then LOAD OUT.
  const idx = t.search(/LOAD\s*OUT/i);
  const emptyPart = idx >= 0 ? t.slice(0, idx) : '';
  const loadPart = idx >= 0 ? t.slice(idx) : t;
  const emptyConts = findContainers(emptyPart);
  const loadConts = findContainers(loadPart);
  const all = findContainers(t);
  out.empty_container = emptyConts[0] || '';
  out.container_no = loadConts[0] || all.find(c => c !== out.empty_container) || '';
  if (!out.empty_container && all.length >= 2 && out.container_no === all[1]) {
    out.empty_container = all[0];
  }
  out.empty_pin = findPin(emptyPart);
  out.load_pin = findPin(loadPart);

  const mbl = t.match(/MBL\s*[:#.]?\s*([A-Z0-9-]{6,17})/i);
  if (mbl) out.bol_ref = mbl[1];

  out.delivery = findCity(loadPart) || findCity(t);

  // Raw delivery line (customer + address) — kept as the load's note so
  // the driver keeps the detail without it becoming the settlement city.
  const del = loadPart.match(/(?:DELIVER(?:Y)?|DROP[-\s]?OFF|CONSIGNEE)\s*[:#.]?\s*(.+)/i)
    || loadPart.match(/(?:CUSTOMER|SHIP\s*TO)\s*[:#.]?\s*(.+)/i);
  if (del) out.delivery_line = del[1].trim().slice(0, 200);

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
