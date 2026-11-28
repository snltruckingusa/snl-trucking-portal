// Checklists — defined ONCE here, read everywhere (Eric, 2026-11-15).
// The checklist IS the management system: a registered item shows its
// validity (expiry), a missing item is visible on the driver's side
// AND the owner's side, so the owner can call and nudge. Driver Home,
// My File, My Truck, the Driver Overview and the Audit page all read
// these same definitions — the same answer everywhere, no duplication.
//
// `who` says whose job the item is: the driver supplies it, or the
// company keeps it (the driver cannot upload a company record).
// `expires` items ask for an expiry date. `optional` items (a permit
// a truck may not have) never count as missing.

const DRIVER_DOC_CHECKLIST = [
  { key: 'cdl', label: 'CDL (license copy)', who: 'Driver', expires: true },
  { key: 'medical_card', label: 'DOT Medical Card', who: 'Driver', expires: true },
  { key: 'twic', label: 'TWIC Card', who: 'Driver', expires: true },
  { key: 'application', label: 'Driver Application', who: 'Driver', expires: false },
  { key: 'contract', label: 'Signed Contract', who: 'Driver', expires: false },
  { key: 'w9', label: 'W-9', who: 'Driver', expires: false },
  { key: 'annual_review', label: 'Annual Review of Driving Record', who: 'Driver', expires: true },
  { key: 'clearinghouse_consent', label: 'Clearinghouse Consent (signed)', who: 'Driver', expires: false },
  { key: 'safety_history', label: 'Safety Performance History', who: 'Driver', expires: false },
  { key: 'mvr', label: 'MVR (owner pulls from GA DDS)', who: 'Company', expires: false },
  { key: 'clearinghouse', label: 'Clearinghouse Query Result', who: 'Company', expires: false },
  { key: 'drug_test', label: 'Drug Test Result', who: 'Company', expires: false },
  { key: 'road_test', label: 'Road Test Record', who: 'Company', expires: false },
];

const VEHICLE_DOC_CHECKLIST = [
  { key: 'registration', label: 'Registration / Cab Card', who: 'Driver', expires: true },
  { key: 'annual_inspection', label: 'Annual Inspection', who: 'Driver', expires: true },
  { key: 'insurance', label: 'Insurance Certificate', who: 'Company', expires: true },
  { key: 'permit', label: 'Overweight Permit (if any)', who: 'Company', expires: true, optional: true },
  { key: 'title_lease', label: 'Title / Lease', who: 'Company', expires: false },
];

// Latest document per category. `docs` must be ordered newest first
// (every query in the portal orders by uploaded_at DESC).
function latestByCategory(docs) {
  const m = {};
  for (const d of docs || []) {
    if (d.is_duplicate) continue; // a duplicate never becomes the record
    if (!m[d.category]) m[d.category] = d;
  }
  return m;
}

// The agreement chain for one driver: every non-duplicate contract
// document, oldest first — original agreement, then each amendment in
// the order it was signed/uploaded. The newest is the current record.
function contractChain(docs) {
  return (docs || [])
    .filter((d) => d.category === 'contract' && !d.is_duplicate)
    .slice()
    .sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
}

// Driver documents: the newest document in a category is the record
// (its status says whether it is confirmed or waiting for review).
// Blank forms the driver downloads, completes, signs and uploads under
// the matching checklist item. Served from public/forms/ (templates only,
// no personal data). Added 2026-11-15 with the forms library.
const FORM_DOWNLOADS = {
  application: [{ label: 'Driver Application (PDF)', href: '/forms/driver-application.pdf' }],
  contract: [
    { label: 'Independent Contractor Agreement (PDF)', href: '/forms/independent-contractor-agreement.pdf' },
    { label: 'Amendment (PDF)', href: '/forms/agreement-amendment.pdf' },
  ],
  w9: [{ label: 'W-9 (PDF)', href: '/forms/w9.pdf' }],
  annual_review: [{ label: 'Annual Review of Driving Record (PDF)', href: '/forms/annual-review-of-driving-record.pdf' }],
  clearinghouse_consent: [{ label: 'Clearinghouse Consent (PDF)', href: '/forms/clearinghouse-consent.pdf' }],
  safety_history: [{ label: 'Safety Performance History (PDF)', href: '/forms/safety-performance-history.pdf' }],
};

// Record-only categories (Eric, 2026-11-28): these are copies of records
// issued by someone else — the license itself, the medical card, the
// MVR the owner pulls, the lab's drug-test result, the Clearinghouse
// query printout, the TWIC card. A signature NEVER belongs on them, so
// the Sign button is not rendered for them anywhere and the sign
// routes refuse them outright (even via a direct URL). Defined ONCE
// here, next to the checklist, and read by routes/documents.js and
// views/documents.ejs — the same answer everywhere.
const NON_SIGNABLE_CATEGORIES = ['cdl', 'medical_card', 'twic', 'mvr', 'drug_test', 'clearinghouse'];

function isSignableCategory(category) {
  return NON_SIGNABLE_CATEGORIES.indexOf(category) === -1;
}

function docChecklist(docs) {
  const latest = latestByCategory(docs);
  return DRIVER_DOC_CHECKLIST.map((c) => ({ ...c, doc: latest[c.key] || null, forms: FORM_DOWNLOADS[c.key] || null }));
}

// Vehicle documents: the OFFICIAL copy is the newest CONFIRMED one —
// that is what a driver shows at roadside. A newer upload still
// waiting for the owner's review is reported separately and never
// hides the confirmed copy.
function vehicleChecklist(vdocs) {
  const confirmed = latestByCategory((vdocs || []).filter((d) => d.status !== 'pending'));
  const pending = latestByCategory((vdocs || []).filter((d) => d.status === 'pending'));
  return VEHICLE_DOC_CHECKLIST.map((c) => ({
    ...c,
    doc: confirmed[c.key] || null,
    pendingDoc: pending[c.key] || null,
  }));
}

// Profile completeness for one driver row. `owner: true` items are
// entered by the owner on the Drivers page; the rest are the driver's
// own to keep current in My File.
function profileChecklist(driver) {
  const d = driver || {};
  const items = [
    { key: 'address', label: 'Home address', value: d.address },
    { key: 'phone', label: 'Phone', value: d.phone },
    { key: 'emergency', label: 'Emergency contact', value: d.emergency_name || d.emergency_phone },
    { key: 'dob', label: 'Date of birth', value: d.dob, owner: true },
    { key: 'email', label: 'Email', value: d.email, owner: true },
    { key: 'license', label: 'License (CDL) number', value: d.license_no, owner: true },
  ];
  return items.map((i) => ({ ...i, done: !!(i.value && String(i.value).trim()) }));
}

module.exports = {
  DRIVER_DOC_CHECKLIST,
  VEHICLE_DOC_CHECKLIST,
  NON_SIGNABLE_CATEGORIES,
  isSignableCategory,
  latestByCategory,
  contractChain,
  docChecklist,
  vehicleChecklist,
  profileChecklist,
};
