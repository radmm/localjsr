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
  AutoCaptureEngine,
  executeLearnBadgeWorkflow,
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

// 3. No badge returns friendly "Place the badge so the six squares sit on the dots."
const noBadgeImage = createSyntheticBadge({ ppm: 20, noBadge: true });
const noBadgeResult = captureBadgeReading([noBadgeImage]);
assert.equal(noBadgeResult.valid, false);
assert.equal(noBadgeResult.refusalReason, 'Place the badge so the six squares sit on the dots.');
console.log('✓ Test 3 passed: Non-yellow S1 returns friendly tip: "Place the badge so the six squares sit on the dots."');

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

// 7. Rejection checks with friendly tips (Hold steady, lighting, badge not in frame)
// A. Frame stability gate: spread <= 6 passes; spread > 6 fails with "Hold steady."
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
assert.equal(unstableResult.refusalReason, 'Hold steady.');

// B. Lighting gain out of range: friendly too dark / shadow tip
const gainPassBadge = createSyntheticBadge({ ppm: 20, gain: [1.1, 1.1, 1.1] });
const gainPassResult = captureBadgeReading([gainPassBadge]);
assert.equal(gainPassResult.valid, true, 'Gain inside limits should pass');

const gainFailBadge = createSyntheticBadge({ ppm: 20, gain: [0.4, 0.4, 0.4] });
const gainFailResult = captureBadgeReading([gainFailBadge]);
assert.equal(gainFailResult.valid, false);
assert.match(gainFailResult.refusalReason, /Too dark|Shadow|Move/);

// C. S1 yellow gate: yellow passes; non-yellow fails with "Place the badge so the six squares sit on the dots."
const yellowPassBadge = createSyntheticBadge({ ppm: 20, noBadge: false });
assert.equal(captureBadgeReading([yellowPassBadge]).valid, true);

const yellowFailBadge = createSyntheticBadge({ ppm: 20, noBadge: true });
const yellowFailResult = captureBadgeReading([yellowFailBadge]);
assert.equal(yellowFailResult.valid, false);
assert.equal(yellowFailResult.refusalReason, 'Place the badge so the six squares sit on the dots.');
console.log('✓ Test 7 passed: Friendly tips for instability, lighting, and frame alignment.');

// 8. Specific Prompt Requirements Tests:
// A. Patches with some pixels at 255 still produce a reading from the remaining pixels
const badgeWithClippedPixels = createSyntheticBadge({ ppm: 20, clippedRatio: 0.25 });
const clippedResult = captureBadgeReading([badgeWithClippedPixels]);
assert.equal(clippedResult.valid, true, 'Patches with some pixels at 255 must produce a valid reading');
assert.equal(clippedResult.classPpm, 20);
console.log('✓ Test 8A passed: Patches with some pixels at 255 still produce a reading from remaining pixels.');

// B. A badge with only S1 glared still reads
const badgeS1Glared = createSyntheticBadge({ ppm: 20, s1Glared: true });
const s1GlaredResult = captureBadgeReading([badgeS1Glared]);
assert.equal(s1GlaredResult.valid, true, 'A badge with only S1 glared still reads');
assert.equal(s1GlaredResult.classPpm, 20);
assert.equal(s1GlaredResult.patchStatus?.S1?.status, 'red', 'S1 is glared and marked red');
console.log('✓ Test 8B passed: A badge with only S1 glared still reads.');

// C. Auto capture fires once after 1 second of stable good patches and not before
let autoCaptureFiredCount = 0;
let beepCount = 0;
const autoEngine = new AutoCaptureEngine({
  delayMs: 1000,
  onCapture: () => { autoCaptureFiredCount++; },
  onBeep: () => { beepCount++; },
});

// t = 0ms
let updateRes = autoEngine.update({ isKeyPatchesUsable: true, isStable: true, now: 0 });
assert.equal(updateRes.fired, false, 'Auto capture must not fire at t=0');
assert.equal(autoCaptureFiredCount, 0);

// t = 500ms
updateRes = autoEngine.update({ isKeyPatchesUsable: true, isStable: true, now: 500 });
assert.equal(updateRes.fired, false, 'Auto capture must not fire at t=500ms');
assert.equal(autoCaptureFiredCount, 0);

// t = 999ms
updateRes = autoEngine.update({ isKeyPatchesUsable: true, isStable: true, now: 999 });
assert.equal(updateRes.fired, false, 'Auto capture must not fire before 1000ms');
assert.equal(autoCaptureFiredCount, 0);

// t = 1000ms: fires!
updateRes = autoEngine.update({ isKeyPatchesUsable: true, isStable: true, now: 1000 });
assert.equal(updateRes.fired, true, 'Auto capture must fire at 1 second');
assert.equal(autoCaptureFiredCount, 1, 'Auto capture must fire exactly once');
assert.equal(beepCount, 1, 'Beep feedback played');

// t = 1100ms: cooldown active, does not fire again
updateRes = autoEngine.update({ isKeyPatchesUsable: true, isStable: true, now: 1100 });
assert.equal(updateRes.fired, false, 'Auto capture must not re-fire immediately');
assert.equal(autoCaptureFiredCount, 1);
console.log('✓ Test 8C passed: Auto capture fires once after 1 second of stable good patches and not before.');

// D. Learn saves without any popup
resetLearnedTemplates();
const testLearnBadge = createSyntheticBadge({ ppm: 40 });
const learnResult = executeLearnBadgeWorkflow(40, [testLearnBadge]);
assert.equal(learnResult.success, true);
assert.equal(learnResult.message, 'Learned 40 ppm');
const learnedMap = getCombinedTemplates();
assert.equal(learnedMap[40].isDefault, false, 'Learned template must be saved and active');
resetLearnedTemplates();
console.log('✓ Test 8D passed: Learn saves without any popup.');

// E. No alert() calls remain in the code
const fs = require('fs');
const appJsSource = fs.readFileSync('./app.js', 'utf8');
const indexHtmlSource = fs.readFileSync('./index.html', 'utf8');
assert.ok(!appJsSource.includes('alert('), 'No alert() calls in app.js');
assert.ok(!indexHtmlSource.includes('alert('), 'No alert() calls in index.html');
console.log('✓ Test 8E passed: No alert() calls remain in the code.');

// 9. Records tests: deleting one row removes only that record; deleting all records empties storage and UI
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
console.log('✓ Test 9 passed: Single row deletion and delete-all-records operate cleanly.');

console.log('\nAll tests passed successfully! Verification complete.');
