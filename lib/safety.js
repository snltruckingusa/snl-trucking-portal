// Safety training topics (Eric, 2026-11-14). The key is stored in
// safety_acks when a driver taps "I have read and understand" — the
// login + timestamp record is the audit evidence, no signature needed.
const SAFETY_TOPICS = [
  { key: 'inspection', title: 'Vehicle inspection — before you roll' },
  { key: 'container', title: 'Container & chassis safety' },
  { key: 'speed', title: 'Speed, distance & braking' },
  { key: 'backing', title: 'Backing & blind spots' },
  { key: 'fatigue', title: 'Fatigue & hours of service' },
  { key: 'distraction', title: 'No phone while rolling' },
  { key: 'seatbelt', title: 'Seat belts' },
  { key: 'weather', title: 'Weather, night & deer' },
  { key: 'port', title: 'Port & terminal safety' },
  { key: 'accident', title: 'If an accident happens' },
  { key: 'cargo', title: 'Cargo, seals & placards' },
  { key: 'mindset', title: 'The professional mindset — it starts at home' },
];

module.exports = { SAFETY_TOPICS };
