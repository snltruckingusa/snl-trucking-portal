// Shared helpers: dates, money, auth middleware.
const INSURANCE_PER_DAY = 100; // $100/day insurance, per driver day worked

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d) ? null : d;
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Sunday of the week containing `date` (weeks run Sun-Sat, matching the
// owner's settlement sheets — changed from Mon-Sun on 2026-11-14).
function weekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diff = d.getDay(); // 0 Sun .. 6 Sat — days since Sunday
  d.setDate(d.getDate() - diff);
  return d;
}

function weekEnd(weekStartDate) {
  const d = new Date(weekStartDate);
  d.setDate(d.getDate() + 6);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function money(v) {
  const n = num(v, 0);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return toISODate(dt);
}

// Total money on one load — the statement components:
// Rate + Prepull + Reefer + Detention + Overweight + FSC.
const LOAD_MONEY_SQL = 'rate + prepull + reefer + detention + overweight + fsc';

function loadTotal(l) {
  return num(l && l.rate) + num(l && l.prepull) + num(l && l.reefer)
    + num(l && l.detention) + num(l && l.overweight) + num(l && l.fsc);
}

// Load progress (execution state, separate from pending/confirmed approval):
// 예정 → 픽업 완료 → 배송 완료 → 반납 완료.
const PROGRESS_STEPS = ['scheduled', 'picked', 'delivered', 'returned'];
const PROGRESS_LABELS = {
  scheduled: '예정',
  picked: '픽업 완료',
  delivered: '배송 완료',
  returned: '반납 완료',
};

function nextProgress(p) {
  const i = PROGRESS_STEPS.indexOf(p);
  if (i < 0) return PROGRESS_STEPS[1];
  return PROGRESS_STEPS[Math.min(i + 1, PROGRESS_STEPS.length - 1)];
}

// True when a DATE value falls within the next `days` days (today included,
// already-expired dates also count as urgent).
function expiringWithin(dateVal, days = 30) {
  if (!dateVal) return false;
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (isNaN(d)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / 86400000);
  return diffDays <= days;
}

// ---- Auth middleware ----
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).send('Forbidden — admin only.');
}

// For a driver, restrict to their own driver_id. Admins see everything.
// Returns the driver_id the current user is allowed to see, or null for admin.
function scopedDriverId(req) {
  const u = req.session && req.session.user;
  if (!u) return null;
  if (u.role === 'admin') return null; // null = all drivers
  return u.driver_id;
}

function isAdmin(req) {
  return !!(req.session && req.session.user && req.session.user.role === 'admin');
}

module.exports = {
  INSURANCE_PER_DAY,
  parseDate,
  toISODate,
  weekStart,
  weekEnd,
  addDays,
  num,
  money,
  fmtDate,
  LOAD_MONEY_SQL,
  loadTotal,
  PROGRESS_STEPS,
  PROGRESS_LABELS,
  nextProgress,
  expiringWithin,
  requireLogin,
  requireAdmin,
  scopedDriverId,
  isAdmin,
};
