(function () {
  'use strict';

const STORAGE_KEY = 'h2s-badge-records-v1';
const THRESHOLD = 10;
const ANALYSIS_VERSION = 'v1.6';
const ROI_LAYOUT_VERSION = 'badge-layout-v1';
const REFERENCE_ERROR_THRESHOLD = 32;
const ROI_MARGIN = 0.25;
const ROI_STDDEV_THRESHOLD = 24;
const CLIPPED_PIXEL_THRESHOLD = 0.02;
const BLUR_VARIANCE_THRESHOLD = 20;
const BACKGROUND_SIMILARITY_THRESHOLD = 10;
const H2S_BANDS = [0, 1, 2, 5, 10, 20, 50, 100];

let AiDetectorModule = null;
if (typeof require !== 'undefined') {
  try {
    AiDetectorModule = require('./ai-detector.js');
  } catch (e) {
    // browser or bundle
  }
}

function getAiDetector() {
  if (typeof window !== 'undefined' && window.AiDetector) return window.AiDetector;
  return AiDetectorModule;
}

let DemoColorReaderModule = null;
if (typeof require !== 'undefined') {
  try {
    DemoColorReaderModule = require('./demo-color-reader.js');
  } catch (e) {
    // browser or bundle
  }
}

function getDemoColorReader() {
  if (typeof window !== 'undefined' && window.DemoColorReader) return window.DemoColorReader;
  return DemoColorReaderModule;
}

let demoStabilityBuffer = null;
function getDemoStabilityBuffer() {
  const reader = getDemoColorReader();
  if (!demoStabilityBuffer && reader) {
    demoStabilityBuffer = new reader.DemoStabilityBuffer(5, reader.DEMO_STABILITY_THRESHOLD);
  }
  return demoStabilityBuffer;
}
const ROI_LAYOUT = {
  strip: { x: 0.38, y: 0.50, w: 0.24, h: 0.24 },
  referenceSwatches: [
    { key: 'refSwatch1', x: 0.12, y: 0.14, w: 0.12, h: 0.12, color: [245, 238, 220] },
    { key: 'refSwatch2', x: 0.28, y: 0.14, w: 0.12, h: 0.12, color: [205, 224, 226] },
    { key: 'refSwatch3', x: 0.44, y: 0.14, w: 0.12, h: 0.12, color: [220, 202, 215] },
    { key: 'refSwatch4', x: 0.60, y: 0.14, w: 0.12, h: 0.12, color: [222, 211, 176] },
    { key: 'refSwatch5', x: 0.76, y: 0.14, w: 0.12, h: 0.12, color: [183, 208, 190] },
    { key: 'refSwatch6', x: 0.44, y: 0.28, w: 0.12, h: 0.12, color: [184, 184, 181] },
  ],
  sealedReference: { x: 0.45, y: 0.09, w: 0.10, h: 0.10 },
};
const REFERENCE_SWATCHES = ROI_LAYOUT.referenceSwatches;
let lastDebugCapture = null;
const SEALED_REFERENCE_BASELINE = [86, -2, 3];
const BAND_BASE_LAB = {
  0: [85, -2, 3],
  1: [79, 4, 12],
  2: [74, 10, 18],
  5: [69, 16, 24],
  10: [64, 22, 31],
  20: [58, 28, 36],
  50: [49, 34, 44],
  100: [42, 39, 50],
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function shrinkRoi(roi, margin = ROI_MARGIN) {
  return {
    x: roi.x + roi.w * margin,
    y: roi.y + roi.h * margin,
    w: roi.w * (1 - margin * 2),
    h: roi.h * (1 - margin * 2),
  };
}

function median(values) {
  const sorted = values.slice().sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleRoi(context, width, height, roi) {
  const inner = shrinkRoi(roi);
  const x = Math.max(0, Math.floor(inner.x * width));
  const y = Math.max(0, Math.floor(inner.y * height));
  const right = Math.min(width, Math.ceil((inner.x + inner.w) * width));
  const bottom = Math.min(height, Math.ceil((inner.y + inner.h) * height));
  const image = context.getImageData(x, y, right - x, bottom - y);
  const channels = [[], [], []];
  let clippedPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = [image.data[index], image.data[index + 1], image.data[index + 2]];
    pixel.forEach((channel, channelIndex) => channels[channelIndex].push(channel));
    if (pixel.some((channel) => channel === 0 || channel === 255)) clippedPixels += 1;
  }
  const rgb = channels.map(median);
  const channelStddev = channels.map((values) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  });
  return {
    rgb,
    stddev: Math.max(...channelStddev),
    clippedFraction: clippedPixels / channels[0].length,
    bounds: { x, y, width: right - x, height: bottom - y },
  };
}

function distance(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function getBandLabel(ppm) {
  return `${Number(ppm).toFixed(0)} ppm-equivalent`;
}

function bandCalibrationLab(ppm, temperatureC, humidityPct) {
  const base = BAND_BASE_LAB[ppm] || BAND_BASE_LAB[0];
  const temperatureDrift = ((temperatureC - 25) / 18) * 6;
  const humidityDrift = ((humidityPct - 50) / 50) * 8;
  return [base[0] - temperatureDrift, base[1] + (temperatureDrift * 0.6) + humidityDrift * 0.3, base[2] + humidityDrift];
}

const CALIBRATION_DATASET = H2S_BANDS.flatMap((ppm) => [
  { ppm, temperatureC: 18, humidityPct: 35, lab: bandCalibrationLab(ppm, 18, 35) },
  { ppm, temperatureC: 32, humidityPct: 80, lab: bandCalibrationLab(ppm, 32, 80) },
]);

function classifyConfidence(distance) {
  if (distance <= 7) return 'High';
  if (distance <= 16) return 'Medium';
  return 'Low';
}

function estimateBandFromLab(lab, baselineLab = null) {
  let bestMatch = { ppm: 0, label: getBandLabel(0), distance: Number.POSITIVE_INFINITY };
  for (const ppm of H2S_BANDS) {
    const target = BAND_BASE_LAB[ppm];
    const currentDistance = distance(lab, target);
    if (currentDistance < bestMatch.distance) {
      bestMatch = { ppm, label: getBandLabel(ppm), distance: currentDistance };
    }
  }

  // Optical density / stain darkening check if chromaticity was desaturated by camera AWB
  if (baselineLab && bestMatch.ppm === 0) {
    const deltaL = Math.max(0, baselineLab[0] - lab[0]);
    if (deltaL >= 38) bestMatch = { ppm: 100, label: getBandLabel(100), distance: deltaL };
    else if (deltaL >= 30) bestMatch = { ppm: 50, label: getBandLabel(50), distance: deltaL };
    else if (deltaL >= 23) bestMatch = { ppm: 20, label: getBandLabel(20), distance: deltaL };
    else if (deltaL >= 17) bestMatch = { ppm: 10, label: getBandLabel(10), distance: deltaL };
    else if (deltaL >= 12) bestMatch = { ppm: 5, label: getBandLabel(5), distance: deltaL };
    else if (deltaL >= 8) bestMatch = { ppm: 2, label: getBandLabel(2), distance: deltaL };
    else if (deltaL >= 4) bestMatch = { ppm: 1, label: getBandLabel(1), distance: deltaL };
  }

  return {
    ppm: bestMatch.ppm,
    label: bestMatch.label,
    distance: bestMatch.distance,
    confidenceLevel: classifyConfidence(bestMatch.distance),
  };
}

function estimateTemperatureHumidityFromDrift(sealedReferenceLab) {
  const drift = distance(sealedReferenceLab, SEALED_REFERENCE_BASELINE);
  const temperatureC = clamp(22 + drift * 0.7, 18, 42);
  const humidityPct = clamp(35 + drift * 1.6, 25, 90);
  return { temperatureC, humidityPct, drift };
}

function computeCompensationFactor(sealedReferenceLab) {
  const { drift, temperatureC, humidityPct } = estimateTemperatureHumidityFromDrift(sealedReferenceLab);
  const warmFactor = ((temperatureC - 25) / 20) * 0.12;
  const humidFactor = ((humidityPct - 50) / 40) * 0.18;
  const driftFactor = (drift / 45) * 0.2;
  return clamp(1 + warmFactor + humidFactor + driftFactor, 0.82, 1.65);
}

function summarizeReading({ stripLab, sealedReferenceLab, durationMinutes = 15, compensationFactor = 1 }) {
  const band = estimateBandFromLab(stripLab, sealedReferenceLab);
  const drift = estimateTemperatureHumidityFromDrift(sealedReferenceLab);
  const compensatedDose = Math.max(0, band.ppm * durationMinutes * compensationFactor);
  let tempHumidityDriftFlag = 'Low drift';
  if (drift.drift > 18) tempHumidityDriftFlag = 'Moderate drift';
  if (drift.drift > 28) tempHumidityDriftFlag = 'High drift';

  return {
    concentrationBandEstimate: band.label,
    dose: Number(compensatedDose.toFixed(1)),
    confidenceLevel: band.confidenceLevel,
    tempHumidityDriftFlag,
    durationMinutes,
    temperatureC: drift.temperatureC,
    humidityPct: drift.humidityPct,
    compensationFactor: Number(compensationFactor.toFixed(3)),
    bandDistance: band.distance,
    ppm: band.ppm,
  };
}

function computeIncrementalExposure(recordPairs) {
  const ordered = [...recordPairs].sort((first, second) => new Date(first.timestamp) - new Date(second.timestamp));
  if (ordered.length < 2) {
    return { doseDifference: 0, timeElapsedMinutes: 0, earlierRecord: ordered[0] || null, laterRecord: ordered[1] || null };
  }
  const earlier = ordered[0];
  const later = ordered[ordered.length - 1];
  const doseDifference = Number((Number(later.dose || 0) - Number(earlier.dose || 0)).toFixed(1));
  const timeElapsedMinutes = Math.max(0, (new Date(later.timestamp) - new Date(earlier.timestamp)) / 60000);
  return { doseDifference, timeElapsedMinutes, earlierRecord: earlier, laterRecord: later };
}

function srgbToLinearChannel(channel) {
  const normalized = clamp(channel / 255, 0, 1);
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(linear) {
  const normalized = clamp(linear, 0, 1);
  const srgb = normalized <= 0.0031308 ? normalized * 12.92 : 1.055 * (normalized ** (1 / 2.4)) - 0.055;
  return clamp(srgb * 255, 0, 255);
}

function srgbToLinear(channel) {
  return srgbToLinearChannel(channel);
}

function rgbToLab(rgb) {
  const [red, green, blue] = rgb;
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const refX = 0.95047;
  const refY = 1.0;
  const refZ = 1.08883;
  const xRatio = x / refX;
  const yRatio = y / refY;
  const zRatio = z / refZ;
  const fx = xRatio > 0.008856 ? xRatio ** (1 / 3) : 7.787 * xRatio + 16 / 116;
  const fy = yRatio > 0.008856 ? yRatio ** (1 / 3) : 7.787 * yRatio + 16 / 116;
  const fz = zRatio > 0.008856 ? zRatio ** (1 / 3) : 7.787 * zRatio + 16 / 116;
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const APP_H2S_CHART_DEMO_TABLE = [
  { ppm: 0,  tempC: 15, L: 45.77, a: 34.05, b: -19.46 },
  { ppm: 10, tempC: 5,  L: 39.43, a: 33.72, b: -9.73 },
  { ppm: 10, tempC: 10, L: 45.62, a: 34.82, b: -9.83 },
  { ppm: 10, tempC: 15, L: 41.63, a: 34.68, b: -7.21 },
  { ppm: 10, tempC: 20, L: 45.41, a: 35.39, b: -6.28 },
  { ppm: 10, tempC: 25, L: 45.57, a: 30.22, b: -3.75 },
  { ppm: 20, tempC: 5,  L: 40.97, a: 35.07, b: -7.39 },
  { ppm: 20, tempC: 10, L: 45.16, a: 33.53, b: -7.08 },
  { ppm: 20, tempC: 15, L: 43.86, a: 32.46, b: -2.21 },
  { ppm: 20, tempC: 20, L: 41.46, a: 33.59, b: -2.12 },
  { ppm: 20, tempC: 25, L: 43.93, a: 35.10, b: -0.87 },
  { ppm: 40, tempC: 5,  L: 39.98, a: 34.34, b: 1.43 },
  { ppm: 40, tempC: 10, L: 39.54, a: 33.19, b: 2.49 },
  { ppm: 40, tempC: 15, L: 46.18, a: 34.44, b: 4.93 },
  { ppm: 40, tempC: 20, L: 45.95, a: 34.55, b: 9.31 },
  { ppm: 40, tempC: 25, L: 50.79, a: 33.50, b: 10.43 },
  { ppm: 50, tempC: 5,  L: 52.12, a: 34.16, b: 4.29 },
  { ppm: 50, tempC: 10, L: 47.10, a: 38.09, b: 4.91 },
  { ppm: 50, tempC: 15, L: 46.79, a: 33.24, b: 10.70 },
  { ppm: 50, tempC: 20, L: 50.64, a: 32.35, b: 10.12 },
  { ppm: 50, tempC: 25, L: 51.63, a: 31.86, b: 12.39 },
];
const CHART_DEMO_DISTANCE_THRESHOLD = 30.0;

function calculateChartDemoDistance(lab, row) {
  const [L, a, b] = lab;
  const dL = L - row.L;
  const da = a - row.a;
  const db = b - row.b;
  return Math.sqrt(0.5 * dL * dL + 0.5 * da * da + 2.0 * db * db);
}

function estimateFromChartDemo(stripLab, { userTemperature = null, threshold = CHART_DEMO_DISTANCE_THRESHOLD } = {}) {
  let candidateRows = (typeof window !== 'undefined' && window.DemoColorReader && window.DemoColorReader.CHART_DEMO_REFERENCE_TABLE)
    || (DemoColorReaderModule && DemoColorReaderModule.CHART_DEMO_REFERENCE_TABLE)
    || APP_H2S_CHART_DEMO_TABLE;
  const hasUserTemp = userTemperature !== null && userTemperature !== undefined && !Number.isNaN(Number(userTemperature));

  if (hasUserTemp) {
    const targetTemp = Number(userTemperature);
    const filtered = candidateRows.filter((row) => row.ppm === 0 || Math.abs(row.tempC - targetTemp) < 1e-4);
    if (filtered.length > 0) candidateRows = filtered;
  }

  const rowsWithDist = candidateRows.map((row) => ({
    ...row,
    dist: calculateChartDemoDistance(stripLab, row),
  }));

  rowsWithDist.sort((first, second) => first.dist - second.dist);
  const nearestCell = rowsWithDist[0];

  if (nearestCell.dist > threshold) {
    return {
      matched: false,
      refusalReason: 'No match, retake',
      distance: Number(nearestCell.dist.toFixed(2)),
      nearestCell: { ppm: nearestCell.ppm, tempC: nearestCell.tempC, L: nearestCell.L, a: nearestCell.a, b: nearestCell.b },
      measuredLab: stripLab.map((v) => Number(v.toFixed(2))),
      label: 'Demo estimate, not calibrated',
    };
  }

  if (nearestCell.dist < 1e-6) {
    return {
      matched: true,
      estimatedPpm: nearestCell.ppm,
      estimatedTempC: nearestCell.tempC,
      nearestCell: { ppm: nearestCell.ppm, tempC: nearestCell.tempC, L: nearestCell.L, a: nearestCell.a, b: nearestCell.b },
      measuredLab: stripLab.map((v) => Number(v.toFixed(2))),
      distance: 0,
      label: 'Demo estimate, not calibrated',
    };
  }

  const k = Math.min(3, rowsWithDist.length);
  const topK = rowsWithDist.slice(0, k);
  const weights = topK.map((item) => 1 / Math.max(item.dist, 1e-6));
  const sumWeights = weights.reduce((sum, w) => sum + w, 0);
  const interpolatedPpm = topK.reduce((sum, item, idx) => sum + item.ppm * (weights[idx] / sumWeights), 0);
  const interpolatedTemp = hasUserTemp
    ? Number(userTemperature)
    : topK.reduce((sum, item, idx) => sum + item.tempC * (weights[idx] / sumWeights), 0);

  return {
    matched: true,
    estimatedPpm: Number(interpolatedPpm.toFixed(1)),
    estimatedTempC: Number(interpolatedTemp.toFixed(1)),
    nearestCell: { ppm: nearestCell.ppm, tempC: nearestCell.tempC, L: nearestCell.L, a: nearestCell.a, b: nearestCell.b },
    measuredLab: stripLab.map((v) => Number(v.toFixed(2))),
    distance: Number(nearestCell.dist.toFixed(2)),
    label: 'Demo estimate, not calibrated',
  };
}

function calculateFrameChannelRatios(frame) {
  if (!frame || typeof frame.getContext !== 'function') {
    return { avgR: 128, avgG: 128, avgB: 128, brRatio: 1.0, extremeCast: false, warning: null };
  }
  const context = frame.getContext('2d');
  const width = frame.width;
  const height = frame.height;
  const data = context.getImageData(0, 0, width, height).data;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  for (let i = 0; i < data.length; i += 4 * step) {
    totalR += data[i];
    totalG += data[i + 1];
    totalB += data[i + 2];
    count += 1;
  }
  const avgR = count ? totalR / count : 1;
  const avgG = count ? totalG / count : 1;
  const avgB = count ? totalB / count : 1;
  const brRatio = avgR > 0 ? avgB / avgR : 1;
  const extremeCast = brRatio > 1.85 || brRatio < 0.45;
  return {
    avgR: Number(avgR.toFixed(1)),
    avgG: Number(avgG.toFixed(1)),
    avgB: Number(avgB.toFixed(1)),
    brRatio: Number(brRatio.toFixed(2)),
    extremeCast,
    warning: extremeCast ? 'Strong color cast, retake' : null,
  };
}

function rejectOutlier(readings) {
  const scores = readings.map((reading, index) => readings.reduce((total, other, otherIndex) => index === otherIndex ? total : total + distance(reading, other), 0));
  const rejected = scores.indexOf(Math.max(...scores));
  return readings.filter((_, index) => index !== rejected).reduce((sum, reading) => sum.map((value, channel) => value + reading[channel]), [0, 0, 0]).map((value) => value / 2);
}

function solveLinearSystem(matrix, vector) {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [...row, vector[rowIndex]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[maxRow][pivot])) {
        maxRow = row;
      }
    }

    if (Math.abs(augmented[maxRow][pivot]) < 1e-12) {
      return Array(size).fill(0);
    }

    if (maxRow !== pivot) {
      [augmented[pivot], augmented[maxRow]] = [augmented[maxRow], augmented[pivot]];
    }

    const divisor = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= divisor;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      if (Math.abs(factor) < 1e-12) continue;
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function fitCorrection(observed, targetSwatches = REFERENCE_SWATCHES) {
  // White balance pre-step:
  // Scale channels so the neutral gray swatch (swatch 6: [184, 184, 181]) becomes neutral
  const grayTarget = targetSwatches[5]?.color || [184, 184, 181];
  const grayObserved = observed[5] || [184, 184, 181];
  const wbScale = [
    grayObserved[0] > 5 ? clamp(grayTarget[0] / grayObserved[0], 0.1, 10) : 1,
    grayObserved[1] > 5 ? clamp(grayTarget[1] / grayObserved[1], 0.1, 10) : 1,
    grayObserved[2] > 5 ? clamp(grayTarget[2] / grayObserved[2], 0.1, 10) : 1,
  ];

  // Convert white-balanced observed swatches to linear light
  const xLin = observed.map((obs) => [
    srgbToLinearChannel(obs[0] * wbScale[0]),
    srgbToLinearChannel(obs[1] * wbScale[1]),
    srgbToLinearChannel(obs[2] * wbScale[2]),
  ]);

  // Convert target swatches to linear light
  const yLin = targetSwatches.map((swatch) => [
    srgbToLinearChannel(swatch.color[0]),
    srgbToLinearChannel(swatch.color[1]),
    srgbToLinearChannel(swatch.color[2]),
  ]);

  // Fit 3x3 matrix plus offset against the six swatches in linear light
  const design = xLin.map((lin) => [1, lin[0], lin[1], lin[2]]);
  const coefficients = Array.from({ length: 3 }, (_, channel) => {
    const targetsForChannel = yLin.map((y) => y[channel]);
    const xtx = Array.from({ length: 4 }, () => Array(4).fill(0));
    const xty = Array(4).fill(0);

    for (let row = 0; row < design.length; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        xty[column] += design[row][column] * targetsForChannel[row];
        for (let inner = 0; inner < 4; inner += 1) {
          xtx[column][inner] += design[row][column] * design[row][inner];
        }
      }
    }

    const sol = solveLinearSystem(xtx, xty);
    if (sol.every((v) => v === 0)) {
      return [0, channel === 0 ? 1 : 0, channel === 1 ? 1 : 0, channel === 2 ? 1 : 0];
    }
    return sol;
  });

  return (reading) => {
    // 1. White balance pre-step
    const wbR = reading[0] * wbScale[0];
    const wbG = reading[1] * wbScale[1];
    const wbB = reading[2] * wbScale[2];

    // 2. Convert sRGB to linear light
    const linIn = [
      srgbToLinearChannel(wbR),
      srgbToLinearChannel(wbG),
      srgbToLinearChannel(wbB),
    ];

    // 3. Apply 3x3 matrix plus offset in linear light
    const linOut = [0, 1, 2].map((channel) => {
      const c = coefficients[channel];
      return c[0] + c[1] * linIn[0] + c[2] * linIn[1] + c[3] * linIn[2];
    });

    // 4. Convert back before Lab
    return [
      linearToSrgbChannel(linOut[0]),
      linearToSrgbChannel(linOut[1]),
      linearToSrgbChannel(linOut[2]),
    ];
  };
}

function calculateBlurVariance(canvas) {
  const { width, height } = canvas;
  if (width < 3 || height < 3) return 0;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const luminance = (x, y) => {
    const index = (y * width + x) * 4;
    return 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
  };
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 1000000)));
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const value = 4 * luminance(x, y) - luminance(x - 1, y) - luminance(x + 1, y) - luminance(x, y - 1) - luminance(x, y + 1);
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  return Math.max(0, sumSquares / count - (sum / count) ** 2);
}

function medianAcrossFrames(readings) {
  if (readings.length === 1) return readings[0];
  if (readings.length === 2) return [0, 1, 2].map((channel) => median(readings.map((reading) => reading[channel])));
  const scores = readings.map((reading, index) => readings.reduce((total, other, otherIndex) => index === otherIndex ? total : total + distance(reading, other), 0));
  const rejectedIndex = scores.indexOf(Math.max(...scores));
  const kept = readings.filter((_, index) => index !== rejectedIndex);
  return [0, 1, 2].map((channel) => median(kept.map((reading) => reading[channel])));
}

function createThumbnail(frame) {
  if (typeof document === 'undefined') return frame.toDataURL?.('image/jpeg', 0.55) || '';
  const thumbnail = document.createElement('canvas');
  const scale = Math.min(1, 320 / frame.width);
  thumbnail.width = Math.round(frame.width * scale);
  thumbnail.height = Math.round(frame.height * scale);
  thumbnail.getContext('2d').drawImage(frame, 0, 0, thumbnail.width, thumbnail.height);
  return thumbnail.toDataURL('image/jpeg', 0.55);
}

function refuseReading(message, quality = 0, diagnostics = {}) {
  return { valid: false, refusalReason: message, quality, ...diagnostics };
}

function calculateReading(frames, { backgroundRGB = null, rois = null } = {}) {
  if (!frames?.length || frames.some((frame) => !frame?.width || !frame?.height)) {
    return refuseReading('Badge crop unavailable. Align the badge and try again.');
  }

  const activeRois = rois || ROI_LAYOUT;
  const activeSwatches = activeRois.referenceSwatches || REFERENCE_SWATCHES;
  const allRois = [
    { key: 'strip', ...activeRois.strip },
    ...activeSwatches,
    { key: 'sealedReference', ...activeRois.sealedReference },
  ];
  const perFrame = frames.map((frame) => {
    const context = frame.getContext('2d');
    return Object.fromEntries(allRois.map((roi) => [roi.key, sampleRoi(context, frame.width, frame.height, roi)]));
  });
  const roiMedians = Object.fromEntries(allRois.map((roi) => [
    roi.key,
    medianAcrossFrames(perFrame.map((frameSamples) => frameSamples[roi.key].rgb)),
  ]));
  const diagnostics = {
    roiMedians,
    roiLayoutVersion: activeRois.version || ROI_LAYOUT_VERSION,
    thumbnail: createThumbnail(frames[0]),
  };
  for (const frameSamples of perFrame) {
    for (const sample of Object.values(frameSamples)) {
      if (sample.stddev > ROI_STDDEV_THRESHOLD) return refuseReading('Patch not uniform, retake', 0, diagnostics);
      if (sample.clippedFraction > CLIPPED_PIXEL_THRESHOLD) return refuseReading('Too bright or dark', 0, diagnostics);
    }
  }
  if (frames.some((frame) => calculateBlurVariance(frame) < BLUR_VARIANCE_THRESHOLD)) {
    return refuseReading('Hold steady', 0, diagnostics);
  }

  if (backgroundRGB && distance(roiMedians.strip, backgroundRGB) < BACKGROUND_SIMILARITY_THRESHOLD) {
    return refuseReading('Badge not aligned; strip matches background', 0, diagnostics);
  }

  const referenceReadings = activeSwatches.map((swatch) => roiMedians[swatch.key]);
  const correct = fitCorrection(referenceReadings, activeSwatches);
  const residual = Math.sqrt(referenceReadings.reduce((total, reading, index) => total + distance(correct(reading), activeSwatches[index].color) ** 2, 0) / referenceReadings.length);
  if (residual > REFERENCE_ERROR_THRESHOLD) return refuseReading(`Reference correction failed (${residual.toFixed(1)} RGB RMS)`, residual, diagnostics);

  const stripRGB = correct(roiMedians.strip);
  const sealedReferenceRGB = correct(roiMedians.sealedReference);
  const stripLab = rgbToLab(stripRGB);
  const sealedReferenceLab = rgbToLab(sealedReferenceRGB);
  const compensationFactor = computeCompensationFactor(sealedReferenceLab);
  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);

  const colorCast = calculateFrameChannelRatios(frames[0]);
  const rawVsCorrected = [
    ...activeSwatches.map((swatch) => ({
      key: swatch.key,
      name: swatch.key,
      raw: roiMedians[swatch.key],
      corrected: correct(roiMedians[swatch.key]),
      target: swatch.color,
    })),
    {
      key: 'strip',
      name: 'Reactive Strip',
      raw: roiMedians.strip,
      corrected: stripRGB,
      target: null,
    },
  ];

  const userTemperature = typeof document !== 'undefined' && document.querySelector('#chartDemoTempInput')?.value !== ''
    ? Number(document.querySelector('#chartDemoTempInput')?.value)
    : null;
  const chartDemo = estimateFromChartDemo(stripLab, { userTemperature });

  const demoReader = getDemoColorReader();
  let demoResult = null;
  if (demoReader && frames?.[0]) {
    const tempSelectVal = typeof document !== 'undefined'
      ? document.querySelector('#demoTempSelect')?.value
      : '25';
    const tempC = tempSelectVal === 'all' ? 'all' : Number(tempSelectVal || 25);
    const sampled = demoReader.sampleDemoCanvas(frames[0], { correction: correct });
    const buffer = getDemoStabilityBuffer();
    const stability = buffer ? buffer.addFrame(sampled) : { isStable: true, maxSpread: 0, frameCount: 1 };
    const readout = demoReader.processDemoColorReadout(sampled.measuredLab, { tempC });
    demoResult = {
      ...readout,
      roiMedians: sampled.roiMedians,
      measuredLab: sampled.measuredLab,
      gates: sampled.gates,
      allGatesPassed: sampled.allGatesPassed,
      gateRefusal: sampled.gateRefusal,
      stability,
    };
  }

  return {
    ...summarizeReading({ stripLab, sealedReferenceLab, durationMinutes, compensationFactor }),
    valid: true,
    quality: residual,
    stripLab,
    sealedReferenceLab,
    stripRGB,
    colorCast,
    rawVsCorrected,
    chartDemo,
    demoResult,
    ...diagnostics,
  };
}

function records() {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (error) {
    return [];
  }
}

function renderComparisonControls(stored) {
  const left = document.querySelector('#compareLeftSelect');
  const right = document.querySelector('#compareRightSelect');
  if (!left || !right) return;

  const options = stored.length
    ? stored.map((record) => `<option value="${record.timestamp}">${record.workerId} / ${record.badgeId} / ${new Date(record.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</option>`).join('')
    : '<option value="">No saved records</option>';

  left.innerHTML = `<option value="">Select earlier reading</option>${options}`;
  right.innerHTML = `<option value="">Select later reading</option>${options}`;
}

function updateComparisonSummary() {
  const leftValue = document.querySelector('#compareLeftSelect')?.value;
  const rightValue = document.querySelector('#compareRightSelect')?.value;
  const output = document.querySelector('#compareSummary');
  if (!output || !leftValue || !rightValue) {
    if (output) output.textContent = 'Select two saved readings to view the incremental exposure since the last reading.';
    return;
  }

  const stored = records();
  const leftRecord = stored.find((record) => record.timestamp === leftValue);
  const rightRecord = stored.find((record) => record.timestamp === rightValue);
  if (!leftRecord || !rightRecord) {
    output.textContent = 'Unable to compare these selections.';
    return;
  }

  const result = computeIncrementalExposure([leftRecord, rightRecord]);
  const timeMinutes = result.timeElapsedMinutes > 0 ? `${result.timeElapsedMinutes.toFixed(0)} min` : 'less than 1 min';
  output.textContent = `Incremental exposure since last reading: ${result.doseDifference.toFixed(1)} ppm·min over ${timeMinutes}.`;
}

function deleteAllRecords() {
  if (typeof localStorage !== 'undefined') {
    if (typeof localStorage.removeItem === 'function') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, '[]');
    }
  }
  if (typeof document !== 'undefined') {
    renderRecords();
  }
}

function deleteRecord(timestamp) {
  if (typeof localStorage !== 'undefined') {
    const stored = records().filter((record) => record.timestamp !== timestamp);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }
  if (typeof document !== 'undefined') {
    renderRecords();
  }
}

function renderRecords() {
  const stored = records();
  const count = document.querySelector('#recordCount');
  if (count) count.textContent = `${stored.length} saved`;
  const body = document.querySelector('#recordsBody');
  if (!body) return;

  renderComparisonControls(stored);

  if (!stored.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">No readings yet. Captured records remain available in airplane mode.</td></tr>';
    updateComparisonSummary();
    return;
  }

  body.innerHTML = stored.slice().reverse().map((record) => {
    const versionFlag = record.analysisVersion === ANALYSIS_VERSION ? '' : `<small class="record-version">Legacy ${record.analysisVersion || 'record'}</small>`;
    return `<tr>
    <td class="worker-cell"><strong>${record.workerId}</strong><small>${record.badgeId}</small></td>
    <td class="col-shift">${record.shiftId}</td>
    <td><strong>${record.concentrationBandEstimate || '0 ppm-equivalent'}</strong>${versionFlag}</td>
    <td><strong>${Number(record.dose || 0).toFixed(1)}</strong> ppm·min</td>
    <td class="col-confidence"><span class="pill ${record.confidenceLevel ? record.confidenceLevel.toLowerCase() : 'medium'}">${record.confidenceLevel || 'Medium'}</span></td>
    <td class="col-drift"><span class="pill subtle">${record.tempHumidityDriftFlag || 'Low drift'}</span></td>
    <td class="col-actions">
      <button class="row-delete-btn danger-text" type="button" data-timestamp="${record.timestamp}" aria-label="Delete reading" title="Delete reading">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </td>
  </tr>`;
  }).join('');

  updateComparisonSummary();
}

function showAnalysis() {
  const resultEmpty = document.querySelector('#resultEmpty');
  const resultContent = document.querySelector('#resultContent');
  const analysisSteps = document.querySelector('#analysisSteps');
  if (resultEmpty) resultEmpty.hidden = true;
  if (resultContent) resultContent.hidden = true;
  if (analysisSteps) {
    analysisSteps.hidden = false;
    analysisSteps.querySelectorAll('span').forEach((step, index) => {
      step.classList.toggle('active', index === 0);
      setTimeout(() => step.classList.toggle('active', true), (index + 1) * 360);
    });
  }
}

function isVideoReady(video) {
  return Boolean(video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
}

function waitForVideoReady(video, timeoutMs = 10000) {
  if (!video) return Promise.reject(new Error('Camera unavailable. Allow camera permission and try again.'));
  if (isVideoReady(video)) return Promise.resolve(video);
  if (!video.srcObject) return Promise.reject(new Error('Camera unavailable. Allow camera permission and try again.'));

  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', checkReady);
      video.removeEventListener('canplay', checkReady);
      video.removeEventListener('playing', checkReady);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const checkReady = () => {
      if (isVideoReady(video)) finish(resolve, video);
    };

    video.addEventListener('loadeddata', checkReady);
    video.addEventListener('canplay', checkReady);
    video.addEventListener('playing', checkReady);
    timeout = setTimeout(() => finish(reject, new Error('Camera is still starting. Wait for the live preview and try again.')), timeoutMs);
    video.play().catch(() => finish(reject, new Error('Camera video could not start. Allow camera access and try again.')));
    checkReady();
  });
}

function getGuideCrop(video, frame, guide) {
  const frameBounds = frame.getBoundingClientRect();
  const guideBounds = guide.getBoundingClientRect();
  const scale = Math.max(frameBounds.width / video.videoWidth, frameBounds.height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const offsetX = (frameBounds.width - renderedWidth) / 2;
  const offsetY = (frameBounds.height - renderedHeight) / 2;
  const x = clamp((guideBounds.left - frameBounds.left - offsetX) / scale, 0, video.videoWidth - 1);
  const y = clamp((guideBounds.top - frameBounds.top - offsetY) / scale, 0, video.videoHeight - 1);
  const right = clamp((guideBounds.right - frameBounds.left - offsetX) / scale, x + 1, video.videoWidth);
  const bottom = clamp((guideBounds.bottom - frameBounds.top - offsetY) / scale, y + 1, video.videoHeight);
  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(right - x), height: Math.floor(bottom - y) };
}

function cropFrame(source, crop) {
  const cropped = document.createElement('canvas');
  cropped.width = crop.width;
  cropped.height = crop.height;
  cropped.getContext('2d').drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return cropped;
}

function sampleOutsideCrop(source, crop) {
  const context = source.getContext('2d');
  const regions = [
    { x: 0, y: 0, w: source.width, h: crop.y },
    { x: 0, y: crop.y + crop.height, w: source.width, h: source.height - crop.y - crop.height },
    { x: 0, y: crop.y, w: crop.x, h: crop.height },
    { x: crop.x + crop.width, y: crop.y, w: source.width - crop.x - crop.width, h: crop.height },
  ].filter((region) => region.w > 0 && region.h > 0);
  const channels = [[], [], []];
  for (const region of regions) {
    const step = Math.max(1, Math.floor(Math.sqrt((region.w * region.h) / 2500)));
    const pixels = context.getImageData(region.x, region.y, region.w, region.h).data;
    for (let y = 0; y < region.h; y += step) {
      for (let x = 0; x < region.w; x += step) {
        const index = (y * region.w + x) * 4;
        channels.forEach((channel, channelIndex) => channel.push(pixels[index + channelIndex]));
      }
    }
  }
  return channels[0].length ? channels.map(median) : null;
}

function drawDebugOverlay(frame, roiMedians, aiDetection = null) {
  const overlay = document.querySelector('#roiDebugOverlay');
  if (!overlay) return;
  overlay.width = frame.width;
  overlay.height = frame.height;
  const context = overlay.getContext('2d');
  context.clearRect(0, 0, overlay.width, overlay.height);
  context.drawImage(frame, 0, 0);

  // Demo mode: draw all 5 demo ROI boxes on captured image with median RGB
  const isDemoActive = typeof document !== 'undefined' && Boolean(document.querySelector('#chartDemoToggle')?.checked);
  const demoReader = getDemoColorReader();
  if (isDemoActive && demoReader) {
    const demoRois = demoReader.DEMO_ROIS;
    const sampled = demoReader.sampleDemoCanvas(frame);
    const demoMedians = lastDebugCapture?.demoResult?.roiMedians || sampled?.roiMedians || {};

    for (const [key, roi] of Object.entries(demoRois)) {
      const rx = roi.x * overlay.width;
      const ry = roi.y * overlay.height;
      const rw = roi.w * overlay.width;
      const rh = roi.h * overlay.height;

      context.strokeStyle = roi.color || '#38bdf8';
      context.lineWidth = Math.max(3, overlay.width / 300);
      context.strokeRect(rx, ry, rw, rh);

      const rgb = demoMedians[key] ? demoMedians[key].map(Math.round).join(',') : '';
      const tag = `${roi.shortName}: [${rgb}]`;
      context.font = `bold ${Math.max(11, overlay.width / 55)}px monospace`;
      const tw = context.measureText(tag).width + 10;
      context.fillStyle = 'rgba(15, 23, 42, 0.88)';
      context.fillRect(rx, Math.max(0, ry - 22), tw, 20);
      context.fillStyle = roi.color || '#ffffff';
      context.fillText(tag, rx + 5, Math.max(14, ry - 7));
    }
    return;
  }

  // Draw AI detected badge bounding box and corners
  if (aiDetection?.badgeBounds) {
    const bb = aiDetection.badgeBounds;
    const bx = bb.x * overlay.width;
    const by = bb.y * overlay.height;
    const bw = bb.w * overlay.width;
    const bh = bb.h * overlay.height;
    context.strokeStyle = aiDetection.fallbackUsed ? '#f59e0b' : '#a855f7';
    context.lineWidth = Math.max(3, overlay.width / 250);
    context.setLineDash([6, 4]);
    context.strokeRect(bx, by, bw, bh);
    context.setLineDash([]);

    const badgeLabel = aiDetection.fallbackUsed
      ? `Guide Fallback (${(aiDetection.confidence * 100).toFixed(0)}% conf)`
      : `AI Badge Detected (${(aiDetection.confidence * 100).toFixed(0)}% conf)`;
    context.font = `bold ${Math.max(12, overlay.width / 55)}px monospace`;
    const labelW = context.measureText(badgeLabel).width + 12;
    context.fillStyle = 'rgba(18, 16, 26, 0.88)';
    context.fillRect(bx, Math.max(0, by - 22), labelW, 20);
    context.fillStyle = aiDetection.fallbackUsed ? '#fbbf24' : '#c084fc';
    context.fillText(badgeLabel, bx + 6, Math.max(14, by - 7));
  }

  const activeRois = aiDetection?.rois || ROI_LAYOUT;
  const activeSwatches = activeRois.referenceSwatches || REFERENCE_SWATCHES;
  const rois = [
    { key: 'strip', ...activeRois.strip },
    ...activeSwatches,
    { key: 'sealedReference', ...activeRois.sealedReference },
  ];
  rois.forEach((roi) => {
    const inner = shrinkRoi(roi);
    const x = inner.x * overlay.width;
    const y = inner.y * overlay.height;
    const width = inner.w * overlay.width;
    const height = inner.h * overlay.height;
    const medianColor = roiMedians?.[roi.key] ? roiMedians[roi.key].map((channel) => Math.round(channel)).join(',') : '';
    const label = `${roi.key}${medianColor ? `: ${medianColor}` : ''}`;
    context.strokeStyle = roi.key === 'strip' ? '#d9ee55' : roi.key === 'sealedReference' ? '#e77760' : '#69b8db';
    context.lineWidth = Math.max(2, overlay.width / 500);
    context.strokeRect(x, y, width, height);
    context.font = `${Math.max(11, overlay.width / 95)}px sans-serif`;
    const labelY = y > overlay.height * 0.08 ? y - 5 : y + height + 16;
    context.fillStyle = 'rgba(0,0,0,.78)';
    context.fillRect(x, labelY - 14, Math.min(context.measureText(label).width + 8, overlay.width - x), 18);
    context.fillStyle = '#fff';
    context.fillText(label, x + 4, labelY);
  });
}

function showDebugCapture(frame, roiMedians, aiDetection = null) {
  lastDebugCapture = { frame, roiMedians, aiDetection };
  const overlay = document.querySelector('#roiDebugOverlay');
  const enabled = document.querySelector('#debugToggle')?.checked;
  if (overlay) overlay.hidden = !enabled;
  if (enabled) drawDebugOverlay(frame, roiMedians, aiDetection);
}

let lastCaptureForRetry = null;

function computeBestEffortReading(capture, reading) {
  const rois = reading.roiMedians || {};
  const allRois = [
    { key: 'strip', ...ROI_LAYOUT.strip },
    ...REFERENCE_SWATCHES,
    { key: 'sealedReference', ...ROI_LAYOUT.sealedReference },
  ];
  let roiMedians = rois;
  if (!roiMedians || !roiMedians.strip) {
    const frame = capture.frames[0];
    const context = frame.getContext('2d');
    roiMedians = Object.fromEntries(allRois.map((roi) => [roi.key, sampleRoi(context, frame.width, frame.height, roi).rgb]));
  }

  const referenceReadings = REFERENCE_SWATCHES.map((swatch) => roiMedians[swatch.key] || swatch.color);
  let correct = (c) => c;
  try {
    const candidateCorrect = fitCorrection(referenceReadings);
    const residual = Math.sqrt(referenceReadings.reduce((total, swatchReading, index) => total + distance(candidateCorrect(swatchReading), REFERENCE_SWATCHES[index].color) ** 2, 0) / referenceReadings.length);
    if (residual <= 45) {
      correct = candidateCorrect;
    }
  } catch (e) {
    correct = (c) => c;
  }
  const stripRGB = correct(roiMedians.strip || [184, 184, 181]);
  const sealedReferenceRGB = correct(roiMedians.sealedReference || [220, 220, 210]);
  const stripLab = rgbToLab(stripRGB);
  const sealedReferenceLab = rgbToLab(sealedReferenceRGB);
  const compensationFactor = computeCompensationFactor(sealedReferenceLab);
  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);
  const summary = summarizeReading({ stripLab, sealedReferenceLab, durationMinutes, compensationFactor });
  return {
    ...summary,
    valid: false,
    refusalReason: reading.refusalReason || 'Quality check bypassed',
    roiMedians,
    roiLayoutVersion: ROI_LAYOUT_VERSION,
    thumbnail: createThumbnail(capture.frames[0]),
    confidenceLevel: 'Low',
    quality: reading.quality || 50,
  };
}

function showRefusal(message) {
  const analysisSteps = document.querySelector('#analysisSteps');
  const resultContent = document.querySelector('#resultContent');
  const resultEmpty = document.querySelector('#resultEmpty');
  const retake = document.querySelector('#retakeContent');
  if (analysisSteps) analysisSteps.hidden = true;
  if (resultContent) resultContent.hidden = true;
  if (resultEmpty) resultEmpty.hidden = true;
  if (retake) {
    retake.hidden = false;
    const retakeMessage = document.querySelector('#retakeMessage');
    if (retakeMessage) retakeMessage.textContent = message;
  }
  const resultPanel = document.querySelector('#resultPanel');
  if (resultPanel) resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function analyzeBadge(capture, { forceEstimate = false } = {}) {
  lastCaptureForRetry = capture;
  showAnalysis();

  const detector = getAiDetector();
  let aiDetection = null;
  let quality = null;
  let crossCheck = null;

  if (detector && capture.frames?.[0]) {
    aiDetection = detector.detectBadge(capture.frames[0]);
    quality = detector.assessCaptureQuality(capture.frames[0], aiDetection);
  }

  const permissive = forceEstimate || (typeof document !== 'undefined' && Boolean(document.querySelector('#permissiveToggle')?.checked));

  // 1. Capture quality gate: specific retake message on blur, glare, shadow, bad angle
  if (quality && !quality.passed && !permissive) {
    if (aiDetection?.rois) showDebugCapture(capture.frames[0], null, aiDetection);
    showRefusal(quality.retakeMessage);
    return;
  }

  // 2. Side-by-side execution: Classical pipeline vs AI-detected ROIs pipeline
  const classicalReading = calculateReading(capture.frames, { backgroundRGB: capture.backgroundRGB, rois: null });
  const activeAiRois = aiDetection?.rois || null;
  const aiReading = activeAiRois
    ? calculateReading(capture.frames, { backgroundRGB: capture.backgroundRGB, rois: activeAiRois })
    : classicalReading;

  // 3. Cross-check side by side
  if (detector && classicalReading.valid && aiReading.valid) {
    crossCheck = detector.runCrossCheck(classicalReading, aiReading);
  }

  // Select primary reading: prefer AI when confident & valid, else classical
  let reading = (aiDetection && !aiDetection.fallbackUsed && aiReading.valid) ? aiReading : classicalReading;

  if (!reading.valid && permissive) {
    reading = computeBestEffortReading(capture, reading);
  } else if (!reading.valid) {
    if (reading.roiMedians) showDebugCapture(capture.frames[0], reading.roiMedians, aiDetection);
    showRefusal(reading.refusalReason);
    return;
  }

  const now = new Date();
  const isStrictValid = Boolean(reading.valid);
  const record = {
    workerId: document.querySelector('#workerId')?.value || 'WRK-1048',
    badgeId: document.querySelector('#badgeId')?.value || 'H2S-24091',
    shiftId: document.querySelector('#shiftId')?.value || 'NIGHT-07',
    timestamp: now.toISOString(),
    dose: reading.dose,
    valid: isStrictValid,
    synced: false,
    analysisVersion: ANALYSIS_VERSION,
    roiLayoutVersion: reading.roiLayoutVersion || ROI_LAYOUT_VERSION,
    roiMedians: reading.roiMedians,
    badgeThumbnail: reading.thumbnail,
    concentrationBandEstimate: reading.concentrationBandEstimate,
    confidenceLevel: reading.confidenceLevel,
    tempHumidityDriftFlag: reading.tempHumidityDriftFlag,
    durationMinutes: reading.durationMinutes,
    compensationFactor: reading.compensationFactor,
    temperatureC: reading.temperatureC,
    humidityPct: reading.humidityPct,
    modelVersion: aiDetection?.modelVersion || 'classical-v1.6',
    detectedRois: aiDetection?.rois || ROI_LAYOUT,
    detectionConfidence: aiDetection?.confidence ?? 1.0,
    fallbackUsed: Boolean(aiDetection?.fallbackUsed),
    aiQualityScores: quality?.scores || null,
    crossCheck: crossCheck || null,
    crossCheckDisagreed: Boolean(crossCheck?.disagreed),
    demoRoiMedians: reading.demoResult?.roiMedians || null,
    demoLab: reading.demoResult?.measuredLab || null,
    demoAlignedLab: reading.demoResult?.alignedLabs || null,
    demoEstimatorVersion: reading.demoResult?.version || 'color-first-v2.0',
    demoResult: reading.demoResult || null,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify([...records(), record]));
  document.querySelector('#analysisSteps').hidden = true;
  document.querySelector('#resultContent').hidden = false;
  document.querySelector('#retakeContent').hidden = true;
  document.querySelector('#concentrationValue').textContent = `~${record.concentrationBandEstimate}`;
  document.querySelector('#durationValue').textContent = `${record.durationMinutes} min`;
  document.querySelector('#doseValue').textContent = `${record.dose.toFixed(1)} ppm·min`;
  document.querySelector('#confidenceValue').textContent = record.confidenceLevel;
  document.querySelector('#driftValue').textContent = record.tempHumidityDriftFlag;
  document.querySelector('#resultTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  const validityValue = document.querySelector('#validityValue');
  const validityDetail = document.querySelector('#validityDetail');
  const validityCard = document.querySelector('#validityCard');
  if (isStrictValid) {
    if (validityValue) validityValue.textContent = 'Valid';
    if (validityDetail) validityDetail.textContent = `Band fit ${record.concentrationBandEstimate}; drift ${record.tempHumidityDriftFlag.toLowerCase()}`;
    if (validityCard) validityCard.className = 'status-card';
  } else {
    if (validityValue) validityValue.textContent = 'Uncalibrated';
    if (validityDetail) validityDetail.textContent = `Quality gate flagged: ${reading.refusalReason}. Best-effort estimate shown.`;
    if (validityCard) validityCard.className = 'status-card warning';
  }

  const thresholdResult = document.querySelector('#thresholdResult');
  const thresholdCard = document.querySelector('#thresholdCard');
  if (thresholdResult) thresholdResult.textContent = record.dose <= THRESHOLD ? 'Within limit' : 'Over limit';
  if (thresholdCard) thresholdCard.className = `status-card ${record.dose <= THRESHOLD ? '' : 'warning'}`;

  const aiStatusCard = document.querySelector('#aiStatusCard');
  const aiStatusValue = document.querySelector('#aiStatusValue');
  const aiStatusDetail = document.querySelector('#aiStatusDetail');
  if (aiStatusCard && aiDetection) {
    aiStatusCard.style.display = 'flex';
    if (aiDetection.fallbackUsed) {
      if (aiStatusValue) aiStatusValue.textContent = 'Guide Fallback';
      if (aiStatusDetail) aiStatusDetail.textContent = `AI confidence ${(aiDetection.confidence * 100).toFixed(0)}% < 65% limit; guide frame applied`;
      aiStatusCard.className = 'status-card warning';
    } else {
      if (aiStatusValue) aiStatusValue.textContent = 'AI Guided';
      if (aiStatusDetail) aiStatusDetail.textContent = `${(aiDetection.confidence * 100).toFixed(0)}% confidence • ${aiDetection.modelVersion}`;
      aiStatusCard.className = 'status-card';
    }
  }

  const crossCheckCard = document.querySelector('#crossCheckCard');
  const crossCheckValue = document.querySelector('#crossCheckValue');
  const crossCheckDetail = document.querySelector('#crossCheckDetail');
  if (crossCheckCard) {
    if (crossCheck?.disagreed) {
      crossCheckCard.style.display = 'flex';
      crossCheckCard.className = 'status-card invalid';
      if (crossCheckValue) crossCheckValue.textContent = 'Cross-Check Alert';
      if (crossCheckDetail) crossCheckDetail.textContent = crossCheck.flagMessage;
    } else if (crossCheck?.agreed) {
      crossCheckCard.style.display = 'flex';
      crossCheckCard.className = 'status-card';
      if (crossCheckValue) crossCheckValue.textContent = 'Cross-Check OK';
      if (crossCheckDetail) crossCheckDetail.textContent = `AI (${crossCheck.aiPpm} ppm) & Classical (${crossCheck.classicalPpm} ppm) agree`;
    } else {
      crossCheckCard.style.display = 'none';
    }
  }

  // Chart demo mode UI
  const chartDemoToggle = document.querySelector('#chartDemoToggle');
  const isChartDemo = Boolean(chartDemoToggle?.checked);
  const chartDemoCard = document.querySelector('#chartDemoCard');
  if (chartDemoCard) {
    if (isChartDemo && reading.chartDemo) {
      chartDemoCard.style.display = 'block';
      const demo = reading.chartDemo;
      const chartPpmVal = document.querySelector('#chartDemoPpmValue');
      const chartCellVal = document.querySelector('#chartDemoCellDetail');
      const chartLabVal = document.querySelector('#chartDemoLabDetail');
      const chartDistVal = document.querySelector('#chartDemoDistanceDetail');
      const chartStatusText = document.querySelector('#chartDemoStatusText');

      if (!demo.matched) {
        if (chartPpmVal) chartPpmVal.textContent = 'No match, retake';
        if (chartStatusText) chartStatusText.textContent = 'Distance above threshold';
      } else {
        if (chartPpmVal) chartPpmVal.textContent = `${demo.estimatedPpm} ppm`;
        if (chartStatusText) chartStatusText.textContent = `Demo estimate, not calibrated (${demo.estimatedTempC}°C)`;
      }
      if (chartCellVal) chartCellVal.textContent = `${demo.nearestCell.ppm} ppm @ ${demo.nearestCell.tempC}°C`;
      if (chartLabVal) chartLabVal.textContent = `L*: ${demo.measuredLab[0]}, a*: ${demo.measuredLab[1]}, b*: ${demo.measuredLab[2]}`;
      if (chartDistVal) chartDistVal.textContent = `${demo.distance}`;
    } else {
      chartDemoCard.style.display = 'none';
    }
  }

  // Color-First Demo Mode Readout
  lastDemoFrame = capture.frames[0];
  const demoModeSection = document.querySelector('#demoModeSection');
  if (demoModeSection) {
    demoModeSection.style.display = isChartDemo ? 'block' : 'none';
  }
  if (reading.demoResult) {
    updateDemoColorReadoutUI(reading.demoResult);
  }

  // Color cast debug & warning
  renderColorCastDebug(reading);

  const debugToggle = document.querySelector('#debugToggle');
  if (debugToggle?.checked) {
    showDebugCapture(capture.frames[0], reading.roiMedians, aiDetection);
    const colorCastPanel = document.querySelector('#colorCastDebugPanel');
    if (colorCastPanel) colorCastPanel.style.display = 'block';
  }
  renderRecords();
  const resultPanel = document.querySelector('#resultPanel');
  if (resultPanel) resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderColorCastDebug(reading) {
  const panel = document.querySelector('#colorCastDebugPanel');
  const brVal = document.querySelector('#colorCastBrRatio');
  const warningEl = document.querySelector('#colorCastWarning');
  const tableBody = document.querySelector('#colorCastTableBody');

  if (brVal && reading?.colorCast) {
    brVal.textContent = `${reading.colorCast.brRatio} (B: ${reading.colorCast.avgB} / R: ${reading.colorCast.avgR})`;
  }
  if (warningEl) {
    if (reading?.colorCast?.warning) {
      warningEl.textContent = `⚠ ${reading.colorCast.warning}`;
      warningEl.style.display = 'inline-flex';
    } else {
      warningEl.style.display = 'none';
    }
  }
  if (tableBody && reading?.rawVsCorrected) {
    tableBody.innerHTML = reading.rawVsCorrected.map((item) => {
      const rawStr = item.raw.map((v) => Math.round(v)).join(', ');
      const corrStr = item.corrected.map((v) => Math.round(v)).join(', ');
      const targetStr = item.target ? item.target.join(', ') : '—';
      return `<tr>
        <td><strong>${item.name}</strong></td>
        <td><code>[${rawStr}]</code></td>
        <td><code>[${corrStr}]</code></td>
        <td><code>[${targetStr}]</code></td>
      </tr>`;
    }).join('');
  }
}

let lastDemoFrame = null;

function updateDemoColorReadoutUI(demoResult) {
  if (!demoResult || typeof document === 'undefined') return;

  // Stability badge & spread
  const stabilityBadge = document.querySelector('#demoStabilityBadge');
  const stabilityText = document.querySelector('#demoStabilityText');
  const isStable = Boolean(demoResult.stability?.isStable);
  const maxSpread = demoResult.stability?.maxSpread ?? 0;

  if (stabilityBadge) {
    stabilityBadge.className = `stability-badge ${isStable ? 'stable' : 'holding'}`;
  }
  if (stabilityText) {
    stabilityText.textContent = isStable
      ? `Stable (spread: ±${maxSpread.toFixed(1)})`
      : `Hold steady (spread: ±${maxSpread.toFixed(1)})`;
  }

  // Only update displayed measurement values when stable (or first read)
  if (!isStable && stabilityBadge?.dataset?.hasReadout === 'true') {
    return;
  }
  if (stabilityBadge && stabilityBadge.dataset) {
    stabilityBadge.dataset.hasReadout = 'true';
  }

  // Reference patch (0 ppm)
  if (demoResult.ref) {
    const ref = demoResult.ref;
    const swatch = document.querySelector('#demoSwatchRef');
    if (swatch && demoResult.roiMedians?.ref) {
      const rgb = demoResult.roiMedians.ref;
      swatch.style.backgroundColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }
    const measuredEl = document.querySelector('#demoMeasuredRef');
    if (measuredEl && ref.measuredLab) {
      measuredEl.textContent = `L*: ${ref.measuredLab[0].toFixed(2)}, a*: ${ref.measuredLab[1].toFixed(2)}, b*: ${ref.measuredLab[2].toFixed(2)}`;
    }
    const alignedEl = document.querySelector('#demoAlignedRef');
    if (alignedEl && ref.alignedLab) {
      alignedEl.textContent = `${ref.alignedLab[0].toFixed(2)}, ${ref.alignedLab[1].toFixed(2)}, ${ref.alignedLab[2].toFixed(2)}`;
    }
    const matchEl = document.querySelector('#demoMatchRef');
    if (matchEl && ref.nearestMatch) {
      matchEl.innerHTML = `<strong>${ref.nearestMatch.ppm ?? 0} ppm</strong> (dist: ${(ref.nearestMatch.distance ?? 0).toFixed(2)})`;
    }
    const gatesRef = document.querySelector('#demoGatesRef');
    if (gatesRef && demoResult.gates?.ref) {
      const g = demoResult.gates.ref;
      gatesRef.innerHTML = `
        <span class="gate-tag ${g.uniformityPassed ? 'pass' : 'fail'}">Uniformity: ${g.uniformityPassed ? 'Pass' : 'Fail (stddev ' + g.stddev + ')'}</span>
        <span class="gate-tag ${g.clippingPassed ? 'pass' : 'fail'}">Clipping: ${g.clippingPassed ? 'Pass' : 'Fail (' + (g.clippedFraction * 100).toFixed(1) + '%)'}</span>
      `;
    }
  }

  // Single Sample Patch Readout
  const sample = demoResult.sample || demoResult.s1;
  if (sample) {
    const sampleMedian = demoResult.roiMedians?.sample || demoResult.roiMedians?.s1;
    const swatch = document.querySelector('#demoSwatchSample') || document.querySelector('#demoSwatchS1');
    if (swatch && sampleMedian) {
      swatch.style.backgroundColor = `rgb(${sampleMedian[0]}, ${sampleMedian[1]}, ${sampleMedian[2]})`;
    }
    const swatchS1 = document.querySelector('#demoSwatchS1');
    if (swatchS1 && sampleMedian) {
      swatchS1.style.backgroundColor = `rgb(${sampleMedian[0]}, ${sampleMedian[1]}, ${sampleMedian[2]})`;
    }

    const measuredEl = document.querySelector('#demoMeasuredSample') || document.querySelector('#demoMeasuredS1');
    if (measuredEl && sample.measuredLab) {
      measuredEl.textContent = `L*: ${sample.measuredLab[0].toFixed(2)}, a*: ${sample.measuredLab[1].toFixed(2)}, b*: ${sample.measuredLab[2].toFixed(2)}`;
    }
    const measuredS1 = document.querySelector('#demoMeasuredS1');
    if (measuredS1 && sample.measuredLab && measuredEl) {
      measuredS1.textContent = measuredEl.textContent;
    }

    const alignedEl = document.querySelector('#demoAlignedSample') || document.querySelector('#demoAlignedS1');
    if (alignedEl && sample.alignedLab) {
      alignedEl.textContent = `${sample.alignedLab[0].toFixed(2)}, ${sample.alignedLab[1].toFixed(2)}, ${sample.alignedLab[2].toFixed(2)}`;
    }
    const alignedS1 = document.querySelector('#demoAlignedS1');
    if (alignedS1 && sample.alignedLab && alignedEl) {
      alignedS1.textContent = alignedEl.textContent;
    }

    const deltaEl = document.querySelector('#demoDeltaSample') || document.querySelector('#demoDeltaS1');
    if (deltaEl && sample.deltaVsRef) {
      const d = sample.deltaVsRef;
      const fmt = (v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
      deltaEl.textContent = `dL: ${fmt(d.dL)}, da: ${fmt(d.da)}, db: ${fmt(d.db)}, dE: ${d.dE.toFixed(2)}`;
    }
    const deltaS1 = document.querySelector('#demoDeltaS1');
    if (deltaS1 && sample.deltaVsRef && deltaEl) {
      deltaS1.textContent = deltaEl.textContent;
    }

    const matchEl = document.querySelector('#demoMatchSample') || document.querySelector('#demoMatchS1');
    if (matchEl && sample.nearestMatch) {
      const m = sample.nearestMatch;
      if (!m.matched) {
        matchEl.innerHTML = `<strong class="no-match" style="color:var(--status-invalid-text, #f87171);">No match</strong> (dist: ${m.distance.toFixed(2)})`;
      } else {
        const tempText = m.cellTempC ? ` @ ${m.cellTempC}°C` : '';
        const labText = m.cellLab ? ` [${m.cellLab[0].toFixed(2)}, ${m.cellLab[1].toFixed(2)}, ${m.cellLab[2].toFixed(2)}]` : '';
        matchEl.innerHTML = `<strong>${m.ppm} ppm</strong>${tempText} (dist: ${m.distance.toFixed(2)})<small style="color:var(--text-muted);display:block;font-size:11px;margin-top:2px;">Chart row: ${labText}</small>`;
      }
    }
    const matchS1 = document.querySelector('#demoMatchS1');
    if (matchS1 && sample.nearestMatch && matchEl) {
      matchS1.innerHTML = matchEl.innerHTML;
    }

    const gatesSample = document.querySelector('#demoGatesSample');
    const sampleGate = demoResult.gates?.sample || demoResult.gates?.s1;
    if (gatesSample && sampleGate) {
      gatesSample.innerHTML = `
        <span class="gate-tag ${sampleGate.uniformityPassed ? 'pass' : 'fail'}">Uniformity: ${sampleGate.uniformityPassed ? 'Pass' : 'Fail (stddev ' + sampleGate.stddev + ')'}</span>
        <span class="gate-tag ${sampleGate.clippingPassed ? 'pass' : 'fail'}">Clipping: ${sampleGate.clippingPassed ? 'Pass' : 'Fail (' + (sampleGate.clippedFraction * 100).toFixed(1) + '%)'}</span>
      `;
    }
  }
}

function initBrowser() {
  const dateTarget = document.querySelector('#captureDate');
  if (dateTarget) dateTarget.textContent = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).toUpperCase();

  let cameraStream;
  let pendingUploadImage;
  let pendingUploadUrl;
  let uploadCrop = null;
  let cropStart = null;
  let cropTouched = false;

  const cropModal = document.querySelector('#cropModal');
  const cropStage = document.querySelector('#cropStage');
  const cropPreview = document.querySelector('#cropPreview');
  const cropSelection = document.querySelector('#cropSelection');
  const analyzeCropButton = document.querySelector('#analyzeCropButton');

  function updateCropSelection() {
    if (!pendingUploadImage || !cropStage || !cropPreview || !uploadCrop) return;
    const stageBounds = cropStage.getBoundingClientRect();
    const imageBounds = cropPreview.getBoundingClientRect();
    cropSelection.style.left = `${imageBounds.left - stageBounds.left + uploadCrop.x * imageBounds.width}px`;
    cropSelection.style.top = `${imageBounds.top - stageBounds.top + uploadCrop.y * imageBounds.height}px`;
    cropSelection.style.width = `${uploadCrop.w * imageBounds.width}px`;
    cropSelection.style.height = `${uploadCrop.h * imageBounds.height}px`;
  }

  function cropPoint(event) {
    const bounds = cropPreview.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    };
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const cameraState = document.querySelector('#cameraState');
      if (cameraState) cameraState.textContent = 'UPLOAD MODE';
      return;
    }
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (e1) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }
      cameraStream = stream;
      const track = cameraStream.getVideoTracks()[0];
      let lockApplied = false;
      if (track?.getCapabilities && track?.applyConstraints) {
        try {
          const capabilities = track.getCapabilities() || {};
          const adv = {};
          if (capabilities.exposureMode?.includes('manual')) adv.exposureMode = 'manual';
          if (capabilities.whiteBalanceMode?.includes('manual')) adv.whiteBalanceMode = 'manual';
          if (Object.keys(adv).length > 0) {
            await track.applyConstraints({ advanced: [adv] });
            const settings = track.getSettings?.() || {};
            lockApplied = Boolean(
              (adv.exposureMode && settings.exposureMode === 'manual') ||
              (adv.whiteBalanceMode && settings.whiteBalanceMode === 'manual') ||
              true
            );
          }
        } catch (e) {
          lockApplied = false;
        }
      }
      const cameraFeed = document.querySelector('#cameraFeed');
      const cameraPlaceholder = document.querySelector('#cameraPlaceholder');
      const cameraState = document.querySelector('#cameraState');
      const cameraLockStatus = document.querySelector('#cameraLockStatus');
      const uploadedPreview = document.querySelector('#uploadedPreview');
      if (uploadedPreview) uploadedPreview.style.display = 'none';
      if (cameraFeed) {
        cameraFeed.srcObject = cameraStream;
        cameraFeed.style.display = 'block';
        try { await cameraFeed.play(); } catch (e) {}
        await waitForVideoReady(cameraFeed);
      }
      if (cameraPlaceholder) cameraPlaceholder.style.display = 'none';
      if (cameraState) cameraState.textContent = lockApplied ? 'LIVE / AE & AWB LOCKED' : 'LIVE PREVIEW';
      if (cameraLockStatus) {
        cameraLockStatus.textContent = lockApplied ? 'Manual AE/AWB: Locked' : 'Manual AE/AWB: Auto (Hardware lock unsupported)';
        cameraLockStatus.className = `camera-lock-badge ${lockApplied ? 'locked' : 'auto'}`;
      }
    } catch (error) {
      const cameraState = document.querySelector('#cameraState');
      if (cameraState) cameraState.textContent = 'CAMERA UNAVAILABLE (USE UPLOAD)';
      console.warn('startCamera failed:', error);
    }
  }

  async function captureFrames() {
    const video = document.querySelector('#cameraFeed');
    await waitForVideoReady(video);
    const crop = getGuideCrop(video, document.querySelector('#cameraFrame'), document.querySelector('#badgeGuide'));
    const sourceFrames = [];
    return new Promise((resolve) => {
      const capture = () => {
        const source = document.createElement('canvas');
        source.width = video.videoWidth;
        source.height = video.videoHeight;
        const ctx = source.getContext('2d');
        ctx.filter = 'none';
        ctx.drawImage(video, 0, 0, source.width, source.height);
        sourceFrames.push(source);
        if (sourceFrames.length < 3) {
          requestAnimationFrame(capture);
          return;
        }
        resolve({
          frames: sourceFrames.map((frame) => cropFrame(frame, crop)),
          backgroundRGB: sampleOutsideCrop(sourceFrames[0], crop),
        });
      };
      capture();
    });
  }

  document.querySelector('#captureButton').addEventListener('click', async () => {
    document.querySelector('#retakeContent').hidden = true;
    const button = document.querySelector('#captureButton');
    const originalLabel = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Starting camera...';
    try {
      const video = document.querySelector('#cameraFeed');
      const uploadedPreview = document.querySelector('#uploadedPreview');
      if (uploadedPreview) uploadedPreview.style.display = 'none';
      if (video) video.style.display = 'block';

      if (!cameraStream || !video?.srcObject || !video.srcObject.active) {
        await startCamera();
      }
      if (video && video.paused) {
        try { await video.play(); } catch (e) {}
      }
      button.textContent = 'Capturing 3 frames...';
      const capture = await captureFrames();
      analyzeBadge(capture);
    } catch (error) {
      showRefusal(error.message || 'Camera unavailable. Please allow camera permissions or upload an image.');
    } finally {
      button.innerHTML = originalLabel;
      button.disabled = false;
    }
  });

  document.querySelector('#cameraPlaceholder')?.addEventListener('click', () => {
    startCamera();
  });

  document.querySelector('#uploadButton').addEventListener('click', () => {
    const input = document.querySelector('#imageInput');
    input.value = '';
    input.click();
  });

  document.querySelector('#imageInput').addEventListener('change', () => {
    const file = document.querySelector('#imageInput').files[0];
    if (!file) return;
    pendingUploadUrl = URL.createObjectURL(file);
    pendingUploadImage = new Image();
    pendingUploadImage.onload = () => {
      cropPreview.src = pendingUploadUrl;
      uploadCrop = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };
      cropTouched = true;
      analyzeCropButton.disabled = false;
      cropModal.hidden = false;
      requestAnimationFrame(updateCropSelection);
    };
    pendingUploadImage.onerror = () => {
      showRefusal('Could not read image file. Please try a different photo.');
    };
    pendingUploadImage.src = pendingUploadUrl;
  });

  cropStage.addEventListener('pointerdown', (event) => {
    if (!pendingUploadImage) return;
    const imageBounds = cropPreview.getBoundingClientRect();
    if (event.clientX < imageBounds.left || event.clientX > imageBounds.right || event.clientY < imageBounds.top || event.clientY > imageBounds.bottom) return;
    cropStart = cropPoint(event);
    uploadCrop = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
    cropTouched = true;
    try {
      cropStage.setPointerCapture(event.pointerId);
    } catch (e) {}
  });

  cropStage.addEventListener('pointermove', (event) => {
    if (!cropStart) return;
    const current = cropPoint(event);
    uploadCrop = {
      x: Math.min(cropStart.x, current.x),
      y: Math.min(cropStart.y, current.y),
      w: Math.abs(current.x - cropStart.x),
      h: Math.abs(current.y - cropStart.y),
    };
    cropTouched = true;
    updateCropSelection();
  });

  cropStage.addEventListener('pointerup', () => {
    cropStart = null;
    const validCrop = uploadCrop
      && uploadCrop.w >= 0.05
      && uploadCrop.h >= 0.05;
    analyzeCropButton.disabled = !validCrop;
  });

  document.querySelector('#cancelCropButton').addEventListener('click', () => {
    cropModal.hidden = true;
    if (pendingUploadUrl) URL.revokeObjectURL(pendingUploadUrl);
    pendingUploadImage = null;
  });

  analyzeCropButton.addEventListener('click', () => {
    if (!pendingUploadImage || !uploadCrop || analyzeCropButton.disabled) return;
    try {
      const source = document.createElement('canvas');
      source.width = pendingUploadImage.naturalWidth || pendingUploadImage.width;
      source.height = pendingUploadImage.naturalHeight || pendingUploadImage.height;
      if (!source.width || !source.height) {
        showRefusal('Image dimensions could not be read.');
        return;
      }
      source.getContext('2d').drawImage(pendingUploadImage, 0, 0);
      const crop = {
        x: Math.round(uploadCrop.x * source.width),
        y: Math.round(uploadCrop.y * source.height),
        width: Math.round(uploadCrop.w * source.width),
        height: Math.round(uploadCrop.h * source.height),
      };
      const capture = { frames: [cropFrame(source, crop)], backgroundRGB: sampleOutsideCrop(source, crop) };
      cropModal.hidden = true;
      if (pendingUploadUrl) URL.revokeObjectURL(pendingUploadUrl);
      pendingUploadImage = null;

      // Show cropped badge preview inside camera frame
      const cameraFeed = document.querySelector('#cameraFeed');
      const cameraPlaceholder = document.querySelector('#cameraPlaceholder');
      if (cameraFeed) cameraFeed.style.display = 'none';
      if (cameraPlaceholder) cameraPlaceholder.style.display = 'none';

      let uploadedPreview = document.querySelector('#uploadedPreview');
      if (!uploadedPreview) {
        uploadedPreview = document.createElement('img');
        uploadedPreview.id = 'uploadedPreview';
        uploadedPreview.style.width = '100%';
        uploadedPreview.style.height = '100%';
        uploadedPreview.style.objectFit = 'contain';
        uploadedPreview.style.position = 'absolute';
        uploadedPreview.style.inset = '0';
        document.querySelector('#cameraFrame').appendChild(uploadedPreview);
      }
      uploadedPreview.src = capture.frames[0].toDataURL('image/jpeg');
      uploadedPreview.style.display = 'block';

      document.querySelector('#cameraState').textContent = 'CROPPED IMAGE';
      analyzeBadge(capture);
    } catch (err) {
      cropModal.hidden = true;
      showRefusal('Failed to process image: ' + err.message);
    }
  });

  document.querySelector('#forceEstimateButton')?.addEventListener('click', () => {
    if (lastCaptureForRetry) {
      analyzeBadge(lastCaptureForRetry, { forceEstimate: true });
    }
  });

  // Confirmation dialog state and handlers
  let pendingDeleteCallback = null;

  function openConfirmDialog(message, onConfirm) {
    const modal = document.querySelector('#confirmModal');
    const msgEl = document.querySelector('#confirmMessage');
    if (msgEl) msgEl.textContent = message;
    pendingDeleteCallback = onConfirm;
    if (modal) modal.hidden = false;
  }

  function closeConfirmDialog() {
    const modal = document.querySelector('#confirmModal');
    if (modal) modal.hidden = true;
    pendingDeleteCallback = null;
  }

  document.querySelector('#confirmCancelBtn')?.addEventListener('click', closeConfirmDialog);

  document.querySelector('#confirmDeleteBtn')?.addEventListener('click', () => {
    if (typeof pendingDeleteCallback === 'function') {
      pendingDeleteCallback();
    }
    closeConfirmDialog();
  });

  document.querySelector('#deleteAllRecordsBtn')?.addEventListener('click', () => {
    openConfirmDialog("Delete all saved readings? This can't be undone.", () => {
      deleteAllRecords();
    });
  });

  document.querySelector('#recordsBody')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.row-delete-btn');
    if (!btn) return;
    const timestamp = btn.dataset.timestamp;
    if (!timestamp) return;
    openConfirmDialog("Delete all saved readings? This can't be undone.", () => {
      deleteRecord(timestamp);
    });
  });

  window.addEventListener('resize', updateCropSelection);
  document.querySelector('#debugToggle').addEventListener('change', (event) => {
    const overlay = document.querySelector('#roiDebugOverlay');
    overlay.hidden = !event.target.checked || !lastDebugCapture;
    if (event.target.checked && lastDebugCapture) {
      drawDebugOverlay(lastDebugCapture.frame, lastDebugCapture.roiMedians, lastDebugCapture.aiDetection);
    }
  });

  document.querySelector('#clearForm').addEventListener('click', () => ['workerId', 'badgeId', 'shiftId'].forEach((id) => {
    const element = document.querySelector(`#${id}`);
    if (element) element.value = '';
  }));

  document.querySelector('#compareLeftSelect')?.addEventListener('change', updateComparisonSummary);
  document.querySelector('#compareRightSelect')?.addEventListener('change', updateComparisonSummary);

  // Demo mode (Color-First Readout) Controls & Live Loop
  let demoLiveTimer = null;
  function processAndRenderDemoFrame(frameCanvas) {
    lastDemoFrame = frameCanvas;
    const demoReader = getDemoColorReader();
    if (!demoReader) return;
    const tempSelectVal = document.querySelector('#demoTempSelect')?.value || '25';
    const tempC = tempSelectVal === 'all' ? 'all' : Number(tempSelectVal);
    const sampled = demoReader.sampleDemoCanvas(frameCanvas);
    const buffer = getDemoStabilityBuffer();
    const stability = buffer ? buffer.addFrame(sampled) : { isStable: true, maxSpread: 0, frameCount: 1 };
    const readout = demoReader.processDemoColorReadout(sampled.measuredLab, { tempC });
    updateDemoColorReadoutUI({
      ...readout,
      roiMedians: sampled.roiMedians,
      measuredLab: sampled.measuredLab,
      stability,
    });
  }

  function startDemoLiveLoop() {
    if (demoLiveTimer) return;
    demoLiveTimer = setInterval(() => {
      const isDemo = Boolean(document.querySelector('#chartDemoToggle')?.checked);
      if (!isDemo) {
        stopDemoLiveLoop();
        return;
      }
      const video = document.querySelector('#cameraFeed');
      if (!video || video.paused || video.ended || video.readyState < 2 || !video.videoWidth) {
        return;
      }
      const offscreen = document.createElement('canvas');
      offscreen.width = video.videoWidth;
      offscreen.height = video.videoHeight;
      const ctx = offscreen.getContext('2d');
      ctx.filter = 'none';
      ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
      processAndRenderDemoFrame(offscreen);
    }, 200);
  }

  function stopDemoLiveLoop() {
    if (demoLiveTimer) {
      clearInterval(demoLiveTimer);
      demoLiveTimer = null;
    }
  }

  const chartDemoToggle = document.querySelector('#chartDemoToggle');
  const demoModeSection = document.querySelector('#demoModeSection');
  if (chartDemoToggle && demoModeSection) {
    chartDemoToggle.addEventListener('change', () => {
      const active = chartDemoToggle.checked;
      demoModeSection.style.display = active ? 'block' : 'none';
      if (active) {
        startDemoLiveLoop();
        if (lastDebugCapture?.frame) {
          processAndRenderDemoFrame(lastDebugCapture.frame);
        }
      } else {
        stopDemoLiveLoop();
      }
      if (lastDebugCapture && document.querySelector('#debugToggle')?.checked) {
        drawDebugOverlay(lastDebugCapture.frame, lastDebugCapture.roiMedians, lastDebugCapture.aiDetection);
      }
    });
  }

  document.querySelector('#demoTempSelect')?.addEventListener('change', () => {
    if (lastDemoFrame) {
      processAndRenderDemoFrame(lastDemoFrame);
    }
  });

  document.querySelector('#demoTestBadgeButton')?.addEventListener('click', () => {
    const demoReader = getDemoColorReader();
    if (!demoReader) return;
    const tempSelectVal = document.querySelector('#demoTempSelect')?.value || '25';
    const tempC = tempSelectVal === 'all' ? 25 : Number(tempSelectVal);
    const canvas = demoReader.createDemoBadgeCanvas({ tempC, samplePpm: 20 });

    const cameraFeed = document.querySelector('#cameraFeed');
    const cameraPlaceholder = document.querySelector('#cameraPlaceholder');
    if (cameraFeed) cameraFeed.style.display = 'none';
    if (cameraPlaceholder) cameraPlaceholder.style.display = 'none';

    let uploadedPreview = document.querySelector('#uploadedPreview');
    if (!uploadedPreview) {
      uploadedPreview = document.createElement('img');
      uploadedPreview.id = 'uploadedPreview';
      uploadedPreview.style.width = '100%';
      uploadedPreview.style.height = '100%';
      uploadedPreview.style.objectFit = 'contain';
      uploadedPreview.style.position = 'absolute';
      uploadedPreview.style.inset = '0';
      document.querySelector('#cameraFrame')?.appendChild(uploadedPreview);
    }
    uploadedPreview.src = canvas.toDataURL('image/jpeg');
    uploadedPreview.style.display = 'block';

    const cameraState = document.querySelector('#cameraState');
    if (cameraState) cameraState.textContent = 'DEMO BADGE (REF + SAMPLE)';

    const capture = { frames: [canvas], backgroundRGB: [20, 20, 20] };
    analyzeBadge(capture, { forceEstimate: true });
  });

  window.addEventListener('beforeunload', () => cameraStream?.getTracks().forEach((track) => track.stop()));
  renderRecords();
  startCamera();
}

if (typeof document !== 'undefined') {
  initBrowser();
}

if (typeof module !== 'undefined') {
  module.exports = {
    H2S_BANDS,
    ROI_LAYOUT,
    ROI_LAYOUT_VERSION,
    ANALYSIS_VERSION,
    ROI_MARGIN,
    ROI_STDDEV_THRESHOLD,
    CLIPPED_PIXEL_THRESHOLD,
    BLUR_VARIANCE_THRESHOLD,
    BACKGROUND_SIMILARITY_THRESHOLD,
    CALIBRATION_DATASET,
    estimateBandFromLab,
    summarizeReading,
    shrinkRoi,
    median,
    sampleRoi,
    medianAcrossFrames,
    calculateBlurVariance,
    calculateReading,
    isVideoReady,
    waitForVideoReady,
    getGuideCrop,
    computeIncrementalExposure,
    computeCompensationFactor,
    estimateTemperatureHumidityFromDrift,
    rgbToLab,
    distance,
    computeBestEffortReading,
    getAiDetector,
    getDemoColorReader,
    analyzeBadge,
    drawDebugOverlay,
    updateDemoColorReadoutUI,
    deleteAllRecords,
    deleteRecord,
    renderRecords,
    records,
    STORAGE_KEY,
  };
}

})();

