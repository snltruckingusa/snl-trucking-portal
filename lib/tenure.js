// Tenure pay ladder — Eric's rule, confirmed 2026-11-14:
//   first 3 months after hire : driver 45% / company 55%
//   after 3 months            : driver 50% / company 50%
//   after 1 year              : driver 55% / company 45%
// Exceptions: drivers flagged ladder_exempt (Brinceson Sanders and
// Austin Harrell) are on a straight split (their drivers.pay_split)
// from day one. Drivers without a recorded hire_date also fall back to
// drivers.pay_split, so entering hire dates is what switches the ladder on.
// The weekend 70% premium is separate and unaffected by the ladder.

// Whole calendar months between hire and the target date. The ladder
// steps on calendar months (Eric: drivers hired January 2026 move to
// 55% "from January 2027"), so days are not compared.
function monthsBetween(hireISO, onISO) {
  const h = new Date(hireISO + 'T00:00:00');
  const o = new Date(onISO + 'T00:00:00');
  if (isNaN(h) || isNaN(o)) return null;
  return (o.getFullYear() - h.getFullYear()) * 12 + (o.getMonth() - h.getMonth());
}

// Driver's split % (e.g. 50 means the driver gets 50% of net) in effect
// on a given date, from the drivers row.
function effectiveSplitPct(driver, onISO) {
  const fallback = driver && driver.pay_split != null ? parseFloat(driver.pay_split) : 50;
  if (!driver || driver.ladder_exempt) return fallback;
  if (!driver.hire_date) return fallback;
  const hireISO = typeof driver.hire_date === 'string'
    ? driver.hire_date.slice(0, 10)
    : new Date(driver.hire_date).toISOString().slice(0, 10);
  const m = monthsBetween(hireISO, onISO);
  if (m === null) return fallback;
  if (m < 3) return 45;
  if (m < 12) return 50;
  return 55;
}

module.exports = { monthsBetween, effectiveSplitPct };
