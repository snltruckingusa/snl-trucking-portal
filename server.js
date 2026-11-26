// S&L Trucking LLC — Settlement Portal
// All dates are the owner's local dates: run the process on Eastern Time
// so "today", week boundaries, and form defaults match the business day
// in Georgia, not the server's UTC clock.
process.env.TZ = 'America/New_York';
// Node.js + Express + PostgreSQL. Deploy on Render (see render.yaml).
// Env vars: DATABASE_URL (required), SESSION_SECRET, NODE_ENV, PORT,
//           ADMIN_PASSWORD (optional, default admin password on first seed).
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const { seed } = require('./seed');
const { money, fmtDate, fmtDateTimeLocal, loadTotal, PROGRESS_LABELS, expiringWithin, expiryInfo } = require('./lib/helpers');
const { matchLane } = require('./lib/rates');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render/Cloudflare proxies: honor X-Forwarded-Proto so secure
// session cookies are set correctly on HTTPS requests.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Template helpers available in every view.
app.locals.money = money;
app.locals.fmtDate = fmtDate;
app.locals.fmtDateTimeLocal = fmtDateTimeLocal;
app.locals.loadTotal = loadTotal;
app.locals.PROGRESS_LABELS = PROGRESS_LABELS;
app.locals.expiringWithin = expiringWithin;
app.locals.expiryInfo = expiryInfo;
app.locals.laneFor = matchLane;

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'snl-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

// Make the logged-in user available to all views.
app.use((req, res, next) => {
  res.locals.user = req.session ? req.session.user : null;
  res.locals.path = req.path;
  next();
});

// Mechanic accounts (the shared shop login) see one page only: the
// repair-entry form. Every other address bounces back to it — a shop
// must never reach driver or company data.
app.use((req, res, next) => {
  const u = req.session && req.session.user;
  if (u && u.role === 'mechanic') {
    const ok = req.path === '/mechanic' || req.path.startsWith('/mechanic/')
      || req.path === '/login' || req.path === '/logout' || req.path === '/change-password';
    if (!ok) return res.redirect('/mechanic');
  }
  next();
});

// CPA accounts (the company's accountant) are fenced to the read-only
// accounting sections: his overview, Settlement, Invoice, A/R, A/P and Fuel —
// GET requests only, so no write of any kind can pass, and driver
// files / personal documents stay out of reach entirely.
app.use((req, res, next) => {
  const u = req.session && req.session.user;
  if (u && u.role === 'cpa') {
    const authPage = req.path === '/login' || req.path === '/logout' || req.path === '/change-password';
    const readSection = req.method === 'GET' && (
      req.path === '/cpa' || req.path.startsWith('/cpa/')
      || req.path === '/settlement' || req.path.startsWith('/settlement/')
      || req.path === '/invoice' || req.path.startsWith('/invoice/')
      || req.path === '/ar' || req.path.startsWith('/ar/')
      || req.path === '/ap' || req.path.startsWith('/ap/')
      || req.path === '/fuel' || req.path.startsWith('/fuel/')
      || req.path === '/bizdocs' || req.path.startsWith('/bizdocs/')
    || req.path === '/ledger' || req.path.startsWith('/ledger/'));
    if (!authPage && !readSection) return res.redirect('/cpa');
  }
  next();
});

// Health check (Render uses this).
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// Routes
app.use('/', require('./routes/pages'));
app.use('/', require('./routes/auth'));
app.use('/drivers', require('./routes/drivers'));
app.use('/loads', require('./routes/loads'));
app.use('/fuel', require('./routes/fuel'));
app.use('/receipts', require('./routes/receipts'));
app.use('/settlement', require('./routes/settlement'));
app.use('/invoice', require('./routes/invoice'));
app.use('/ar', require('./routes/ar'));
app.use('/ap', require('./routes/ap'));
app.use('/documents', require('./routes/documents'));
app.use('/dvir', require('./routes/dvir'));
app.use('/mytruck', require('./routes/mytruck'));
app.use('/mechanic', require('./routes/mechanic'));
app.use('/audit', require('./routes/audit'));
app.use('/issued', require('./routes/issued'));
app.use('/cpa', require('./routes/cpa'));
app.use('/bizdocs', require('./routes/bizdocs'));
app.use('/ledger', require('./routes/ledger'));
app.use('/calendar', require('./routes/calendar'));
app.use('/training', require('./routes/training'));

// 404
app.use((req, res) => res.status(404).render('404', { isAdmin: false }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', { isAdmin: false, message: err.message || 'Server error.' });
});

async function start() {
  // Ensure upload directories exist (Render filesystem is ephemeral;
  // uploads are kept on instance disk — see README).
  for (const dir of ['uploads/tickets', 'uploads/documents']) {
    fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
  }

  if (process.env.DATABASE_URL) {
    try {
      await seed();
      console.log('[start] database seeded/verified.');
    } catch (err) {
      console.error('[start] database seed failed:', err.message);
      console.error('[start] The server will still start; fix DATABASE_URL and restart.');
    }
  } else {
    console.warn('[start] WARNING: DATABASE_URL is not set. Pages that need the database will fail until it is set.');
  }

  app.listen(PORT, () => {
    console.log(`[start] S&L Trucking portal listening on port ${PORT}`);
  });
}

start();

module.exports = app;
