/**
 * H2S Badge Reader - Shared Split Scale Engine (Brown Scale & Purple Scale)
 * 
 * Reusable split capture module powering:
 * 1. Brown scale (dL differential colorimetry)
 * 2. Purple scale (db differential colorimetry)
 * 
 * Layout:
 * - One guide rectangle split vertically: Left half is reference, right half is sample.
 * - Samples center 40% of each half away from edges and divider.
 * - 20-frame median per half in Lab space.
 * - Monotonic piecewise linear interpolation.
 * - On-device calibration and history storage in localStorage.
 */

(function () {
  'use strict';

  const ROI_STDDEV_THRESHOLD = 24.0;
  const CLIPPED_PIXEL_THRESHOLD = 0.02;
  const REFERENCE_MAX_DELTA_E = 25.0;

  // Geometry: Left half (x: 0..0.5) center 40%, Right half (x: 0.5..1.0) center 40%
  const SHARED_SPLIT_ROIS = {
    ref: {
      key: 'ref',
      name: 'Reference Patch',
      shortName: 'REF',
      half: { x: 0.0, y: 0.0, w: 0.5, h: 1.0 },
      x: 0.15,
      y: 0.30,
      w: 0.20,
      h: 0.40,
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
    },
  };

  // Color space conversions
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

  // --- CONFIGURATIONS ---

  const BROWN_SCALE_REFERENCE_TABLE = [
    { ppm: 0,   name: 'Pristine', hex: '#C4C3BF', dL: 0.0,  signal: 0.0 },
    { ppm: 1,   name: '1 ppm',    hex: '#C9A793', dL: 7.8,  signal: 7.8 },
    { ppm: 5,   name: '5 ppm',    hex: '#C39782', dL: 12.8, signal: 12.8 },
    { ppm: 10,  name: '10 ppm',   hex: '#B17762', dL: 23.3, signal: 23.3 },
    { ppm: 20,  name: '20 ppm',   hex: '#8F5346', dL: 36.8, signal: 36.8 },
    { ppm: 50,  name: '50 ppm',   hex: '#6C463E', dL: 45.0, signal: 45.0 },
    { ppm: 100, name: '100 ppm',  hex: '#4D3837', dL: 53.0, signal: 53.0 },
  ];

  const PURPLE_SCALE_REFERENCE_TABLE = [
    { ppm: 0,    name: '0 ppm',    hex: '#C27FB9', db: 0.0,  signal: 0.0 },
    { ppm: 0.06, name: '0.06 ppm', hex: '#92729D', db: 1.5,  signal: 1.5 },
    { ppm: 0.1,  name: '0.1 ppm',  hex: '#9786A7', db: 4.8,  signal: 4.8 },
    { ppm: 0.25, name: '0.25 ppm', hex: '#91668A', db: 6.9,  signal: 6.9 },
    { ppm: 0.4,  name: '0.4 ppm',  hex: '#8B4F6A', db: 15.3, signal: 15.3 },
    { ppm: 0.6,  name: '0.6 ppm',  hex: '#925D74', db: 15.9, signal: 15.9 },
    { ppm: 1,    name: '1 ppm',    hex: '#A47586', db: 17.9, signal: 17.9 },
    { ppm: 2.5,  name: '2.5 ppm',  hex: '#BA8E98', db: 21.0, signal: 21.0 },
    { ppm: 4,    name: '4 ppm',    hex: '#CFB4A9', db: 29.0, signal: 29.0 },
    { ppm: 8,    name: '8 ppm',    hex: '#E0C6AD', db: 35.7, signal: 35.7 },
  ];

  const BROWN_SCALE_CONFIG = {
    id: 'brown-scale',
    name: 'Brown scale',
    signalKey: 'dL',
    signalLabel: 'dL (L*ref - L*smp)',
    // dL = L*(reference) - L*(sample)
    computeSignal: (refLab, smpLab) => Number((refLab[0] - smpLab[0]).toFixed(2)),
    // Spread of L*
    computeFrameSpreadMetric: (refLab, smpLab) => refLab[0],
    spreadMetricName: 'L*',
    maxSpread: 1.0,
    clampMin: 0,
    clampMax: 100,
    roundDigits: 1,
    referenceHex: '#C4C3BF',
    referenceName: 'Pristine REF (0 ppm)',
    defaultSampleHex: '#8F5346',
    table: BROWN_SCALE_REFERENCE_TABLE,
    calibrationStorageKey: 'h2s-brown-scale-calibration',
    historyStorageKey: 'h2s-brown-scale-history',
    formatRange: (low, high, nearest) => `${low} to ${high} ppm`,
  };

  const PURPLE_SCALE_CONFIG = {
    id: 'purple-scale',
    name: 'Purple scale',
    signalKey: 'db',
    signalLabel: 'db (b*smp - b*ref)',
    // db = b*(sample) - b*(reference)
    computeSignal: (refLab, smpLab) => Number((smpLab[2] - refLab[2]).toFixed(2)),
    // Spread of db
    computeFrameSpreadMetric: (refLab, smpLab) => Number((smpLab[2] - refLab[2]).toFixed(2)),
    spreadMetricName: 'db',
    maxSpread: 1.0,
    clampMin: 0,
    clampMax: 8,
    roundDigits: 2,
    referenceHex: '#C27FB9',
    referenceName: '0 ppm REF (#C27FB9)',
    defaultSampleHex: '#91668A',
    table: PURPLE_SCALE_REFERENCE_TABLE,
    calibrationStorageKey: 'h2s-purple-scale-calibration',
    historyStorageKey: 'h2s-purple-scale-history',
    formatRange: (low, high, nearest, signalVal) => {
      // Neighbors overlap: 0.4 and 0.6 ppm are almost identical (db 15.3 and 15.9)
      if ((low <= 0.4 && high >= 0.6) || (nearest.ppm === 0.4 || nearest.ppm === 0.6) || (signalVal >= 14.5 && signalVal <= 16.5)) {
        return '0.4 to 0.6 ppm';
      }
      return `${low} to ${high} ppm`;
    },
  };

  /**
   * Factory function that constructs a dedicated split scale module
   * Reused identically for Brown scale and Purple scale.
   */
  function createSplitScaleModule(config) {
    const signalKey = config.signalKey;
    const referenceHex = config.referenceHex;
    const refRgbDefault = hexToRgb(referenceHex);
    const refLabDefault = rgbToLab(refRgbDefault);

    const referencePoints = config.table.map((item) => {
      const rgb = hexToRgb(item.hex);
      const lab = rgbToLab(rgb);
      return {
        ...item,
        rgb,
        lab,
        signal: item[signalKey] !== undefined ? item[signalKey] : item.signal,
      };
    });

    const pristineLab = referencePoints[0].lab;

    const rois = {
      ref: { ...SHARED_SPLIT_ROIS.ref, color: referenceHex },
      sample: { ...SHARED_SPLIT_ROIS.sample, color: config.defaultSampleHex },
    };

    /**
     * Piecewise linear monotonic interpolation
     */
    function interpolatePpm(signalVal, calibrationData = null) {
      let table;
      if (calibrationData && Array.isArray(calibrationData) && calibrationData.length >= 2) {
        table = calibrationData.slice().sort((a, b) => a[signalKey] - b[signalKey]).map((c) => ({
          signal: c[signalKey],
          ppm: c.ppm,
        }));
      } else {
        table = referencePoints.map((r) => ({ signal: r.signal, ppm: r.ppm }));
      }

      if (signalVal <= table[0].signal) {
        return table[0].ppm;
      }
      const last = table[table.length - 1];
      if (signalVal >= last.signal) {
        return last.ppm;
      }

      for (let i = 0; i < table.length - 1; i++) {
        const p1 = table[i];
        const p2 = table[i + 1];
        if (signalVal >= p1.signal && signalVal <= p2.signal) {
          if (Math.abs(p2.signal - p1.signal) < 1e-6) return p1.ppm;
          const fraction = (signalVal - p1.signal) / (p2.signal - p1.signal);
          const ppm = p1.ppm + fraction * (p2.ppm - p1.ppm);
          return clamp(ppm, config.clampMin, config.clampMax);
        }
      }
      return 0;
    }

    /**
     * Find nearest patch in table
     */
    function findNearestPatch(signalVal) {
      let nearest = referencePoints[0];
      let minDiff = Infinity;
      for (const item of referencePoints) {
        const diff = Math.abs(signalVal - item.signal);
        if (diff < minDiff) {
          minDiff = diff;
          nearest = item;
        }
      }
      return nearest;
    }

    /**
     * Calibration storage
     */
    function getCalibration() {
      if (typeof localStorage === 'undefined') return null;
      try {
        const raw = localStorage.getItem(config.calibrationStorageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length < 2) return null;
        return parsed;
      } catch (e) {
        return null;
      }
    }

    function saveCalibrationLevel(ppm, refHexVal, sampleHexVal, sigVal) {
      if (typeof localStorage === 'undefined') return;
      try {
        let current = getCalibration() || [
          {
            ppm: referencePoints[0].ppm,
            refHex: referenceHex,
            sampleHex: referenceHex,
            [signalKey]: 0.0,
            timestamp: new Date().toISOString(),
          },
        ];
        current = current.filter((c) => c.ppm !== Number(ppm));
        current.push({
          ppm: Number(ppm),
          refHex: refHexVal,
          sampleHex: sampleHexVal,
          [signalKey]: Number(sigVal),
          dL: Number(sigVal), // Backwards compatibility
          db: Number(sigVal),
          timestamp: new Date().toISOString(),
        });
        current.sort((a, b) => a[signalKey] - b[signalKey]);
        localStorage.setItem(config.calibrationStorageKey, JSON.stringify(current));
      } catch (e) {
        console.warn('Could not save calibration:', e);
      }
    }

    function deleteCalibration() {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.removeItem(config.calibrationStorageKey);
      } catch (e) {}
    }

    /**
     * History storage
     */
    function getHistory() {
      if (typeof localStorage === 'undefined') return [];
      try {
        const raw = localStorage.getItem(config.historyStorageKey);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    }

    function addHistory(reading) {
      if (typeof localStorage === 'undefined') return;
      try {
        const list = getHistory();
        list.unshift(reading);
        if (list.length > 10) list.length = 10;
        localStorage.setItem(config.historyStorageKey, JSON.stringify(list));
      } catch (e) {}
    }

    function deleteAllHistory() {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.removeItem(config.historyStorageKey);
      } catch (e) {}
    }

    /**
     * Color parsing helper
     */
    function parseColor(input, defaultHex) {
      if (typeof input === 'string') {
        const hex = input.toUpperCase();
        const rgb = hexToRgb(hex);
        return { hex, rgb, lab: rgbToLab(rgb) };
      }
      if (Array.isArray(input)) {
        if (input[0] <= 100 && input.some((v) => !Number.isInteger(v) || v < 0)) {
          // Lab array
          return { lab: input, rgb: labToRgb(input), hex: rgbToHex(labToRgb(input)) };
        }
        // RGB array
        return { rgb: input, lab: rgbToLab(input), hex: rgbToHex(input) };
      }
      const hex = defaultHex;
      const rgb = hexToRgb(hex);
      return { hex, rgb, lab: rgbToLab(rgb) };
    }

    /**
     * Core Estimation
     */
    function estimate(refInput, sampleInput, { spread = 0, calibration = null } = {}) {
      const refParsed = parseColor(refInput, referenceHex);
      const smpParsed = parseColor(sampleInput, config.defaultSampleHex);

      const refLab = refParsed.lab;
      const smpLab = smpParsed.lab;
      const signalVal = config.computeSignal(refLab, smpLab);

      const activeCal = calibration || getCalibration();
      const rawPpm = interpolatePpm(signalVal, activeCal);
      const ppm = clamp(
        config.roundDigits === 1
          ? Math.round(rawPpm * 10) / 10
          : Math.round(rawPpm * 100) / 100,
        config.clampMin,
        config.clampMax
      );

      const sigLow = signalVal - spread;
      const sigHigh = signalVal + spread;
      const ppmLow = clamp(
        config.roundDigits === 1
          ? Math.round(interpolatePpm(sigLow, activeCal) * 10) / 10
          : Math.round(interpolatePpm(sigLow, activeCal) * 100) / 100,
        config.clampMin,
        config.clampMax
      );
      const ppmHigh = clamp(
        config.roundDigits === 1
          ? Math.round(interpolatePpm(sigHigh, activeCal) * 10) / 10
          : Math.round(interpolatePpm(sigHigh, activeCal) * 100) / 100,
        config.clampMin,
        config.clampMax
      );

      const nearestPatch = findNearestPatch(signalVal);
      const range = config.formatRange(ppmLow, ppmHigh, nearestPatch, signalVal);

      let nearestPatchName = nearestPatch.name;
      if (config.id === 'purple-scale' && (nearestPatch.ppm === 0.4 || nearestPatch.ppm === 0.6)) {
        nearestPatchName = '0.4 to 0.6 ppm (overlap)';
      }

      const result = {
        matched: true,
        valid: true,
        label: 'Estimate, color match',
        pristineHex: refParsed.hex,
        refHex: refParsed.hex,
        sampleHex: smpParsed.hex,
        [signalKey]: signalVal,
        signal: signalVal,
        dL: signalVal, // For backward compatibility with existing tests
        db: signalVal,
        matchedTableHex: nearestPatch.hex,
        nearestPatchPpm: nearestPatch.ppm,
        nearestPatchName,
        ppm,
        range,
        displayPpm: range,
        isRange: true,
        refLab,
        sampleLab: smpLab,
        refRgb: refParsed.rgb,
        sampleRgb: smpParsed.rgb,
        spread,
        usingCalibration: Boolean(activeCal),
      };

      return result;
    }

    /**
     * Process 20 frames per half
     */
    function processFrames(frames, { calibration = null } = {}) {
      if (!frames || !frames.length) {
        return { valid: false, refusalReason: 'No image frames captured' };
      }

      const frameCount = frames.length;
      const perFrameSpreadMetric = [];
      const perFrameRefRgb = [];
      const perFrameSampleRgb = [];
      let gatesFailed = false;
      let gateRefusal = null;

      for (let i = 0; i < frameCount; i++) {
        const frame = frames[i];
        const ctx = frame.getContext('2d');
        const width = frame.width;
        const height = frame.height;

        const gateRef = evaluatePatchGates(ctx, width, height, rois.ref);
        const gateSample = evaluatePatchGates(ctx, width, height, rois.sample);
        if (!gateRef.passed && !gatesFailed) {
          gatesFailed = true;
          gateRefusal = `Reference: ${gateRef.failureReason}`;
        } else if (!gateSample.passed && !gatesFailed) {
          gatesFailed = true;
          gateRefusal = `Sample: ${gateSample.failureReason}`;
        }

        const rRgb = sampleRoiMedian(ctx, width, height, rois.ref);
        const sRgb = sampleRoiMedian(ctx, width, height, rois.sample);
        const rLab = rgbToLab(rRgb);
        const sLab = rgbToLab(sRgb);

        perFrameRefRgb.push(rRgb);
        perFrameSampleRgb.push(sRgb);
        perFrameSpreadMetric.push(config.computeFrameSpreadMetric(rLab, sLab));
      }

      const spreadVal = frameCount > 1
        ? Number((Math.max(...perFrameSpreadMetric) - Math.min(...perFrameSpreadMetric)).toFixed(2))
        : 0;

      // Reject if frame-to-frame spread is above maxSpread (1.0)
      if (frameCount > 1 && spreadVal > config.maxSpread) {
        return {
          valid: false,
          refusalReason: 'Hold steady',
          spread: spreadVal,
          spreadL: spreadVal, // compatibility
          spreadDb: spreadVal,
        };
      }

      if (gatesFailed) {
        return {
          valid: false,
          refusalReason: gateRefusal,
        };
      }

      // Per-channel median per half across frames
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

      // Reference check: Warn if reference half is far from expected in Lab (tint or shadow)
      const deltaERef = Math.sqrt(
        (medianRefLab[0] - pristineLab[0]) ** 2 +
        (medianRefLab[1] - pristineLab[1]) ** 2 +
        (medianRefLab[2] - pristineLab[2]) ** 2
      );

      if (deltaERef > REFERENCE_MAX_DELTA_E) {
        return {
          valid: false,
          refusalReason: 'Reference patch mismatch: check lighting or shadow (shadow or tint warning)',
          deltaEPris: Number(deltaERef.toFixed(2)),
          deltaERef: Number(deltaERef.toFixed(2)),
        };
      }

      const estimation = estimate(medianRefLab, medianSampleLab, {
        spread: spreadVal,
        calibration,
      });

      return {
        ...estimation,
        valid: true,
        refusalReason: null,
        spread: spreadVal,
        spreadL: spreadVal,
        spreadDb: spreadVal,
        deltaERef: Number(deltaERef.toFixed(2)),
        deltaEPris: Number(deltaERef.toFixed(2)),
        medianRefRgb,
        medianSampleRgb,
      };
    }

    /**
     * Repeat test diagnostics (10 captures)
     */
    async function runRepeatTest(captureFrameCallback, count = 10) {
      const results = [];
      for (let i = 0; i < count; i++) {
        try {
          const frames = await captureFrameCallback();
          const processed = processFrames(frames);
          if (processed && processed.valid) {
            results.push(processed);
          }
        } catch (err) {
          console.warn(`${config.name} repeat capture iteration failed:`, err);
        }
      }

      if (!results.length) return null;

      const signals = results.map((r) => r[signalKey]);
      const ppms = results.map((r) => r.ppm);

      const meanSignal = signals.reduce((a, b) => a + b, 0) / signals.length;
      const minSignal = Math.min(...signals);
      const maxSignal = Math.max(...signals);

      const meanPpm = ppms.reduce((a, b) => a + b, 0) / ppms.length;
      const minPpm = Math.min(...ppms);
      const maxPpm = Math.max(...ppms);

      return {
        count: results.length,
        [signalKey]: {
          mean: Number(meanSignal.toFixed(2)),
          min: Number(minSignal.toFixed(2)),
          max: Number(maxSignal.toFixed(2)),
        },
        dL: {
          mean: Number(meanSignal.toFixed(2)),
          min: Number(minSignal.toFixed(2)),
          max: Number(maxSignal.toFixed(2)),
        },
        db: {
          mean: Number(meanSignal.toFixed(2)),
          min: Number(minSignal.toFixed(2)),
          max: Number(maxSignal.toFixed(2)),
        },
        ppm: {
          mean: Number(meanPpm.toFixed(config.roundDigits)),
          min: Number(minPpm.toFixed(config.roundDigits)),
          max: Number(maxPpm.toFixed(config.roundDigits)),
        },
      };
    }

    /**
     * Create synthetic badge canvas for testing / demonstration
     */
    function createBadgeCanvas({
      samplePpm = 20,
      tint = [0, 0, 0],
      noiseStddev = 0,
      badReference = false,
      clipped = false,
      width = 400,
      height = 200,
    } = {}) {
      const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
      let canvas;
      let px;

      if (isBrowser) {
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);
        px = imgData.data;
        canvas._imgData = imgData;
      } else {
        px = new Uint8ClampedArray(width * height * 4);
        canvas = {
          width,
          height,
          toDataURL: () => 'data:image/jpeg;base64,mock',
          getContext: () => ({
            filter: 'none',
            getImageData: (x, y, w, h) => {
              const sub = new Uint8ClampedArray(w * h * 4);
              for (let row = 0; row < h; row++) {
                for (let col = 0; col < w; col++) {
                  const srcIdx = ((y + row) * width + (x + col)) * 4;
                  const dstIdx = (row * w + col) * 4;
                  sub[dstIdx] = px[srcIdx];
                  sub[dstIdx + 1] = px[srcIdx + 1];
                  sub[dstIdx + 2] = px[srcIdx + 2];
                  sub[dstIdx + 3] = px[srcIdx + 3];
                }
              }
              return { data: sub, width: w, height: h };
            },
          }),
        };
      }

      // Reference color
      let refRgb = hexToRgb(referenceHex);
      if (badReference) {
        refRgb = [30, 220, 60];
      }

      // Sample color based on ppm
      let smpHex = config.defaultSampleHex;
      const exactMatch = referencePoints.find((p) => Math.abs(p.ppm - samplePpm) < 0.001);
      if (exactMatch) {
        smpHex = exactMatch.hex;
      } else {
        const nearest = findNearestPatch(samplePpm);
        smpHex = nearest.hex;
      }
      const smpRgb = hexToRgb(smpHex);

      const refLab = rgbToLab(refRgb);
      const smpLab = rgbToLab(smpRgb);

      const tintedRefLab = [refLab[0] + tint[0], refLab[1] + tint[1], refLab[2] + tint[2]];
      const tintedSmpLab = [smpLab[0] + tint[0], smpLab[1] + tint[1], smpLab[2] + tint[2]];

      const tintedRefRgb = labToRgb(tintedRefLab);
      const tintedSmpRgb = labToRgb(tintedSmpLab);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const isLeft = x < width / 2;
          const isDivider = Math.abs(x - width / 2) <= 1;

          if (isDivider) {
            px[idx] = 255;
            px[idx + 1] = 255;
            px[idx + 2] = 255;
            px[idx + 3] = 255;
          } else {
            let [r, g, b] = isLeft ? tintedRefRgb : tintedSmpRgb;

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

      if (isBrowser) {
        canvas.getContext('2d').putImageData(canvas._imgData, 0, 0);
      }

      return canvas;
    }

    return {
      config,
      rois,
      referencePoints,
      pristineLab,
      interpolatePpm,
      findNearestPatch,
      estimate,
      processFrames,
      runRepeatTest,
      getCalibration,
      saveCalibrationLevel,
      deleteCalibration,
      getHistory,
      addHistory,
      deleteAllHistory,
      createBadgeCanvas,
    };
  }

  // Instantiate Modules
  const BrownScaleModuleInstance = createSplitScaleModule(BROWN_SCALE_CONFIG);
  const PurpleScaleModuleInstance = createSplitScaleModule(PURPLE_SCALE_CONFIG);

  // CommonJS and browser exports with backwards-compatibility aliases
  const BrownScaleReaderModule = {
    ...BrownScaleModuleInstance,
    BROWN_SCALE_REFERENCE_TABLE,
    BROWN_SCALE_ROIS: BrownScaleModuleInstance.rois,
    SPREAD_THRESHOLD_L: 1.0,
    ROI_STDDEV_THRESHOLD,
    CLIPPED_PIXEL_THRESHOLD,
    PRISTINE_MAX_DELTA_E: REFERENCE_MAX_DELTA_E,
    PRISTINE_LAB: BrownScaleModuleInstance.pristineLab,
    clamp,
    hexToRgb,
    rgbToHex,
    rgbToLab,
    labToRgb,
    sampleRoiMedian,
    evaluatePatchGates,
    interpolateBrownScalePpm: BrownScaleModuleInstance.interpolatePpm,
    findNearestBrownScalePatch: BrownScaleModuleInstance.findNearestPatch,
    estimateBrownScale: BrownScaleModuleInstance.estimate,
    processBrownScaleFrames: BrownScaleModuleInstance.processFrames,
    runBrownScaleRepeatTest: BrownScaleModuleInstance.runRepeatTest,
    createBrownScaleBadgeCanvas: BrownScaleModuleInstance.createBadgeCanvas,
    // Provide purple scale exports on module
    PurpleScaleReader: PurpleScaleModuleInstance,
    purpleScaleReader: PurpleScaleModuleInstance,
    PURPLE_SCALE_CONFIG,
    PURPLE_SCALE_REFERENCE_TABLE,
    interpolatePurpleScalePpm: PurpleScaleModuleInstance.interpolatePpm,
    estimatePurpleScale: PurpleScaleModuleInstance.estimate,
    processPurpleScaleFrames: PurpleScaleModuleInstance.processFrames,
    runPurpleScaleRepeatTest: PurpleScaleModuleInstance.runRepeatTest,
    createPurpleScaleBadgeCanvas: PurpleScaleModuleInstance.createBadgeCanvas,
    createSplitScaleModule,
  };

  const PurpleScaleReaderModule = {
    ...PurpleScaleModuleInstance,
    PURPLE_SCALE_REFERENCE_TABLE,
    PURPLE_SCALE_ROIS: PurpleScaleModuleInstance.rois,
    interpolatePurpleScalePpm: PurpleScaleModuleInstance.interpolatePpm,
    findNearestPurpleScalePatch: PurpleScaleModuleInstance.findNearestPatch,
    estimatePurpleScale: PurpleScaleModuleInstance.estimate,
    processPurpleScaleFrames: PurpleScaleModuleInstance.processFrames,
    runPurpleScaleRepeatTest: PurpleScaleModuleInstance.runRepeatTest,
    createPurpleScaleBadgeCanvas: PurpleScaleModuleInstance.createBadgeCanvas,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BrownScaleReaderModule;
  }

  if (typeof window !== 'undefined') {
    window.BrownScaleReader = BrownScaleReaderModule;
    window.PurpleScaleReader = PurpleScaleReaderModule;
  }
})();
