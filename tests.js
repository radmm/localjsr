const assert = require('node:assert/strict');

// Set up mock DOM environment for Node.js test runner
const localStorageStore = {};
global.localStorage = {
  getItem: (key) => localStorageStore[key] || null,
  setItem: (key, val) => { localStorageStore[key] = String(val); },
  removeItem: (key) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]); },
};

global.document = {
  querySelector: (selector) => {
    return {
      value: '15',
      textContent: '',
      innerHTML: '',
      style: {},
      dataset: {},
      querySelectorAll: () => [],
      addEventListener: () => {},
    };
  },
  querySelectorAll: () => [],
  createElement: () => ({
    style: {},
    appendChild: () => {},
    getContext: () => ({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(400) }),
    }),
  }),
};

const app = require('./app.js');
const {
  BADGE_CONFIG,
  hexToRgb,
  rgbToHex,
  rgbToLab,
  captureBadgeReading,
  matchBadgeFingerprint,
  createSyntheticBadge,
  saveLearnedTemplate,
  resetLearnedTemplates,
  getCombinedTemplates,
  records,
  saveRecord,
  deleteRecord,
  deleteAllRecords,
} = app;

console.log('Running H2S Badge Reader tests...');

// 1. Each template returns its own class
for (const targetPpm of [10, 20, 40, 50]) {
  const badge = createSyntheticBadge({ ppm: targetPpm });
  const result = captureBadgeReading([badge]);
  assert.equal(result.valid, true, `Capture failed for ${targetPpm} ppm: ${result.refusalReason}`);
  assert.equal(result.classPpm, targetPpm, `Expected class ${targetPpm}, got ${result.classPpm}`);
  assert.equal(result.ppm, targetPpm);
  assert.equal(result.matched, true);
  assert.ok(result.d1 < 1.0, `Expected low distance for exact match, got ${result.d1}`);
}
console.log('✓ Test 1 passed: Each template returns its own class.');

// 2. Random gain of +-8% and brightness +-12%, 200 trials per class, >= 95% correct
for (const targetPpm of [10, 20, 40, 50]) {
  let correctCount = 0;
  const trials = 200;

  for (let i = 0; i < trials; i++) {
    const gainR = 1 + (Math.random() * 0.16 - 0.08);
    const gainG = 1 + (Math.random() * 0.16 - 0.08);
    const gainB = 1 + (Math.random() * 0.16 - 0.08);
    const brightness = 1 + (Math.random() * 0.24 - 0.12);

    const badge = createSyntheticBadge({
      ppm: targetPpm,
      gain: [gainR, gainG, gainB],
      brightness,
    });

    const result = captureBadgeReading([badge]);
    if (result.valid && result.classPpm === targetPpm) {
      correctCount++;
    }
  }

  const accuracy = (correctCount / trials) * 100;
  assert.ok(
    accuracy >= 95,
    `Class ${targetPpm} ppm accuracy under gain/brightness was ${accuracy}%, expected >= 95%`
  );
  console.log(`  Class ${targetPpm} ppm: ${correctCount}/${trials} (${accuracy.toFixed(1)}%)`);
}
console.log('✓ Test 2 passed: 200 trials per class with +-8% gain and +-12% brightness achieved >= 95% accuracy.');

// 3. No badge returns "No badge found"
const noBadgeImage = createSyntheticBadge({ ppm: 20, noBadge: true });
const noBadgeResult = captureBadgeReading([noBadgeImage]);
assert.equal(noBadgeResult.valid, false);
assert.equal(noBadgeResult.refusalReason, 'No badge found');
console.log('✓ Test 3 passed: Non-yellow S1 returns "No badge found".');

// 4. Random color returns "No match"
const randomColorImage = createSyntheticBadge({ ppm: 20, randomColor: true });
const randomColorResult = captureBadgeReading([randomColorImage]);
assert.equal(randomColorResult.valid, true);
assert.equal(randomColorResult.matched, false);
assert.equal(randomColorResult.status, 'No match, retake');
assert.ok(randomColorResult.d1 > 12);
console.log('✓ Test 4 passed: Distant/random color returns "No match, retake".');

// 5. Learned template overrides default
resetLearnedTemplates();
// Save a custom template for 10 ppm with custom hex
saveLearnedTemplate(10, '#8C5244', '#934A68'); // uses 20 ppm color for 10 ppm
const learnedBadge = createSyntheticBadge({ s3Hex: '#8C5244', s2Hex: '#934A68' });
const learnedResult = captureBadgeReading([learnedBadge]);
assert.equal(learnedResult.valid, true);
assert.equal(learnedResult.classPpm, 10, 'Learned template should override default class');
resetLearnedTemplates();
console.log('✓ Test 5 passed: Learned template overrides default template.');

// 6. Rotated grid gives the same result
for (const targetPpm of [10, 20, 40, 50]) {
  const unrotatedBadge = createSyntheticBadge({ ppm: targetPpm, rotated: false });
  const rotatedBadge = createSyntheticBadge({ ppm: targetPpm, rotated: true });

  const unrotatedResult = captureBadgeReading([unrotatedBadge], { rotated: false });
  const rotatedResult = captureBadgeReading([rotatedBadge], { rotated: true });

  assert.equal(unrotatedResult.valid, true);
  assert.equal(rotatedResult.valid, true);
  assert.equal(rotatedResult.classPpm, unrotatedResult.classPpm);
  assert.equal(rotatedResult.ppm, unrotatedResult.ppm);
}
console.log('✓ Test 6 passed: Rotated grid 90° gives the same result.');

// 7. Each rejection has a passing and a failing fixture
// A. Uniformity gate: std <= 12 passes; std > 12 fails
const uniformPassBadge = createSyntheticBadge({ ppm: 20, nonUniformStd: 0 });
const uniformPassResult = captureBadgeReading([uniformPassBadge]);
assert.equal(uniformPassResult.valid, true, 'Uniform badge should pass');

const uniformFailBadge = createSyntheticBadge({ ppm: 20, nonUniformStd: 30 });
const uniformFailResult = captureBadgeReading([uniformFailBadge]);
assert.equal(uniformFailResult.valid, false);
assert.equal(uniformFailResult.refusalReason, 'Patch not uniform, retake');

// B. Clipping gate: clipped <= 2% passes; clipped > 2% fails
const clippingPassBadge = createSyntheticBadge({ ppm: 20, clipped: false });
const clippingPassResult = captureBadgeReading([clippingPassBadge]);
assert.equal(clippingPassResult.valid, true, 'Unclipped badge should pass');

const clippingFailBadge = createSyntheticBadge({ ppm: 20, clipped: true });
const clippingFailResult = captureBadgeReading([clippingFailBadge]);
assert.equal(clippingFailResult.valid, false);
assert.match(clippingFailResult.refusalReason, /Clipping/);

// C. Frame stability gate: spread <= 6 passes; spread > 6 fails
const stableFrames = [
  createSyntheticBadge({ ppm: 20 }),
  createSyntheticBadge({ ppm: 20 }),
  createSyntheticBadge({ ppm: 20 }),
];
const stableResult = captureBadgeReading(stableFrames);
assert.equal(stableResult.valid, true, 'Stable frames should pass');

const unstableFrames = [
  createSyntheticBadge({ ppm: 20, brightness: 1.0 }),
  createSyntheticBadge({ ppm: 20, brightness: 1.25 }), // large spread > 6
  createSyntheticBadge({ ppm: 20, brightness: 0.75 }),
];
const unstableResult = captureBadgeReading(unstableFrames);
assert.equal(unstableResult.valid, false);
assert.equal(unstableResult.refusalReason, 'Hold steady');

// D. Lighting gain gate: gain in [0.6, 1.6] passes; gain outside fails
const gainPassBadge = createSyntheticBadge({ ppm: 20, gain: [1.1, 1.1, 1.1] });
const gainPassResult = captureBadgeReading([gainPassBadge]);
assert.equal(gainPassResult.valid, true, 'Gain inside [0.6, 1.6] should pass');

const gainFailBadge = createSyntheticBadge({ ppm: 20, gain: [0.4, 0.4, 0.4] }); // gain ~ 2.5 > 1.6
const gainFailResult = captureBadgeReading([gainFailBadge]);
assert.equal(gainFailResult.valid, false);
assert.match(gainFailResult.refusalReason, /Lighting out of range/);

// E. S1 yellow gate: yellow passes; non-yellow fails
const yellowPassBadge = createSyntheticBadge({ ppm: 20, noBadge: false });
assert.equal(captureBadgeReading([yellowPassBadge]).valid, true);

const yellowFailBadge = createSyntheticBadge({ ppm: 20, noBadge: true });
assert.equal(captureBadgeReading([yellowFailBadge]).valid, false);
assert.equal(captureBadgeReading([yellowFailBadge]).refusalReason, 'No badge found');
console.log('✓ Test 7 passed: All 5 rejection checks have passing and failing fixtures.');

// 8. Records tests: deleting one row removes only that record; deleting all records empties storage and UI
global.localStorage.clear();
assert.equal(records().length, 0);

// Add 3 mock records
const r1 = saveRecord({ ppm: 10, approxPpm: 10.2, classPpm: 10, confidence: 'High confidence', valid: true, durationMinutes: 15, s2Hex: '#955375', s3Hex: '#AA6F5C', d1: 0.2, d2: 10.1, gains: [1, 1, 1] });
const r2 = saveRecord({ ppm: 20, approxPpm: 20.4, classPpm: 20, confidence: 'High confidence', valid: true, durationMinutes: 15, s2Hex: '#934A68', s3Hex: '#8C5244', d1: 0.1, d2: 10.2, gains: [1, 1, 1] });
const r3 = saveRecord({ ppm: 40, approxPpm: 40.0, classPpm: 40, confidence: 'High confidence', valid: true, durationMinutes: 15, s2Hex: '#A76070', s3Hex: '#6E493E', d1: 0.3, d2: 8.5, gains: [1, 1, 1] });

assert.equal(records().length, 3);

// Delete row 2 by timestamp
deleteRecord(r2.timestamp);
const remaining = records();
assert.equal(remaining.length, 2, 'Only one record should be removed');
assert.ok(!remaining.some((r) => r.timestamp === r2.timestamp), 'Target record must not exist');
assert.ok(remaining.some((r) => r.timestamp === r1.timestamp), 'r1 must remain');
assert.ok(remaining.some((r) => r.timestamp === r3.timestamp), 'r3 must remain');

// Delete all records
deleteAllRecords();
assert.equal(records().length, 0, 'All records should be cleared');
assert.equal(global.localStorage.getItem('h2s-badge-records-v1'), null);
console.log('✓ Test 8 passed: Single row deletion and delete-all-records operate cleanly.');

console.log('\nAll tests passed successfully! Verification complete.');
