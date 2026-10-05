/**
 * H2S Badge Reader - Single Unified Badge Reader
 * One config object, one capture function, one matching function.
 */

(function () {
  'use strict';

const STORAGE_KEY = 'h2s-badge-records-v1';
const LEARNED_KEY = 'h2s_learned_badge_templates';
const THRESHOLD = 10;
const ANALYSIS_VERSION = 'v2.0-unified';

// ONE CONFIG OBJECT
const BADGE_CONFIG = {
  aspectRatio: 0.64, // width : height (unrotated guide rectangle)
  sampleCenterFraction: 0.40, // sample center 40% of each patch
  r3TargetHex: '#C4C3BF',
  r3TargetRgb: [196, 195, 191],
  gainLimits: [0.6, 1.6],
  patchBoxSize: { w: 0.22, h: 0.16 }, // fraction of guide rectangle
  patches: {
    R1: { id: 'R1', col: 'REF', row: 1, name: 'pink', x: 0.22, y: 0.12, defaultHex: '#CD8290' },
    S1: { id: 'S1', col: 'SENSE', row: 1, name: 'yellow', x: 0.78, y: 0.12, defaultHex: '#CFB522' },
    R2: { id: 'R2', col: 'REF', row: 2, name: 'purple', x: 0.22, y: 0.50, defaultHex: '#BB8FCE' },
    S2: { id: 'S2', col: 'SENSE', row: 2, name: 'magenta', x: 0.78, y: 0.50 },
    R3: { id: 'R3', col: 'REF', row: 3, name: 'gray', x: 0.22, y: 0.88, defaultHex: '#C4C3BF' },
    S3: { id: 'S3', col: 'SENSE', row: 3, name: 'brown', x: 0.78, y: 0.88 },
  },
  defaultTemplates: {
    10: { s3Hex: '#AA6F5C', s2Hex: '#955375' },
    20: { s3Hex: '#8C5244', s2Hex: '#934A68' },
    40: { s3Hex: '#6E493E', s2Hex: '#A76070' },
    50: { s3Hex: '#6B463D', s2Hex: '#AB5E65' },
  },
  weights: { L: 0.5, a: 1.0, b: 1.5 },
  thresholds: {
    maxLuminanceStd: 12.0,
    maxClippedFraction: 0.02,
    maxFrameSpread: 6.0,
    s1MinLabB: 40.0,
    s1MinLabL: 45.0,
    noMatchDist: 12.0,
    lowConfidenceDist: 8.0,
    lowConfidenceDiff: 4.0,
  },
};

// Utilities
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '').trim();
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(rgb) {
  return '#' + rgb.map((c) => {
    const hex = clamp(Math.round(c), 0, 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('').toUpperCase();
}

function srgbToLinearChannel(channel) {
  const norm = clamp(channel / 255, 0, 1);
  return norm <= 0.04045 ? norm / 12.92 : ((norm + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(linear) {
  const norm = clamp(linear, 0, 1);
  const srgb = norm <= 0.0031308 ? norm * 12.92 : 1.055 * (norm ** (1 / 2.4)) - 0.055;
  return clamp(Math.round(srgb * 255), 0, 255);
}

function rgbToLinear(rgb) {
  return [srgbToLinearChannel(rgb[0]), srgbToLinearChannel(rgb[1]), srgbToLinearChannel(rgb[2])];
}

function linearToRgb(lin) {
  return [linearToSrgbChannel(lin[0]), linearToSrgbChannel(lin[1]), linearToSrgbChannel(lin[2])];
}

function rgbToLab(rgb) {
  const r = srgbToLinearChannel(rgb[0]);
  const g = srgbToLinearChannel(rgb[1]);
  const b = srgbToLinearChannel(rgb[2]);

  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.00000;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  return [
    Number((116 * fy - 16).toFixed(2)),
    Number((500 * (fx - fy)).toFixed(2)),
    Number((200 * (fy - fz)).toFixed(2)),
  ];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getPatchCoordinates(patch, rotated = false) {
  if (!rotated) {
    return { x: patch.x, y: patch.y };
  }
  // 90 degree clockwise rotation: x' = 1 - y, y' = x
  return {
    x: Number((1 - patch.y).toFixed(4)),
    y: Number(patch.x.toFixed(4)),
  };
}

function getLearnedTemplates() {
  if (typeof localStorage === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(LEARNED_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveLearnedTemplate(ppm, s3Hex, s2Hex) {
  if (typeof localStorage === 'undefined') return;
  const current = getLearnedTemplates();
  current[ppm] = {
    ppm: Number(ppm),
    s3Hex: s3Hex.toUpperCase(),
    s2Hex: s2Hex.toUpperCase(),
    timestamp: new Date().toISOString(),
  };
  localStorage.setItem(LEARNED_KEY, JSON.stringify(current));
}

function resetLearnedTemplates() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(LEARNED_KEY);
  }
}

function getCombinedTemplates(customTemplates = null) {
  const combined = {};
  // 1. Defaults
  for (const [ppm, tpl] of Object.entries(BADGE_CONFIG.defaultTemplates)) {
    const s3Rgb = hexToRgb(tpl.s3Hex);
    const s2Rgb = hexToRgb(tpl.s2Hex);
    combined[ppm] = {
      ppm: Number(ppm),
      s3Hex: tpl.s3Hex,
      s2Hex: tpl.s2Hex,
      fingerprint: [...rgbToLab(s3Rgb), ...rgbToLab(s2Rgb)],
      isDefault: true,
    };
  }
  // 2. Learned templates override defaults or add new classes
  const learned = customTemplates || getLearnedTemplates();
  for (const [ppm, tpl] of Object.entries(learned)) {
    const s3Rgb = hexToRgb(tpl.s3Hex);
    const s2Rgb = hexToRgb(tpl.s2Hex);
    combined[ppm] = {
      ppm: Number(ppm),
      s3Hex: tpl.s3Hex,
      s2Hex: tpl.s2Hex,
      fingerprint: [...rgbToLab(s3Rgb), ...rgbToLab(s2Rgb)],
      isDefault: false,
    };
  }
  return combined;
}

// ONE MATCHING FUNCTION
function matchBadgeFingerprint(fingerprint, customTemplates = null) {
  const templates = getCombinedTemplates(customTemplates);
  const candidates = [];

  const wL = BADGE_CONFIG.weights.L;
  const wa = BADGE_CONFIG.weights.a;
  const wb = BADGE_CONFIG.weights.b;

  for (const [ppmStr, tpl] of Object.entries(templates)) {
    const tf = tpl.fingerprint;
    const dL3 = fingerprint[0] - tf[0];
    const da3 = fingerprint[1] - tf[1];
    const db3 = fingerprint[2] - tf[2];
    const dL2 = fingerprint[3] - tf[3];
    const da2 = fingerprint[4] - tf[4];
    const db2 = fingerprint[5] - tf[5];

    const distSq =
      wL * (dL3 * dL3 + dL2 * dL2) +
      wa * (da3 * da3 + da2 * da2) +
      wb * (db3 * db3 + db2 * db2);
    const dist = Math.sqrt(distSq);

    candidates.push({
      ppm: Number(ppmStr),
      dist: Number(dist.toFixed(2)),
      s3Hex: tpl.s3Hex,
      s2Hex: tpl.s2Hex,
      isDefault: tpl.isDefault,
    });
  }

  candidates.sort((a, b) => a.dist - b.dist);

  const d1 = candidates[0].dist;
  const classPpm = candidates[0].ppm;
  const d2 = candidates.length > 1 ? candidates[1].dist : d1 + 10;
  const secondPpm = candidates.length > 1 ? candidates[1].ppm : classPpm;

  const t = d1 + d2 > 0 ? d1 / (d1 + d2) : 0;
  const approxPpm = Number((classPpm + 0.15 * t * (secondPpm - classPpm)).toFixed(1));

  let status = 'Match';
  let confidence = 'High confidence';
  let matched = true;

  if (d1 > BADGE_CONFIG.thresholds.noMatchDist) {
    status = 'No match, retake';
    confidence = 'No match';
    matched = false;
  } else if (d1 > BADGE_CONFIG.thresholds.lowConfidenceDist || (d2 - d1) < BADGE_CONFIG.thresholds.lowConfidenceDiff) {
    status = 'Match';
    confidence = 'Low confidence';
  } else {
    status = 'Match';
    confidence = 'High confidence';
  }

  return {
    classPpm,
    ppm: classPpm,
    approxPpm,
    confidence,
    status,
    matched,
    d1,
    d2,
    s3Hex: candidates[0].s3Hex,
    s2Hex: candidates[0].s2Hex,
    isLearned: !candidates[0].isDefault,
  };
}

// FORGIVING CLIPPING & PIXEL ANALYSIS
function analyzePatchPixels(data) {
  const totalPixels = data.length / 4;
  const usableR = [];
  const usableG = [];
  const usableB = [];
  const allR = [];
  const allG = [];
  const allB = [];
  const luminances = [];
  let clippedHigh = 0;
  let clippedLow = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    allR.push(r);
    allG.push(g);
    allB.push(b);
    luminances.push(0.2126 * r + 0.7152 * g + 0.0722 * b);

    if (r === 255 || g === 255 || b === 255) clippedHigh++;
    if (r === 0 || g === 0 || b === 0) clippedLow++;

    // Ignore pixels at 0 or 255
    if (r > 0 && r < 255 && g > 0 && g < 255 && b > 0 && b < 255) {
      usableR.push(r);
      usableG.push(g);
      usableB.push(b);
    }
  }

  const usableFraction = totalPixels > 0 ? usableR.length / totalPixels : 0;
  // Use median of usable pixels, or all if none
  const medR = usableR.length > 0 ? median(usableR) : median(allR);
  const medG = usableG.length > 0 ? median(usableG) : median(allG);
  const medB = usableB.length > 0 ? median(usableB) : median(allB);
  const rgb = [medR, medG, medB];

  const lumMean = luminances.reduce((a, b) => a + b, 0) / (luminances.length || 1);
  const lumVar = luminances.reduce((a, b) => a + (b - lumMean) ** 2, 0) / (luminances.length || 1);
  const lumStd = Math.sqrt(lumVar);

  const minCh = Math.min(medR, medG, medB);
  const maxCh = Math.max(medR, medG, medB);

  // Status definition:
  // Red only if fewer than 30% of pixels are usable, or median < 8 or > 247.
  // Yellow if between 30% and 70% usable (or lumStd > 12).
  // Green if >= 70% usable and median within 8..247 and lumStd <= 12.
  let status = 'green';
  if (usableFraction < 0.30 || minCh < 8 || maxCh > 247) {
    status = 'red';
  } else if (usableFraction < 0.70 || lumStd > 12) {
    status = 'yellow';
  } else {
    status = 'green';
  }

  return {
    rgb,
    usableFraction,
    lumStd,
    status,
    totalPixels,
    usablePixels: usableR.length,
    clippedHigh,
    clippedLow,
    minCh,
    maxCh,
  };
}

// LIVE PATCH GUIDE TIPS (in strict priority order)
function getLiveGuideTip({ patchStatus = {}, patchMedians = {}, frameSpread = 0, isBadgeDetected = true }) {
  // Priority 1: Badge not in frame
  if (!isBadgeDetected) {
    return 'Place the badge so the six squares sit on the dots.';
  }

  // Priority 2: Too dark
  const keyMedians = [patchMedians?.R3, patchMedians?.S2, patchMedians?.S3].filter(Boolean);
  const avgKeyLum = keyMedians.length
    ? keyMedians.reduce((acc, c) => acc + (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]), 0) / keyMedians.length
    : 100;
  if (avgKeyLum < 35 || (patchMedians?.R3 && (0.2126 * patchMedians.R3[0] + 0.7152 * patchMedians.R3[1] + 0.0722 * patchMedians.R3[2]) < 30)) {
    return 'Too dark. Move to a brighter spot.';
  }

  // Priority 3: Glare or too bright
  const hasKeyGlare = ['R3', 'S2', 'S3'].some((k) => patchStatus?.[k]?.status === 'red' && (patchStatus[k].clippedHigh > 0 || patchStatus[k].maxCh > 245));
  if (hasKeyGlare || avgKeyLum > 225) {
    return 'Glare on the badge. Tilt it slightly.';
  }

  // Priority 4: Uneven light or shadow
  const hasShadow = ['R3', 'S2', 'S3'].some((k) => patchStatus?.[k]?.lumStd > 12 || patchStatus?.[k]?.status === 'yellow');
  if (hasShadow) {
    return 'Shadow on the badge. Move the light or the badge.';
  }

  // Priority 5: Moving
  if (frameSpread > BADGE_CONFIG.thresholds.maxFrameSpread) {
    return 'Hold steady.';
  }

  // Priority 6: All good
  return 'Looks good. Hold still.';
}

// EVALUATE LIVE GUIDE (runs ~4 times a second)
function evaluateLiveGuide(canvas, { rotated = false, previousMedians = null } = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'none';

  const targetAspect = rotated ? (1 / BADGE_CONFIG.aspectRatio) : BADGE_CONFIG.aspectRatio;
  let rWidth, rHeight;
  if (width / height > targetAspect) {
    rHeight = Math.round(height * 0.76);
    rWidth = Math.round(rHeight * targetAspect);
  } else {
    rWidth = Math.round(width * 0.76);
    rHeight = Math.round(rWidth / targetAspect);
  }
  const rX = Math.round((width - rWidth) / 2);
  const rY = Math.round((height - rHeight) / 2);
  const rect = { x: rX, y: rY, w: rWidth, h: rHeight };

  const patchKeys = Object.keys(BADGE_CONFIG.patches);
  const patchStatus = {};
  const patchMedians = {};

  for (const key of patchKeys) {
    const patch = BADGE_CONFIG.patches[key];
    const coords = getPatchCoordinates(patch, rotated);
    const cx = rect.x + coords.x * rect.w;
    const cy = rect.y + coords.y * rect.h;

    const bw = (rotated ? BADGE_CONFIG.patchBoxSize.h : BADGE_CONFIG.patchBoxSize.w) * rect.w;
    const bh = (rotated ? BADGE_CONFIG.patchBoxSize.w : BADGE_CONFIG.patchBoxSize.h) * rect.h;
    const sw = Math.max(3, Math.round(bw * BADGE_CONFIG.sampleCenterFraction));
    const sh = Math.max(3, Math.round(bh * BADGE_CONFIG.sampleCenterFraction));
    const sx = Math.max(0, Math.min(width - sw, Math.round(cx - sw / 2)));
    const sy = Math.max(0, Math.min(height - sh, Math.round(cy - sh / 2)));

    const imgData = ctx.getImageData(sx, sy, sw, sh);
    const analysis = analyzePatchPixels(imgData.data);
    patchStatus[key] = analysis;
    patchMedians[key] = analysis.rgb;
  }

  // Calculate frame spread vs previous frame
  let frameSpread = 0;
  if (previousMedians) {
    for (const key of ['R3', 'S2', 'S3']) {
      if (previousMedians[key] && patchMedians[key]) {
        for (let ch = 0; ch < 3; ch++) {
          const diff = Math.abs(patchMedians[key][ch] - previousMedians[key][ch]);
          if (diff > frameSpread) frameSpread = diff;
        }
      }
    }
  }

  // Check if badge is detected in frame:
  // S1 is yellow (Lab b* > 50, L* > 70) or S1 is glared (status red with clipped pixels)
  // And not all 6 patches are pure background/identical
  const s1Lab = rgbToLab(patchMedians.S1 || [0, 0, 0]);
  const isS1Yellow = s1Lab[2] > 40 && s1Lab[0] > 55;
  const isS1Glared = patchStatus.S1?.status === 'red' && patchStatus.S1?.clippedHigh > 0;
  const isBadgeDetected = isS1Yellow || isS1Glared;

  const tip = getLiveGuideTip({
    patchStatus,
    patchMedians,
    frameSpread,
    isBadgeDetected,
  });

  const isKeyPatchesUsable = ['R3', 'S2', 'S3'].every((k) => patchStatus[k]?.status === 'green' || patchStatus[k]?.status === 'yellow');
  const isStable = frameSpread <= BADGE_CONFIG.thresholds.maxFrameSpread;

  return {
    patchStatus,
    patchMedians,
    frameSpread,
    isBadgeDetected,
    tip,
    isKeyPatchesUsable,
    isStable,
  };
}

// AUTO CAPTURE CONTROLLER
class AutoCaptureEngine {
  constructor({ onCapture = null, onBeep = null, onFlash = null, delayMs = 1000, cooldownMs = 3000 } = {}) {
    this.enabled = true;
    this.delayMs = delayMs;
    this.cooldownMs = cooldownMs;
    this.onCapture = onCapture;
    this.onBeep = onBeep;
    this.onFlash = onFlash;
    this.stableStartTime = null;
    this.lastCaptureTime = -1;
    this.isCapturing = false;
  }

  update({ isKeyPatchesUsable, isStable, now = Date.now() }) {
    if (!this.enabled || this.isCapturing) {
      this.stableStartTime = null;
      return { fired: false, progress: 0 };
    }

    if (this.lastCaptureTime >= 0 && (now - this.lastCaptureTime) < this.cooldownMs) {
      this.stableStartTime = null;
      return { fired: false, progress: 0 };
    }

    if (isKeyPatchesUsable && isStable) {
      if (this.stableStartTime === null) {
        this.stableStartTime = now;
      }
      const elapsed = now - this.stableStartTime;
      if (elapsed >= this.delayMs) {
        this.lastCaptureTime = now;
        this.stableStartTime = null;
        this.isCapturing = true;
        if (this.onBeep) this.onBeep();
        if (this.onFlash) this.onFlash();
        if (this.onCapture) this.onCapture();
        return { fired: true, progress: 1 };
      }
      return { fired: false, progress: elapsed / this.delayMs };
    } else {
      this.stableStartTime = null;
      return { fired: false, progress: 0 };
    }
  }

  reset() {
    this.stableStartTime = null;
    this.isCapturing = false;
  }
}

// ONE CAPTURE FUNCTION (Forgiving & Friendly)
function captureBadgeReading(frames, { rotated = false, learnedTemplates = null, guideRect = null, isLearning = false } = {}) {
  if (!frames || !frames.length) {
    return { valid: false, refusalReason: 'Hold steady.', tip: 'No frames captured. Align badge and hold still.' };
  }

  const firstFrame = frames[0];
  const width = firstFrame.width;
  const height = firstFrame.height;

  // Compute guide rectangle in pixel coordinates
  let rect;
  if (guideRect) {
    rect = guideRect;
  } else {
    const targetAspect = rotated ? (1 / BADGE_CONFIG.aspectRatio) : BADGE_CONFIG.aspectRatio;
    let rWidth, rHeight;
    if (width / height > targetAspect) {
      rHeight = Math.round(height * 0.76);
      rWidth = Math.round(rHeight * targetAspect);
    } else {
      rWidth = Math.round(width * 0.76);
      rHeight = Math.round(rWidth / targetAspect);
    }
    const rX = Math.round((width - rWidth) / 2);
    const rY = Math.round((height - rHeight) / 2);
    rect = { x: rX, y: rY, w: rWidth, h: rHeight };
  }

  const patchKeys = Object.keys(BADGE_CONFIG.patches);
  const patchSamplesPerFrame = [];

  for (let fIdx = 0; fIdx < frames.length; fIdx++) {
    const frame = frames[fIdx];
    const ctx = frame.getContext('2d');
    ctx.filter = 'none';

    const frameResult = {};

    for (const key of patchKeys) {
      const patch = BADGE_CONFIG.patches[key];
      const coords = getPatchCoordinates(patch, rotated);

      const cx = rect.x + coords.x * rect.w;
      const cy = rect.y + coords.y * rect.h;

      // Sample center 40%
      const bw = (rotated ? BADGE_CONFIG.patchBoxSize.h : BADGE_CONFIG.patchBoxSize.w) * rect.w;
      const bh = (rotated ? BADGE_CONFIG.patchBoxSize.w : BADGE_CONFIG.patchBoxSize.h) * rect.h;

      const sw = Math.max(3, Math.round(bw * BADGE_CONFIG.sampleCenterFraction));
      const sh = Math.max(3, Math.round(bh * BADGE_CONFIG.sampleCenterFraction));

      const sx = Math.max(0, Math.min(width - sw, Math.round(cx - sw / 2)));
      const sy = Math.max(0, Math.min(height - sh, Math.round(cy - sh / 2)));

      const imgData = ctx.getImageData(sx, sy, sw, sh);
      const analysis = analyzePatchPixels(imgData.data);

      frameResult[key] = {
        ...analysis,
        bounds: { x: sx, y: sy, w: sw, h: sh },
      };
    }

    patchSamplesPerFrame.push(frameResult);
  }

  // Aggregate patch medians and status across frames
  const patchMedians = {};
  const patchStatus = {};
  for (const key of patchKeys) {
    const rVals = patchSamplesPerFrame.map((f) => f[key].rgb[0]);
    const gVals = patchSamplesPerFrame.map((f) => f[key].rgb[1]);
    const bVals = patchSamplesPerFrame.map((f) => f[key].rgb[2]);
    patchMedians[key] = [median(rVals), median(gVals), median(bVals)];

    const statuses = patchSamplesPerFrame.map((f) => f[key].status);
    const avgUsable = patchSamplesPerFrame.reduce((acc, f) => acc + f[key].usableFraction, 0) / patchSamplesPerFrame.length;
    const avgStd = patchSamplesPerFrame.reduce((acc, f) => acc + f[key].lumStd, 0) / patchSamplesPerFrame.length;
    
    // Status prioritization: red if any frame red; else yellow if any frame yellow; else green
    let aggStatus = 'green';
    if (statuses.includes('red')) {
      aggStatus = 'red';
    } else if (statuses.includes('yellow')) {
      aggStatus = 'yellow';
    }
    patchStatus[key] = {
      status: aggStatus,
      usableFraction: avgUsable,
      lumStd: avgStd,
      clippedHigh: patchSamplesPerFrame[0][key].clippedHigh,
      maxCh: patchSamplesPerFrame[0][key].maxCh,
      minCh: patchSamplesPerFrame[0][key].minCh,
    };
  }

  // 1. Stability gate across frames (spread <= 6)
  if (frames.length > 1) {
    let maxSpread = 0;
    for (const key of ['R3', 'S2', 'S3']) {
      for (let ch = 0; ch < 3; ch++) {
        const chVals = patchSamplesPerFrame.map((f) => f[key].rgb[ch]);
        const spread = Math.max(...chVals) - Math.min(...chVals);
        if (spread > maxSpread) maxSpread = spread;
      }
    }
    if (maxSpread > BADGE_CONFIG.thresholds.maxFrameSpread) {
      return {
        valid: false,
        refusalReason: 'Hold steady.',
        tip: 'The phone or badge moved during capture.',
        patchStatus,
      };
    }
  }

  // 2. Forgiving Quality Check: ONLY block capture if R3, S2, or S3 is red!
  // S1 or other patches being red DOES NOT block capture.
  if (patchStatus.R3.status === 'red') {
    const isDark = (patchStatus.R3.minCh || 0) < 8;
    return {
      valid: false,
      refusalReason: isDark ? 'Too dark. Move to a brighter spot.' : 'Glare on the badge. Tilt it slightly.',
      tip: isDark ? 'Move to a brighter area to see the badge clearly.' : 'Tilt the badge slightly away from direct reflections.',
      patchStatus,
    };
  }

  if (patchStatus.S2.status === 'red' || patchStatus.S3.status === 'red') {
    return {
      valid: false,
      refusalReason: 'Glare on the badge. Tilt it slightly.',
      tip: 'Tilt the badge slightly to avoid glare on the sensing squares.',
      patchStatus,
    };
  }

  // 3. Badge Detection Check (S1 yellow or S1 glared)
  const s1Lab = rgbToLab(patchMedians.S1);
  const isS1Yellow = s1Lab[2] > BADGE_CONFIG.thresholds.s1MinLabB && s1Lab[0] > BADGE_CONFIG.thresholds.s1MinLabL;
  const isS1Glared = patchStatus.S1.status === 'red' && patchStatus.S1.clippedHigh > 0;

  if (!isS1Yellow && !isS1Glared) {
    return {
      valid: false,
      refusalReason: 'Place the badge so the six squares sit on the dots.',
      tip: 'Ensure all six squares on the badge align with the dots.',
      patchStatus,
    };
  }

  // 4. Lighting Cancellation (Linear RGB scaling so R3 becomes #C4C3BF)
  const r3MeasRgb = patchMedians.R3;
  const r3MeasLin = rgbToLinear(r3MeasRgb);
  const r3TargLin = rgbToLinear(BADGE_CONFIG.r3TargetRgb);

  let gainR = r3TargLin[0] / Math.max(1e-6, r3MeasLin[0]);
  let gainG = r3TargLin[1] / Math.max(1e-6, r3MeasLin[1]);
  let gainB = r3TargLin[2] / Math.max(1e-6, r3MeasLin[2]);

  const minGain = BADGE_CONFIG.gainLimits[0];
  const maxGain = BADGE_CONFIG.gainLimits[1];

  if (!isLearning) {
    if (gainR < minGain || gainR > maxGain || gainG < minGain || gainG > maxGain || gainB < minGain || gainB > maxGain) {
      let reason = 'Shadow on the badge. Move the light or the badge.';
      let tip = 'Even out the lighting across the badge.';
      if (gainR > maxGain || gainG > maxGain || gainB > maxGain) {
        reason = 'Too dark. Move to a brighter spot.';
        tip = 'Turn on more light or step closer to a lamp.';
      } else if (gainR < minGain || gainG < minGain || gainB < minGain) {
        reason = 'Glare on the badge. Tilt it slightly.';
        tip = 'Tilt the badge slightly away from direct reflections.';
      }
      return {
        valid: false,
        refusalReason: reason,
        tip,
        patchStatus,
      };
    }
  } else {
    // "Learning is more lenient than scanning: accept yellow patches, and never fail on lighting alone."
    gainR = clamp(gainR, 0.5, 2.0);
    gainG = clamp(gainG, 0.5, 2.0);
    gainB = clamp(gainB, 0.5, 2.0);
  }

  // Apply gains to all patches
  const correctedRgb = {};
  const correctedLab = {};
  for (const key of patchKeys) {
    const rawRgb = patchMedians[key];
    const rawLin = rgbToLinear(rawRgb);
    const corrLin = [rawLin[0] * gainR, rawLin[1] * gainG, rawLin[2] * gainB];
    const corrRgb = linearToRgb(corrLin);
    correctedRgb[key] = corrRgb;
    correctedLab[key] = rgbToLab(corrRgb);
  }

  // 5. Fingerprint = Lab of S3 and S2 after gain (6 numbers)
  const s3Lab = correctedLab.S3;
  const s2Lab = correctedLab.S2;
  const fingerprint = [...s3Lab, ...s2Lab];

  // 6. Match against templates
  const match = matchBadgeFingerprint(fingerprint, learnedTemplates);

  // 7. Yellow note: "Yellow patches proceed with a small 'Low quality' note."
  const hasYellowPatch = ['R3', 'S2', 'S3'].some((k) => patchStatus[k]?.status === 'yellow');
  const isLowQuality = Boolean(hasYellowPatch);
  const qualityNote = isLowQuality ? 'Low quality' : null;

  const s2Hex = rgbToHex(correctedRgb.S2);
  const s3Hex = rgbToHex(correctedRgb.S3);

  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);
  const dose = match.classPpm * durationMinutes;

  return {
    valid: true,
    refusalReason: null,
    tip: null,
    ppm: match.classPpm,
    approxPpm: match.approxPpm,
    classPpm: match.classPpm,
    confidence: match.confidence,
    status: match.status,
    matched: match.matched,
    isLowQuality,
    qualityNote,
    patchStatus,
    d1: match.d1,
    d2: match.d2,
    label: 'Estimate, color match',
    s2Hex,
    s3Hex,
    matchedHex: { s2: match.s2Hex, s3: match.s3Hex },
    gains: [Number(gainR.toFixed(3)), Number(gainG.toFixed(3)), Number(gainB.toFixed(3))],
    fingerprint,
    patchColors: correctedRgb,
    rawMedians: patchMedians,
    guideRect: rect,
    durationMinutes,
    dose,
    sampleBounds: patchSamplesPerFrame[0],
  };
}

// GUIDED LEARN WORKFLOW (Lenient, no popups)
function executeLearnBadgeWorkflow(ppm, frames, options = {}) {
  const reading = captureBadgeReading(frames, { ...options, isLearning: true });
  if (!reading.valid) {
    return {
      success: false,
      message: reading.refusalReason,
      tip: reading.tip,
    };
  }
  saveLearnedTemplate(ppm, reading.s3Hex, reading.s2Hex);
  return {
    success: true,
    ppm: Number(ppm),
    s3Hex: reading.s3Hex,
    s2Hex: reading.s2Hex,
    message: `Learned ${ppm} ppm`,
  };
}

// Synthetic badge generator for unit tests and local simulations
function createSyntheticBadge({
  ppm = 20,
  s3Hex = null,
  s2Hex = null,
  gain = [1, 1, 1],
  brightness = 1.0,
  nonUniformStd = 0,
  clipped = false,
  clippedRatio = 0,
  s1Glared = false,
  noBadge = false,
  randomColor = false,
  rotated = false,
  width = 640,
  height = 480,
} = {}) {
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const pixels = new Uint8ClampedArray(width * height * 4);

  // Fill background
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 230;
    pixels[i + 1] = 232;
    pixels[i + 2] = 235;
    pixels[i + 3] = 255;
  }

  // Guide rectangle centered
  const targetAspect = rotated ? (1 / BADGE_CONFIG.aspectRatio) : BADGE_CONFIG.aspectRatio;
  let rWidth, rHeight;
  if (width / height > targetAspect) {
    rHeight = Math.round(height * 0.76);
    rWidth = Math.round(rHeight * targetAspect);
  } else {
    rWidth = Math.round(width * 0.76);
    rHeight = Math.round(rWidth / targetAspect);
  }
  const rX = Math.round((width - rWidth) / 2);
  const rY = Math.round((height - rHeight) / 2);

  // Badge body
  for (let y = rY; y < rY + rHeight; y++) {
    for (let x = rX; x < rX + rWidth; x++) {
      const idx = (y * width + x) * 4;
      pixels[idx] = 250;
      pixels[idx + 1] = 250;
      pixels[idx + 2] = 250;
      pixels[idx + 3] = 255;
    }
  }

  const tpl = BADGE_CONFIG.defaultTemplates[ppm] || BADGE_CONFIG.defaultTemplates[20];
  const s3Target = randomColor ? '#128472' : (s3Hex || tpl.s3Hex);
  const s2Target = randomColor ? '#451092' : (s2Hex || tpl.s2Hex);
  const s1Target = noBadge ? '#3498DB' : BADGE_CONFIG.patches.S1.defaultHex; // blue if noBadge

  const patchTargetHex = {
    R1: BADGE_CONFIG.patches.R1.defaultHex,
    S1: s1Target,
    R2: BADGE_CONFIG.patches.R2.defaultHex,
    S2: s2Target,
    R3: BADGE_CONFIG.r3TargetHex,
    S3: s3Target,
  };

  const patchKeys = Object.keys(BADGE_CONFIG.patches);

  for (const key of patchKeys) {
    const patch = BADGE_CONFIG.patches[key];
    const coords = getPatchCoordinates(patch, rotated);

    const cx = rX + coords.x * rWidth;
    const cy = rY + coords.y * rHeight;

    const pw = Math.round((rotated ? BADGE_CONFIG.patchBoxSize.h : BADGE_CONFIG.patchBoxSize.w) * rWidth);
    const ph = Math.round((rotated ? BADGE_CONFIG.patchBoxSize.w : BADGE_CONFIG.patchBoxSize.h) * rHeight);

    const px1 = Math.max(0, Math.round(cx - pw / 2));
    const px2 = Math.min(width, Math.round(cx + pw / 2));
    const py1 = Math.max(0, Math.round(cy - ph / 2));
    const py2 = Math.min(height, Math.round(cy + ph / 2));

    const baseRgb = hexToRgb(patchTargetHex[key]);
    const lin = rgbToLinear(baseRgb);

    // Apply lighting gain and brightness
    const illLin = [
      lin[0] * gain[0] * brightness,
      lin[1] * gain[1] * brightness,
      lin[2] * gain[2] * brightness,
    ];
    const illRgb = linearToRgb(illLin);

    let pixCounter = 0;
    for (let y = py1; y < py2; y++) {
      for (let x = px1; x < px2; x++) {
        const idx = (y * width + x) * 4;
        let r = illRgb[0];
        let g = illRgb[1];
        let b = illRgb[2];

        // Non-uniform noise injection
        if (nonUniformStd > 0 && key === 'S3') {
          const noise = (pixCounter % 2 === 0 ? 1 : -1) * nonUniformStd * 1.6;
          r = clamp(Math.round(r + noise), 0, 255);
          g = clamp(Math.round(g + noise), 0, 255);
          b = clamp(Math.round(b + noise), 0, 255);
        }

        // S1 Glare injection
        if (s1Glared && key === 'S1') {
          r = 255;
          g = 255;
          b = 255;
        }

        // Clipping injection
        if (clipped && key === 'S3') {
          r = 255;
          g = 255;
          b = 255;
        } else if (clippedRatio > 0 && key === 'S3') {
          const totalInPatch = (py2 - py1) * (px2 - px1);
          if (pixCounter < totalInPatch * clippedRatio) {
            r = 255;
            g = 255;
            b = 255;
          }
        }

        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
        pixCounter++;
      }
    }
  }

  return {
    width,
    height,
    _pixels: pixels,
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
    toDataURL: () => 'data:image/jpeg;base64,mockbadge',
  };
}

// Records & Storage
function records() {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (error) {
    return [];
  }
}

let lastRecordTimestampMs = 0;

function generateRecordTimestamp() {
  let now = Date.now();
  if (now <= lastRecordTimestampMs) {
    now = lastRecordTimestampMs + 1;
  }
  lastRecordTimestampMs = now;
  return new Date(now).toISOString();
}

function saveRecord(reading) {
  const current = records();
  const workerId = document.querySelector('#workerId')?.value || 'WRK-1048';
  const badgeId = document.querySelector('#badgeId')?.value || 'H2S-24091';
  const shiftId = document.querySelector('#shiftId')?.value || 'NIGHT-07';
  const duration = Number(reading.durationMinutes || 15);
  const timestamp = reading.timestamp || generateRecordTimestamp();

  const record = {
    workerId,
    badgeId,
    shiftId,
    timestamp,
    dose: Number((reading.ppm * duration).toFixed(1)),
    valid: Boolean(reading.valid),
    durationMinutes: duration,
    concentrationBandEstimate: `${reading.ppm} ppm-equivalent`,
    confidenceLevel: reading.confidence,
    ppm: reading.ppm,
    approxPpm: reading.approxPpm,
    classPpm: reading.classPpm,
    confidence: reading.confidence,
    s2Hex: reading.s2Hex,
    s3Hex: reading.s3Hex,
    matchedS2Hex: reading.matchedHex?.s2,
    matchedS3Hex: reading.matchedHex?.s3,
    d1: reading.d1,
    d2: reading.d2,
    gains: reading.gains,
  };

  const updated = [...current, record];
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }
  return record;
}

function deleteRecord(timestamp) {
  const current = records();
  const filtered = current.filter((r) => r.timestamp !== timestamp);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  }
  renderRecords();
}

function deleteAllRecords() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  renderRecords();
}

function computeIncrementalExposure(selected) {
  if (!selected || selected.length < 2) return { doseDifference: 0, timeElapsedMinutes: 0 };
  const sorted = [...selected].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const doseDifference = Math.max(0, last.dose - first.dose);
  const timeElapsedMinutes = Math.max(0, (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 60000);
  return { doseDifference, timeElapsedMinutes };
}

function renderComparisonControls(stored) {
  const left = document.querySelector('#compareLeftSelect');
  const right = document.querySelector('#compareRightSelect');
  if (!left || !right) return;

  const options = stored.length
    ? stored.map((r) => `<option value="${r.timestamp}">${r.workerId} / ${r.badgeId} / ${new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</option>`).join('')
    : '<option value="">No saved records</option>';

  left.innerHTML = `<option value="">Select earlier reading</option>${options}`;
  right.innerHTML = `<option value="">Select later reading</option>${options}`;
}

function updateComparisonSummary() {
  const leftVal = document.querySelector('#compareLeftSelect')?.value;
  const rightVal = document.querySelector('#compareRightSelect')?.value;
  const output = document.querySelector('#compareSummary');
  if (!output) return;

  if (!leftVal || !rightVal) {
    output.textContent = 'Select two saved readings to view the incremental exposure.';
    return;
  }

  const stored = records();
  const leftRec = stored.find((r) => r.timestamp === leftVal);
  const rightRec = stored.find((r) => r.timestamp === rightVal);

  if (!leftRec || !rightRec) {
    output.textContent = 'Unable to compare selected readings.';
    return;
  }

  const result = computeIncrementalExposure([leftRec, rightRec]);
  const timeStr = result.timeElapsedMinutes > 0 ? `${result.timeElapsedMinutes.toFixed(0)} min` : 'less than 1 min';
  output.textContent = `Incremental exposure: ${result.doseDifference.toFixed(1)} ppm·min over ${timeStr}.`;
}

function renderRecords() {
  const stored = records();
  const countEl = document.querySelector('#recordCount');
  if (countEl) countEl.textContent = `${stored.length} saved`;

  renderComparisonControls(stored);

  const tbody = document.querySelector('#recordsBody');
  if (!tbody) return;

  if (!stored.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No readings yet. Captured records remain available in airplane mode.</td></tr>';
    return;
  }

  tbody.innerHTML = stored.slice().reverse().map((r) => {
    const timeFormatted = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const classStr = r.classPpm !== undefined ? `${r.classPpm} ppm` : (r.concentrationBandEstimate || '--');
    const doseStr = `${Number(r.dose || 0).toFixed(1)} ppm·min`;
    const confStr = r.confidence || r.confidenceLevel || 'High';

    return `
      <tr>
        <td><strong>${r.workerId}</strong><br><small class="text-muted">${r.badgeId}</small></td>
        <td>${timeFormatted}</td>
        <td><span class="class-pill">${classStr}</span></td>
        <td>${doseStr}</td>
        <td><span class="confidence-tag ${confStr.toLowerCase().includes('low') ? 'low' : 'high'}">${confStr}</span></td>
        <td style="text-align:center;">
          <button class="icon-delete-btn" type="button" data-timestamp="${r.timestamp}" aria-label="Delete reading" title="Delete reading">✕</button>
        </td>
      </tr>
    `;
  }).join('');

  // Row delete button handlers
  tbody.querySelectorAll('.icon-delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ts = btn.dataset.timestamp;
      showConfirmDialog('Delete this saved reading? This can\'t be undone.', () => {
        deleteRecord(ts);
      });
    });
  });
}

function showConfirmDialog(message, onConfirm) {
  const modal = document.querySelector('#confirmDeleteModal');
  const msgEl = document.querySelector('#confirmDialogMessage');
  const confirmBtn = document.querySelector('#confirmDeleteBtn');
  const cancelBtn = document.querySelector('#confirmCancelBtn');

  if (!modal) {
    if (typeof confirm === 'function' && confirm(message)) onConfirm();
    return;
  }

  if (msgEl) msgEl.textContent = message;
  modal.hidden = false;
  modal.classList.remove('hidden');
  modal.style.display = 'flex';

  function cleanup() {
    modal.hidden = true;
    modal.classList.add('hidden');
    modal.style.display = 'none';
    confirmBtn?.removeEventListener('click', handleConfirm);
    cancelBtn?.removeEventListener('click', handleCancel);
    modal.removeEventListener('click', handleBackdrop);
    document.removeEventListener('keydown', handleKeydown);
  }

  function handleConfirm(e) {
    e?.preventDefault();
    e?.stopPropagation();
    cleanup();
    onConfirm();
  }

  function handleCancel(e) {
    e?.preventDefault();
    e?.stopPropagation();
    cleanup();
  }

  function handleBackdrop(e) {
    if (e.target === modal) {
      cleanup();
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }

  confirmBtn?.addEventListener('click', handleConfirm);
  cancelBtn?.addEventListener('click', handleCancel);
  modal.addEventListener('click', handleBackdrop);
  document.addEventListener('keydown', handleKeydown);
}

// UI Rendering
function showResult(reading) {
  const resultContent = document.querySelector('#resultContent');
  const resultEmpty = document.querySelector('#resultEmpty');
  const retakeContent = document.querySelector('#retakeContent');

  if (resultEmpty) resultEmpty.hidden = true;
  if (retakeContent) retakeContent.hidden = true;
  if (resultContent) resultContent.hidden = false;

  const concEl = document.querySelector('#concentrationValue');
  const approxEl = document.querySelector('#approxPpmValue');
  const confEl = document.querySelector('#confidenceValue');
  const classEl = document.querySelector('#classValue');
  const doseEl = document.querySelector('#doseValue');
  const durationEl = document.querySelector('#durationValue');
  const thresholdEl = document.querySelector('#thresholdResult');
  const timeEl = document.querySelector('#resultTime');

  if (concEl) concEl.textContent = `${reading.classPpm} ppm`;
  if (approxEl) approxEl.textContent = `~${reading.approxPpm} ppm`;
  if (confEl) {
    confEl.textContent = reading.confidence;
    confEl.className = `confidence-chip ${reading.confidence.toLowerCase().includes('low') ? 'low' : 'high'}`;
  }
  if (classEl) classEl.textContent = `Class ${reading.classPpm} ppm`;
  if (doseEl) doseEl.textContent = `${reading.dose.toFixed(1)} ppm·min`;
  if (durationEl) durationEl.textContent = `${reading.durationMinutes} min`;
  if (thresholdEl) {
    const isExceeded = reading.dose > THRESHOLD;
    thresholdEl.textContent = isExceeded ? 'Exceeded threshold' : 'Within limit';
    thresholdEl.style.color = isExceeded ? 'var(--status-red-text, #ef4444)' : 'var(--text-primary)';
  }
  if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Collapsible details
  const s3El = document.querySelector('#detailS3Hex');
  const s2El = document.querySelector('#detailS2Hex');
  const gainsEl = document.querySelector('#detailGains');
  const distEl = document.querySelector('#detailDistances');
  const usabilityEl = document.querySelector('#detailPatchUsability');
  const qualityBadge = document.querySelector('#qualityNoteBadge');

  if (qualityBadge) {
    if (reading.isLowQuality) {
      qualityBadge.style.display = 'inline-flex';
    } else {
      qualityBadge.style.display = 'none';
    }
  }

  if (s3El) s3El.textContent = `${reading.s3Hex} / matched ${reading.matchedHex?.s3 || '--'}`;
  if (s2El) s2El.textContent = `${reading.s2Hex} / matched ${reading.matchedHex?.s2 || '--'}`;
  if (gainsEl) gainsEl.textContent = `${reading.gains[0]}, ${reading.gains[1]}, ${reading.gains[2]}`;
  if (distEl) distEl.textContent = `d1: ${reading.d1}, d2: ${reading.d2}`;
  if (usabilityEl && reading.patchStatus) {
    const list = Object.entries(reading.patchStatus).map(([k, s]) => `${k}: ${Math.round((s.usableFraction ?? 1) * 100)}% (${s.status})`);
    usabilityEl.textContent = list.join(', ');
  }

  const panel = document.querySelector('#resultPanel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showRefusal(message, tip = '') {
  const resultContent = document.querySelector('#resultContent');
  const resultEmpty = document.querySelector('#resultEmpty');
  const retakeContent = document.querySelector('#retakeContent');
  const retakeHeading = document.querySelector('#retakeHeading');
  const retakeMsg = document.querySelector('#retakeMessage');
  const retakeTip = document.querySelector('#retakeTip');

  if (resultContent) resultContent.hidden = true;
  if (resultEmpty) resultEmpty.hidden = true;
  if (retakeContent) retakeContent.hidden = false;

  if (retakeHeading) retakeHeading.textContent = message || 'Could not read badge';
  if (retakeMsg) retakeMsg.textContent = tip || 'Place the badge so the six squares sit on the dots.';
  if (retakeTip) retakeTip.textContent = '';

  const panel = document.querySelector('#resultPanel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function drawDebugOverlay(frame, reading, rotated) {
  const overlay = document.querySelector('#roiDebugOverlay');
  if (!overlay) return;
  overlay.width = frame.width;
  overlay.height = frame.height;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.drawImage(frame, 0, 0);

  const rect = reading?.guideRect || {
    x: Math.round(frame.width * 0.18),
    y: Math.round(frame.height * 0.12),
    w: Math.round(frame.width * 0.64),
    h: Math.round(frame.height * 0.76),
  };

  // Draw guide rect
  ctx.strokeStyle = '#0d9488';
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  // Draw patch boxes with hex
  for (const [key, patch] of Object.entries(BADGE_CONFIG.patches)) {
    const coords = getPatchCoordinates(patch, rotated);
    const cx = rect.x + coords.x * rect.w;
    const cy = rect.y + coords.y * rect.h;

    const pw = (rotated ? BADGE_CONFIG.patchBoxSize.h : BADGE_CONFIG.patchBoxSize.w) * rect.w;
    const ph = (rotated ? BADGE_CONFIG.patchBoxSize.w : BADGE_CONFIG.patchBoxSize.h) * rect.h;
    const sx = cx - pw / 2;
    const sy = cy - ph / 2;

    ctx.strokeStyle = key.startsWith('S') ? '#4ade80' : '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, sy, pw, ph);

    const hex = reading?.patchColors?.[key] ? rgbToHex(reading.patchColors[key]) : patch.defaultHex || '';
    const label = `${key}: ${hex}`;
    ctx.font = 'bold 10px monospace';
    const tw = ctx.measureText(label).width + 6;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(sx, Math.max(0, sy - 14), tw, 13);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, sx + 3, Math.max(10, sy - 3));
  }
}

// Browser Initialization
function initBrowser() {
  let cameraStream = null;
  let isRotated = false;
  let isDebugActive = false;
  let lastCapturedFrames = null;
  let lastReading = null;

  const dateEl = document.querySelector('#captureDate');
  if (dateEl) {
    dateEl.textContent = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).toUpperCase();
  }

  // Camera Management
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const stateEl = document.querySelector('#cameraState');
      if (stateEl) stateEl.textContent = 'Upload mode';
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      const video = document.querySelector('#cameraFeed');
      const placeholder = document.querySelector('#cameraPlaceholder');
      if (video) {
        video.srcObject = cameraStream;
        video.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';

      // Check exposure and white balance lock support
      const track = cameraStream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities ? track.getCapabilities() : {};
      let lockStatus = 'Rear camera active';

      if (capabilities.exposureMode?.includes('continuous') || capabilities.whiteBalanceMode?.includes('continuous')) {
        try {
          await track.applyConstraints({
            advanced: [{ exposureMode: 'continuous', whiteBalanceMode: 'continuous' }],
          });
          lockStatus = 'Camera locked (WB/Exp continuous)';
        } catch (e) {
          lockStatus = 'Camera ready';
        }
      }

      const stateEl = document.querySelector('#cameraState');
      if (stateEl) stateEl.textContent = lockStatus;
    } catch (err) {
      console.warn('Camera stream error:', err);
      const stateEl = document.querySelector('#cameraState');
      if (stateEl) stateEl.textContent = 'Camera unavailable • Use upload';
    }
  }

  async function captureFrames(count = 15) {
    const video = document.querySelector('#cameraFeed');
    const uploadedPreview = document.querySelector('#uploadedPreview');

    // If an uploaded image is active, use that single frame
    if (uploadedPreview && uploadedPreview.style.display !== 'none' && uploadedPreview.src) {
      const canvas = document.createElement('canvas');
      canvas.width = uploadedPreview.naturalWidth || 640;
      canvas.height = uploadedPreview.naturalHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(uploadedPreview, 0, 0, canvas.width, canvas.height);
      return [canvas];
    }

    if (!video || !video.videoWidth) {
      return null;
    }

    const frames = [];
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    for (let i = 0; i < count; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, vw, vh);
      frames.push(canvas);
      if (count > 1) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    return frames;
  }

  // Sound, vibration, and flash feedback
  function playFeedbackTone() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
      }
    } catch (e) {}

    try {
      if (navigator.vibrate) {
        navigator.vibrate(80);
      }
    } catch (e) {}
  }

  function flashCapturedEffect() {
    const frame = document.querySelector('#cameraFrame');
    if (frame) {
      frame.classList.add('flash-captured');
      setTimeout(() => frame.classList.remove('flash-captured'), 450);
    }
  }

  // Best of 3 capture engine
  async function runBestOfThreeCapture(options = {}) {
    let bestAttempt = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const frames = await captureFrames(attempt === 1 ? 15 : 8);
      if (!frames || !frames.length) continue;

      const reading = captureBadgeReading(frames, { rotated: isRotated, ...options });
      let greenCount = 0;
      if (reading.patchStatus) {
        for (const st of Object.values(reading.patchStatus)) {
          if (st.status === 'green') greenCount++;
        }
      }

      const attemptResult = { reading, frames, greenCount, attempt };
      if (!bestAttempt) {
        bestAttempt = attemptResult;
      } else {
        if (reading.valid && !bestAttempt.reading.valid) {
          bestAttempt = attemptResult;
        } else if (reading.valid === bestAttempt.reading.valid && greenCount > bestAttempt.greenCount) {
          bestAttempt = attemptResult;
        }
      }

      if (reading.valid && greenCount >= 5) {
        break;
      }

      if (!reading.valid && attempt < 3) {
        await new Promise((r) => setTimeout(r, 160));
      }
    }

    return bestAttempt;
  }

  let isCaptureInProgress = false;

  async function triggerCapture(isAuto = false) {
    if (isCaptureInProgress) return;
    isCaptureInProgress = true;
    const btn = document.querySelector('#captureButton');
    if (btn) btn.disabled = true;

    try {
      const best = await runBestOfThreeCapture();
      if (!best || !best.reading) {
        showRefusal('Place the badge so the six squares sit on the dots.');
        return;
      }

      lastCapturedFrames = best.frames;
      lastReading = best.reading;

      if (!best.reading.valid) {
        showRefusal(best.reading.refusalReason, best.reading.tip);
      } else {
        if (isAuto) {
          playFeedbackTone();
          flashCapturedEffect();
        }
        saveRecord(best.reading);
        renderRecords();
        showResult(best.reading);
      }

      if (isDebugActive && best.frames && best.frames[0]) {
        drawDebugOverlay(best.frames[0], best.reading, isRotated);
      }
    } finally {
      isCaptureInProgress = false;
      if (btn) btn.disabled = false;
      autoCaptureEngine.isCapturing = false;
    }
  }

  // Auto Capture Controller
  const autoCaptureEngine = new AutoCaptureEngine({
    delayMs: 1000,
    cooldownMs: 3500,
    onBeep: playFeedbackTone,
    onFlash: flashCapturedEffect,
    onCapture: () => {
      triggerCapture(true);
    },
  });

  const autoCaptureToggle = document.querySelector('#autoCaptureToggle');
  if (autoCaptureToggle) {
    autoCaptureEngine.enabled = autoCaptureToggle.checked;
    autoCaptureToggle.addEventListener('change', (e) => {
      autoCaptureEngine.enabled = e.target.checked;
    });
  }

  // Handle capture button
  document.querySelector('#captureButton')?.addEventListener('click', () => {
    triggerCapture(false);
  });

  // Try again button in friendly refusal card
  document.querySelector('#tryAgainBtn')?.addEventListener('click', () => {
    document.querySelector('#cameraFrame')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    triggerCapture(false);
  });

  // Live 4-times-a-second patch guide runner
  let previousMedians = null;
  let isLearningActive = false;
  let isCalibrateAll = false;
  let calibrateAllIndex = 0;
  const CALIBRATE_PPM_STEPS = [10, 20, 40, 50];
  let learnStableStartTime = null;

  function runLivePatchGuide() {
    const video = document.querySelector('#cameraFeed');
    const uploadedPreview = document.querySelector('#uploadedPreview');
    let sourceEl = null;

    if (uploadedPreview && uploadedPreview.style.display !== 'none' && uploadedPreview.naturalWidth) {
      sourceEl = uploadedPreview;
    } else if (video && video.videoWidth && video.style.display !== 'none') {
      sourceEl = video;
    }

    if (!sourceEl) return;

    const sw = sourceEl.videoWidth || sourceEl.naturalWidth || 640;
    const sh = sourceEl.videoHeight || sourceEl.naturalHeight || 480;

    let offscreen = document.querySelector('#liveOffscreenCanvas');
    if (!offscreen) {
      offscreen = document.createElement('canvas');
      offscreen.id = 'liveOffscreenCanvas';
      offscreen.style.display = 'none';
      document.body.appendChild(offscreen);
    }
    offscreen.width = sw;
    offscreen.height = sh;
    const ctx = offscreen.getContext('2d');
    ctx.filter = 'none';
    ctx.drawImage(sourceEl, 0, 0, sw, sh);

    const guideResult = evaluateLiveGuide(offscreen, {
      rotated: isRotated,
      previousMedians,
    });
    previousMedians = guideResult.patchMedians;

    // 1. Color each dot R1 to S3 green, yellow, or red
    for (const [key, info] of Object.entries(guideResult.patchStatus)) {
      const dotEl = document.querySelector(`.patch-target.${key.toLowerCase()}`);
      if (dotEl) {
        dotEl.classList.remove('dot-green', 'dot-yellow', 'dot-red');
        dotEl.classList.add(`dot-${info.status}`);
      }
    }

    // 2. Show one plain line under the viewfinder with the single most useful tip
    const tipEl = document.querySelector('#viewfinderTip');
    if (tipEl) {
      tipEl.textContent = guideResult.tip;
    }

    // 3. Auto capture or Guided Learning
    if (isLearningActive) {
      if (guideResult.isKeyPatchesUsable && guideResult.isStable) {
        handleGuidedLearnStep([offscreen]);
      } else {
        learnStableStartTime = null;
      }
    } else if (autoCaptureEngine.enabled && !isCaptureInProgress) {
      autoCaptureEngine.update({
        isKeyPatchesUsable: guideResult.isKeyPatchesUsable,
        isStable: guideResult.isStable,
        now: Date.now(),
      });
    }
  }

  setInterval(runLivePatchGuide, 250);

  // Guided Learn Panel Controls
  const learnPanel = document.querySelector('#guidedLearnPanel');
  const learnHeading = document.querySelector('#learnGuideHeading');
  const learnStepTag = document.querySelector('#learnStepTag');
  const learnPpmSelect = document.querySelector('#learnPpmSelect');
  const learnCustomInput = document.querySelector('#learnCustomPpmInput');
  const learnSkipBtn = document.querySelector('#learnSkipBtn');
  const closeLearnBtn = document.querySelector('#closeLearnPanelBtn');
  const learnFeedback = document.querySelector('#guidedFeedback');
  const learnFeedbackText = document.querySelector('#guidedFeedbackText');

  function openGuidedLearn({ calibrateAll = false } = {}) {
    isLearningActive = true;
    isCalibrateAll = calibrateAll;
    calibrateAllIndex = 0;
    learnStableStartTime = null;

    if (learnPanel) learnPanel.hidden = false;
    updateGuidedLearnUI();
    document.querySelector('#cameraFrame')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function closeGuidedLearn() {
    isLearningActive = false;
    isCalibrateAll = false;
    learnStableStartTime = null;
    if (learnPanel) learnPanel.hidden = true;
    if (learnFeedback) learnFeedback.hidden = true;
  }

  function getCurrentTargetPpm() {
    if (isCalibrateAll) {
      return CALIBRATE_PPM_STEPS[calibrateAllIndex] || 20;
    }
    const val = learnPpmSelect?.value;
    if (val === 'custom') {
      return Number(learnCustomInput?.value) || 25;
    }
    return Number(val) || 20;
  }

  function updateGuidedLearnUI() {
    const targetPpm = getCurrentTargetPpm();
    if (isCalibrateAll) {
      if (learnStepTag) {
        learnStepTag.hidden = false;
        learnStepTag.textContent = `Step ${calibrateAllIndex + 1} of ${CALIBRATE_PPM_STEPS.length}`;
      }
      if (learnSkipBtn) learnSkipBtn.style.display = 'inline-flex';
      if (learnHeading) learnHeading.textContent = `Hold the ${targetPpm} ppm badge in the frame.`;
      if (learnPpmSelect) learnPpmSelect.value = String(targetPpm);
    } else {
      if (learnStepTag) learnStepTag.hidden = true;
      if (learnSkipBtn) learnSkipBtn.style.display = 'none';
      if (learnHeading) learnHeading.textContent = `Hold the ${targetPpm} ppm badge in the frame.`;
    }
  }

  function handleGuidedLearnStep(frames) {
    const now = Date.now();
    if (!learnStableStartTime) {
      learnStableStartTime = now;
      return;
    }

    if (now - learnStableStartTime < 1000) {
      return;
    }

    // 1 second stable!
    learnStableStartTime = null;
    const targetPpm = getCurrentTargetPpm();
    const result = executeLearnBadgeWorkflow(targetPpm, frames, { isLearning: true });

    if (result.success) {
      playFeedbackTone();
      flashCapturedEffect();

      if (learnFeedback && learnFeedbackText) {
        learnFeedback.hidden = false;
        learnFeedbackText.textContent = `✓ Learned ${targetPpm} ppm`;
      }

      if (isCalibrateAll) {
        calibrateAllIndex++;
        if (calibrateAllIndex < CALIBRATE_PPM_STEPS.length) {
          setTimeout(() => {
            if (learnFeedback) learnFeedback.hidden = true;
            updateGuidedLearnUI();
          }, 1200);
        } else {
          setTimeout(() => {
            if (learnFeedbackText) learnFeedbackText.textContent = '✓ Calibration complete! All levels learned.';
            setTimeout(() => {
              closeGuidedLearn();
            }, 1800);
          }, 1200);
        }
      } else {
        setTimeout(() => {
          if (learnFeedback) learnFeedback.hidden = true;
          closeGuidedLearn();
        }, 1500);
      }
    }
  }

  document.querySelector('#learnBadgeBtn')?.addEventListener('click', () => {
    openGuidedLearn({ calibrateAll: false });
  });

  document.querySelector('#calibrateAllBtn')?.addEventListener('click', () => {
    openGuidedLearn({ calibrateAll: true });
  });

  closeLearnBtn?.addEventListener('click', closeGuidedLearn);

  learnPpmSelect?.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      if (learnCustomInput) learnCustomInput.style.display = 'inline-block';
    } else {
      if (learnCustomInput) learnCustomInput.style.display = 'none';
    }
    updateGuidedLearnUI();
  });

  learnCustomInput?.addEventListener('input', updateGuidedLearnUI);

  learnSkipBtn?.addEventListener('click', () => {
    if (isCalibrateAll) {
      calibrateAllIndex++;
      if (calibrateAllIndex < CALIBRATE_PPM_STEPS.length) {
        updateGuidedLearnUI();
      } else {
        closeGuidedLearn();
      }
    }
  });

  // Handle Upload Image
  const uploadBtn = document.querySelector('#uploadButton');
  const imageInput = document.querySelector('#imageInput');

  uploadBtn?.addEventListener('click', () => imageInput?.click());

  imageInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      let preview = document.querySelector('#uploadedPreview');
      if (!preview) {
        preview = document.createElement('img');
        preview.id = 'uploadedPreview';
        preview.alt = 'Uploaded badge';
        document.querySelector('#cameraFrame')?.appendChild(preview);
      }

      preview.onload = async () => {
        preview.style.display = 'block';
        const feed = document.querySelector('#cameraFeed');
        const ph = document.querySelector('#cameraPlaceholder');
        if (feed) feed.style.display = 'none';
        if (ph) ph.style.display = 'none';

        const stateEl = document.querySelector('#cameraState');
        if (stateEl) stateEl.textContent = 'Uploaded image ready';

        const canvas = document.createElement('canvas');
        canvas.width = preview.naturalWidth;
        canvas.height = preview.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(preview, 0, 0);

        lastCapturedFrames = [canvas];
        const reading = captureBadgeReading([canvas], { rotated: isRotated });
        lastReading = reading;

        if (!reading.valid) {
          showRefusal(reading.refusalReason);
        } else {
          saveRecord(reading);
          renderRecords();
          showResult(reading);
        }

        if (isDebugActive) {
          drawDebugOverlay(canvas, reading, isRotated);
        }
      };
      preview.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });

  // Rotate Grid 90 button
  const rotateBtn = document.querySelector('#rotateButton');
  rotateBtn?.addEventListener('click', () => {
    isRotated = !isRotated;
    rotateBtn.textContent = isRotated ? 'Rotated 90°' : 'Rotate grid 90°';
    const guide = document.querySelector('#badgeGuide');
    if (guide) {
      guide.classList.toggle('rotated', isRotated);
    }
    if (lastCapturedFrames && lastCapturedFrames.length) {
      const reading = captureBadgeReading(lastCapturedFrames, { rotated: isRotated });
      lastReading = reading;
      if (reading.valid) {
        showResult(reading);
      } else {
        showRefusal(reading.refusalReason);
      }
      if (isDebugActive) {
        drawDebugOverlay(lastCapturedFrames[0], reading, isRotated);
      }
    }
  });

  // Debug toggle button
  const debugBtn = document.querySelector('#debugToggleBtn');
  debugBtn?.addEventListener('click', () => {
    isDebugActive = !isDebugActive;
    debugBtn.classList.toggle('active', isDebugActive);
    const overlay = document.querySelector('#roiDebugOverlay');
    if (overlay) overlay.hidden = !isDebugActive;

    if (isDebugActive && lastCapturedFrames && lastCapturedFrames[0]) {
      drawDebugOverlay(lastCapturedFrames[0], lastReading, isRotated);
    }
  });

  // Reset to defaults (no alert)
  const resetBtn = document.querySelector('#resetLearnedBtn');
  resetBtn?.addEventListener('click', () => {
    showConfirmDialog('Reset all learned badges to defaults? This can\'t be undone.', () => {
      resetLearnedTemplates();
      const banner = document.querySelector('#repeatTestResults');
      if (banner) {
        banner.hidden = false;
        banner.textContent = '✓ Learned badges reset to factory defaults.';
        setTimeout(() => { banner.hidden = true; }, 3000);
      }
    });
  });

  // Repeat Test (5 captures, show class counts and min and max ppm)
  const repeatBtn = document.querySelector('#repeatTestBtn');
  repeatBtn?.addEventListener('click', async () => {
    repeatBtn.disabled = true;
    const banner = document.querySelector('#repeatTestResults');
    if (banner) {
      banner.hidden = false;
      banner.textContent = 'Running 5 repeat captures...';
    }

    try {
      const counts = {};
      const ppms = [];

      for (let i = 0; i < 5; i++) {
        const frames = await captureFrames(5);
        if (!frames) break;
        const reading = captureBadgeReading(frames, { rotated: isRotated });
        if (reading.valid) {
          counts[reading.ppm] = (counts[reading.ppm] || 0) + 1;
          ppms.push(reading.ppm);
        }
        await new Promise((r) => setTimeout(r, 80));
      }

      if (!ppms.length) {
        if (banner) banner.textContent = 'Repeat test failed: quality check not met.';
      } else {
        const minPpm = Math.min(...ppms);
        const maxPpm = Math.max(...ppms);
        const countStr = Object.entries(counts).map(([p, c]) => `${p} ppm: ${c}x`).join(', ');
        if (banner) {
          banner.textContent = `Repeat test (5 captures): ${countStr} (Min: ${minPpm} ppm, Max: ${maxPpm} ppm)`;
        }
      }
    } finally {
      repeatBtn.disabled = false;
    }
  });

  // Delete All Records button
  document.querySelector('#deleteAllRecordsBtn')?.addEventListener('click', () => {
    showConfirmDialog('Delete all saved readings? This can\'t be undone.', () => {
      deleteAllRecords();
    });
  });

  // Compare dropdown handlers
  document.querySelector('#compareLeftSelect')?.addEventListener('change', updateComparisonSummary);
  document.querySelector('#compareRightSelect')?.addEventListener('change', updateComparisonSummary);

  // Clear Session Form
  document.querySelector('#clearForm')?.addEventListener('click', () => {
    ['workerId', 'badgeId', 'shiftId'].forEach((id) => {
      const el = document.querySelector(`#${id}`);
      if (el) el.value = '';
    });
  });

  // Initial render
  const modal = document.querySelector('#confirmDeleteModal');
  if (modal) {
    modal.hidden = true;
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }

  renderRecords();
  startCamera();
}

// Global initialization
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', initBrowser);
}

// Module Exports for Node.js unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BADGE_CONFIG,
    clamp,
    hexToRgb,
    rgbToHex,
    srgbToLinearChannel,
    linearToSrgbChannel,
    rgbToLinear,
    linearToRgb,
    rgbToLab,
    median,
    getPatchCoordinates,
    getLearnedTemplates,
    saveLearnedTemplate,
    resetLearnedTemplates,
    getCombinedTemplates,
    matchBadgeFingerprint,
    captureBadgeReading,
    createSyntheticBadge,
    records,
    saveRecord,
    deleteRecord,
    deleteAllRecords,
    computeIncrementalExposure,
    renderRecords,
    analyzePatchPixels,
    getLiveGuideTip,
    evaluateLiveGuide,
    AutoCaptureEngine,
    executeLearnBadgeWorkflow,
  };
}

})();
