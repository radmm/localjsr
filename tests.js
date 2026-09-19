const assert = require('node:assert/strict');
const app = require('./app.js');

const { H2S_BANDS, CALIBRATION_DATASET, estimateBandFromLab, computeIncrementalExposure, summarizeReading } = app;

assert.deepEqual(H2S_BANDS, [0, 1, 2, 5, 10, 20, 50, 100]);
assert.equal(CALIBRATION_DATASET.length, 16);
assert.ok(CALIBRATION_DATASET.every((entry) => H2S_BANDS.includes(entry.ppm)));

const bandResult = estimateBandFromLab([58, 30, 38]);
assert.equal(bandResult.ppm, 20);
assert.ok(['High', 'Medium', 'Low'].includes(bandResult.confidenceLevel));

const reading = summarizeReading({ stripLab: [58, 30, 38], sealedReferenceLab: [68, 20, 24], durationMinutes: 15, compensationFactor: 1.12 });
assert.equal(reading.concentrationBandEstimate, '20 ppm-equivalent');
assert.equal(reading.confidenceLevel, 'High');
assert.ok(reading.tempHumidityDriftFlag.length > 0);

const delta = computeIncrementalExposure([
  { dose: 120, timestamp: '2026-09-01T08:00:00.000Z' },
  { dose: 220, timestamp: '2026-09-01T09:00:00.000Z' }
]);
assert.equal(delta.doseDifference, 100);
assert.equal(delta.timeElapsedMinutes, 60);

console.log('verification ok');
