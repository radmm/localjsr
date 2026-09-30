const assert = require('node:assert/strict');
const app = require('./app.js');

const {
  H2S_BANDS,
  CALIBRATION_DATASET,
  ROI_LAYOUT,
  ROI_MARGIN,
  ROI_LAYOUT_VERSION,
  ANALYSIS_VERSION,
  CHART_REFERENCE_TABLE,
  DEMO_DISTANCE_THRESHOLD,
  weightedLabDistance,
  estimateChartDemo,
  srgbToLinear,
  linearToSrgb,
  labToRgb,
  fitCorrection,
  calculateFrameChannelRatio,
  applyCameraLocks,
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
  distance,
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

// --- 7. Linear Light & sRGB Conversion Tests ---
[0, 10, 50, 128, 184, 200, 255].forEach((val) => {
  const lin = srgbToLinear(val);
  const roundTrip = linearToSrgb(lin);
  assert.ok(Math.abs(roundTrip - val) < 0.02, `Round trip for ${val} failed: got ${roundTrip}`);
});

// 7b. Lab to RGB conversion tests
CHART_REFERENCE_TABLE.forEach((row, idx) => {
  const rgb = labToRgb(row.lab);
  assert.equal(rgb.length, 3);
  rgb.forEach((c) => {
    assert.ok(c >= 0 && c <= 255, `RGB channel ${c} out of range for chart row ${idx}`);
  });
});

// --- 8. Chart Demo Mode Tests ---
assert.equal(CHART_REFERENCE_TABLE.length, 21);

// 8a. Weighted Euclidean Lab distance tests (weights: L 0.5, a 0.5, b 2.0)
const dLTest = weightedLabDistance([50, 20, 10], [52, 20, 10]);
assert.ok(Math.abs(dLTest - Math.sqrt(0.5 * 4)) < 1e-6);
const daTest = weightedLabDistance([50, 20, 10], [50, 22, 10]);
assert.ok(Math.abs(daTest - Math.sqrt(0.5 * 4)) < 1e-6);
const dbTest = weightedLabDistance([50, 20, 10], [50, 20, 12]);
assert.ok(Math.abs(dbTest - Math.sqrt(2.0 * 4)) < 1e-6);

// 8b. Add tests with each chart row as input expecting its own ppm back
CHART_REFERENCE_TABLE.forEach((row, index) => {
  const result = estimateChartDemo(row.lab);
  assert.equal(result.valid, true, `Chart row ${index} (ppm: ${row.ppm}, temp: ${row.tempC}) failed validity`);
  assert.equal(result.ppm, row.ppm, `Row ${index} expected ppm ${row.ppm}, got ${result.ppm}`);
  assert.equal(result.nearestCell.ppm, row.ppm);
  assert.equal(result.nearestCell.tempC, row.tempC);
  assert.ok(result.distance < 1e-4, `Distance for exact chart row ${index} should be ~0, got ${result.distance}`);
  assert.equal(result.label, 'Demo estimate, not calibrated');
  assert.deepEqual(result.measuredLab, row.lab.map((v) => Number(v.toFixed(2))));
});

// 8c. Test each row with optional user temperature input expecting its own ppm back
CHART_REFERENCE_TABLE.forEach((row, index) => {
  const resultWithTemp = estimateChartDemo(row.lab, { userTemperature: row.tempC });
  assert.equal(resultWithTemp.valid, true);
  assert.equal(resultWithTemp.ppm, row.ppm);
  assert.equal(resultWithTemp.temperatureConstraintApplied, true);
  assert.equal(resultWithTemp.filteredTemp, row.tempC);
});

// 8d. Optional temperature column filtering across rows
const testLab25 = [45, 33, -3];
const demoCol25 = estimateChartDemo(testLab25, { userTemperature: 25 });
assert.equal(demoCol25.valid, true);
assert.equal(demoCol25.temperatureConstraintApplied, true);
assert.equal(demoCol25.filteredTemp, 25);
assert.ok(demoCol25.ppm >= 10);

// 8e. 3-nearest cells inverse-distance weighting interpolation across rows
const midLab15 = [
  (41.63 + 43.86) / 2,
  (34.68 + 32.46) / 2,
  (-7.21 + -2.21) / 2,
];
const midDemo = estimateChartDemo(midLab15);
assert.equal(midDemo.valid, true);
assert.ok(midDemo.ppm >= 10 && midDemo.ppm <= 20, `Interpolated ppm should be between 10 and 20, got ${midDemo.ppm}`);
assert.equal(midDemo.label, 'Demo estimate, not calibrated');

// 8f. "No match, retake" when distance exceeds threshold
const unmatchedLab = [10, 0, -80]; // extreme blue color far from badge spectrum
const noMatchResult = estimateChartDemo(unmatchedLab);
assert.equal(noMatchResult.valid, false);
assert.equal(noMatchResult.refusalReason, 'No match, retake');
assert.equal(noMatchResult.message, 'No match, retake');
assert.ok(noMatchResult.distance > DEMO_DISTANCE_THRESHOLD);
assert.equal(noMatchResult.label, 'Demo estimate, not calibrated');

// --- 9. Blue Color Cast Correction & Diagnostics Tests ---

function applySyntheticBlueTint(badgeFrame) {
  const w = badgeFrame.width;
  const h = badgeFrame.height;
  const tinted = {
    width: w,
    height: h,
    pixels: new Uint8ClampedArray(badgeFrame.pixels.length),
    getContext: () => ({
      getImageData: (x, y, sw, sh) => {
        const sample = new Uint8ClampedArray(sw * sh * 4);
        for (let row = 0; row < sh; row += 1) {
          const start = ((y + row) * w + x) * 4;
          sample.set(tinted.pixels.subarray(start, start + sw * 4), row * sw * 4);
        }
        return { data: sample, width: sw, height: sh };
      },
    }),
    toDataURL: () => 'data:image/jpeg;base64,tinted',
  };
  for (let i = 0; i < badgeFrame.pixels.length; i += 4) {
    const r = badgeFrame.pixels[i];
    const g = badgeFrame.pixels[i + 1];
    const b = badgeFrame.pixels[i + 2];
    // Strong blue cast: Red suppressed to 65%, Green 90%, Blue boosted without clipping to 255
    tinted.pixels[i] = Math.max(1, Math.min(250, Math.round(r * 0.65)));
    tinted.pixels[i + 1] = Math.max(1, Math.min(250, Math.round(g * 0.90)));
    tinted.pixels[i + 2] = Math.max(1, Math.min(250, Math.round(b * 1.12 + 5)));
    tinted.pixels[i + 3] = badgeFrame.pixels[i + 3];
  }
  return tinted;
}

// 9a. Channel ratio calculation & extreme cast warning
const untintedFrame = syntheticBadge();
const tintedFrame = applySyntheticBlueTint(syntheticBadge());
const untintedRatio = calculateFrameChannelRatio(untintedFrame);
const tintedRatio = calculateFrameChannelRatio(tintedFrame);

assert.ok(untintedRatio.bOverR < 1.3, `Untinted B/R should be balanced, got ${untintedRatio.bOverR}`);
assert.equal(untintedRatio.isExtreme, false);
assert.equal(untintedRatio.warning, null);

assert.ok(tintedRatio.bOverR > 1.6, `Tinted B/R should exceed 1.6, got ${tintedRatio.bOverR}`);
assert.equal(tintedRatio.isExtreme, true);
assert.equal(tintedRatio.warning, 'Strong color cast, retake');

// 9b. Synthetic blue tint correction test: corrected result lands within tolerance of untinted one
const cleanResult = calculateReading([untintedFrame], { backgroundRGB: [20, 20, 20] });
const tintedResult = calculateReading([tintedFrame], { backgroundRGB: [20, 20, 20] });

assert.equal(cleanResult.valid, true, cleanResult.refusalReason);
assert.equal(tintedResult.valid, true, tintedResult.refusalReason);

// Confirm strip Lab lands within tolerance
const stripDeltaE = distance(cleanResult.stripLab, tintedResult.stripLab);
assert.ok(stripDeltaE < 5.0, `Corrected Lab DeltaE (${stripDeltaE.toFixed(2)}) should be within 5.0 tolerance`);

// Confirm ppm and dose estimates match untinted image
assert.equal(tintedResult.ppm, cleanResult.ppm);
assert.equal(tintedResult.dose, cleanResult.dose);

// Confirm corrected RGB (not raw RGB) is output and used for rgbToLab
assert.ok(tintedResult.stripRGB);
assert.notDeepEqual(tintedResult.stripRGB, tintedResult.roiMedians.strip);

// Confirm white balance pre-step scaled channels appropriately (red boosted, blue suppressed)
assert.ok(tintedResult.wbScales[0] > 1.0, `Red channel WB scale should be > 1.0, got ${tintedResult.wbScales[0]}`);
assert.ok(tintedResult.wbScales[2] < 1.0, `Blue channel WB scale should be < 1.0, got ${tintedResult.wbScales[2]}`);

// 9c. MediaStreamTrack manual camera lock tests
const mockTrackLockable = {
  getCapabilities: () => ({
    exposureMode: ['manual', 'continuous'],
    whiteBalanceMode: ['manual', 'continuous'],
  }),
  applyConstraints: async () => {},
  getSettings: () => ({
    exposureMode: 'manual',
    whiteBalanceMode: 'manual',
  }),
};
const mockTrackAutoOnly = {
  getCapabilities: () => ({
    exposureMode: ['continuous'],
    whiteBalanceMode: ['continuous'],
  }),
};

applyCameraLocks(mockTrackLockable).then((lockResult) => {
  assert.equal(lockResult.supported, true);
  assert.equal(lockResult.exposureLocked, true);
  assert.equal(lockResult.whiteBalanceLocked, true);
  assert.equal(lockResult.description, 'AE & AWB Locked');
});

applyCameraLocks(mockTrackAutoOnly).then((lockResult) => {
  assert.equal(lockResult.supported, false);
  assert.equal(lockResult.exposureLocked, false);
  assert.equal(lockResult.whiteBalanceLocked, false);
});

waitForVideoReady(startingVideo).then((video) => {
  assert.equal(video, startingVideo);
  console.log('verification ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
