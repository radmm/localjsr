const assert = require('node:assert/strict');
const app = require('./app.js');

const {
  H2S_BANDS,
  CALIBRATION_DATASET,
  ROI_LAYOUT,
  ROI_MARGIN,
  ROI_LAYOUT_VERSION,
  ANALYSIS_VERSION,
  estimateBandFromLab,
  computeIncrementalExposure,
  summarizeReading,
  shrinkRoi,
  medianAcrossFrames,
  sampleRoi,
  calculateReading,
  isVideoReady,
  waitForVideoReady,
  getGuideCrop,
} = app;

assert.deepEqual(H2S_BANDS, [0, 1, 2, 5, 10, 20, 50, 100]);
assert.equal(CALIBRATION_DATASET.length, 16);
assert.ok(CALIBRATION_DATASET.every((entry) => H2S_BANDS.includes(entry.ppm)));
assert.equal(isVideoReady({ readyState: 2, videoWidth: 640, videoHeight: 480 }), true);
assert.equal(isVideoReady({ readyState: 1, videoWidth: 640, videoHeight: 480 }), false);
assert.equal(isVideoReady({ readyState: 2, videoWidth: 0, videoHeight: 480 }), false);
const startingVideo = Object.assign(new EventTarget(), {
  readyState: 0,
  videoWidth: 0,
  videoHeight: 0,
  srcObject: {},
  play() {
    this.readyState = 2;
    this.videoWidth = 640;
    this.videoHeight = 480;
    queueMicrotask(() => this.dispatchEvent(new Event('loadeddata')));
    return Promise.resolve();
  },
});
assert.equal(ANALYSIS_VERSION, 'v1.6');
assert.equal(ROI_LAYOUT.referenceSwatches.length, 6);
const sourceCrop = getGuideCrop(
  { videoWidth: 1920, videoHeight: 1080 },
  { getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 400 }) },
  { getBoundingClientRect: () => ({ left: 70, top: 60, right: 630, bottom: 340 }) },
);
assert.deepEqual(sourceCrop, { x: 203, y: 162, width: 1512, height: 756 });

const bandResult = estimateBandFromLab([58, 30, 38]);
assert.equal(bandResult.ppm, 20);
assert.ok(['High', 'Medium', 'Low'].includes(bandResult.confidenceLevel));

const reading = summarizeReading({ stripLab: [58, 30, 38], sealedReferenceLab: [68, 20, 24], durationMinutes: 15, compensationFactor: 1.12 });
assert.equal(reading.concentrationBandEstimate, '20 ppm-equivalent');
assert.equal(reading.confidenceLevel, 'High');
assert.ok(reading.tempHumidityDriftFlag.length > 0);

const delta = computeIncrementalExposure([
  { dose: 120, timestamp: '2026-09-01T08:00:00.000Z' },
  { dose: 220, timestamp: '2026-09-01T09:00:00.000Z' },
]);
assert.equal(delta.doseDifference, 100);
assert.equal(delta.timeElapsedMinutes, 60);

const shrunk = shrinkRoi({ x: 0.2, y: 0.1, w: 0.4, h: 0.2 });
assert.ok(Math.abs(shrunk.x - 0.3) < 1e-12);
assert.ok(Math.abs(shrunk.y - 0.15) < 1e-12);
assert.equal(shrunk.w, 0.2);
assert.equal(shrunk.h, 0.1);
assert.equal(ROI_MARGIN, 0.25);
assert.deepEqual(medianAcrossFrames([[10, 10, 10], [20, 20, 20], [250, 250, 250]]), [15, 15, 15]);

const medianSample = sampleRoi({
  getImageData: () => ({
    data: new Uint8ClampedArray([
      2, 20, 40, 255,
      200, 80, 120, 255,
      10, 60, 90, 255,
    ]),
    width: 3,
    height: 1,
  }),
}, 10, 10, { x: 0, y: 0, w: 1, h: 1 });
assert.deepEqual(medianSample.rgb, [10, 60, 90]);

const width = 320;
const height = 240;
const colors = {
  strip: [184, 184, 181],
  sealedReference: [220, 220, 210],
};

function paintRoi(data, roi, color) {
  const left = Math.floor(roi.x * width);
  const top = Math.floor(roi.y * height);
  const right = Math.ceil((roi.x + roi.w) * width);
  const bottom = Math.ceil((roi.y + roi.h) * height);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = 255;
    }
  }
}

function syntheticBadge({ noisyBackground = false, uniform = false, clipped = false, blurred = false, badReferences = false, stripColor = colors.strip } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alternate = (x + y) % 2 === 0;
      const noise = noisyBackground ? ((x * 17 + y * 31) % 180) : 0;
      const shade = uniform || blurred ? 120 : (alternate ? 35 + noise % 90 : 145 + noise % 70);
      data[index] = shade;
      data[index + 1] = shade - 5;
      data[index + 2] = shade - 10;
      data[index + 3] = 255;
    }
  }
  paintRoi(data, shrinkRoiForTest(ROI_LAYOUT.strip), stripColor);
  ROI_LAYOUT.referenceSwatches.forEach((roi) => paintRoi(data, shrinkRoiForTest(roi), badReferences ? [30, 30, 30] : roi.color));
  paintRoi(data, shrinkRoiForTest(ROI_LAYOUT.sealedReference), colors.sealedReference);

  if (uniform || blurred) {
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 120;
      data[index + 1] = 115;
      data[index + 2] = 110;
    }
  }
  if (clipped) paintRoi(data, shrinkRoiForTest(ROI_LAYOUT.strip), [255, 255, 255]);

  return {
    width,
    height,
    pixels: data,
    getContext: () => ({
      getImageData: (x, y, sampleWidth, sampleHeight) => {
        const sample = new Uint8ClampedArray(sampleWidth * sampleHeight * 4);
        for (let row = 0; row < sampleHeight; row += 1) {
          const start = ((y + row) * width + x) * 4;
          sample.set(data.subarray(start, start + sampleWidth * 4), row * sampleWidth * 4);
        }
        return { data: sample, width: sampleWidth, height: sampleHeight };
      },
    }),
    toDataURL: () => 'data:image/jpeg;base64,thumbnail',
  };
}

function shrinkRoiForTest(roi) {
  return {
    x: roi.x + roi.w * ROI_MARGIN,
    y: roi.y + roi.h * ROI_MARGIN,
    w: roi.w * (1 - ROI_MARGIN * 2),
    h: roi.h * (1 - ROI_MARGIN * 2),
  };
}

const clean = calculateReading([syntheticBadge()], { backgroundRGB: [20, 20, 20] });
assert.equal(clean.valid, true, clean.refusalReason);
assert.equal(clean.roiLayoutVersion, ROI_LAYOUT_VERSION);
assert.match(clean.thumbnail, /^data:image\/jpeg/);
assert.equal(Object.keys(clean.roiMedians).length, 8);

const noisy = calculateReading([syntheticBadge({ noisyBackground: true })], { backgroundRGB: [20, 20, 20] });
assert.equal(noisy.valid, true, noisy.refusalReason);
assert.equal(noisy.ppm, clean.ppm);
assert.equal(noisy.dose, clean.dose);

const uniformFailure = calculateReading([syntheticBadge({ uniform: true })]);
assert.equal(uniformFailure.refusalReason, 'Hold steady');

const clippingFailure = calculateReading([syntheticBadge({ clipped: true })]);
assert.equal(clippingFailure.refusalReason, 'Too bright or dark');

const patchFailure = syntheticBadge();
for (let y = 135; y < 145; y += 1) {
  for (let x = 150; x < 160; x += 1) {
    const index = (y * width + x) * 4;
    patchFailure.pixels[index] = 0;
    patchFailure.pixels[index + 1] = 0;
    patchFailure.pixels[index + 2] = 0;
  }
}
assert.equal(calculateReading([patchFailure]).refusalReason, 'Patch not uniform, retake');

const backgroundFailure = calculateReading([syntheticBadge()], { backgroundRGB: colors.strip });
assert.equal(backgroundFailure.refusalReason, 'Badge not aligned; strip matches background');

const referenceFailure = calculateReading([syntheticBadge({ badReferences: true })]);
assert.match(referenceFailure.refusalReason, /^Reference correction failed/);

// --- Offline AI Tests ---
const aiDetector = require('./ai-detector.js');

// 1. AI Detector - High confidence on clean synthetic badge
const cleanBadgeFrame = syntheticBadge();
const highConfDetection = aiDetector.detectBadge(cleanBadgeFrame);
assert.equal(highConfDetection.detected, true);
assert.equal(highConfDetection.fallbackUsed, false);
assert.ok(highConfDetection.confidence >= 0.65);
assert.ok(highConfDetection.rois.strip);
assert.equal(highConfDetection.rois.referenceSwatches.length, 6);

// 2. AI Detector - Low confidence triggers fallback path
const randomFrame = {
  width: 320,
  height: 240,
  getContext: () => ({
    getImageData: () => ({
      data: new Uint8ClampedArray(320 * 240 * 4).fill(120),
      width: 320,
      height: 240,
    }),
  }),
};
const lowConfDetection = aiDetector.detectBadge(randomFrame);
assert.equal(lowConfDetection.detected, false);
assert.equal(lowConfDetection.fallbackUsed, true);
assert.ok(lowConfDetection.confidence < 0.65);
assert.ok(lowConfDetection.reason.includes('fell back to guide frame'));
assert.deepEqual(lowConfDetection.rois.strip, ROI_LAYOUT.strip);

// 3. Capture Quality Scorer Tests
// 3a. Blur detection
const blurQuality = aiDetector.assessCaptureQuality(syntheticBadge({ uniform: true }));
assert.equal(blurQuality.passed, false);
assert.equal(blurQuality.failReason, 'blur');
assert.ok(blurQuality.retakeMessage.includes('blurry'));

// 3b. Glare detection
const glareBadge = syntheticBadge();
const glareData = glareBadge.pixels;
for (let y = 100; y < 140; y += 1) {
  for (let x = 100; x < 150; x += 1) {
    const idx = (y * 320 + x) * 4;
    glareData[idx] = 255;
    glareData[idx + 1] = 255;
    glareData[idx + 2] = 255;
  }
}
const glareQuality = aiDetector.assessCaptureQuality(glareBadge);
assert.equal(glareQuality.passed, false);
assert.equal(glareQuality.failReason, 'glare');
assert.ok(glareQuality.retakeMessage.includes('Glare detected'));

// 3c. Shadow detection
const shadowBadge = syntheticBadge();
const shadowData = shadowBadge.pixels;
for (let y = 120; y < 240; y += 1) {
  for (let x = 160; x < 320; x += 1) {
    const idx = (y * 320 + x) * 4;
    shadowData[idx] = 10;
    shadowData[idx + 1] = 10;
    shadowData[idx + 2] = 10;
  }
}
const shadowQuality = aiDetector.assessCaptureQuality(shadowBadge);
assert.equal(shadowQuality.passed, false);
assert.equal(shadowQuality.failReason, 'shadow');
assert.ok(shadowQuality.retakeMessage.includes('shadow'));

// 3d. Bad angle detection
const badAngleDetection = {
  corners: [
    { x: 0.1, y: 0.05 },
    { x: 0.9, y: 0.05 },
    { x: 0.6, y: 0.95 },
    { x: 0.4, y: 0.95 },
  ],
};
const angleQuality = aiDetector.assessCaptureQuality(syntheticBadge(), badAngleDetection);
assert.equal(angleQuality.passed, false);
assert.equal(angleQuality.failReason, 'angle');
assert.ok(angleQuality.retakeMessage.includes('angle'));

// 4. Cross-Check Tests
// 4a. Within tolerance (agreement)
const crossCheckAgree = aiDetector.runCrossCheck({ ppm: 20, dose: 300 }, { ppm: 21, dose: 315 });
assert.equal(crossCheckAgree.agreed, true);
assert.equal(crossCheckAgree.disagreed, false);

// 4b. Disagreement beyond tolerance
const crossCheckDisagree = aiDetector.runCrossCheck({ ppm: 10, dose: 150 }, { ppm: 20, dose: 300 });
assert.equal(crossCheckDisagree.agreed, false);
assert.equal(crossCheckDisagree.disagreed, true);
assert.ok(crossCheckDisagree.flagMessage.includes('Cross-check discrepancy'));

// 5. Fallback path reading calculation
const fallbackReading = calculateReading([syntheticBadge()], { rois: lowConfDetection.rois });
assert.equal(fallbackReading.valid, true);
assert.equal(fallbackReading.ppm, clean.ppm);
assert.equal(fallbackReading.dose, clean.dose);

// 6. Integration test for analyzeBadge with fallback and record metadata storage
let savedRecords = [];
const mockStorage = {
  getItem: () => JSON.stringify(savedRecords),
  setItem: (key, val) => { savedRecords = JSON.parse(val); },
  removeItem: (key) => { savedRecords = []; },
};
global.localStorage = mockStorage;
global.document = {
  createElement: () => ({
    width: 100,
    height: 100,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => 'data:image/jpeg;base64,mock',
  }),
  querySelector: () => ({
    value: 'WRK-TEST',
    textContent: '',
    hidden: false,
    style: {},
    className: '',
    querySelectorAll: () => [],
    scrollIntoView: () => {},
  }),
};
const testCapture = {
  frames: [syntheticBadge()],
  backgroundRGB: [20, 20, 20],
};
app.analyzeBadge(testCapture);
assert.equal(savedRecords.length, 1);
const savedRec = savedRecords[0];
assert.ok(savedRec.detectedRois);
assert.ok(savedRec.detectedRois.strip);
assert.equal(savedRec.modelVersion, 'h2s-badge-ai-v1.2');
assert.equal(typeof savedRec.fallbackUsed, 'boolean');
assert.ok(savedRec.aiQualityScores);
assert.ok(savedRec.crossCheck);

// --- Color-First Demo Mode Unit & Integration Tests (2 ROIs: Reference & Sample) ---
const demoColorReader = require('./demo-color-reader.js');

// Test 1: Record persistence includes ROI medians, Lab, aligned Lab, and estimator version
assert.ok(savedRec.demoRoiMedians);
assert.ok(savedRec.demoLab);
assert.ok(savedRec.demoAlignedLab);
assert.equal(savedRec.demoEstimatorVersion, 'color-first-v2.0');
assert.ok(savedRec.demoRoiMedians.ref);
assert.ok(savedRec.demoRoiMedians.sample || savedRec.demoRoiMedians.s1);

// Test 2: db values from the table return their ppm
assert.equal(demoColorReader.interpolateDemoPpm(0), 0, 'db 0 must return 0 ppm');
assert.equal(demoColorReader.interpolateDemoPpm(15.71), 10, 'db 15.71 must return 10 ppm');
assert.equal(demoColorReader.interpolateDemoPpm(18.59), 20, 'db 18.59 must return 20 ppm');
assert.equal(demoColorReader.interpolateDemoPpm(29.89), 40, 'db 29.89 must return 40 ppm');
assert.equal(demoColorReader.interpolateDemoPpm(31.85), 50, 'db 31.85 must return 50 ppm');

assert.equal(demoColorReader.matchDemoColor(0).ppm, 0);
assert.equal(demoColorReader.matchDemoColor(15.71).ppm, 10);
assert.equal(demoColorReader.matchDemoColor(18.59).ppm, 20);
assert.equal(demoColorReader.matchDemoColor(29.89).ppm, 40);
assert.equal(demoColorReader.matchDemoColor(31.85).ppm, 50);

// Test 2b: Range output (ppm at db minus spread to db plus spread, e.g. "10 to 20 ppm")
const demoRangeTest = demoColorReader.matchDemoColor(18.59, undefined, { spread: 1.0 });
assert.ok(demoRangeTest.range.includes('to'), `Range must be in "X to Y ppm" format: ${demoRangeTest.range}`);
assert.equal(demoRangeTest.ppm, 20);

// Test 3: A uniform tint applied to both halves leaves db unchanged
const demoRefLab = [45.77, 34.05, -19.46];
const demoTestTable = [
  { expectedPpm: 0, db: 0 },
  { expectedPpm: 10, db: 15.71 },
  { expectedPpm: 20, db: 18.59 },
  { expectedPpm: 40, db: 29.89 },
  { expectedPpm: 50, db: 31.85 },
];

const demoTints = [
  [12.5, -8.3, 15.2],
  [-10.0, 15.0, -12.0],
  [5.0, 5.0, 5.0],
];

for (const { expectedPpm, db } of demoTestTable) {
  const sampleLab = [demoRefLab[0], demoRefLab[1], demoRefLab[2] + db];
  const baseResult = demoColorReader.matchDemoColor(demoRefLab, sampleLab);

  for (const tint of demoTints) {
    const tintedRef = [demoRefLab[0] + tint[0], demoRefLab[1] + tint[1], demoRefLab[2] + tint[2]];
    const tintedSample = [sampleLab[0] + tint[0], sampleLab[1] + tint[1], sampleLab[2] + tint[2]];
    const tintedResult = demoColorReader.matchDemoColor(tintedRef, tintedSample);

    assert.ok(
      Math.abs(baseResult.db - tintedResult.db) < 1e-4,
      `Uniform tint ${tint} changed db (base: ${baseResult.db}, tinted: ${tintedResult.db})`
    );
    assert.equal(tintedResult.ppm, expectedPpm, `Tinted result ppm must equal expected ppm ${expectedPpm}`);
  }
}

// Test 4: 10 repeated captures of the same synthetic image return identical ppm
const syntheticDemoBadge = demoColorReader.createDemoBadgeCanvas({ samplePpm: 20 });
const demoRepeatCaptures = [];
for (let i = 0; i < 10; i++) {
  const processed = demoColorReader.processDemoFrames([syntheticDemoBadge]);
  assert.equal(processed.valid, true);
  demoRepeatCaptures.push(processed);
}
assert.equal(demoRepeatCaptures.length, 10);
const firstDemoPpm = demoRepeatCaptures[0].ppm;
const firstDemoDb = demoRepeatCaptures[0].db;
for (let i = 1; i < 10; i++) {
  assert.equal(demoRepeatCaptures[i].ppm, firstDemoPpm, `Capture ${i} ppm must match first capture`);
  assert.equal(demoRepeatCaptures[i].db, firstDemoDb, `Capture ${i} db must match first capture`);
}

// Test 4b: Spread above 1.5 rejects the capture with "Hold steady"
const unsteadyFrames = [];
for (let i = 0; i < 5; i++) {
  unsteadyFrames.push(demoColorReader.createDemoBadgeCanvas({ samplePpm: 10 + i * 10 }));
}
const unsteadyResult = demoColorReader.processDemoFrames(unsteadyFrames);
assert.equal(unsteadyResult.valid, false);
assert.equal(unsteadyResult.refusalReason, 'Hold steady');
assert.ok(unsteadyResult.spreadDb > 1.5);

// Test 5: Quality gates - each gate has a passing and a failing fixture
// A. Uniformity Gate:
// Passing fixture: uniform patch (noiseStddev = 0)
const passUniformCanvas = demoColorReader.createDemoBadgeCanvas({ noiseStddev: 0, clippedPixels: 0 });
const passUniformCheck = demoColorReader.checkDemoQualityGates(passUniformCanvas);
assert.equal(passUniformCheck.gates.sample.uniformityPassed, true, 'Uniform patch should pass uniformity gate');
assert.ok(passUniformCheck.gates.sample.stddev <= 24);

// Failing fixture: non-uniform noisy patch (noiseStddev = 30)
const failUniformCanvas = demoColorReader.createDemoBadgeCanvas({ noiseStddev: 30, clippedPixels: 0 });
const failUniformCheck = demoColorReader.checkDemoQualityGates(failUniformCanvas);
assert.equal(failUniformCheck.gates.sample.uniformityPassed, false, 'Noisy patch should fail uniformity gate');
assert.ok(failUniformCheck.gates.sample.stddev > 24);
assert.equal(failUniformCheck.gates.sample.failureReason, 'Patch not uniform, retake');

// B. Clipping Gate:
// Passing fixture: normal brightness patch (clippedPixels = 0)
const passClipCanvas = demoColorReader.createDemoBadgeCanvas({ noiseStddev: 0, clippedPixels: 0 });
const passClipCheck = demoColorReader.checkDemoQualityGates(passClipCanvas);
assert.equal(passClipCheck.gates.sample.clippingPassed, true, 'Normal patch should pass clipping gate');
assert.ok(passClipCheck.gates.sample.clippedFraction <= 0.02);

// Failing fixture: overexposed/clipped patch (saturated = true)
const failClipCanvas = demoColorReader.createDemoBadgeCanvas({ noiseStddev: 0, saturated: true });
const failClipCheck = demoColorReader.checkDemoQualityGates(failClipCanvas);
assert.equal(failClipCheck.gates.sample.clippingPassed, false, 'Clipped patch should fail clipping gate');
assert.ok(failClipCheck.gates.sample.clippedFraction > 0.02);
assert.equal(failClipCheck.gates.sample.failureReason, 'Too bright or dark');

// --- Brown Scale Dedicated Module Unit & Integration Tests ---
const brownScaleReader = require('./brown-scale-reader.js');

// Test BS 1: Each table dL returns its own ppm
assert.equal(brownScaleReader.interpolateBrownScalePpm(0), 0, 'dL 0 -> 0 ppm');
assert.equal(brownScaleReader.interpolateBrownScalePpm(7.8), 1, 'dL 7.8 -> 1 ppm');
assert.equal(brownScaleReader.interpolateBrownScalePpm(12.8), 5, 'dL 12.8 -> 5 ppm');
assert.equal(brownScaleReader.interpolateBrownScalePpm(23.3), 10, 'dL 23.3 -> 10 ppm');
assert.equal(brownScaleReader.interpolateBrownScalePpm(36.8), 20, 'dL 36.8 -> 20 ppm');
assert.equal(brownScaleReader.interpolateBrownScalePpm(45.0), 50, 'dL 45.0 -> 50 ppm');
assert.equal(brownScaleReader.interpolateBrownScalePpm(53.0), 100, 'dL 53.0 -> 100 ppm');

// Test BS 2: A uniform tint applied to both halves leaves dL unchanged within tolerance
const pristineRefLab = brownScaleReader.PRISTINE_LAB;
const brownScaleTable = [
  { expectedPpm: 0, dL: 0 },
  { expectedPpm: 1, dL: 7.8 },
  { expectedPpm: 5, dL: 12.8 },
  { expectedPpm: 10, dL: 23.3 },
  { expectedPpm: 20, dL: 36.8 },
  { expectedPpm: 50, dL: 45.0 },
  { expectedPpm: 100, dL: 53.0 },
];

const brownTints = [
  [8.0, -4.0, 5.0],
  [-6.0, 8.0, -4.0],
  [2.0, 2.0, 2.0],
];

for (const { expectedPpm, dL } of brownScaleTable) {
  const smpLab = [pristineRefLab[0] - dL, pristineRefLab[1], pristineRefLab[2]];
  const baseResult = brownScaleReader.estimateBrownScale(pristineRefLab, smpLab);

  for (const tint of brownTints) {
    const tintedRef = [pristineRefLab[0] + tint[0], pristineRefLab[1] + tint[1], pristineRefLab[2] + tint[2]];
    const tintedSmp = [smpLab[0] + tint[0], smpLab[1] + tint[1], smpLab[2] + tint[2]];
    const tintedResult = brownScaleReader.estimateBrownScale(tintedRef, tintedSmp);

    assert.ok(
      Math.abs(baseResult.dL - tintedResult.dL) < 1e-4,
      `Uniform tint ${tint} changed dL (base: ${baseResult.dL}, tinted: ${tintedResult.dL})`
    );
    assert.equal(tintedResult.ppm, expectedPpm, `Tinted result ppm must equal expected ${expectedPpm}`);
  }
}

// Test BS 3: A sample equal to the reference returns 0
const equalResult = brownScaleReader.estimateBrownScale('#C4C3BF', '#C4C3BF');
assert.equal(equalResult.ppm, 0, 'Sample equal to reference must return 0 ppm');
assert.equal(equalResult.dL, 0, 'Sample equal to reference must have dL 0');
assert.equal(equalResult.displayPpm, '0 to 0 ppm');

// Test BS 4: 10 repeated captures of the same synthetic image return identical ppm
const syntheticBrownBadge = brownScaleReader.createBrownScaleBadgeCanvas({ samplePpm: 20 });
const brownRepeatCaptures = [];
for (let i = 0; i < 10; i++) {
  const processed = brownScaleReader.processBrownScaleFrames([syntheticBrownBadge]);
  assert.equal(processed.valid, true);
  brownRepeatCaptures.push(processed);
}
assert.equal(brownRepeatCaptures.length, 10);
const firstBrownPpm = brownRepeatCaptures[0].ppm;
const firstBrownDL = brownRepeatCaptures[0].dL;
for (let i = 1; i < 10; i++) {
  assert.equal(brownRepeatCaptures[i].ppm, firstBrownPpm, `Brown capture ${i} ppm must match first`);
  assert.equal(brownRepeatCaptures[i].dL, firstBrownDL, `Brown capture ${i} dL must match first`);
}

// Test BS 5: Spread of L* above 1.0 rejects with "Hold steady"
const unsteadyBrownFrames = [];
for (let i = 0; i < 5; i++) {
  unsteadyBrownFrames.push(brownScaleReader.createBrownScaleBadgeCanvas({ tint: [i * 1.5, 0, 0] }));
}
const unsteadyBrownResult = brownScaleReader.processBrownScaleFrames(unsteadyBrownFrames);
assert.equal(unsteadyBrownResult.valid, false);
assert.equal(unsteadyBrownResult.refusalReason, 'Hold steady');
assert.ok(unsteadyBrownResult.spreadL > 1.0);

// Test BS 6: Pristine reference far from #C4C3BF rejected with warning
const badRefCanvas = brownScaleReader.createBrownScaleBadgeCanvas({ badReference: true });
const badRefResult = brownScaleReader.processBrownScaleFrames([badRefCanvas]);
assert.equal(badRefResult.valid, false);
assert.ok(badRefResult.refusalReason.includes('shadow or tint warning'));

// Test BS 7: Calibration save, override, and reset
const customCalLevel = { ppm: 10, dL: 20.0, pristineHex: '#C4C3BF', sampleHex: '#B17762' };
brownScaleReader.saveCalibrationLevel(customCalLevel.ppm, customCalLevel.pristineHex, customCalLevel.sampleHex, customCalLevel.dL);
const customCalResult = brownScaleReader.estimateBrownScale(pristineRefLab, [pristineRefLab[0] - 20.0, pristineRefLab[1], pristineRefLab[2]]);
assert.equal(customCalResult.ppm, 10, 'Custom calibration should override default table');
assert.equal(customCalResult.usingCalibration, true);

brownScaleReader.deleteCalibration();
assert.equal(brownScaleReader.getCalibration(), null, 'Calibration should be deleted on reset');


// Test 6: Demo stability buffer tests
const sampledDemo = demoColorReader.sampleDemoCanvas(passUniformCanvas);
assert.ok(sampledDemo.roiMedians.ref);
assert.ok(sampledDemo.measuredLab.ref);
assert.ok(sampledDemo.roiMedians.sample);
assert.ok(sampledDemo.measuredLab.sample);

const buffer = new demoColorReader.DemoStabilityBuffer(5, 3.5);
assert.equal(buffer.addFrame(sampledDemo).isStable, true); // single frame is stable
buffer.reset();

// 4 unsteady frames
for (let i = 0; i < 4; i++) {
  const perturbed = {
    roiMedians: sampledDemo.roiMedians,
    measuredLab: {
      ref: [sampledDemo.measuredLab.ref[0] + i * 2, sampledDemo.measuredLab.ref[1], sampledDemo.measuredLab.ref[2]],
      sample: [sampledDemo.measuredLab.sample[0], sampledDemo.measuredLab.sample[1], sampledDemo.measuredLab.sample[2]],
    },
  };
  const st = buffer.addFrame(perturbed);
  if (i > 0) {
    assert.equal(st.isStable, false); // < 5 frames
  }
}

// --- Delete Records Tests: Delete One Row and Delete All Records ---
const initialTestRecords = [
  {
    workerId: 'WRK-001',
    badgeId: 'BADGE-A',
    shiftId: 'SHIFT-1',
    timestamp: '2026-10-04T10:00:00.000Z',
    dose: 15.0,
    concentrationBandEstimate: '10 ppm-equivalent',
    confidenceLevel: 'High',
    tempHumidityDriftFlag: 'Low drift',
    analysisVersion: app.ANALYSIS_VERSION,
  },
  {
    workerId: 'WRK-002',
    badgeId: 'BADGE-B',
    shiftId: 'SHIFT-2',
    timestamp: '2026-10-04T11:00:00.000Z',
    dose: 30.0,
    concentrationBandEstimate: '20 ppm-equivalent',
    confidenceLevel: 'Medium',
    tempHumidityDriftFlag: 'Low drift',
    analysisVersion: app.ANALYSIS_VERSION,
  },
  {
    workerId: 'WRK-003',
    badgeId: 'BADGE-C',
    shiftId: 'SHIFT-3',
    timestamp: '2026-10-04T12:00:00.000Z',
    dose: 45.0,
    concentrationBandEstimate: '50 ppm-equivalent',
    confidenceLevel: 'High',
    tempHumidityDriftFlag: 'Moderate drift',
    analysisVersion: app.ANALYSIS_VERSION,
  },
];

savedRecords = [...initialTestRecords];

const mockElements = {
  '#recordCount': { textContent: '' },
  '#recordsBody': { innerHTML: '' },
  '#compareLeftSelect': { innerHTML: '', value: '' },
  '#compareRightSelect': { innerHTML: '', value: '' },
  '#compareSummary': { textContent: '' },
};

global.document.querySelector = (selector) => {
  if (mockElements[selector]) return mockElements[selector];
  return {
    value: 'WRK-TEST',
    textContent: '',
    hidden: false,
    style: {},
    className: '',
    querySelectorAll: () => [],
    scrollIntoView: () => {},
  };
};

// Initial render
app.renderRecords();
assert.equal(app.records().length, 3, 'Initial record count must be 3');
assert.equal(mockElements['#recordCount'].textContent, '3 saved');
assert.ok(mockElements['#recordsBody'].innerHTML.includes('2026-10-04T10:00:00.000Z'));
assert.ok(mockElements['#recordsBody'].innerHTML.includes('2026-10-04T11:00:00.000Z'));
assert.ok(mockElements['#recordsBody'].innerHTML.includes('2026-10-04T12:00:00.000Z'));
assert.ok(mockElements['#recordsBody'].innerHTML.includes('row-delete-btn'));

// Test A: Deleting one row removes ONLY that record from storage and UI
app.deleteRecord('2026-10-04T11:00:00.000Z');

// Verify storage after deleting one row
assert.equal(app.records().length, 2, 'Storage must contain 2 records after deleting 1 row');
const remainingTimestamps = app.records().map((r) => r.timestamp);
assert.ok(!remainingTimestamps.includes('2026-10-04T11:00:00.000Z'), 'Deleted record must not be in storage');
assert.ok(remainingTimestamps.includes('2026-10-04T10:00:00.000Z'), 'First record must remain in storage');
assert.ok(remainingTimestamps.includes('2026-10-04T12:00:00.000Z'), 'Third record must remain in storage');

// Verify UI after deleting one row
assert.equal(mockElements['#recordCount'].textContent, '2 saved', 'UI record count must show 2 saved');
assert.ok(!mockElements['#recordsBody'].innerHTML.includes('2026-10-04T11:00:00.000Z'), 'Deleted row must not be in table UI');
assert.ok(mockElements['#recordsBody'].innerHTML.includes('2026-10-04T10:00:00.000Z'), 'First record must still be in table UI');
assert.ok(mockElements['#recordsBody'].innerHTML.includes('2026-10-04T12:00:00.000Z'), 'Third record must still be in table UI');
assert.ok(!mockElements['#compareLeftSelect'].innerHTML.includes('2026-10-04T11:00:00.000Z'), 'Compare dropdown must not contain deleted record');
assert.ok(mockElements['#compareLeftSelect'].innerHTML.includes('2026-10-04T10:00:00.000Z'), 'Compare dropdown must retain other records');

// Test B: Deleting all records empties storage and the UI
app.deleteAllRecords();

// Verify storage is empty
assert.equal(app.records().length, 0, 'Storage must have 0 records after deleteAllRecords');
assert.equal(savedRecords.length, 0, 'Underlying storage array must be empty');

// Verify UI shows empty state
assert.equal(mockElements['#recordCount'].textContent, '0 saved', 'UI record count must show 0 saved');
assert.ok(mockElements['#recordsBody'].innerHTML.includes('empty-row'), 'Table UI must contain empty-row state');
assert.ok(mockElements['#recordsBody'].innerHTML.includes('No readings yet'), 'Table UI must show empty readings message');
assert.ok(mockElements['#compareLeftSelect'].innerHTML.includes('No saved records'), 'Compare left dropdown must show no saved records');
assert.ok(mockElements['#compareRightSelect'].innerHTML.includes('No saved records'), 'Compare right dropdown must show no saved records');
assert.ok(mockElements['#compareSummary'].textContent.includes('Select two saved readings'), 'Compare summary must reset to initial state');

waitForVideoReady(startingVideo).then((video) => {
  assert.equal(video, startingVideo);
  console.log('verification ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
