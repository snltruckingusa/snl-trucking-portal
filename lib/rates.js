// Lane standards — Eric's rate chart + mileage/gallons chart
// (confirmed 2026-11-14; source: import-prep/rate-mileage-standards-2026-11-14.json).
//
// IMPORTANT (Eric's spot-rate principle): chart values are DEFAULT
// SUGGESTIONS only. The dispatcher sometimes prices a load individually
// (Forest Park has NO chart rate at all), and the actual amount always
// governs. Anything that auto-fills from this table must stay editable.
//
// Standard gallons = standard miles / 7 MPG (Eric's fuel-awareness chart).
const LANES = {
  'DALTON':      { rate: 1380, ow: 75, fsc: 195, miles: 690, gallons: 100 },
  'ADAIRSVILLE': { rate: 1320, ow: 75, fsc: 155, miles: 640, gallons: 92 },
  'WHITE':       { rate: 1270, ow: 75, fsc: 155, miles: 620, gallons: 90 },
  'CALHOUN':     { rate: 1270, ow: 75, fsc: 155, miles: 650, gallons: 94 },
  'AUBURN':      { rate: 1150, ow: 50, fsc: 150, miles: 640, gallons: 92 },
  'BUFORD':      { rate: 1150, ow: 50, fsc: 100, miles: 590, gallons: 85 },
  'OPELIKA':     { rate: 1050, ow: 50, fsc: 100, miles: 600, gallons: 85 },
  'LANETTE':     { rate: 1050, ow: 50, fsc: 100, miles: 600, gallons: 85 },
  'VALLEY':      { rate: 1050, ow: 50, fsc: 100, miles: 600, gallons: 85 },
  'LA GRANGE':   { rate: 1000, ow: 50, fsc: 100, miles: 580, gallons: 83 },
  'LAGRANGE':    { rate: 1000, ow: 50, fsc: 100, miles: 580, gallons: 83 },
  'DULUTH':      { rate: 1000, ow: 50, fsc: 100, miles: 580, gallons: 83 },
  'SUWANEE':     { rate: 1000, ow: 50, fsc: 100, miles: 580, gallons: 83 },
  'DECATUR':     { rate: 950,  ow: 50, fsc: 100, miles: 520, gallons: 75 },
  'ELLABELL':    { rate: 300,  ow: 50, fsc: 25,  miles: 100, gallons: 15 },
  'RINCON':      { rate: 275,  ow: 50, fsc: 25,  miles: 50,  gallons: 9 },
  // Forest Park: NO chart rate (per-load dispatcher amount). Miles/gallons only.
  'FOREST PARK': { rate: null, ow: null, fsc: null, miles: 520, gallons: 74 },
};

// Terminal leg fees (also the prepull / exception-deduction amounts).
const LEG_FEES = { loadOut: 75, mtyReturn: 60 };

// Match a free-text delivery value ("Dalton", "DALTON GA", "White") to a lane.
// Longest key wins so "FOREST PARK" beats any shorter partial match.
function matchLane(delivery) {
  if (!delivery) return null;
  const t = String(delivery).toUpperCase();
  let best = null;
  for (const key of Object.keys(LANES)) {
    if (t.includes(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? { key: best, ...LANES[best] } : null;
}

module.exports = { LANES, LEG_FEES, matchLane };
