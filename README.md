# S&L Trucking LLC — Settlement Portal

Driver settlement portal for S&L Trucking LLC (Pooler, GA).
Drivers log in, record loads and fuel, and see their own pay.
The owner (admin) sees everything, confirms loads, and closes the
weekly settlement on Fridays.

- **Domain:** snltruckingusa.com (Porkbun, registered Nov 2026)
- **Hosting:** Render — Web Service (Starter, $7/mo) + PostgreSQL (Basic, $6/mo)
- **Stack:** Node.js + Express + PostgreSQL (`pg`), EJS views, session auth (bcrypt)

## Features

- **Drivers** — roster with truck number, pay split % (default 50), active flag.
- **Loads** — date, container #, BOL/reference, pickup/delivery, appointment,
  rate, prepull, overweight, FSC, miles, status pending/confirmed.
  Only **confirmed** loads count in settlement. Filter by date range and driver.
- **Ticket-photo OCR** — upload a POD / gate ticket photo; Tesseract.js
  (optional) extracts container #, BOL, return location, pickup/delivery,
  appointment to prefill the form. Extracted values are **suggestions only** —
  a human reviews them before saving. If OCR is unavailable, the photo is
  attached and the form is filled in manually.
- **Fuel** — gallons, pump price, TCS discounted price. Cost = gallons × TCS price.
- **Receipts** — PierLink payments received.
- **Weekly settlement (Mon–Sun)** — per driver: confirmed revenue, fuel,
  insurance ($100/day worked), net, driver pay (50%), company net.
  Friday close-out: close / reopen a week's settlement (snapshot stored).
  Week summary: revenue, driver pay, fuel, company net, receipts,
  pending entries awaiting review.
- **MPG** — miles ÷ gallons per driver per week. **MPG < 6.0 is flagged
  "연비 개선 필요"** (needs fuel-economy improvement). Good ~7.2–7.3, bad ~6.2–6.3.
- **Login (V2)** — session-based auth, bcrypt hashes. Admin sees all;
  a driver sees only their own today's work and this/last week's pay.
- **Safety education** — placeholder for YouTube Episode 1 + key safety rules.
- **Instructions / regulations** — contract-based rules, incl. no driving
  over 70 mph, consequences, termination.
- **Benefits** — vacation 14 days/yr (7 paid), $700 birthday if vacation
  unused, Thanksgiving $1,000/driver before Thanksgiving.
- **Mechanic logs + DVIR** — daily vehicle inspection reports and repair logs.
- **Driver documents** — file upload/list per driver: MVR, medical card,
  CDL, registration, contracts.
- **Bilingual UI** — Korean primary (admin), English labels for drivers.
  Mobile-friendly (drivers use phones).

## Default login (change immediately)

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `changeme123` |

The admin account is forced to change its password on first login.
Driver accounts are created by the admin (Users page) — one per driver,
password set by the admin; the driver must change it on first login.
To use a different initial admin password, set the `ADMIN_PASSWORD`
environment variable **before the first start** (it is only used when no
admin account exists yet).

## Run locally

```bash
npm install
# Start a local Postgres and set DATABASE_URL, e.g.:
#   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/snl_portal
#   psql "$DATABASE_URL" -f schema.sql
# (Or just start the server — it runs schema.sql + seeds on first start
#  automatically when DATABASE_URL is set.)
export SESSION_SECRET='a-long-random-secret'
node server.js
# Open http://localhost:3000  (login: admin / changeme123)
```

Environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | Postgres connection string (Render sets this from the database service). SSL is used automatically when `NODE_ENV=production`. |
| `SESSION_SECRET` | yes (prod) | Random secret for session cookies. Render generates one in `render.yaml`. |
| `NODE_ENV` | no | Set to `production` on Render. |
| `PORT` | no | Render sets this automatically (default 3000). |
| `ADMIN_PASSWORD` | no | Initial admin password, used only on first seed. Default `changeme123`. |

## Deploy on Render

Prerequisites (already done): domain `snltruckingusa.com` registered at
Porkbun; Render account `acteo22@gmail.com`; Postgres database
`snltrucking-db` (Basic, Oregon, PostgreSQL 18) created in the Render
dashboard; card on file.

1. Push this folder to a Git repository (GitHub/GitLab/Bitbucket).
2. In the Render dashboard: **New → Web Service → Build and deploy from
   a Git repository**, pick the repo. Render detects `render.yaml` and
   creates the service from it (name `snl-trucking-portal`, Starter plan,
   `npm install` build, `node server.js` start, health check `/health`).
3. `render.yaml` wires `DATABASE_URL` from the `snltrucking-db` database
   and generates a `SESSION_SECRET`. Confirm both are set on the service's
   Environment page. If `render.yaml` was not picked up, add the env vars
   manually: `DATABASE_URL` (from the database's **Internal Database URL**),
   `SESSION_SECRET` (generate a random value), `NODE_ENV=production`.
4. Deploy. The server runs `schema.sql` and seeds the 5 drivers
   (Green #101, Darrell #201, Brinceson #200, Harrell #100,
   Dong Sung Lee #100) plus the admin account on first start.
5. Point the domain: in the service's **Settings → Custom Domains**,
   add `snltruckingusa.com` (and `www.snltruckingusa.com` if wanted).
   Render shows the DNS records to add — add them at Porkbun
   (an `A` record / `CNAME` as shown). Render provisions a free SSL
   certificate automatically once DNS resolves.
6. Log in as `admin` / `changeme123`, change the password, then create
   driver accounts (Users page) and give each driver their login.

## Notes / limitations

- **Uploads are stored on the instance disk** (`uploads/`). Render's
  filesystem is ephemeral — files are lost on redeploy. For durable
  storage, move ticket photos and documents to S3/Cloudinary later.
- Sessions use the default in-memory store (fine for a single Starter
  instance). If you ever scale to multiple instances, switch to a
  Postgres-backed session store.
- OCR uses `tesseract.js` (optional dependency) and the English language
  data bundled in `tessdata/eng.traineddata` (~5 MB, committed to the
  repo so no CDN download is needed at runtime). OCR runs in a **separate
  child process** (`lib/ocr-worker.js`) — if OCR crashes or times out,
  the server keeps running and the upload falls back to manual entry
  with the photo attached. OCR never blocks saving a load.
- No credentials are hardcoded. Never commit a `.env` file or real
  passwords; use Render's Environment settings.
