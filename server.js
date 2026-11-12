// S&L Trucking LLC — Settlement Portal
// Node.js + Express + PostgreSQL. Deploy on Render (see render.yaml).
// Env vars: DATABASE_URL (required), SESSION_SECRET, NODE_ENV, PORT,
//           ADMIN_PASSWORD (optional, default admin password on first seed).
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const { seed } = require('./seed');
const { money, fmtDate } = require('./lib/helpers');

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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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
app.use('/documents', require('./routes/documents'));
app.use('/dvir', require('./routes/dvir'));

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
