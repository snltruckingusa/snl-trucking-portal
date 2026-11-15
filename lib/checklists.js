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
  for (const d of docs || []) if (!m[d.category]) m[d.category] = d;
  return m;
}

// Driver documents: the newest document in a category is the record
// (its status says whether it is confirmed or waiting for review).
function docChecklist(docs) {
  const latest = latestByCategory(docs);
  return DRIVER_DOC_CHECKLIST.map((c) => ({ ...c, doc: latest[c.key] || null }));
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
  latestByCategory,
  docChecklist,
  vehicleChecklist,
  profileChecklist,
};
