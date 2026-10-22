/**
 * Hail size names and the plain-language damage scale shown on reports and
 * public pages. Damage descriptions are typical outcomes, not a guarantee.
 */
const SIZES = [
  [4.5, 'Grapefruit'], [4.0, 'Softball'], [2.75, 'Baseball'], [2.5, 'Tennis Ball'],
  [2.0, 'Hen Egg'], [1.75, 'Golf Ball'], [1.5, 'Ping Pong Ball'], [1.25, 'Half Dollar'],
  [1.0, 'Quarter'], [0.88, 'Nickel'], [0.75, 'Penny'], [0.5, 'Marble'],
];

function sizeName(inches) {
  for (const [min, name] of SIZES) if (inches >= min) return name;
  return 'Pea';
}

const SCALE = [
  { min: 2.5, level: 'Catastrophic', color: '#7f1d1d', damage: 'Severe roof damage and punctures, broken windows and skylights. Full roof replacement is common.' },
  { min: 1.75, level: 'Major', color: '#b91c1c', damage: 'Widespread shingle damage, dented siding, gutters and vehicles. Most roofs need inspection.' },
  { min: 1.25, level: 'Severe', color: '#ea580c', damage: 'Shingle bruising and granule loss likely, especially on older roofs. Soft metals dented.' },
  { min: 1.0, level: 'Moderate', color: '#d97706', damage: 'Damage likely on aging asphalt shingles; dents to gutters, vents and screens.' },
  { min: 0.75, level: 'Minor', color: '#ca8a04', damage: 'Cosmetic damage to soft metals and screens. Roof damage possible on older roofs.' },
  { min: 0, level: 'Trace', color: '#65a30d', damage: 'Little to no roof damage expected.' },
];

function severity(inches) {
  return SCALE.find(s => inches >= s.min) || SCALE[SCALE.length - 1];
}

module.exports = { sizeName, severity, SCALE };
