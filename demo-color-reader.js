/**
 * H2S Badge Reader - Color-First Demo Mode Module
 * - 0 ppm reference ROI + four sample ROIs (S1 to S4)
 * - Clean offscreen canvas sampling with optional 6-swatch correction
 * - Live color swatches, measured Lab (2 decimals)
 * - Chart-aligned Lab: measured sample Lab + (45.77 - Lref, 34.05 - aref, -19.46 - bref)
 * - Delta vs reference: dL, da, db, dE
 * - Nearest chart match with weights L 0.5, a 0.5, b 2 (25 C default, selectable)
 * - Stability: 5-frame median, spread (max - min), Stable / Hold steady indicator
 * - Offline compatible
 */

(function () {
  'use strict';

const DEMO_ESTIMATOR_VERSION = 'color-first-v2.0';

// Fixed chart reference point at 0 ppm
const CHART_REF_POINT = { L: 45.77, a: 34.05, b: -19.46 };

// Reference table (ppm, temp C, L*, a*, b*)
const CHART_DEMO_REFERENCE_TABLE = [
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

// One 0 ppm reference ROI + four sample ROIs (S1 to S4)
const DEMO_ROIS = {
  ref: { key: 'ref', name: 'Reference (0 ppm)', shortName: 'REF', x: 0.10, y: 0.46, w: 0.13, h: 0.26, color: '#38bdf8' },
  s1:  { key: 's1',  name: 'Sample 1',          shortName: 'S1',  x: 0.28, y: 0.46, w: 0.13, h: 0.26, color: '#4ade80' },
  s2:  { key: 's2',  name: 'Sample 2',          shortName: 'S2',  x: 0.46, y: 0.46, w: 0.13, h: 0.26, color: '#facc15' },
  s3:  { key: 's3',  name: 'Sample 3',          shortName: 'S3',  x: 0.64, y: 0.46, w: 0.13, h: 0.26, color: '#fb923c' },
  s4:  { key: 's4',  name: 'Sample 4',          shortName: 'S4',  x: 0.82, y: 0.46, w: 0.13, h: 0.26, color: '#f87171' },
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
 * Chart-aligned Lab: measured sample Lab plus (45.77 - Lref, 34.05 - aref, -19.46 - bref)
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
 * Distance = weighted Euclidean in Lab with weights L 0.5, a 0.5, b 2
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
 * Samples all 5 Demo ROIs from a clean canvas
 */
function sampleDemoCanvas(canvas, { correction = null } = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'none';

  const roiMedians = {};
  const measuredLab = {};

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
  }

  return { roiMedians, measuredLab };
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
    const roiKeys = Object.keys(DEMO_ROIS);

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
      };
      return this.lastStableResult;
    }

    const medianLab = {};
    const medianRgb = {};
    const spreads = {};
    let overallMaxSpread = 0;

    for (const k of roiKeys) {
      const L_vals = this.frames.map((f) => f.measuredLab[k][0]);
      const a_vals = this.frames.map((f) => f.measuredLab[k][1]);
      const b_vals = this.frames.map((f) => f.measuredLab[k][2]);

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

      const r_vals = this.frames.map((f) => f.roiMedians[k][0]);
      const g_vals = this.frames.map((f) => f.roiMedians[k][1]);
      const bl_vals = this.frames.map((f) => f.roiMedians[k][2]);

      medianRgb[k] = [
        Math.round(calcMedian(r_vals)),
        Math.round(calcMedian(g_vals)),
        Math.round(calcMedian(bl_vals)),
      ];
    }

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
 * Complete color-first readout processor for given 5 ROI Lab values
 */
function processDemoColorReadout(sampleLabs, { tempC = 25, threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
  const refLab = sampleLabs.ref;
  if (!refLab) {
    throw new Error('Reference Lab (0 ppm) is required.');
  }

  const results = {};
  const alignedLabs = {};
  const deltas = {};
  const matches = {};

  for (const [key, roi] of Object.entries(DEMO_ROIS)) {
    const measured = sampleLabs[key];
    const isRef = key === 'ref';

    const aligned = isRef
      ? [CHART_REF_POINT.L, CHART_REF_POINT.a, CHART_REF_POINT.b]
      : computeAlignedLab(measured, refLab);

    const delta = isRef
      ? { dL: 0, da: 0, db: 0, dE: 0 }
      : computeDeltaVsRef(measured, refLab);

    const match = findNearestChartMatch(aligned, { tempC, threshold });

    alignedLabs[key] = aligned;
    deltas[key] = delta;
    matches[key] = match;

    results[key] = {
      key,
      name: roi.name,
      shortName: roi.shortName,
      color: roi.color,
      measuredLab: measured,
      alignedLab: aligned,
      deltaVsRef: delta,
      nearestMatch: match,
    };
  }

  return {
    version: DEMO_ESTIMATOR_VERSION,
    tempC,
    ref: results.ref,
    s1: results.s1,
    s2: results.s2,
    s3: results.s3,
    s4: results.s4,
    alignedLabs,
    deltas,
    matches,
  };
}

/**
 * Creates a synthetic demo badge canvas with the 5 ROIs (ref + S1 to S4)
 */
function createDemoBadgeCanvas({ tempC = 25, ppmValues = [10, 20, 40, 50], tint = [0, 0, 0] } = {}) {
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

  const sampleRows = ppmValues.map((ppm) => {
    const row = CHART_DEMO_REFERENCE_TABLE.find(
      (r) => r.ppm === ppm && (tempC === 'all' || Math.abs(r.tempC - tempC) < 1e-4)
    ) || refRow;
    return labToRgb([row.L + tint[0], row.a + tint[1], row.b + tint[2]]);
  });

  const colors = {
    ref: refRgb,
    s1: sampleRows[0],
    s2: sampleRows[1],
    s3: sampleRows[2],
    s4: sampleRows[3],
  };

  if (isBrowserCanvas && ctx) {
    // Browser canvas drawing
    ctx.fillStyle = '#1e293b';
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
      for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
          const idx = (y * width + x) * 4;
          px[idx] = c[0];
          px[idx + 1] = c[1];
          px[idx + 2] = c[2];
          px[idx + 3] = 255;
        }
      }
    }
  }

  return canvas;
}

// Module export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEMO_ESTIMATOR_VERSION,
    CHART_REF_POINT,
    CHART_DEMO_REFERENCE_TABLE,
    DEMO_ROIS,
    DEFAULT_DEMO_MATCH_THRESHOLD,
    DEMO_STABILITY_THRESHOLD,
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
    sampleDemoCanvas,
    DemoStabilityBuffer,
    processDemoColorReadout,
    createDemoBadgeCanvas,
  };
}

if (typeof window !== 'undefined') {
  window.DemoColorReader = {
    DEMO_ESTIMATOR_VERSION,
    CHART_REF_POINT,
    CHART_DEMO_REFERENCE_TABLE,
    DEMO_ROIS,
    DEFAULT_DEMO_MATCH_THRESHOLD,
    DEMO_STABILITY_THRESHOLD,
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
    sampleDemoCanvas,
    DemoStabilityBuffer,
    processDemoColorReadout,
    createDemoBadgeCanvas,
  };
}

})();

