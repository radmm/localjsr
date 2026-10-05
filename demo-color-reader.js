/**
 * H2S Badge Reader - Color-First Demo Mode Module
 * Color-only match against fixed reference table (25 C):
 *   0 ppm #95578D
 *  10 ppm #995873
 *  20 ppm #9C4F6A
 *  40 ppm #B26169
 *  50 ppm #B36567
 *
 * Method:
 * 1. Sample median color of 0 ppm reference patch and sample patch from the same photo
 *    (clean offscreen canvas, 5 frame median, existing correction).
 * 2. Convert all colors to Lab internally.
 * 3. Observed shift: sample Lab minus measured reference Lab.
 *    Chart shift: chart color Lab minus 0 ppm chart Lab.
 * 4. Nearest chart shift with weights L 0.3, a 0.3, b 2. Interpolate ppm between two nearest chart points. Clamp 0 to 50.
 * 5. If top two candidates are within a small distance of each other, show range like "40 to 50 ppm".
 *    If nearest distance is large (> 25), show "No match, retake".
 * 6. UI: estimated ppm (large), observed reference hex, observed sample hex, matched chart hex, distance,
 *    label "Demo estimate, color match".
 */

(function () {
  'use strict';

const DEMO_ESTIMATOR_VERSION = 'color-first-v2.0';

// Fixed reference table (25 C)
const DEMO_REFERENCE_TABLE = [
  { ppm: 0,  hex: '#95578D' },
  { ppm: 10, hex: '#995873' },
  { ppm: 20, hex: '#9C4F6A' },
  { ppm: 40, hex: '#B26169' },
  { ppm: 50, hex: '#B36567' },
];

const DEFAULT_DEMO_MATCH_THRESHOLD = 25.0; // Distance considered "large" -> "No match, retake"
const DEMO_STABILITY_THRESHOLD = 3.5;       // Max spread across L*, a*, b* for stability
const ROI_STDDEV_THRESHOLD = 24.0;          // Quality gate: max channel stddev for uniformity
const CLIPPED_PIXEL_THRESHOLD = 0.02;       // Quality gate: max fraction of pixels near 0 or 255

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

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return [149, 87, 141];
  const clean = hex.replace('#', '').trim();
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(rgb) {
  if (!rgb || !Array.isArray(rgb)) return '#000000';
  const [r, g, b] = rgb.map((c) => clamp(Math.round(c), 0, 255));
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
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

// Convert the five 25 C reference colors to Lab internally and compute chart shifts vs 0 ppm
const CHART_REFERENCE_POINTS = DEMO_REFERENCE_TABLE.map((entry) => {
  const rgb = hexToRgb(entry.hex);
  const lab = rgbToLab(rgb);
  return {
    ppm: entry.ppm,
    hex: entry.hex.toUpperCase(),
    rgb,
    lab,
    L: lab[0],
    a: lab[1],
    b: lab[2],
    tempC: 25,
  };
});

const REF_0_CHART = CHART_REFERENCE_POINTS[0];
const CHART_REF_POINT = { L: REF_0_CHART.lab[0], a: REF_0_CHART.lab[1], b: REF_0_CHART.lab[2] };

CHART_REFERENCE_POINTS.forEach((pt) => {
  pt.shift = [
    Number((pt.lab[0] - REF_0_CHART.lab[0]).toFixed(2)),
    Number((pt.lab[1] - REF_0_CHART.lab[1]).toFixed(2)),
    Number((pt.lab[2] - REF_0_CHART.lab[2]).toFixed(2)),
  ];
});

// Alias for backwards compatibility
const CHART_DEMO_REFERENCE_TABLE = CHART_REFERENCE_POINTS;

/**
 * Weighted shift distance: weights L 0.3, a 0.3, b 2
 */
function calculateShiftDistance(shiftA, shiftB) {
  const dL = shiftA[0] - shiftB[0];
  const da = shiftA[1] - shiftB[1];
  const db = shiftA[2] - shiftB[2];
  return Math.sqrt(0.3 * dL * dL + 0.3 * da * da + 2.0 * db * db);
}

function calculateWeightedDistance(lab, row) {
  const shift = [lab[0] - REF_0_CHART.lab[0], lab[1] - REF_0_CHART.lab[1], lab[2] - REF_0_CHART.lab[2]];
  return calculateShiftDistance(shift, row.shift);
}

function computeAlignedLab(sampleLab, refLab) {
  const dL = REF_0_CHART.lab[0] - refLab[0];
  const da = REF_0_CHART.lab[1] - refLab[1];
  const db = REF_0_CHART.lab[2] - refLab[2];
  return [
    Number((sampleLab[0] + dL).toFixed(2)),
    Number((sampleLab[1] + da).toFixed(2)),
    Number((sampleLab[2] + db).toFixed(2)),
  ];
}

function computeDeltaVsRef(sampleLab, refLab) {
  const dL = Number((sampleLab[0] - refLab[0]).toFixed(2));
  const da = Number((sampleLab[1] - refLab[1]).toFixed(2));
  const db = Number((sampleLab[2] - refLab[2]).toFixed(2));
  const dE = Number(Math.sqrt(dL * dL + da * da + db * db).toFixed(2));
  return { dL, da, db, dE };
}

/**
 * Parses any color format (hex string, RGB array [0-255], or Lab array) into normalized { lab, rgb, hex }
 */
function toColorObject(color, fallbackHex = '#95578D') {
  if (!color) {
    const rgb = hexToRgb(fallbackHex);
    return { hex: fallbackHex.toUpperCase(), rgb, lab: rgbToLab(rgb) };
  }
  if (typeof color === 'string') {
    const rgb = hexToRgb(color);
    return { hex: color.toUpperCase(), rgb, lab: rgbToLab(rgb) };
  }
  if (Array.isArray(color)) {
    // If negative chromaticity or decimals with L <= 100, treat as Lab
    const isLab = color.some((v) => v < 0 || (!Number.isInteger(v) && Math.abs(v) <= 128)) && color[0] <= 100;
    if (isLab) {
      const rgb = labToRgb(color);
      return {
        lab: [Number(color[0].toFixed(2)), Number(color[1].toFixed(2)), Number(color[2].toFixed(2))],
        rgb,
        hex: rgbToHex(rgb),
      };
    }
    // Otherwise RGB
    const rgb = [clamp(Math.round(color[0]), 0, 255), clamp(Math.round(color[1]), 0, 255), clamp(Math.round(color[2]), 0, 255)];
    return {
      rgb,
      lab: rgbToLab(rgb),
      hex: rgbToHex(rgb),
    };
  }
  if (color.lab) {
    const lab = color.lab;
    const rgb = color.rgb || labToRgb(lab);
    const hex = color.hex || rgbToHex(rgb);
    return { lab, rgb, hex };
  }
  return { hex: fallbackHex.toUpperCase(), rgb: hexToRgb(fallbackHex), lab: rgbToLab(hexToRgb(fallbackHex)) };
}

/**
 * Color-only match against fixed 25 C reference table:
 * 1. Convert all colors to Lab internally
 * 2. Observed shift: sample Lab minus measured reference Lab
 * 3. Find nearest chart shift using weights L 0.3, a 0.3, b 2
 * 4. Interpolate ppm between two nearest points. Clamp 0 to 50.
 * 5. If top two are within a small distance of each other, show range like "40 to 50 ppm".
 *    If nearest distance > 25, show "No match, retake".
 */
function matchDemoColor(refInput, sampleInput, { threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
  const refColor = toColorObject(refInput, '#95578D');
  const sampleColor = toColorObject(sampleInput, '#95578D');

  const refLab = refColor.lab;
  const sampleLab = sampleColor.lab;

  // Observed shift: sample Lab minus measured reference Lab
  const observedShift = [
    sampleLab[0] - refLab[0],
    sampleLab[1] - refLab[1],
    sampleLab[2] - refLab[2],
  ];

  // Score against chart shifts
  const scored = CHART_REFERENCE_POINTS.map((pt) => {
    const dist = calculateShiftDistance(observedShift, pt.shift);
    return {
      ...pt,
      distance: dist,
    };
  }).sort((a, b) => a.distance - b.distance);

  const first = scored[0];
  const second = scored[1];
  const d1 = first.distance;
  const d2 = second.distance;

  // Check if nearest distance is large
  if (d1 > threshold) {
    return {
      matched: false,
      ppm: null,
      estimatedPpm: null,
      range: null,
      isRange: false,
      displayPpm: 'No match, retake',
      observedRefHex: refColor.hex,
      observedSampleHex: sampleColor.hex,
      matchedChartHex: first.hex,
      distance: Number(d1.toFixed(2)),
      label: 'Demo estimate, color match',
      refColor,
      sampleColor,
      candidates: scored,
    };
  }

  // Interpolate ppm between two nearest chart points
  let interpolatedPpm;
  if (d1 < 1e-4) {
    interpolatedPpm = first.ppm;
  } else {
    const w1 = 1 / Math.max(d1, 1e-6);
    const w2 = 1 / Math.max(d2, 1e-6);
    interpolatedPpm = (first.ppm * w1 + second.ppm * w2) / (w1 + w2);
  }
  const estimatedPpm = clamp(Math.round(interpolatedPpm * 10) / 10, 0, 50);

  // Range determination: if top two candidates are within a small distance of each other (e.g. 40 and 50)
  const candShiftDist = calculateShiftDistance(first.shift, second.shift);
  let isRange = false;
  let rangeStr = null;

  if (candShiftDist <= 4.0 || Math.abs(d2 - d1) <= 2.5) {
    const minPpm = Math.min(first.ppm, second.ppm);
    const maxPpm = Math.max(first.ppm, second.ppm);
    if (minPpm !== maxPpm) {
      isRange = true;
      rangeStr = `${minPpm} to ${maxPpm} ppm`;
    }
  }

  const displayPpm = isRange ? rangeStr : `${estimatedPpm} ppm`;

  return {
    matched: true,
    ppm: estimatedPpm,
    estimatedPpm,
    range: rangeStr,
    isRange,
    displayPpm,
    observedRefHex: refColor.hex,
    observedSampleHex: sampleColor.hex,
    matchedChartHex: first.hex,
    distance: Number(d1.toFixed(2)),
    label: 'Demo estimate, color match',
    refColor,
    sampleColor,
    candidates: scored,
    first,
    second,
    valueOf() {
      return this.ppm;
    },
    toString() {
      return this.displayPpm;
    },
  };
}

function findNearestChartMatch(alignedLab, { threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
  const match = matchDemoColor(REF_0_CHART.lab, alignedLab, { threshold });
  if (!match.matched) {
    return {
      matched: false,
      label: 'No match',
      distance: match.distance,
      ppm: null,
      chartHex: match.matchedChartHex,
      cellLab: match.first ? match.first.lab : null,
      cellTempC: 25,
    };
  }

  return {
    matched: true,
    label: 'Demo estimate, color match',
    ppm: match.ppm,
    displayPpm: match.displayPpm,
    range: match.range,
    distance: match.distance,
    chartHex: match.matchedChartHex,
    cellLab: match.first.lab,
    cellTempC: 25,
  };
}

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

function processDemoColorReadout(sampleLabs, { threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
  const refInput = sampleLabs.ref;
  const sampleInput = sampleLabs.sample || sampleLabs.s1;

  if (!refInput) throw new Error('Reference color (0 ppm) is required.');
  if (!sampleInput) throw new Error('Sample color is required.');

  const match = matchDemoColor(refInput, sampleInput, { threshold });

  const refAligned = [REF_0_CHART.lab[0], REF_0_CHART.lab[1], REF_0_CHART.lab[2]];
  const sampleAligned = computeAlignedLab(match.sampleColor.lab, match.refColor.lab);
  const sampleDelta = computeDeltaVsRef(match.sampleColor.lab, match.refColor.lab);

  const refResult = {
    key: 'ref',
    name: 'Reference (0 ppm)',
    shortName: 'REF',
    color: DEMO_ROIS.ref.color,
    measuredLab: match.refColor.lab,
    alignedLab: refAligned,
    hex: match.observedRefHex,
    deltaVsRef: { dL: 0, da: 0, db: 0, dE: 0 },
    nearestMatch: {
      matched: true,
      ppm: 0,
      distance: 0,
      chartHex: REF_0_CHART.hex,
      label: 'Demo estimate, color match',
      cellLab: REF_0_CHART.lab,
      cellTempC: 25,
    },
  };

  const sampleNearestMatch = {
    matched: match.matched,
    ppm: match.ppm,
    estimatedPpm: match.estimatedPpm,
    range: match.range,
    displayPpm: match.displayPpm,
    distance: match.distance,
    chartHex: match.matchedChartHex,
    label: match.label,
    cellLab: match.first ? match.first.lab : null,
    cellTempC: 25,
  };

  const sampleResult = {
    key: 'sample',
    name: 'Sample Patch',
    shortName: 'SMP',
    color: DEMO_ROIS.sample.color,
    measuredLab: match.sampleColor.lab,
    alignedLab: sampleAligned,
    hex: match.observedSampleHex,
    deltaVsRef: sampleDelta,
    nearestMatch: sampleNearestMatch,
    ppm: match.ppm,
    displayPpm: match.displayPpm,
    range: match.range,
  };

  return {
    version: DEMO_ESTIMATOR_VERSION,
    tempC: 25,
    matched: match.matched,
    ppm: match.ppm,
    estimatedPpm: match.estimatedPpm,
    range: match.range,
    displayPpm: match.displayPpm,
    isRange: match.isRange,
    distance: match.distance,
    label: match.label,
    observedRefHex: match.observedRefHex,
    observedSampleHex: match.observedSampleHex,
    matchedChartHex: match.matchedChartHex,
    ref: refResult,
    sample: sampleResult,
    s1: sampleResult,
    alignedLabs: {
      ref: refAligned,
      sample: sampleAligned,
      s1: sampleAligned,
    },
    deltas: {
      ref: { dL: 0, da: 0, db: 0, dE: 0 },
      sample: sampleDelta,
      s1: sampleDelta,
    },
    matches: {
      ref: refResult.nearestMatch,
      sample: sampleNearestMatch,
      s1: sampleNearestMatch,
    },
    valueOf() {
      return this.ppm;
    },
    toString() {
      return this.displayPpm;
    },
  };
}

function createDemoBadgeCanvas({ samplePpm = 20, tint = [0, 0, 0], noiseStddev = 0, clippedPixels = 0, clipRatio = 0, saturated = false } = {}) {
  const width = 640;
  const height = 480;

  const isBrowserCanvas = typeof window !== 'undefined' && typeof window.document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
  let canvas;
  if (isBrowserCanvas) {
    canvas = document.createElement('canvas');
  } else {
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

  const refPoint = CHART_REFERENCE_POINTS.find((r) => r.ppm === 0);
  const refRgb = labToRgb([refPoint.lab[0] + tint[0], refPoint.lab[1] + tint[1], refPoint.lab[2] + tint[2]]);

  const samplePoint = CHART_REFERENCE_POINTS.find((r) => r.ppm === samplePpm) || refPoint;
  const sampleRgb = labToRgb([samplePoint.lab[0] + tint[0], samplePoint.lab[1] + tint[1], samplePoint.lab[2] + tint[2]]);

  const colors = {
    ref: refRgb,
    sample: sampleRgb,
  };

  if (isBrowserCanvas && ctx) {
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

          if (noiseStddev > 0 && key === 'sample') {
            const noise = ((pixelIndex % 2 === 0 ? 1 : -1) * noiseStddev * 1.5);
            r = clamp(Math.round(r + noise), 10, 240);
            g = clamp(Math.round(g + noise), 10, 240);
            b = clamp(Math.round(b + noise), 10, 240);
          }

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
  DEMO_REFERENCE_TABLE,
  CHART_REFERENCE_POINTS,
  CHART_REF_POINT,
  CHART_DEMO_REFERENCE_TABLE,
  DEMO_ROIS,
  DEFAULT_DEMO_MATCH_THRESHOLD,
  DEMO_STABILITY_THRESHOLD,
  ROI_STDDEV_THRESHOLD,
  CLIPPED_PIXEL_THRESHOLD,
  clamp,
  hexToRgb,
  rgbToHex,
  srgbToLinearChannel,
  linearToSrgbChannel,
  rgbToLab,
  labToRgb,
  computeAlignedLab,
  computeDeltaVsRef,
  calculateShiftDistance,
  calculateWeightedDistance,
  matchDemoColor,
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
