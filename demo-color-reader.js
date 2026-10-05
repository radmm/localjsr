/**
 * H2S Badge Reader - Color-First Demo Mode Module
 *
 * 1. Layout: one guide rectangle split vertically.
 *    Left half is the 0 ppm reference, right half is the sample.
 *    Sample only the center 40% of each half, leaving a margin from divider and edges.
 *    Marker detection dropped; guide frame used.
 *
 * 2. Capture:
 *    - Lock exposure and white balance via applyConstraints where supported, show whether locked.
 *    - Capture 20 frames, take the per-channel median per ROI, then convert to Lab.
 *    - Reject the capture if frame-to-frame spread of db is above 1.5, show "Hold steady".
 *
 * 3. Estimation:
 *    - db = b*(sample) minus b*(reference). Use db only.
 *    - Piecewise linear, monotonic interpolation on 25 C table:
 *      db 0 -> 0 ppm, 15.71 -> 10, 18.59 -> 20, 29.89 -> 40, 31.85 -> 50. Clamp 0 to 50.
 *    - Show a range: ppm at db minus spread to db plus spread. Example "10 to 20 ppm".
 *
 * 4. Diagnostics:
 *    - Show reference hex, sample hex, db, and ppm for each capture.
 *    - "Repeat test" button: runs 10 captures and shows mean, min, and max of db and ppm.
 *    - History list of the last 10 readings.
 */

(function () {
  'use strict';

  const DEMO_ESTIMATOR_VERSION = 'color-first-v2.0';
  const DEMO_HISTORY_STORAGE_KEY = 'h2s-demo-history';
  const SPREAD_THRESHOLD_DB = 1.5;
  const ROI_STDDEV_THRESHOLD = 24.0;
  const CLIPPED_PIXEL_THRESHOLD = 0.02;
  const DEFAULT_DEMO_MATCH_THRESHOLD = 25.0;
  const DEMO_STABILITY_THRESHOLD = 1.5;

  // Fixed 25 C reference table
  const DEMO_REFERENCE_TABLE = [
    { ppm: 0,  hex: '#95578D', db: 0.0 },
    { ppm: 10, hex: '#995873', db: 15.71 },
    { ppm: 20, hex: '#9C4F6A', db: 18.59 },
    { ppm: 40, hex: '#B26169', db: 29.89 },
    { ppm: 50, hex: '#B36567', db: 31.85 },
  ];

  // Layout: one guide rectangle split vertically.
  // Left half (x: 0..0.5): center 40% is x: 0.15, y: 0.30, w: 0.20, h: 0.40.
  // Right half (x: 0.5..1.0): center 40% is x: 0.65, y: 0.30, w: 0.20, h: 0.40.
  // This leaves 15% margin from edges, 15% from center divider, and 30% top/bottom.
  const DEMO_ROIS = {
    ref: {
      key: 'ref',
      name: 'Reference (0 ppm)',
      shortName: 'REF',
      half: { x: 0.0, y: 0.0, w: 0.5, h: 1.0 },
      x: 0.15,
      y: 0.30,
      w: 0.20,
      h: 0.40,
      color: '#38bdf8',
    },
    sample: {
      key: 'sample',
      name: 'Sample Patch',
      shortName: 'SMP',
      half: { x: 0.5, y: 0.0, w: 0.5, h: 1.0 },
      x: 0.65,
      y: 0.30,
      w: 0.20,
      h: 0.40,
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
      db: entry.db,
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
  const CHART_DEMO_REFERENCE_TABLE = CHART_REFERENCE_POINTS;

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
      const isLab = color.some((v) => v < 0 || (!Number.isInteger(v) && Math.abs(v) <= 128)) && color[0] <= 100;
      if (isLab) {
        const rgb = labToRgb(color);
        return {
          lab: [Number(color[0].toFixed(2)), Number(color[1].toFixed(2)), Number(color[2].toFixed(2))],
          rgb,
          hex: rgbToHex(rgb),
        };
      }
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
   * Piecewise linear, monotonic interpolation on this 25 C table:
   * db 0 -> 0 ppm, 15.71 -> 10, 18.59 -> 20, 29.89 -> 40, 31.85 -> 50.
   * Clamp to 0 to 50.
   */
  function interpolateDemoPpm(db) {
    const table = DEMO_REFERENCE_TABLE;
    if (db <= table[0].db) {
      return table[0].ppm;
    }
    const last = table[table.length - 1];
    if (db >= last.db) {
      return last.ppm;
    }
    for (let i = 0; i < table.length - 1; i++) {
      const p1 = table[i];
      const p2 = table[i + 1];
      if (db >= p1.db && db <= p2.db) {
        const fraction = (db - p1.db) / (p2.db - p1.db);
        const ppm = p1.ppm + fraction * (p2.ppm - p1.ppm);
        return clamp(ppm, 0, 50);
      }
    }
    return 0;
  }

  /**
   * Find nearest entry in DEMO_REFERENCE_TABLE by db
   */
  function findNearestDemoPatch(db) {
    let nearest = DEMO_REFERENCE_TABLE[0];
    let minDiff = Infinity;
    for (const item of DEMO_REFERENCE_TABLE) {
      const diff = Math.abs(db - item.db);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = item;
      }
    }
    return nearest;
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
   * Estimation function (replaces nearest-neighbor):
   * db = b*(sample) minus b*(reference). Use db only.
   * Piecewise linear, monotonic interpolation on 25 C table:
   * db 0 -> 0 ppm, 15.71 -> 10, 18.59 -> 20, 29.89 -> 40, 31.85 -> 50. Clamp 0 to 50.
   * Show a range: ppm at db minus spread to db plus spread. Example "10 to 20 ppm".
   */
  function matchDemoColor(refInput, sampleInput, { spread = 0, threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
    let db;
    let refColor, sampleColor;

    if (typeof refInput === 'number' && (sampleInput === undefined || (typeof sampleInput === 'object' && !Array.isArray(sampleInput) && !sampleInput?.lab))) {
      db = Number(refInput.toFixed(2));
      const nearest = findNearestDemoPatch(db);
      refColor = { hex: '#95578D', rgb: hexToRgb('#95578D'), lab: [45.77, 34.05, -19.46] };
      sampleColor = { hex: nearest.hex, rgb: hexToRgb(nearest.hex), lab: [45.77, 34.05, -19.46 + db] };
    } else {
      refColor = toColorObject(refInput, '#95578D');
      sampleColor = toColorObject(sampleInput, '#95578D');
      const refLab = refColor.lab;
      const sampleLab = sampleColor.lab;
      db = Number((sampleLab[2] - refLab[2]).toFixed(2));
    }

    const estimatedPpm = clamp(Math.round(interpolateDemoPpm(db) * 10) / 10, 0, 50);
    const nearestPatch = findNearestDemoPatch(db);
    const dist = Number(Math.abs(db - nearestPatch.db).toFixed(2));

    // Show a range: ppm at db minus spread to db plus spread.
    const effectiveSpread = Math.max(0, spread);
    const dbLow = db - effectiveSpread;
    const dbHigh = db + effectiveSpread;
    const ppmLow = Math.round(interpolateDemoPpm(dbLow));
    const ppmHigh = Math.round(interpolateDemoPpm(dbHigh));

    const isRange = true;
    const rangeStr = `${ppmLow} to ${ppmHigh} ppm`;
    const displayPpm = rangeStr;

    const matched = true;

    return {
      matched,
      ppm: estimatedPpm,
      estimatedPpm,
      db,
      range: rangeStr,
      isRange,
      displayPpm,
      observedRefHex: refColor.hex,
      observedSampleHex: sampleColor.hex,
      matchedChartHex: nearestPatch.hex,
      nearestPatchPpm: nearestPatch.ppm,
      distance: dist,
      label: 'Demo estimate, color match',
      refColor,
      sampleColor,
      first: nearestPatch,
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
    return {
      matched: match.matched,
      label: 'Demo estimate, color match',
      ppm: match.ppm,
      db: match.db,
      displayPpm: match.displayPpm,
      range: match.range,
      distance: match.distance,
      chartHex: match.matchedChartHex,
      cellLab: match.first ? match.first.lab : null,
      cellTempC: 25,
    };
  }

  /**
   * Sample the center 40% of the ROI
   */
  function sampleRoiMedian(context, width, height, roi) {
    const x = Math.max(0, Math.floor(roi.x * width));
    const y = Math.max(0, Math.floor(roi.y * height));
    const right = Math.min(width, Math.ceil((roi.x + roi.w) * width));
    const bottom = Math.min(height, Math.ceil((roi.y + roi.h) * height));

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

    const calcMedian = (arr) => {
      if (!arr.length) return 128;
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    return [
      calcMedian(channels[0]),
      calcMedian(channels[1]),
      calcMedian(channels[2]),
    ];
  }

  function evaluatePatchGates(context, width, height, roi) {
    const x = Math.max(0, Math.floor(roi.x * width));
    const y = Math.max(0, Math.floor(roi.y * height));
    const right = Math.min(width, Math.ceil((roi.x + roi.w) * width));
    const bottom = Math.min(height, Math.ceil((roi.y + roi.h) * height));

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

  /**
   * Process 20 frames for Demo Mode:
   * - Capture 20 frames, take the per-channel median per ROI, then convert to Lab.
   * - Reject the capture if the frame-to-frame spread of db is above 1.5, and show "Hold steady".
   */
  function processDemoFrames(frames) {
    if (!frames || !frames.length) {
      return { valid: false, refusalReason: 'No frames captured' };
    }

    const frameCount = frames.length;
    const perFrameRefRgb = [];
    const perFrameSampleRgb = [];
    const perFrameDb = [];
    let gatesFailed = false;
    let gateRefusal = null;

    for (let i = 0; i < frameCount; i++) {
      const frame = frames[i];
      const ctx = frame.getContext('2d');
      const width = frame.width;
      const height = frame.height;

      const gRef = evaluatePatchGates(ctx, width, height, DEMO_ROIS.ref);
      const gSample = evaluatePatchGates(ctx, width, height, DEMO_ROIS.sample);
      if (!gRef.passed && !gatesFailed) {
        gatesFailed = true;
        gateRefusal = `Reference: ${gRef.failureReason}`;
      } else if (!gSample.passed && !gatesFailed) {
        gatesFailed = true;
        gateRefusal = `Sample: ${gSample.failureReason}`;
      }

      const rRgb = sampleRoiMedian(ctx, width, height, DEMO_ROIS.ref);
      const sRgb = sampleRoiMedian(ctx, width, height, DEMO_ROIS.sample);
      const rLab = rgbToLab(rRgb);
      const sLab = rgbToLab(sRgb);

      perFrameRefRgb.push(rRgb);
      perFrameSampleRgb.push(sRgb);
      const curDb = Number((sLab[2] - rLab[2]).toFixed(2));
      perFrameDb.push(curDb);
    }

    // Frame-to-frame spread of db
    const minDb = Math.min(...perFrameDb);
    const maxDb = Math.max(...perFrameDb);
    const spreadDb = frameCount > 1 ? Number((maxDb - minDb).toFixed(2)) : 0.0;

    // Reject if frame-to-frame spread of db is above 1.5, show "Hold steady"
    if (frameCount > 1 && spreadDb > SPREAD_THRESHOLD_DB) {
      return {
        valid: false,
        refusalReason: 'Hold steady',
        spreadDb,
      };
    }

    if (gatesFailed) {
      return {
        valid: false,
        refusalReason: gateRefusal,
      };
    }

    // Take per-channel median per ROI across 20 frames, then convert to Lab
    const calcMedianChannel = (values, channelIdx) => {
      const arr = values.map((v) => v[channelIdx]).sort((a, b) => a - b);
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };

    const medianRefRgb = [
      Math.round(calcMedianChannel(perFrameRefRgb, 0)),
      Math.round(calcMedianChannel(perFrameRefRgb, 1)),
      Math.round(calcMedianChannel(perFrameRefRgb, 2)),
    ];
    const medianSampleRgb = [
      Math.round(calcMedianChannel(perFrameSampleRgb, 0)),
      Math.round(calcMedianChannel(perFrameSampleRgb, 1)),
      Math.round(calcMedianChannel(perFrameSampleRgb, 2)),
    ];

    const medianRefLab = rgbToLab(medianRefRgb);
    const medianSampleLab = rgbToLab(medianSampleRgb);

    const match = matchDemoColor(medianRefLab, medianSampleLab, { spread: spreadDb });

    return {
      ...match,
      valid: true,
      refusalReason: null,
      spreadDb,
      medianRefRgb,
      medianSampleRgb,
      medianRefLab,
      medianSampleLab,
    };
  }

  function processDemoColorReadout(sampleLabs, { spread = 0, threshold = DEFAULT_DEMO_MATCH_THRESHOLD } = {}) {
    const refInput = sampleLabs.ref;
    const sampleInput = sampleLabs.sample || sampleLabs.s1;

    if (!refInput) throw new Error('Reference color (0 ppm) is required.');
    if (!sampleInput) throw new Error('Sample color is required.');

    const match = matchDemoColor(refInput, sampleInput, { spread, threshold });

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
      db: match.db,
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
      db: match.db,
      displayPpm: match.displayPpm,
      range: match.range,
    };

    return {
      version: DEMO_ESTIMATOR_VERSION,
      tempC: 25,
      matched: match.matched,
      ppm: match.ppm,
      db: match.db,
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

  /**
   * Run Repeat Test for Demo Mode: 10 captures, compute mean, min, max of db and ppm
   */
  async function runDemoRepeatTest(captureFunction, count = 10) {
    const results = [];
    for (let i = 0; i < count; i++) {
      const frames = await captureFunction();
      const res = processDemoFrames(frames);
      if (res.valid) {
        results.push(res);
      }
    }

    if (!results.length) return null;

    const dbVals = results.map((r) => r.db);
    const ppmVals = results.map((r) => r.ppm);
    const mean = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;

    return {
      count: results.length,
      db: {
        mean: Number(mean(dbVals).toFixed(2)),
        min: Number(Math.min(...dbVals).toFixed(2)),
        max: Number(Math.max(...dbVals).toFixed(2)),
      },
      ppm: {
        mean: Number(mean(ppmVals).toFixed(1)),
        min: Number(Math.min(...ppmVals).toFixed(1)),
        max: Number(Math.max(...ppmVals).toFixed(1)),
      },
      results,
    };
  }

  function getDemoHistory() {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(DEMO_HISTORY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function addDemoHistory(reading) {
    if (typeof localStorage === 'undefined') return;
    try {
      const list = getDemoHistory();
      list.unshift(reading);
      if (list.length > 10) list.length = 10;
      localStorage.setItem(DEMO_HISTORY_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function deleteDemoHistory() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(DEMO_HISTORY_STORAGE_KEY);
    } catch (e) {}
  }

  /**
   * Synthetic canvas generator:
   * Layout: one guide rectangle split vertically.
   * Left half is the 0 ppm reference, right half is the sample.
   */
  function createDemoBadgeCanvas({ samplePpm = 20, sampleHex = null, tint = [0, 0, 0], noiseStddev = 0, clippedPixels = 0, saturated = false } = {}) {
    const width = 640;
    const height = 480;

    const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
    let canvas;
    if (isBrowser) {
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

    const refPoint = CHART_REFERENCE_POINTS.find((r) => r.ppm === 0);
    const refRgb = labToRgb([refPoint.lab[0] + tint[0], refPoint.lab[1] + tint[1], refPoint.lab[2] + tint[2]]);

    let sampleRgb;
    if (sampleHex) {
      const sLab = rgbToLab(hexToRgb(sampleHex));
      sampleRgb = labToRgb([sLab[0] + tint[0], sLab[1] + tint[1], sLab[2] + tint[2]]);
    } else {
      const samplePoint = CHART_REFERENCE_POINTS.find((r) => r.ppm === samplePpm) || refPoint;
      sampleRgb = labToRgb([samplePoint.lab[0] + tint[0], samplePoint.lab[1] + tint[1], samplePoint.lab[2] + tint[2]]);
    }

    if (isBrowser) {
      const ctx = canvas.getContext('2d');
      // Left half (0 ppm reference)
      ctx.fillStyle = `rgb(${refRgb[0]}, ${refRgb[1]}, ${refRgb[2]})`;
      ctx.fillRect(0, 0, width / 2, height);

      // Right half (sample)
      ctx.fillStyle = `rgb(${sampleRgb[0]}, ${sampleRgb[1]}, ${sampleRgb[2]})`;
      ctx.fillRect(width / 2, 0, width / 2, height);
    } else {
      const px = canvas._pixels;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const isLeft = x < width / 2;
          const color = isLeft ? refRgb : sampleRgb;

          let r = color[0];
          let g = color[1];
          let b = color[2];

          if (noiseStddev > 0 && !isLeft) {
            const noise = ((x + y) % 2 === 0 ? 1 : -1) * noiseStddev * 1.5;
            r = clamp(Math.round(r + noise), 10, 240);
            g = clamp(Math.round(g + noise), 10, 240);
            b = clamp(Math.round(b + noise), 10, 240);
          }

          if ((saturated || clippedPixels > 0) && !isLeft) {
            r = 255;
            g = 255;
            b = 255;
          }

          px[idx] = r;
          px[idx + 1] = g;
          px[idx + 2] = b;
          px[idx + 3] = 255;
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
    SPREAD_THRESHOLD_DB,
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
    interpolateDemoPpm,
    findNearestDemoPatch,
    matchDemoColor,
    findNearestChartMatch,
    sampleRoiMedian,
    evaluatePatchGates,
    checkDemoQualityGates,
    sampleDemoCanvas,
    processDemoFrames,
    runDemoRepeatTest,
    getDemoHistory,
    addDemoHistory,
    deleteDemoHistory,
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
