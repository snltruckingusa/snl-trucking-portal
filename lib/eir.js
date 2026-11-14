// EIR (Equipment Interchange Receipt) ticket parsing — best-effort regex
// extraction from OCR text, used for LOAD OUT / EMPTY IN evidence photos.
//
// The money-relevant fields are the WEIGHTS: overweight is judged on
// CARGO WT (net), never on gross (Eric, 2026-11-14):
//   20ft container        : 39,000 lb
//   40ft container        : 45,000 lb
//   40ft reefer (40RF)    : 44,000 lb
// Everything extracted is a SUGGESTION for a human to confirm — OCR mixes
// up digits, so nothing here changes money by itself.

const OW_LIMITS = { '20': 39000, '40': 45000, '40RF': 44000 };

function parseWeight(raw) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parseEIR(text) {
  const t = (text || '').replace(/\r/g, '\n');
  const out = {
    container_no: '', pin: '', seal: '', chassis: '',
    size: '', is_reefer: false, genset: '', genset_temp: '',
    gross_wt: null, cargo_wt: null, tare_wt: null,
    overweight: false, ow_limit: null,
  };

  const cont = t.match(/\b([A-Za-z]{4}\s?\d{7})\b/);
  if (cont) out.container_no = cont[1].replace(/\s/g, '').toUpperCase();

  const pin = t.match(/PIN\s*[:#.]?\s*(\d{5,7})/i);
  if (pin) out.pin = pin[1];

  const seal = t.match(/SEAL\s*(?:NO\.?|#)?\s*[:#.]?\s*([A-Z0-9]{5,12})/i);
  if (seal) out.seal = seal[1].toUpperCase();

  const chassis = t.match(/CHASSIS\s*(?:NO\.?|#)?\s*[:#.]?\s*([A-Z0-9]{6,14})/i);
  if (chassis) out.chassis = chassis[1].toUpperCase();

  // Size / type: 40RF, 40 HC, 20DV, "40'" etc.
  const size = t.match(/\b(20|40|45)\s?(RF|HC|HQ|DV|GP|FT)?\b/i) || t.match(/\b(20|40|45)\s?['’]/);
  if (size) {
    out.size = size[1] + (size[2] ? size[2].toUpperCase() : '');
  }
  if (/\bRF\b|REEFER|GENSET|GEN-SET/i.test(t)) out.is_reefer = true;
  if (out.is_reefer && out.size && out.size.startsWith('40')) out.size = '40RF';

  const genset = t.match(/GENSET\s*(?:NO\.?|#)?\s*[:#.]?\s*([A-Z0-9]{5,14})/i);
  if (genset) out.genset = genset[1].toUpperCase();
  const temp = t.match(/([+-]?\d{1,3}(?:\.\d)?)\s?°?\s?[CF]\b/);
  if (temp) out.genset_temp = temp[1];

  // Weights — labels seen on GPA EIRs: GROSS WT / CARGO WT / TARE WT,
  // sometimes "GROSS WEIGHT 54,932.58 LBS" style decimals.
  const gw = t.match(/GROSS\s*(?:WT|WEIGHT)\s*[:#.]?\s*([\d,]+(?:\.\d+)?)/i);
  if (gw) out.gross_wt = parseWeight(gw[1]);
  const cw = t.match(/CARGO\s*(?:WT|WEIGHT)\s*[:#.]?\s*([\d,]+(?:\.\d+)?)/i);
  if (cw) out.cargo_wt = parseWeight(cw[1]);
  const tw = t.match(/TARE\s*(?:WT|WEIGHT)\s*[:#.]?\s*([\d,]+(?:\.\d+)?)/i);
  if (tw) out.tare_wt = parseWeight(tw[1]);
  // If only gross + tare printed, cargo = gross - tare.
  if (out.cargo_wt === null && out.gross_wt !== null && out.tare_wt !== null) {
    out.cargo_wt = Math.round((out.gross_wt - out.tare_wt) * 100) / 100;
  }

  // Overweight judgment on CARGO weight.
  const key = out.is_reefer && out.size.startsWith('40') ? '40RF'
    : out.size.startsWith('20') ? '20'
    : out.size.startsWith('40') ? '40' : null;
  if (key) out.ow_limit = OW_LIMITS[key];
  if (out.cargo_wt !== null && out.ow_limit !== null) {
    out.overweight = out.cargo_wt > out.ow_limit;
  }
  return out;
}

module.exports = { parseEIR, OW_LIMITS };
