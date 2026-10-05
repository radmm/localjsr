/**
 * H2S Badge Reader - Brown Scale Dedicated Module
 * 
 * Method:
 * 1. Guide rectangle split vertically: Left half is Pristine (#C4C3BF), Right half is Sample.
 * 2. Center 40% sampling away from divider and edges.
 * 3. 20-frame capture, per-channel median per half, convert to Lab.
 * 4. Reject with "Hold steady" if frame-to-frame spread of L* is above 1.0.
 * 5. Primary signal: dL = L*(reference) - L*(sample). Use dL only for ppm.
 * 6. Piecewise linear monotonic interpolation:
 *    0 -> 0, 7.8 -> 1, 12.8 -> 5, 23.3 -> 10, 36.8 -> 20, 45.0 -> 50, 53.0 -> 100. Clamp 0 to 100.
 * 7. Show range from dL - spread to dL + spread ("10 to 20 ppm"), and nearest labeled patch.
 * 8. Calibration for 6 ppm levels (1, 5, 10, 20, 50, 100) stored in localStorage.
 * 9. Diagnostics: Repeat test (10 captures: mean, min, max of dL and ppm) & history of last 10 readings.
 */

(function () {
  'use strict';

  const BROWN_SCALE_CALIBRATION_STORAGE_KEY = 'h2s-brown-scale-calibration';
  const BROWN_SCALE_HISTORY_STORAGE_KEY = 'h2s-brown-scale-history';
  const SPREAD_THRESHOLD_L = 1.0;
  const ROI_STDDEV_THRESHOLD = 24.0;
  const CLIPPED_PIXEL_THRESHOLD = 0.02;
  const PRISTINE_MAX_DELTA_E = 25.0;

  // Reference table (hex, Lab internally)
  const BROWN_SCALE_REFERENCE_TABLE = [
    { ppm: 0,   name: 'Pristine', hex: '#C4C3BF', dL: 0.0 },
    { ppm: 1,   name: '1 ppm',    hex: '#C9A793', dL: 7.8 },
    { ppm: 5,   name: '5 ppm',    hex: '#C39782', dL: 12.8 },
    { ppm: 10,  name: '10 ppm',   hex: '#B17762', dL: 23.3 },
    { ppm: 20,  name: '20 ppm',   hex: '#8F5346', dL: 36.8 },
    { ppm: 50,  name: '50 ppm',   hex: '#6C463E', dL: 45.0 },
    { ppm: 100, name: '100 ppm',  hex: '#4D3837', dL: 53.0 },
  ];

  // Two ROIs: one guide rectangle split vertically.
  // Left half (x: 0..0.5): center 40% is x: 0.15, y: 0.30, w: 0.20, h: 0.40.
  // Right half (x: 0.5..1.0): center 40% is x: 0.65, y: 0.30, w: 0.20, h: 0.40.
  const BROWN_SCALE_ROIS = {
    ref: {
      key: 'ref',
      name: 'Pristine Reference (0 ppm)',
      shortName: 'REF',
      half: { x: 0.0, y: 0.0, w: 0.5, h: 1.0 },
      x: 0.15,
      y: 0.30,
      w: 0.20,
      h: 0.40,
      color: '#C4C3BF',
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
      color: '#8F5346',
    },
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return [196, 195, 191];
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

  // Pre-calculate Lab for reference table
  const REFERENCE_POINTS = BROWN_SCALE_REFERENCE_TABLE.map((item) => {
    const rgb = hexToRgb(item.hex);
    const lab = rgbToLab(rgb);
    return {
      ...item,
      rgb,
      lab,
    };
  });

  const PRISTINE_LAB = REFERENCE_POINTS[0].lab;

  /**
   * Sample the center 40% of an ROI
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

  /**
   * Evaluate uniformity and clipping gates
   */
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

  /**
   * Monotonic piecewise linear interpolation of ppm against dL
   * Table: 0 -> 0, 7.8 -> 1, 12.8 -> 5, 23.3 -> 10, 36.8 -> 20, 45.0 -> 50, 53.0 -> 100
   * Clamped to 0 to 100.
   */
  function interpolateBrownScalePpm(dL, calibrationData = null) {
    let table;
    if (calibrationData && Array.isArray(calibrationData) && calibrationData.length >= 2) {
      table = calibrationData.slice().sort((a, b) => a.dL - b.dL);
    } else {
      table = BROWN_SCALE_REFERENCE_TABLE.map((r) => ({ dL: r.dL, ppm: r.ppm }));
    }

    if (dL <= table[0].dL) {
      return table[0].ppm;
    }
    const last = table[table.length - 1];
    if (dL >= last.dL) {
      return last.ppm;
    }

    for (let i = 0; i < table.length - 1; i++) {
      const p1 = table[i];
      const p2 = table[i + 1];
      if (dL >= p1.dL && dL <= p2.dL) {
        if (Math.abs(p2.dL - p1.dL) < 1e-6) return p1.ppm;
        const fraction = (dL - p1.dL) / (p2.dL - p1.dL);
        const ppm = p1.ppm + fraction * (p2.ppm - p1.ppm);
        return clamp(ppm, 0, 100);
      }
    }
    return 0;
  }

  /**
   * Find the nearest labeled patch in the reference table
   */
  function findNearestBrownScalePatch(dL) {
    let nearest = BROWN_SCALE_REFERENCE_TABLE[0];
    let minDiff = Infinity;
    for (const item of BROWN_SCALE_REFERENCE_TABLE) {
      const diff = Math.abs(dL - item.dL);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = item;
      }
    }
    return nearest;
  }

  /**
   * Get active calibration from localStorage if any
   */
  function getCalibration() {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(BROWN_SCALE_CALIBRATION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length < 2) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save calibration for a single ppm level
   */
  function saveCalibrationLevel(ppm, pristineHex, sampleHex, dL) {
    if (typeof localStorage === 'undefined') return;
    try {
      let current = getCalibration() || [
        { ppm: 0, pristineHex: '#C4C3BF', sampleHex: '#C4C3BF', dL: 0.0, timestamp: new Date().toISOString() },
      ];
      // Filter out existing calibration for this ppm if any
      current = current.filter((c) => c.ppm !== ppm);
      current.push({
        ppm: Number(ppm),
        pristineHex,
        sampleHex,
        dL: Number(dL),
        timestamp: new Date().toISOString(),
      });
      // Sort by dL
      current.sort((a, b) => a.dL - b.dL);
      localStorage.setItem(BROWN_SCALE_CALIBRATION_STORAGE_KEY, JSON.stringify(current));
    } catch (e) {
      console.warn('Could not save calibration:', e);
    }
  }

  /**
   * Reset / delete calibration
   */
  function deleteCalibration() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(BROWN_SCALE_CALIBRATION_STORAGE_KEY);
    } catch (e) {}
  }

  /**
   * Get history of last 10 readings
   */
  function getHistory() {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(BROWN_SCALE_HISTORY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Add reading to history (keeps last 10)
   */
  function addHistory(reading) {
    if (typeof localStorage === 'undefined') return;
    try {
      const list = getHistory();
      list.unshift(reading);
      if (list.length > 10) list.length = 10;
      localStorage.setItem(BROWN_SCALE_HISTORY_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  /**
   * Delete all history
   */
  function deleteAllHistory() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(BROWN_SCALE_HISTORY_STORAGE_KEY);
    } catch (e) {}
  }

  /**
   * Core Estimation logic for two color inputs (Hex, RGB array, or Lab array)
   */
  function estimateBrownScale(refInput, sampleInput, { spread = 0, calibration = null } = {}) {
    let refRgb, refLab, refHex;
    let smpRgb, smpLab, smpHex;

    if (typeof refInput === 'string') {
      refHex = refInput.toUpperCase();
      refRgb = hexToRgb(refHex);
      refLab = rgbToLab(refRgb);
    } else if (Array.isArray(refInput) && refInput[0] <= 100 && refInput.some((v) => !Number.isInteger(v) || v < 0)) {
      refLab = refInput;
      refRgb = labToRgb(refLab);
      refHex = rgbToHex(refRgb);
    } else if (Array.isArray(refInput)) {
      refRgb = refInput;
      refLab = rgbToLab(refRgb);
      refHex = rgbToHex(refRgb);
    } else {
      refHex = '#C4C3BF';
      refRgb = hexToRgb(refHex);
      refLab = rgbToLab(refRgb);
    }

    if (typeof sampleInput === 'string') {
      smpHex = sampleInput.toUpperCase();
      smpRgb = hexToRgb(smpHex);
      smpLab = rgbToLab(smpRgb);
    } else if (Array.isArray(sampleInput) && sampleInput[0] <= 100 && sampleInput.some((v) => !Number.isInteger(v) || v < 0)) {
      smpLab = sampleInput;
      smpRgb = labToRgb(smpLab);
      smpHex = rgbToHex(smpRgb);
    } else if (Array.isArray(sampleInput)) {
      smpRgb = sampleInput;
      smpLab = rgbToLab(smpRgb);
      smpHex = rgbToHex(smpRgb);
    } else {
      smpHex = '#C4C3BF';
      smpRgb = hexToRgb(smpHex);
      smpLab = rgbToLab(smpRgb);
    }

    // dL = L*(reference) - L*(sample). Use dL only for ppm.
    const dL = Number((refLab[0] - smpLab[0]).toFixed(2));
    const activeCal = calibration || getCalibration();
    const ppm = clamp(Math.round(interpolateBrownScalePpm(dL, activeCal) * 10) / 10, 0, 100);

    const dLLow = dL - spread;
    const dLHigh = dL + spread;
    const ppmLow = Math.round(interpolateBrownScalePpm(dLLow, activeCal));
    const ppmHigh = Math.round(interpolateBrownScalePpm(dLHigh, activeCal));

    const nearestPatch = findNearestBrownScalePatch(dL);
    const range = `${ppmLow} to ${ppmHigh} ppm`;

    return {
      matched: true,
      valid: true,
      label: 'Estimate, color match',
      pristineHex: refHex,
      sampleHex: smpHex,
      dL,
      matchedTableHex: nearestPatch.hex,
      nearestPatchPpm: nearestPatch.ppm,
      nearestPatchName: nearestPatch.name,
      ppm,
      range,
      displayPpm: range,
      isRange: true,
      refLab,
      sampleLab: smpLab,
      refRgb,
      sampleRgb: smpRgb,
      spread,
      usingCalibration: Boolean(activeCal),
    };
  }

  /**
   * Process 20 frames (or array of frames) captured for Brown Scale
   */
  function processBrownScaleFrames(frames, { calibration = null } = {}) {
    if (!frames || !frames.length) {
      return { valid: false, refusalReason: 'No image frames captured' };
    }

    const frameCount = frames.length;
    const perFrameLRef = [];
    const perFrameLSample = [];
    const perFrameDL = [];
    const perFrameRefRgb = [];
    const perFrameSampleRgb = [];
    let gatesFailed = false;
    let gateRefusal = null;

    for (let i = 0; i < frameCount; i++) {
      const frame = frames[i];
      const ctx = frame.getContext('2d');
      const width = frame.width;
      const height = frame.height;

      // Quality gates check on first frame or each frame
      const gateRef = evaluatePatchGates(ctx, width, height, BROWN_SCALE_ROIS.ref);
      const gateSample = evaluatePatchGates(ctx, width, height, BROWN_SCALE_ROIS.sample);
      if (!gateRef.passed && !gatesFailed) {
        gatesFailed = true;
        gateRefusal = `Reference: ${gateRef.failureReason}`;
      } else if (!gateSample.passed && !gatesFailed) {
        gatesFailed = true;
        gateRefusal = `Sample: ${gateSample.failureReason}`;
      }

      const rRgb = sampleRoiMedian(ctx, width, height, BROWN_SCALE_ROIS.ref);
      const sRgb = sampleRoiMedian(ctx, width, height, BROWN_SCALE_ROIS.sample);
      const rLab = rgbToLab(rRgb);
      const sLab = rgbToLab(sRgb);

      perFrameRefRgb.push(rRgb);
      perFrameSampleRgb.push(sRgb);
      perFrameLRef.push(rLab[0]);
      perFrameLSample.push(sLab[0]);
      perFrameDL.push(Number((rLab[0] - sLab[0]).toFixed(2)));
    }

    // Frame-to-frame spread of L* check across 20 frames
    const spreadLRef = frameCount > 1 ? Number((Math.max(...perFrameLRef) - Math.min(...perFrameLRef)).toFixed(2)) : 0;
    const spreadLSample = frameCount > 1 ? Number((Math.max(...perFrameLSample) - Math.min(...perFrameLSample)).toFixed(2)) : 0;
    const spreadDL = frameCount > 1 ? Number((Math.max(...perFrameDL) - Math.min(...perFrameDL)).toFixed(2)) : 0;
    const maxSpreadL = Math.max(spreadLRef, spreadLSample, spreadDL);

    // Reject with "Hold steady" if frame-to-frame spread of L* is above 1.0
    if (frameCount > 1 && maxSpreadL > SPREAD_THRESHOLD_L) {
      return {
        valid: false,
        refusalReason: 'Hold steady',
        spreadL: maxSpreadL,
      };
    }

    if (gatesFailed) {
      return {
        valid: false,
        refusalReason: gateRefusal,
      };
    }

    // Per-channel median per half across 20 frames
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

    // Reference check: Reject if reference half is far from #C4C3BF in Lab (shadow or tint warning)
    const deltaEPris = Math.sqrt(
      (medianRefLab[0] - PRISTINE_LAB[0]) ** 2 +
      (medianRefLab[1] - PRISTINE_LAB[1]) ** 2 +
      (medianRefLab[2] - PRISTINE_LAB[2]) ** 2
    );

    if (deltaEPris > PRISTINE_MAX_DELTA_E) {
      return {
        valid: false,
        refusalReason: 'Reference patch mismatch: check lighting or shadow (shadow or tint warning)',
        deltaEPris: Number(deltaEPris.toFixed(2)),
      };
    }

    const estimation = estimateBrownScale(medianRefLab, medianSampleLab, {
      spread: maxSpreadL,
      calibration,
    });

    return {
      ...estimation,
      valid: true,
      refusalReason: null,
      maxSpreadL,
      medianRefRgb,
      medianSampleRgb,
    };
  }

  /**
   * Run Repeat Test: 10 captures, compute mean, min, and max of dL and ppm
   */
  async function runBrownScaleRepeatTest(captureFunction, count = 10) {
    const results = [];
    for (let i = 0; i < count; i++) {
      const frames = await captureFunction();
      const res = processBrownScaleFrames(frames);
      if (res.valid) {
        results.push(res);
      }
    }

    if (!results.length) {
      return null;
    }

    const dLVals = results.map((r) => r.dL);
    const ppmVals = results.map((r) => r.ppm);

    const mean = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;

    return {
      count: results.length,
      dL: {
        mean: Number(mean(dLVals).toFixed(2)),
        min: Number(Math.min(...dLVals).toFixed(2)),
        max: Number(Math.max(...dLVals).toFixed(2)),
      },
      ppm: {
        mean: Number(mean(ppmVals).toFixed(1)),
        min: Number(Math.min(...ppmVals).toFixed(1)),
        max: Number(Math.max(...ppmVals).toFixed(1)),
      },
      results,
    };
  }

  /**
   * Synthetic canvas generator for Brown Scale
   */
  function createBrownScaleBadgeCanvas({
    samplePpm = 20,
    sampleHex = null,
    tint = [0, 0, 0],
    noiseStddev = 0,
    clipped = false,
    badReference = false,
  } = {}) {
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
        toDataURL: () => 'data:image/jpeg;base64,mockbrown',
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

    const pristineRef = REFERENCE_POINTS[0];
    let refRgb = badReference
      ? [20, 20, 20]
      : labToRgb([pristineRef.lab[0] + tint[0], pristineRef.lab[1] + tint[1], pristineRef.lab[2] + tint[2]]);

    let smpRgb;
    if (sampleHex) {
      const sLab = rgbToLab(hexToRgb(sampleHex));
      smpRgb = labToRgb([sLab[0] + tint[0], sLab[1] + tint[1], sLab[2] + tint[2]]);
    } else {
      const match = REFERENCE_POINTS.find((r) => r.ppm === samplePpm) || pristineRef;
      smpRgb = labToRgb([match.lab[0] + tint[0], match.lab[1] + tint[1], match.lab[2] + tint[2]]);
    }

    if (isBrowser) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = `rgb(${refRgb[0]}, ${refRgb[1]}, ${refRgb[2]})`;
      ctx.fillRect(0, 0, width / 2, height);

      ctx.fillStyle = `rgb(${smpRgb[0]}, ${smpRgb[1]}, ${smpRgb[2]})`;
      ctx.fillRect(width / 2, 0, width / 2, height);
    } else {
      const px = canvas._pixels;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const isLeft = x < width / 2;
          let color = isLeft ? refRgb : smpRgb;

          let r = color[0];
          let g = color[1];
          let b = color[2];

          if (noiseStddev > 0 && !isLeft) {
            const noise = ((x + y) % 2 === 0 ? 1 : -1) * noiseStddev * 1.5;
            r = clamp(Math.round(r + noise), 10, 240);
            g = clamp(Math.round(g + noise), 10, 240);
            b = clamp(Math.round(b + noise), 10, 240);
          }

          if (clipped && !isLeft) {
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

  const BrownScaleReaderModule = {
    BROWN_SCALE_REFERENCE_TABLE,
    BROWN_SCALE_ROIS,
    SPREAD_THRESHOLD_L,
    ROI_STDDEV_THRESHOLD,
    CLIPPED_PIXEL_THRESHOLD,
    PRISTINE_MAX_DELTA_E,
    PRISTINE_LAB,
    clamp,
    hexToRgb,
    rgbToHex,
    rgbToLab,
    labToRgb,
    sampleRoiMedian,
    evaluatePatchGates,
    interpolateBrownScalePpm,
    findNearestBrownScalePatch,
    estimateBrownScale,
    processBrownScaleFrames,
    runBrownScaleRepeatTest,
    getCalibration,
    saveCalibrationLevel,
    deleteCalibration,
    getHistory,
    addHistory,
    deleteAllHistory,
    createBrownScaleBadgeCanvas,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BrownScaleReaderModule;
  }

  if (typeof window !== 'undefined') {
    window.BrownScaleReader = BrownScaleReaderModule;
  }

})();
