/**
 * H2S Badge Reader - Color-First Demo Mode Module
 * Two ROIs only: one 0 ppm reference and one sample.
 * - Clean offscreen canvas sampling with optional 6-swatch correction
 * - Live color swatches, measured Lab (2 decimals)
 * - Chart-aligned Lab: measured sample Lab + (45.77 - Lref, 34.05 - aref, -19.46 - bref)
 * - Delta vs reference: dL, da, db, dE
 * - Nearest chart match with weights L 0.5, a 0.5, b 2 (25 C default, selectable)
 * - Single readout only (Reference & Sample patch)
 * - Stability: 5-frame median, spread (max - min), Stable / Hold steady indicator
 * - Uniformity (stddev <= 24) and clipping (<= 2%) quality gates for both patches
 * - Offline compatible
 */

(function () {
  'use strict';

const DEMO_ESTIMATOR_VERSION = 'color-first-v2.0';

// Fixed chart reference point at 0 ppm
const CHART_REF_POINT = { L: 45.77, a: 34.05, b: -19.46 };

// Reference table (ppm, temp C, L*, a*, b*)
var CHART_DEMO_REFERENCE_TABLE = [
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

const DEFAULT_DEMO_MATCH_THRESHOLD = 25.0;
const DEMO_STABILITY_THRESHOLD = 3.5; // Max spread across L*, a*, b* for stability
const ROI_STDDEV_THRESHOLD = 24.0;    // Quality gate: max channel stddev for uniformity
const CLIPPED_PIXEL_THRESHOLD = 0.02; // Quality gate: max fraction of pixels near 0 or 255

// Two ROIs only: one 0 ppm reference and one sample
const DEMO_ROIS = {
  ref: {
    key: 'ref',
    name: 'Reference (0 ppm)',
    shortName: 'REF',
    x: 0.18,
    y: 0.38,
    w: 0.28,
    h: 0.36,
    color: '#38bdf8',
  },
  sample: {
    key: 'sample',
    name: 'Sample Patch',
    shortName: 'SMP',
    x: 0.54,
    y: 0.38,
    w: 0.28,
    h: 0.36,
    color: '#4ade80',
  },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function srgbToLinearChannel(channel) {
  const normalized = clamp(channel / 255, 0, 1);
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(linear) {
  const normalized = clamp(linear, 0, 1);
  const srgb = normalized <= 0.0031308 ? normalized * 12.92 : 1.055 * (normalized ** (1 / 2.4)) - 0.055;
  return clamp(Math.round(srgb * 255), 0, 255);
}

function rgbToLab(rgb) {
  const [red, green, blue] = rgb;
  const r = srgbToLinearChannel(red);
  const g = srgbToLinearChannel(green);
  const b = srgbToLinearChannel(blue);
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
  return [
    Number((116 * fy - 16).toFixed(2)),
    Number((500 * (fx - fy)).toFixed(2)),
    Number((200 * (fy - fz)).toFixed(2)),
  ];
}

function labToRgb(lab) {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const fx3 = fx ** 3;
  const fy3 = fy ** 3;
  const fz3 = fz ** 3;

  const xr = fx3 > 0.008856 ? fx3 : (fx - 16 / 116) / 7.787;
  const yr = fy3 > 0.008856 ? fy3 : (fy - 16 / 116) / 7.787;
  const zr = fz3 > 0.008856 ? fz3 : (fz - 16 / 116) / 7.787;

  const x = xr * 0.95047;
  const y = yr * 1.0;
  const z = zr * 1.08883;

  const rLin = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const gLin = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const bLin = x * 0.0557 + y * -0.2040 + z * 1.0570;

  return [
    linearToSrgbChannel(rLin),
    linearToSrgbChannel(gLin),
    linearToSrgbChannel(bLin),
  ];
}

/**
 * Compute chart-aligned Lab:
 * measured sample Lab plus (45.77 - Lref, 34.05 - aref, -19.46 - bref)
 */
function computeAlignedLab(sampleLab, refLab) {
  const dL = CHART_REF_POINT.L - refLab[0];
  const da = CHART_REF_POINT.a - refLab[1];
  const db = CHART_REF_POINT.b - refLab[2];
  return [
    Number((sampleLab[0] + dL).toFixed(2)),
    Number((sampleLab[1] + da).toFixed(2)),
    Number((sampleLab[2] + db).toFixed(2)),
  ];
}

/**
 * Delta vs reference: dL, da, db, dE
 */
function computeDeltaVsRef(sampleLab, refLab) {
  const dL = Number((sampleLab[0] - refLab[0]).toFixed(2));
  const da = Number((sampleLab[1] - refLab[1]).toFixed(2));
  const db = Number((sampleLab[2] - refLab[2]).toFixed(2));
  const dE = Number(Math.sqrt(dL * dL + da * da + db * db).toFixed(2));
  return { dL, da, db, dE };
}

/**
 * Weighted Euclidean distance in Lab with weights L 0.5, a 0.5, b 2
 */
function calculateWeightedDistance(lab, row) {
  const dL = lab[0] - row.L;
  const da = lab[1] - row.a;
  const db = lab[2] - row.b;
  return Math.sqrt(0.5 * dL * dL + 0.5 * da * da + 2.0 * db * db);
}

/**
 * Nearest chart match (25 C by default, temperature selectable)
 */
function findNearestChartMatch(alignedLab, { tempC = 25, threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
  let candidateRows = CHART_DEMO_REFERENCE_TABLE;
  if (tempC !== null && tempC !== undefined && tempC !== 'all') {
    const targetTemp = Number(tempC);
    const filtered = CHART_DEMO_REFERENCE_TABLE.filter(
      (row) => row.ppm === 0 || Math.abs(row.tempC - targetTemp) < 1e-4
    );
    if (filtered.length > 0) candidateRows = filtered;
  }

  let closest = null;
  let minDistance = Infinity;

  for (const row of candidateRows) {
    const dist = calculateWeightedDistance(alignedLab, row);
    if (dist < minDistance) {
      minDistance = dist;
      closest = row;
    }
  }

  if (!closest || minDistance > threshold) {
    return {
      matched: false,
      label: 'No match',
      distance: Number(minDistance.toFixed(2)),
      ppm: null,
      cellLab: closest ? [closest.L, closest.a, closest.b] : null,
      cellTempC: closest ? closest.tempC : null,
    };
  }

  return {
    matched: true,
    label: 'closest chart match, demo only',
    ppm: closest.ppm,
    distance: Number(minDistance.toFixed(2)),
    cellLab: [closest.L, closest.a, closest.b],
    cellTempC: closest.tempC,
  };
}

/**
 * Sample median RGB for an ROI from a clean offscreen canvas with no CSS filter
 */
function sampleRoiMedian(context, width, height, roi) {
  const margin = 0.20;
  const innerX = roi.x + roi.w * margin;
  const innerY = roi.y + roi.h * margin;
  const innerW = roi.w * (1 - margin * 2);
  const innerH = roi.h * (1 - margin * 2);

  const x = Math.max(0, Math.floor(innerX * width));
  const y = Math.max(0, Math.floor(innerY * height));
  const right = Math.min(width, Math.ceil((innerX + innerW) * width));
  const bottom = Math.min(height, Math.ceil((innerY + innerH) * height));

  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return [128, 128, 128];

  const imgData = context.getImageData(x, y, w, h);
  const data = imgData.data;
  const channels = [[], [], []];

  for (let i = 0; i < data.length; i += 4) {
    channels[0].push(data[i]);
    channels[1].push(data[i + 1]);
    channels[2].push(data[i + 2]);
  }

  const getMedian = (arr) => {
    if (!arr.length) return 128;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return [getMedian(channels[0]), getMedian(channels[1]), getMedian(channels[2])];
}

/**
 * Evaluates uniformity gate (stddev <= 24) and clipping gate (clipped <= 2%) for an ROI
 */
function evaluatePatchGates(context, width, height, roi) {
  const margin = 0.20;
  const innerX = roi.x + roi.w * margin;
  const innerY = roi.y + roi.h * margin;
  const innerW = roi.w * (1 - margin * 2);
  const innerH = roi.h * (1 - margin * 2);

  const x = Math.max(0, Math.floor(innerX * width));
  const y = Math.max(0, Math.floor(innerY * height));
  const right = Math.min(width, Math.ceil((innerX + innerW) * width));
  const bottom = Math.min(height, Math.ceil((innerY + innerH) * height));

  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) {
    return {
      stddev: 0,
      clippedFraction: 0,
      uniformityPassed: true,
      clippingPassed: true,
      passed: true,
      failureReason: null,
    };
  }

  const imgData = context.getImageData(x, y, w, h);
  const data = imgData.data;
  const totalPixels = data.length / 4;
  let clippedCount = 0;

  const channels = [[], [], []];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    channels[0].push(r);
    channels[1].push(g);
    channels[2].push(b);
    if (r <= 2 || r >= 253 || g <= 2 || g >= 253 || b <= 2 || b >= 253) {
      clippedCount++;
    }
  }

  const clippedFraction = totalPixels > 0 ? clippedCount / totalPixels : 0;

  const channelStddev = channels.map((vals) => {
    if (!vals.length) return 0;
    const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
    return Math.sqrt(variance);
  });

  const maxStddev = Math.max(...channelStddev);
  const uniformityPassed = maxStddev <= ROI_STDDEV_THRESHOLD;
  const clippingPassed = clippedFraction <= CLIPPED_PIXEL_THRESHOLD;
  const passed = uniformityPassed && clippingPassed;

  let failureReason = null;
  if (!uniformityPassed) {
    failureReason = 'Patch not uniform, retake';
  } else if (!clippingPassed) {
    failureReason = 'Too bright or dark';
  }

  return {
    stddev: Number(maxStddev.toFixed(2)),
    clippedFraction: Number(clippedFraction.toFixed(4)),
    uniformityPassed,
    clippingPassed,
    passed,
    failureReason,
  };
}

/**
 * Checks quality gates for both patches (ref & sample)
 */
function checkDemoQualityGates(canvas, rois = DEMO_ROIS) {
  const ctx = canvas.getContext('2d');
  const results = {};
  let allPassed = true;
  let firstRefusal = null;

  for (const [key, roi] of Object.entries(rois)) {
    const gateResult = evaluatePatchGates(ctx, canvas.width, canvas.height, roi);
    results[key] = gateResult;
    if (!gateResult.passed) {
      allPassed = false;
      if (!firstRefusal) firstRefusal = gateResult.failureReason;
    }
  }

  return {
    passed: allPassed,
    refusalReason: firstRefusal,
    gates: results,
  };
}

/**
 * Samples the 2 Demo ROIs (ref + sample) from a clean offscreen canvas
 */
function sampleDemoCanvas(canvas, { correction = null } = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'none';

  const roiMedians = {};
  const measuredLab = {};
  const gates = {};
  let allGatesPassed = true;
  let gateRefusal = null;

  for (const [key, roi] of Object.entries(DEMO_ROIS)) {
    let rawRgb = sampleRoiMedian(ctx, width, height, roi);
    let correctedRgb = rawRgb;
    if (typeof correction === 'function') {
      try {
        correctedRgb = correction(rawRgb).map((v) => clamp(Math.round(v), 0, 255));
      } catch (e) {
        correctedRgb = rawRgb;
      }
    }
    roiMedians[key] = correctedRgb;
    measuredLab[key] = rgbToLab(correctedRgb);

    const gateResult = evaluatePatchGates(ctx, width, height, roi);
    gates[key] = gateResult;
    if (!gateResult.passed) {
      allGatesPassed = false;
      if (!gateRefusal) gateRefusal = gateResult.failureReason;
    }
  }

  // Backwards compatibility alias: s1 -> sample
  if (roiMedians.sample) {
    roiMedians.s1 = roiMedians.sample;
    measuredLab.s1 = measuredLab.sample;
  }

  return {
    roiMedians,
    measuredLab,
    gates,
    allGatesPassed,
    gateRefusal,
  };
}

/**
 * Rolling 5-frame stability buffer
 */
class DemoStabilityBuffer {
  constructor(size = 5, threshold = DEMO_STABILITY_THRESHOLD) {
    this.size = size;
    this.threshold = threshold;
    this.frames = [];
    this.lastStableResult = null;
  }

  reset() {
    this.frames = [];
    this.lastStableResult = null;
  }

  addFrame(frameData) {
    this.frames.push(frameData);
    if (this.frames.length > this.size) {
      this.frames.shift();
    }

    const count = this.frames.length;
    const roiKeys = ['ref', 'sample'];

    // If single frame (e.g. uploaded static image), immediately stable
    if (count === 1) {
      const single = this.frames[0];
      const spreads = {};
      for (const k of roiKeys) {
        spreads[k] = { dL: 0, da: 0, db: 0, maxSpread: 0 };
      }
      this.lastStableResult = {
        isStable: true,
        maxSpread: 0,
        spreads,
        measuredLab: single.measuredLab,
        roiMedians: single.roiMedians,
        frameCount: 1,
      };
      return this.lastStableResult;
    }

    const medianLab = {};
    const medianRgb = {};
    const spreads = {};
    let overallMaxSpread = 0;

    for (const k of roiKeys) {
      const sourceKey = this.frames[0].measuredLab[k] ? k : (k === 'sample' && this.frames[0].measuredLab.s1 ? 's1' : k);
      const L_vals = this.frames.map((f) => f.measuredLab[sourceKey]?.[0] ?? 0);
      const a_vals = this.frames.map((f) => f.measuredLab[sourceKey]?.[1] ?? 0);
      const b_vals = this.frames.map((f) => f.measuredLab[sourceKey]?.[2] ?? 0);

      const spreadL = Number((Math.max(...L_vals) - Math.min(...L_vals)).toFixed(2));
      const spreadA = Number((Math.max(...a_vals) - Math.min(...a_vals)).toFixed(2));
      const spreadB = Number((Math.max(...b_vals) - Math.min(...b_vals)).toFixed(2));
      const maxSp = Math.max(spreadL, spreadA, spreadB);

      spreads[k] = { dL: spreadL, da: spreadA, db: spreadB, maxSpread: maxSp };
      if (maxSp > overallMaxSpread) overallMaxSpread = maxSp;

      const calcMedian = (arr) => {
        const sorted = arr.slice().sort((x, y) => x - y);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      medianLab[k] = [
        Number(calcMedian(L_vals).toFixed(2)),
        Number(calcMedian(a_vals).toFixed(2)),
        Number(calcMedian(b_vals).toFixed(2)),
      ];

      const r_vals = this.frames.map((f) => f.roiMedians[sourceKey]?.[0] ?? 128);
      const g_vals = this.frames.map((f) => f.roiMedians[sourceKey]?.[1] ?? 128);
      const bl_vals = this.frames.map((f) => f.roiMedians[sourceKey]?.[2] ?? 128);

      medianRgb[k] = [
        Math.round(calcMedian(r_vals)),
        Math.round(calcMedian(g_vals)),
        Math.round(calcMedian(bl_vals)),
      ];
    }

    // Alias s1 for backwards compatibility
    medianLab.s1 = medianLab.sample;
    medianRgb.s1 = medianRgb.sample;

    const isStable = count >= this.size && overallMaxSpread <= this.threshold;

    const result = {
      isStable,
      maxSpread: Number(overallMaxSpread.toFixed(2)),
      spreads,
      measuredLab: medianLab,
      roiMedians: medianRgb,
      frameCount: count,
    };

    if (isStable || !this.lastStableResult) {
      this.lastStableResult = result;
    }

    return result;
  }
}

/**
 * Color-first readout processor for the 2 ROIs (ref + sample)
 */
function processDemoColorReadout(sampleLabs, { tempC = 25, threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
  const refLab = sampleLabs.ref;
  if (!refLab) {
    throw new Error('Reference Lab (0 ppm) is required.');
  }

  const sampleLab = sampleLabs.sample || sampleLabs.s1;
  if (!sampleLab) {
    throw new Error('Sample Lab is required.');
  }

  // 1. Reference: aligned to chart is fixed (45.77, 34.05, -19.46)
  const refAligned = [CHART_REF_POINT.L, CHART_REF_POINT.a, CHART_REF_POINT.b];
  const refDelta = { dL: 0, da: 0, db: 0, dE: 0 };
  const refMatch = findNearestChartMatch(refAligned, { tempC, threshold });

  // 2. Sample: chart-aligned Lab = measured sample Lab + (45.77 - Lref, 34.05 - aref, -19.46 - bref)
  const sampleAligned = computeAlignedLab(sampleLab, refLab);
  const sampleDelta = computeDeltaVsRef(sampleLab, refLab);
  const sampleMatch = findNearestChartMatch(sampleAligned, { tempC, threshold });

  const refResult = {
    key: 'ref',
    name: 'Reference (0 ppm)',
    shortName: 'REF',
    color: DEMO_ROIS.ref.color,
    measuredLab: refLab,
    alignedLab: refAligned,
    deltaVsRef: refDelta,
    nearestMatch: refMatch,
  };

  const sampleResult = {
    key: 'sample',
    name: 'Sample Patch',
    shortName: 'SMP',
    color: DEMO_ROIS.sample.color,
    measuredLab: sampleLab,
    alignedLab: sampleAligned,
    deltaVsRef: sampleDelta,
    nearestMatch: sampleMatch,
  };

  const alignedLabs = {
    ref: refAligned,
    sample: sampleAligned,
    s1: sampleAligned,
  };

  const deltas = {
    ref: refDelta,
    sample: sampleDelta,
    s1: sampleDelta,
  };

  const matches = {
    ref: refMatch,
    sample: sampleMatch,
    s1: sampleMatch,
  };

  return {
    version: DEMO_ESTIMATOR_VERSION,
    tempC,
    ref: refResult,
    sample: sampleResult,
    s1: sampleResult, // alias
    alignedLabs,
    deltas,
    matches,
  };
}

/**
 * Creates a synthetic demo badge canvas with the two ROIs (ref + sample)
 */
function createDemoBadgeCanvas({ tempC = 25, samplePpm = 20, tint = [0, 0, 0], noiseStddev = 0, clippedPixels = 0, clipRatio = 0, saturated = false } = {}) {
  const width = 640;
  const height = 480;

  const isBrowserCanvas = typeof window !== 'undefined' && typeof window.document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
  let canvas;
  if (isBrowserCanvas) {
    canvas = document.createElement('canvas');
  } else {
    // Mock canvas for node testing
    const pixels = new Uint8ClampedArray(width * height * 4);
    canvas = {
      width,
      height,
      toDataURL: () => 'data:image/jpeg;base64,mockdemo',
      getContext: () => ({
        filter: 'none',
        getImageData: (x, y, w, h) => {
          const sub = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const srcIdx = ((y + row) * width + (x + col)) * 4;
              const dstIdx = (row * w + col) * 4;
              sub[dstIdx] = pixels[srcIdx];
              sub[dstIdx + 1] = pixels[srcIdx + 1];
              sub[dstIdx + 2] = pixels[srcIdx + 2];
              sub[dstIdx + 3] = pixels[srcIdx + 3];
            }
          }
          return { data: sub, width: w, height: h };
        },
      }),
      _pixels: pixels,
    };
  }
  canvas.width = width;
  canvas.height = height;

  const ctx = isBrowserCanvas ? canvas.getContext('2d') : null;
  if (ctx) ctx.filter = 'none';

  // Find chart colors
  const refRow = CHART_DEMO_REFERENCE_TABLE.find((r) => r.ppm === 0);
  const refRgb = labToRgb([refRow.L + tint[0], refRow.a + tint[1], refRow.b + tint[2]]);

  const sampleRow = CHART_DEMO_REFERENCE_TABLE.find(
    (r) => r.ppm === samplePpm && (tempC === 'all' || Math.abs(r.tempC - tempC) < 1e-4)
  ) || refRow;
  const sampleRgb = labToRgb([sampleRow.L + tint[0], sampleRow.a + tint[1], sampleRow.b + tint[2]]);

  const colors = {
    ref: refRgb,
    sample: sampleRgb,
  };

  if (isBrowserCanvas && ctx) {
    // Background card
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(40, 30, width - 80, height - 60);

    for (const [key, roi] of Object.entries(DEMO_ROIS)) {
      const rx = Math.floor(roi.x * width);
      const ry = Math.floor(roi.y * height);
      const rw = Math.floor(roi.w * width);
      const rh = Math.floor(roi.h * height);
      const c = colors[key];
      ctx.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      ctx.fillRect(rx, ry, rw, rh);
    }
  } else {
    // Fill node mock pixels
    const px = canvas._pixels;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 248;
      px[i + 1] = 250;
      px[i + 2] = 252;
      px[i + 3] = 255;
    }
    for (const [key, roi] of Object.entries(DEMO_ROIS)) {
      const rx = Math.floor(roi.x * width);
      const ry = Math.floor(roi.y * height);
      const rw = Math.floor(roi.w * width);
      const rh = Math.floor(roi.h * height);
      const c = colors[key];
      let pixelIndex = 0;
      for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
          const idx = (y * width + x) * 4;
          let r = c[0];
          let g = c[1];
          let b = c[2];

          // Noise injection for uniformity test (stddev > 24)
          if (noiseStddev > 0 && key === 'sample') {
            const noise = ((pixelIndex % 2 === 0 ? 1 : -1) * noiseStddev * 1.5);
            r = clamp(Math.round(r + noise), 10, 240);
            g = clamp(Math.round(g + noise), 10, 240);
            b = clamp(Math.round(b + noise), 10, 240);
          }

          // Clipping injection for clipping test (> 2% saturated pixels)
          if (key === 'sample' && (saturated || clippedPixels > 0 || clipRatio > 0)) {
            r = 255;
            g = 255;
            b = 255;
          }

          px[idx] = r;
          px[idx + 1] = g;
          px[idx + 2] = b;
          px[idx + 3] = 255;
          pixelIndex++;
        }
      }
    }
  }

  return canvas;
}

const DemoColorReaderModule = {
  DEMO_ESTIMATOR_VERSION,
  CHART_REF_POINT,
  CHART_DEMO_REFERENCE_TABLE,
  DEMO_ROIS,
  DEFAULT_DEMO_MATCH_THRESHOLD,
  DEMO_STABILITY_THRESHOLD,
  ROI_STDDEV_THRESHOLD,
  CLIPPED_PIXEL_THRESHOLD,
  clamp,
  srgbToLinearChannel,
  linearToSrgbChannel,
  rgbToLab,
  labToRgb,
  computeAlignedLab,
  computeDeltaVsRef,
  calculateWeightedDistance,
  findNearestChartMatch,
  sampleRoiMedian,
  evaluatePatchGates,
  checkDemoQualityGates,
  sampleDemoCanvas,
  DemoStabilityBuffer,
  processDemoColorReadout,
  createDemoBadgeCanvas,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DemoColorReaderModule;
}

if (typeof window !== 'undefined') {
  window.DemoColorReader = DemoColorReaderModule;
}

})();
