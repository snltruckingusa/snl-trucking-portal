// Weekend (Sat/Sun) pay rule — Eric's rule, confirmed 2026-11-14:
// - A day with >= 1 confirmed load on a Saturday or Sunday is a "weekend day".
// - Day net = that day's confirmed-load revenue - that day's fuel cost
//   - $100 insurance when the day has a confirmed load.
// - Condition (auto-judged from work records): the driver has a confirmed
//   load on EVERY Mon-Fri day of this week AND of the following week.
// - If the condition is met, weekend day nets pay the driver 70% instead of
//   the normal split; everything else pays at the normal split.
// - Fuel-only weekend days are NOT weekend work days: their (negative) net
//   stays in the standard pool.
// The adjusted pay becomes the real driver pay only after the owner
// confirms it at settlement review (settlements.weekend_applied).
const { INSURANCE_PER_DAY } = require('./helpers');

function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayOfWeek(iso) {
  return new Date(iso + 'T00:00:00').getDay(); // 0 Sun .. 6 Sat
}

function round2(n) { return Math.round(n * 100) / 100; }

// days: [{ date: 'YYYY-MM-DD', revenue, fuel, hasLoad }] for every day of the week
// weekDates: the 7 ISO dates of this week (any week convention)
// nextWeekLoadDates: array/Set of ISO dates with confirmed loads in the following week
// split: normal driver split, 0..1 (e.g. 0.5)
function computeWeekend({ days, weekDates, nextWeekLoadDates, split }) {
  const nextSet = new Set(nextWeekLoadDates || []);
  const loadDates = new Set(days.filter(d => d.hasLoad).map(d => d.date));
  const weekdays = weekDates.filter(iso => { const g = dayOfWeek(iso); return g >= 1 && g <= 5; });
  const nextWeekdays = weekDates.map(iso => {
    const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + 7); return isoOf(d);
  }).filter(iso => { const g = dayOfWeek(iso); return g >= 1 && g <= 5; });

  const missingThisWeek = weekdays.filter(iso => !loadDates.has(iso));
  const missingNextWeek = nextWeekdays.filter(iso => !nextSet.has(iso));
  const conditionMet = missingThisWeek.length === 0 && missingNextWeek.length === 0;

  let weekendNet = 0, standardNet = 0, hasWeekend = false;
  for (const d of days) {
    const net = d.revenue - d.fuel - (d.hasLoad ? INSURANCE_PER_DAY : 0);
    const g = dayOfWeek(d.date);
    if (d.hasLoad && (g === 0 || g === 6)) { weekendNet += net; hasWeekend = true; }
    else { standardNet += net; }
  }
  const totalNet = weekendNet + standardNet;
  const standardPay = round2(totalNet * split);
  const adjustedPay = round2(standardNet * split + weekendNet * 0.70);
  return {
    hasWeekend, conditionMet, missingThisWeek, missingNextWeek,
    weekendNet: round2(weekendNet), standardNet: round2(standardNet), totalNet: round2(totalNet),
    standardPay, adjustedPay,
  };
}

module.exports = { computeWeekend, dayOfWeek };
