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

waitForVideoReady(startingVideo).then((video) => {
  assert.equal(video, startingVideo);
  console.log('verification ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
