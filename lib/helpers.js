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

// Monday of the week containing `date` (weeks run Mon-Sun).
function weekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day + 6) % 7; // days since Monday
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
  requireLogin,
  requireAdmin,
  scopedDriverId,
  isAdmin,
};
