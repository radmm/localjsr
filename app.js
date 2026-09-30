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

function srgbToLinear(channel) {
  const normalized = clamp(channel / 255, 0, 1);
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear) {
  const clamped = clamp(linear, 0, 1);
  const norm = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
  return clamp(norm * 255, 0, 255);
}

const CHART_REFERENCE_TABLE = [
  { ppm: 0, tempC: 15, lab: [45.77, 34.05, -19.46] },
  { ppm: 10, tempC: 5, lab: [39.43, 33.72, -9.73] },
  { ppm: 10, tempC: 10, lab: [45.62, 34.82, -9.83] },
  { ppm: 10, tempC: 15, lab: [41.63, 34.68, -7.21] },
  { ppm: 10, tempC: 20, lab: [45.41, 35.39, -6.28] },
  { ppm: 10, tempC: 25, lab: [45.57, 30.22, -3.75] },
  { ppm: 20, tempC: 5, lab: [40.97, 35.07, -7.39] },
  { ppm: 20, tempC: 10, lab: [45.16, 33.53, -7.08] },
  { ppm: 20, tempC: 15, lab: [43.86, 32.46, -2.21] },
  { ppm: 20, tempC: 20, lab: [41.46, 33.59, -2.12] },
  { ppm: 20, tempC: 25, lab: [43.93, 35.10, -0.87] },
  { ppm: 40, tempC: 5, lab: [39.98, 34.34, 1.43] },
  { ppm: 40, tempC: 10, lab: [39.54, 33.19, 2.49] },
  { ppm: 40, tempC: 15, lab: [46.18, 34.44, 4.93] },
  { ppm: 40, tempC: 20, lab: [45.95, 34.55, 9.31] },
  { ppm: 40, tempC: 25, lab: [50.79, 33.50, 10.43] },
  { ppm: 50, tempC: 5, lab: [52.12, 34.16, 4.29] },
  { ppm: 50, tempC: 10, lab: [47.10, 38.09, 4.91] },
  { ppm: 50, tempC: 15, lab: [46.79, 33.24, 10.70] },
  { ppm: 50, tempC: 20, lab: [50.64, 32.35, 10.12] },
  { ppm: 50, tempC: 25, lab: [51.63, 31.86, 12.39] },
];

const DEMO_DISTANCE_THRESHOLD = 25.0;

function weightedLabDistance(lab1, lab2) {
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(0.5 * dL * dL + 0.5 * da * da + 2.0 * db * db);
}

function estimateChartDemo(measuredLab, { userTemperature = null, threshold = DEMO_DISTANCE_THRESHOLD } = {}) {
  let candidates = CHART_REFERENCE_TABLE;
  let temperatureConstraintApplied = false;
  let filteredTemp = null;

  if (userTemperature !== null && userTemperature !== undefined && userTemperature !== '' && !isNaN(Number(userTemperature))) {
    const targetTemp = Number(userTemperature);
    const columns = [5, 10, 15, 20, 25];
    filteredTemp = columns.reduce((prev, curr) => Math.abs(curr - targetTemp) < Math.abs(prev - targetTemp) ? curr : prev, columns[0]);
    candidates = CHART_REFERENCE_TABLE.filter((cell) => cell.ppm === 0 || cell.tempC === filteredTemp);
    temperatureConstraintApplied = true;
  }

  const scored = candidates.map((cell) => ({
    ...cell,
    distance: weightedLabDistance(measuredLab, cell.lab),
  })).sort((a, b) => a.distance - b.distance);

  const nearestCell = scored[0];
  const nearestDistance = nearestCell.distance;

  if (nearestDistance > threshold) {
    return {
      valid: false,
      label: 'Demo estimate, not calibrated',
      refusalReason: 'No match, retake',
      message: 'No match, retake',
      nearestCell: {
        ppm: nearestCell.ppm,
        tempC: nearestCell.tempC,
        lab: nearestCell.lab,
        distance: Number(nearestDistance.toFixed(2)),
      },
      measuredLab: measuredLab.map((v) => Number(v.toFixed(2))),
      distance: Number(nearestDistance.toFixed(2)),
      matchFound: false,
      temperatureConstraintApplied,
      filteredTemp,
    };
  }

  if (nearestDistance < 1e-6) {
    return {
      valid: true,
      label: 'Demo estimate, not calibrated',
      ppm: nearestCell.ppm,
      interpolatedPpm: nearestCell.ppm,
      temperatureC: nearestCell.tempC,
      interpolatedTemp: nearestCell.tempC,
      nearestCell: {
        ppm: nearestCell.ppm,
        tempC: nearestCell.tempC,
        lab: nearestCell.lab,
        distance: 0,
      },
      measuredLab: measuredLab.map((v) => Number(v.toFixed(2))),
      distance: 0,
      matchFound: true,
      temperatureConstraintApplied,
      filteredTemp,
    };
  }

  const k = Math.min(3, scored.length);
  const topK = scored.slice(0, k);

  let totalWeight = 0;
  let weightedPpmSum = 0;
  let weightedTempSum = 0;

  for (const cell of topK) {
    const weight = 1 / Math.max(cell.distance, 1e-6);
    totalWeight += weight;
    weightedPpmSum += cell.ppm * weight;
    weightedTempSum += (temperatureConstraintApplied && filteredTemp !== null ? filteredTemp : cell.tempC) * weight;
  }

  const interpolatedPpm = totalWeight > 0 ? weightedPpmSum / totalWeight : nearestCell.ppm;
  const interpolatedTemp = totalWeight > 0 ? weightedTempSum / totalWeight : nearestCell.tempC;

  return {
    valid: true,
    label: 'Demo estimate, not calibrated',
    ppm: Number(interpolatedPpm.toFixed(1)),
    interpolatedPpm: Number(interpolatedPpm.toFixed(1)),
    temperatureC: Number(interpolatedTemp.toFixed(1)),
    interpolatedTemp: Number(interpolatedTemp.toFixed(1)),
    nearestCell: {
      ppm: nearestCell.ppm,
      tempC: nearestCell.tempC,
      lab: nearestCell.lab,
      distance: Number(nearestDistance.toFixed(2)),
    },
    measuredLab: measuredLab.map((v) => Number(v.toFixed(2))),
    distance: Number(nearestDistance.toFixed(2)),
    matchFound: true,
    topCells: topK.map((c) => ({ ppm: c.ppm, tempC: c.tempC, distance: Number(c.distance.toFixed(2)) })),
    temperatureConstraintApplied,
    filteredTemp,
  };
}

function calculateFrameChannelRatio(frame) {
  if (!frame || !frame.width || !frame.height) {
    return { bOverR: 1.0, rAvg: 128, gAvg: 128, bAvg: 128, isExtreme: false, warning: null };
  }
  const context = frame.getContext('2d');
  const width = frame.width;
  const height = frame.height;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 2500)));
  const imgData = context.getImageData(0, 0, width, height).data;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      rSum += imgData[idx];
      gSum += imgData[idx + 1];
      bSum += imgData[idx + 2];
      count += 1;
    }
  }
  const rAvg = count ? rSum / count : 128;
  const gAvg = count ? gSum / count : 128;
  const bAvg = count ? bSum / count : 128;
  const bOverR = rAvg > 0 ? bAvg / rAvg : 1.0;
  const isExtreme = bOverR > 1.6 || bOverR < 0.45;
  return {
    bOverR: Number(bOverR.toFixed(2)),
    rAvg: Number(rAvg.toFixed(1)),
    gAvg: Number(gAvg.toFixed(1)),
    bAvg: Number(bAvg.toFixed(1)),
    isExtreme,
    warning: isExtreme ? 'Strong color cast, retake' : null,
  };
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

    if (Math.abs(augmented[maxRow][pivot]) < 1e-10) {
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
      if (Math.abs(factor) < 1e-10) continue;
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function fitCorrection(observed, swatches = REFERENCE_SWATCHES) {
  const activeSwatches = swatches || REFERENCE_SWATCHES;

  // 1. White balance pre-step:
  // Identify the neutral gray/white swatch (refSwatch6: [184, 184, 181])
  let neutralIndex = activeSwatches.findIndex((s) => s.key === 'refSwatch6');
  if (neutralIndex === -1 || !observed[neutralIndex]) {
    neutralIndex = activeSwatches.length > 5 ? 5 : 0;
  }

  const targetNeutralSrgb = activeSwatches[neutralIndex].color;
  const targetNeutralLin = targetNeutralSrgb.map(srgbToLinear);
  const targetLuma = (targetNeutralLin[0] + targetNeutralLin[1] + targetNeutralLin[2]) / 3;

  const obsNeutralSrgb = observed[neutralIndex] || targetNeutralSrgb;
  const obsNeutralLin = obsNeutralSrgb.map(srgbToLinear);

  // Scale channels so the gray or white swatch becomes neutral (R = G = B = targetLuma)
  const wbScales = [
    obsNeutralLin[0] > 1e-5 ? targetLuma / obsNeutralLin[0] : 1,
    obsNeutralLin[1] > 1e-5 ? targetLuma / obsNeutralLin[1] : 1,
    obsNeutralLin[2] > 1e-5 ? targetLuma / obsNeutralLin[2] : 1,
  ];

  // 2. Convert all observed swatches to linear and apply white balance scaling
  const design = observed.map((reading) => {
    const lin = reading.map(srgbToLinear);
    const wbLin = [lin[0] * wbScales[0], lin[1] * wbScales[1], lin[2] * wbScales[2]];
    return [1, wbLin[0], wbLin[1], wbLin[2]];
  });

  // 3. Fit 3x3 matrix plus offset against target swatches in linear space
  const coefficients = Array.from({ length: 3 }, (_, channel) => {
    const targets = activeSwatches.map((swatch) => srgbToLinear(swatch.color[channel]));
    const xtx = Array.from({ length: 4 }, () => Array(4).fill(0));
    const xty = Array(4).fill(0);

    for (let row = 0; row < design.length; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        xty[column] += design[row][column] * targets[row];
        for (let inner = 0; inner < 4; inner += 1) {
          xtx[column][inner] += design[row][column] * design[row][inner];
        }
      }
    }

    // Small Tikhonov regularization on diagonal for numerical stability
    for (let i = 0; i < 4; i += 1) {
      xtx[i][i] += 1e-7;
    }

    return solveLinearSystem(xtx, xty);
  });

  // 4. Correction function: sRGB -> linear -> WB scale -> 3x3 matrix + offset -> linearToSrgb
  const correct = (reading) => {
    const lin = reading.map(srgbToLinear);
    const wbLin = [lin[0] * wbScales[0], lin[1] * wbScales[1], lin[2] * wbScales[2]];
    const outLin = coefficients.map((coeffs) => coeffs[0]
      + coeffs[1] * wbLin[0]
      + coeffs[2] * wbLin[1]
      + coeffs[3] * wbLin[2]);
    return outLin.map(linearToSrgb);
  };

  correct.wbScales = wbScales;
  correct.coefficients = coefficients;
  correct.neutralIndex = neutralIndex;

  return correct;
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

  const frameRatio = calculateFrameChannelRatio(frames[0]);
  const referenceReadings = activeSwatches.map((swatch) => roiMedians[swatch.key]);
  const correct = fitCorrection(referenceReadings, activeSwatches);
  const residual = Math.sqrt(referenceReadings.reduce((total, reading, index) => total + distance(correct(reading), activeSwatches[index].color) ** 2, 0) / referenceReadings.length);
  if (residual > REFERENCE_ERROR_THRESHOLD) return refuseReading(`Reference correction failed (${residual.toFixed(1)} RGB RMS)`, residual, { ...diagnostics, frameRatio });

  const stripRGB = correct(roiMedians.strip);
  const sealedReferenceRGB = correct(roiMedians.sealedReference);
  const stripLab = rgbToLab(stripRGB);
  const sealedReferenceLab = rgbToLab(sealedReferenceRGB);
  const compensationFactor = computeCompensationFactor(sealedReferenceLab);
  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);

  const swatchesDiagnostics = activeSwatches.map((swatch) => {
    const rawRgb = roiMedians[swatch.key] || swatch.color;
    const correctedRgb = correct(rawRgb);
    return {
      key: swatch.key,
      name: swatch.key.replace('refSwatch', 'Swatch '),
      rawRgb: rawRgb.map((v) => Math.round(v)),
      correctedRgb: correctedRgb.map((v) => Math.round(v)),
      targetRgb: swatch.color,
    };
  });
  const stripDiagnostic = {
    key: 'strip',
    name: 'Strip ROI',
    rawRgb: (roiMedians.strip || [184, 184, 181]).map((v) => Math.round(v)),
    correctedRgb: stripRGB.map((v) => Math.round(v)),
    targetRgb: null,
  };

  return {
    ...summarizeReading({ stripLab, sealedReferenceLab, durationMinutes, compensationFactor }),
    valid: true,
    quality: residual,
    stripRGB,
    stripLab,
    sealedReferenceRGB,
    sealedReferenceLab,
    frameRatio,
    swatchesDiagnostics: [...swatchesDiagnostics, stripDiagnostic],
    wbScales: correct.wbScales,
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

function renderRecords() {
  const stored = records();
  const count = document.querySelector('#recordCount');
  if (count) count.textContent = `${stored.length} saved`;
  const body = document.querySelector('#recordsBody');
  if (!body) return;

  renderComparisonControls(stored);

  if (!stored.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">No readings yet. Captured records remain available in airplane mode.</td></tr>';
    updateComparisonSummary();
    return;
  }

  body.innerHTML = stored.slice().reverse().map((record) => {
    const versionFlag = record.analysisVersion === ANALYSIS_VERSION ? '' : `<small class="record-version">Legacy ${record.analysisVersion || 'record'}</small>`;
    return `<tr>
    <td class="worker-cell"><strong>${record.workerId}</strong><small>${record.badgeId}</small></td>
    <td>${record.shiftId}</td>
    <td><strong>${record.concentrationBandEstimate || '0 ppm-equivalent'}</strong>${versionFlag}</td>
    <td><strong>${Number(record.dose || 0).toFixed(1)}</strong> ppm·min</td>
    <td><span class="pill ${record.confidenceLevel ? record.confidenceLevel.toLowerCase() : 'medium'}">${record.confidenceLevel || 'Medium'}</span></td>
    <td><span class="pill subtle">${record.tempHumidityDriftFlag || 'Low drift'}</span></td>
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
  const ctx = cropped.getContext('2d');
  ctx.filter = 'none';
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
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

function createCalibratedBadgeCanvas(ppm = 20) {
  const width = 640;
  const height = 480;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const alternate = (x + y) % 2 === 0;
      const shade = alternate ? 35 : 145;
      data[idx] = shade;
      data[idx + 1] = shade - 5;
      data[idx + 2] = shade - 10;
      data[idx + 3] = 255;
    }
  }

  function paintRoiPixels(roi, color) {
    const left = Math.floor(roi.x * width);
    const right = Math.ceil((roi.x + roi.w) * width);
    const top = Math.floor(roi.y * height);
    const bottom = Math.ceil((roi.y + roi.h) * height);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const idx = (y * width + x) * 4;
        data[idx] = color[0];
        data[idx + 1] = color[1];
        data[idx + 2] = color[2];
        data[idx + 3] = 255;
      }
    }
  }

  ROI_LAYOUT.referenceSwatches.forEach((swatch) => paintRoiPixels(swatch, swatch.color));
  paintRoiPixels(ROI_LAYOUT.sealedReference, [220, 220, 210]);

  const stripRgbByPpm = {
    0: [210, 215, 210],
    1: [210, 190, 170],
    2: [215, 175, 150],
    5: [210, 155, 125],
    10: [210, 140, 100],
    20: [200, 120, 80],
    50: [180, 90, 40],
    100: [170, 70, 10],
  };
  paintRoiPixels(ROI_LAYOUT.strip, stripRgbByPpm[ppm] || stripRgbByPpm[20]);

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

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

  const debugToggle = document.querySelector('#debugToggle');
  if (debugToggle?.checked) showDebugCapture(capture.frames[0], reading.roiMedians, aiDetection);
  
  lastSuccessfulReading = reading;
  const frameRatio = reading.frameRatio || calculateFrameChannelRatio(capture.frames[0]);
  updateColorCastDebugPanel(reading, frameRatio);
  updateChartDemoCard(reading);

  renderRecords();
  const resultPanel = document.querySelector('#resultPanel');
  if (resultPanel) resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let lastSuccessfulReading = null;

async function applyCameraLocks(track) {
  if (!track || !track.getCapabilities) {
    return {
      supported: false,
      exposureLocked: false,
      whiteBalanceLocked: false,
      description: 'Auto (Manual lock unsupported)',
    };
  }
  try {
    const capabilities = track.getCapabilities() || {};
    const advanced = {};
    let requested = false;

    if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('manual')) {
      advanced.whiteBalanceMode = 'manual';
      requested = true;
    }
    if (capabilities.exposureMode && capabilities.exposureMode.includes('manual')) {
      advanced.exposureMode = 'manual';
      requested = true;
    }

    if (requested) {
      await track.applyConstraints({ advanced: [advanced] });
      const settings = track.getSettings?.() || {};
      const wbLocked = settings.whiteBalanceMode === 'manual' || Boolean(advanced.whiteBalanceMode);
      const expLocked = settings.exposureMode === 'manual' || Boolean(advanced.exposureMode);
      let desc = 'AE & AWB Locked';
      if (wbLocked && expLocked) desc = 'AE & AWB Locked';
      else if (wbLocked) desc = 'AWB Locked';
      else if (expLocked) desc = 'AE Locked';

      return {
        supported: true,
        exposureLocked: expLocked,
        whiteBalanceLocked: wbLocked,
        description: desc,
      };
    }
    return {
      supported: false,
      exposureLocked: false,
      whiteBalanceLocked: false,
      description: 'Auto (Manual lock unsupported by device)',
    };
  } catch (e) {
    console.warn('applyCameraLocks failed:', e);
    return {
      supported: false,
      exposureLocked: false,
      whiteBalanceLocked: false,
      description: 'Auto (Lock request failed)',
    };
  }
}

function updateColorCastDebugPanel(reading, frameRatio) {
  if (typeof document === 'undefined') return;
  const panel = document.querySelector('#colorCastDebugPanel');
  const ratioBadge = document.querySelector('#frameRatioBadge');
  const warningEl = document.querySelector('#colorCastWarning');
  const tbody = document.querySelector('#debugSwatchesBody');

  if (ratioBadge) {
    ratioBadge.textContent = `B/R: ${frameRatio.bOverR} ${frameRatio.isExtreme ? '(Cast Alert)' : '(Balanced)'}`;
    if (frameRatio.isExtreme) {
      ratioBadge.className = 'pill';
      ratioBadge.style.background = 'var(--status-red-bg)';
      ratioBadge.style.color = 'var(--status-red-text)';
      ratioBadge.style.borderColor = 'var(--status-red-border)';
    } else {
      ratioBadge.className = 'pill subtle';
      ratioBadge.style.background = '';
      ratioBadge.style.color = '';
      ratioBadge.style.borderColor = '';
    }
  }

  if (warningEl) {
    if (frameRatio.isExtreme) {
      warningEl.textContent = `⚠ Strong color cast, retake (Frame B/R ratio: ${frameRatio.bOverR})`;
      warningEl.style.display = 'block';
    } else {
      warningEl.style.display = 'none';
    }
  }

  if (tbody && reading.swatchesDiagnostics) {
    tbody.innerHTML = reading.swatchesDiagnostics.map((item) => {
      const rawColor = `rgb(${item.rawRgb.join(',')})`;
      const corrColor = `rgb(${item.correctedRgb.join(',')})`;
      const targetColor = item.targetRgb ? `rgb(${item.targetRgb.join(',')})` : '--';
      return `<tr style="border-bottom: 1px solid var(--border-subtle);">
        <td style="padding: 4px 6px; font-weight: 600;">${item.name}</td>
        <td style="padding: 4px 6px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${rawColor};vertical-align:middle;margin-right:4px;border:1px solid rgba(0,0,0,0.15);"></span>
          <code>${item.rawRgb.join(', ')}</code>
        </td>
        <td style="padding: 4px 6px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${corrColor};vertical-align:middle;margin-right:4px;border:1px solid rgba(0,0,0,0.15);"></span>
          <code>${item.correctedRgb.join(', ')}</code>
        </td>
        <td style="padding: 4px 6px;">
          ${item.targetRgb ? `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${targetColor};vertical-align:middle;margin-right:4px;border:1px solid rgba(0,0,0,0.15);"></span><code>${item.targetRgb.join(', ')}</code>` : '<span style="color:var(--text-muted);">-</span>'}
        </td>
      </tr>`;
    }).join('');
  }

  const debugToggle = document.querySelector('#debugToggle');
  if (panel) {
    panel.style.display = (debugToggle?.checked || frameRatio.isExtreme) ? 'block' : 'none';
  }
}

function updateChartDemoCard(reading = lastSuccessfulReading) {
  if (typeof document === 'undefined') return;
  const toggle = document.querySelector('#chartDemoToggle');
  const card = document.querySelector('#chartDemoCard');
  if (!card) return;

  if (!toggle?.checked || !reading?.stripLab) {
    card.style.display = 'none';
    return;
  }

  const tempInput = document.querySelector('#demoTempInput');
  const userTemperature = tempInput?.value ? Number(tempInput.value) : null;
  const demo = estimateChartDemo(reading.stripLab, { userTemperature });

  const ppmVal = document.querySelector('#demoPpmValue');
  const tempVal = document.querySelector('#demoTempValue');
  const matchBadge = document.querySelector('#demoMatchBadge');
  const nearestCell = document.querySelector('#demoNearestCell');
  const measuredLab = document.querySelector('#demoMeasuredLab');
  const distanceEl = document.querySelector('#demoDistance');

  card.style.display = 'flex';

  if (!demo.valid || !demo.matchFound) {
    if (ppmVal) {
      ppmVal.textContent = 'No match, retake';
      ppmVal.style.color = 'var(--status-red-text)';
    }
    if (tempVal) tempVal.textContent = '';
    if (matchBadge) {
      matchBadge.textContent = 'Distance Out of Bounds';
      matchBadge.className = 'pill';
      matchBadge.style.background = 'var(--status-red-bg)';
      matchBadge.style.color = 'var(--status-red-text)';
      matchBadge.style.borderColor = 'var(--status-red-border)';
    }
    if (nearestCell && demo.nearestCell) {
      nearestCell.textContent = `${demo.nearestCell.ppm} ppm @ ${demo.nearestCell.tempC}°C`;
    }
    if (measuredLab) {
      measuredLab.textContent = `[${demo.measuredLab.join(', ')}]`;
    }
    if (distanceEl) {
      distanceEl.textContent = `${demo.distance} (limit: ${DEMO_DISTANCE_THRESHOLD})`;
      distanceEl.style.color = 'var(--status-red-text)';
    }
    return;
  }

  if (ppmVal) {
    ppmVal.textContent = `${demo.ppm} ppm`;
    ppmVal.style.color = 'var(--text-primary)';
  }
  if (tempVal) {
    tempVal.textContent = `@ ${demo.temperatureC} °C`;
  }
  if (matchBadge) {
    matchBadge.textContent = demo.temperatureConstraintApplied
      ? `${demo.filteredTemp}°C column interpolation`
      : '3-Cell IDW Interpolation';
    matchBadge.className = 'pill subtle';
    matchBadge.style.background = '';
    matchBadge.style.color = '';
    matchBadge.style.borderColor = '';
  }
  if (nearestCell && demo.nearestCell) {
    nearestCell.textContent = `${demo.nearestCell.ppm} ppm @ ${demo.nearestCell.tempC}°C (L* ${demo.nearestCell.lab[0]}, a* ${demo.nearestCell.lab[1]}, b* ${demo.nearestCell.lab[2]})`;
  }
  if (measuredLab) {
    measuredLab.textContent = `[${demo.measuredLab.join(', ')}]`;
  }
  if (distanceEl) {
    distanceEl.textContent = `${demo.distance}`;
    distanceEl.style.color = 'var(--text-primary)';
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
      const lockStatus = await applyCameraLocks(track);
      const lockBadge = document.querySelector('#cameraLockBadge');
      if (lockBadge) {
        lockBadge.textContent = lockStatus.exposureLocked || lockStatus.whiteBalanceLocked
          ? `AE/AWB: Locked`
          : 'AE/AWB: Auto';
        lockBadge.title = lockStatus.description;
        if (lockStatus.exposureLocked || lockStatus.whiteBalanceLocked) {
          lockBadge.style.color = 'var(--status-green-text)';
          lockBadge.style.borderColor = 'var(--status-green-border)';
          lockBadge.style.background = 'var(--status-green-bg)';
        } else {
          lockBadge.style.color = '';
          lockBadge.style.borderColor = '';
          lockBadge.style.background = '';
        }
      }
      const cameraFeed = document.querySelector('#cameraFeed');
      const cameraPlaceholder = document.querySelector('#cameraPlaceholder');
      const cameraState = document.querySelector('#cameraState');
      const uploadedPreview = document.querySelector('#uploadedPreview');
      if (uploadedPreview) uploadedPreview.style.display = 'none';
      if (cameraFeed) {
        cameraFeed.srcObject = cameraStream;
        cameraFeed.style.display = 'block';
        try { await cameraFeed.play(); } catch (e) {}
        await waitForVideoReady(cameraFeed);
      }
      if (cameraPlaceholder) cameraPlaceholder.style.display = 'none';
      if (cameraState) {
        cameraState.textContent = (lockStatus.exposureLocked || lockStatus.whiteBalanceLocked)
          ? `LIVE / ${lockStatus.description.toUpperCase()}`
          : 'LIVE PREVIEW';
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
      const ctx = source.getContext('2d');
      ctx.filter = 'none';
      ctx.drawImage(pendingUploadImage, 0, 0);
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

  function loadAndAnalyzeSampleBadge(ppm = 20) {
    const badgeCanvas = createCalibratedBadgeCanvas(ppm);
    const capture = {
      frames: [badgeCanvas],
      backgroundRGB: [20, 20, 20],
    };
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
    uploadedPreview.src = badgeCanvas.toDataURL('image/jpeg');
    uploadedPreview.style.display = 'block';

    const cameraState = document.querySelector('#cameraState');
    if (cameraState) cameraState.textContent = `CALIBRATED BADGE (${ppm} PPM)`;
    analyzeBadge(capture, { forceEstimate: false });
  }

  document.querySelector('#sampleBadgeButton')?.addEventListener('click', () => {
    const select = document.querySelector('#samplePpmSelect');
    const ppm = select ? Number(select.value) : 20;
    loadAndAnalyzeSampleBadge(ppm);
  });

  document.querySelector('#loadSampleBadgeFromRetake')?.addEventListener('click', () => {
    const select = document.querySelector('#samplePpmSelect');
    const ppm = select ? Number(select.value) : 20;
    loadAndAnalyzeSampleBadge(ppm);
  });

  document.querySelector('#forceEstimateButton')?.addEventListener('click', () => {
    if (lastCaptureForRetry) {
      analyzeBadge(lastCaptureForRetry, { forceEstimate: true });
    }
  });

  window.addEventListener('resize', updateCropSelection);

  const chartDemoToggle = document.querySelector('#chartDemoToggle');
  const demoTempWrapper = document.querySelector('#demoTempWrapper');
  const demoTempInput = document.querySelector('#demoTempInput');

  chartDemoToggle?.addEventListener('change', (e) => {
    if (demoTempWrapper) demoTempWrapper.style.display = e.target.checked ? 'inline-flex' : 'none';
    updateChartDemoCard();
  });

  demoTempInput?.addEventListener('input', () => {
    updateChartDemoCard();
  });

  document.querySelector('#debugToggle')?.addEventListener('change', (event) => {
    const overlay = document.querySelector('#roiDebugOverlay');
    const colorCastPanel = document.querySelector('#colorCastDebugPanel');
    if (overlay) {
      overlay.hidden = !event.target.checked || !lastDebugCapture;
      if (event.target.checked && lastDebugCapture) {
        drawDebugOverlay(lastDebugCapture.frame, lastDebugCapture.roiMedians, lastDebugCapture.aiDetection);
      }
    }
    if (colorCastPanel) {
      const isExtreme = lastSuccessfulReading?.frameRatio?.isExtreme;
      colorCastPanel.style.display = (event.target.checked || isExtreme) ? 'block' : 'none';
    }
  });

  document.querySelector('#clearForm').addEventListener('click', () => ['workerId', 'badgeId', 'shiftId'].forEach((id) => {
    const element = document.querySelector(`#${id}`);
    if (element) element.value = '';
  }));

  document.querySelector('#compareLeftSelect')?.addEventListener('change', updateComparisonSummary);
  document.querySelector('#compareRightSelect')?.addEventListener('change', updateComparisonSummary);
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
    CHART_REFERENCE_TABLE,
    DEMO_DISTANCE_THRESHOLD,
    weightedLabDistance,
    estimateChartDemo,
    srgbToLinear,
    linearToSrgb,
    fitCorrection,
    calculateFrameChannelRatio,
    applyCameraLocks,
    updateChartDemoCard,
    updateColorCastDebugPanel,
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
    createCalibratedBadgeCanvas,
    computeBestEffortReading,
    getAiDetector,
    analyzeBadge,
    drawDebugOverlay,
  };
}
