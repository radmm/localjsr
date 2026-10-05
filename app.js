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
  sampleCenterFraction: 0.30, // sample center 30% of each patch (avoids edge bleed)
  r3TargetHex: '#C4C3BF',
  r3TargetRgb: [196, 195, 191],
  gainLimits: [0.5, 2.0],
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
    maxLuminanceStd: 18.0, // Balanced quality check: catches non-uniformity without failing good training pics
    maxClippedFraction: 0.06, // Balanced: 6% threshold prevents blowout while ignoring minor single-pixel noise
    maxFrameSpread: 12.0, // Balanced: detects camera movement while tolerating steady handheld shots
    s1MinLabB: 32.0, // Strictly checks for yellow S1 badge patch presence
    s1MinLabL: 50.0, // Strictly checks for adequate illumination
    noMatchDist: 20.0, // Class match distance ceiling
    lowConfidenceDist: 14.0,
    lowConfidenceDiff: 3.0,
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

// ONE CAPTURE FUNCTION
function captureBadgeReading(frames, { rotated = false, learnedTemplates = null, guideRect = null } = {}) {
  if (!frames || !frames.length) {
    return { valid: false, refusalReason: 'No image frames captured' };
  }

  const firstFrame = frames[0];
  const width = firstFrame.width;
  const height = firstFrame.height;

  // Compute guide rectangle in pixel coordinates
  let rect;
  if (guideRect) {
    rect = guideRect;
  } else {
    // Default guide rectangle centered in frame
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
      const data = imgData.data;
      const totalPixels = data.length / 4;

      const rVals = [];
      const gVals = [];
      const bVals = [];
      const luminances = [];
      let clippedPixels = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        rVals.push(r);
        gVals.push(g);
        bVals.push(b);

        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luminances.push(lum);

        // True clipping: severe channel saturation or pitch black crushing
        if ((r >= 255 || g >= 255 || b >= 255) || (r <= 0 && g <= 0 && b <= 0)) {
          clippedPixels++;
        }
      }

      // Calculate luminance standard deviation
      const lumMean = luminances.reduce((a, b) => a + b, 0) / (luminances.length || 1);
      const lumVar = luminances.reduce((a, b) => a + (b - lumMean) ** 2, 0) / (luminances.length || 1);
      const lumStd = Math.sqrt(lumVar);

      const clippedFraction = totalPixels > 0 ? clippedPixels / totalPixels : 0;

      frameResult[key] = {
        rgb: [median(rVals), median(gVals), median(bVals)],
        lumStd,
        clippedFraction,
        bounds: { x: sx, y: sy, w: sw, h: sh },
      };
    }

    patchSamplesPerFrame.push(frameResult);
  }

  // 1. Uniformity gate (luminance std)
  for (const frameResult of patchSamplesPerFrame) {
    for (const key of patchKeys) {
      if (frameResult[key].lumStd > BADGE_CONFIG.thresholds.maxLuminanceStd) {
        return { valid: false, refusalReason: 'Patch not uniform, retake' };
      }
    }
  }

  // 2. Clipping gate (over allowed fraction of pixels saturated/crushed)
  for (const frameResult of patchSamplesPerFrame) {
    for (const key of patchKeys) {
      if (frameResult[key].clippedFraction > BADGE_CONFIG.thresholds.maxClippedFraction) {
        return { valid: false, refusalReason: 'Clipping, retake: excessive glare or saturation' };
      }
    }
  }

  // 3. Stability gate across frames (spread <= 6)
  if (frames.length > 1) {
    let maxSpread = 0;
    for (const key of patchKeys) {
      for (let ch = 0; ch < 3; ch++) {
        const chVals = patchSamplesPerFrame.map((f) => f[key].rgb[ch]);
        const spread = Math.max(...chVals) - Math.min(...chVals);
        if (spread > maxSpread) maxSpread = spread;
      }
    }
    if (maxSpread > BADGE_CONFIG.thresholds.maxFrameSpread) {
      return { valid: false, refusalReason: 'Hold steady' };
    }
  }

  // Median RGB across frames per patch
  const patchMedians = {};
  for (const key of patchKeys) {
    patchMedians[key] = [
      median(patchSamplesPerFrame.map((f) => f[key].rgb[0])),
      median(patchSamplesPerFrame.map((f) => f[key].rgb[1])),
      median(patchSamplesPerFrame.map((f) => f[key].rgb[2])),
    ];
  }

  // 4. Lighting Cancellation (Linear RGB scaling so R3 becomes #C4C3BF)
  const r3MeasRgb = patchMedians.R3;
  const r3MeasLin = rgbToLinear(r3MeasRgb);
  const r3TargLin = rgbToLinear(BADGE_CONFIG.r3TargetRgb);

  const gainR = r3TargLin[0] / Math.max(1e-6, r3MeasLin[0]);
  const gainG = r3TargLin[1] / Math.max(1e-6, r3MeasLin[1]);
  const gainB = r3TargLin[2] / Math.max(1e-6, r3MeasLin[2]);

  const minGain = BADGE_CONFIG.gainLimits[0];
  const maxGain = BADGE_CONFIG.gainLimits[1];

  if (gainR < minGain || gainR > maxGain || gainG < minGain || gainG > maxGain || gainB < minGain || gainB > maxGain) {
    return { valid: false, refusalReason: 'Lighting out of range, retake' };
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

  // 5. Yellow S1 Check (Lab b* > 50, L* > 70)
  const s1Lab = correctedLab.S1;
  if (s1Lab[2] <= BADGE_CONFIG.thresholds.s1MinLabB || s1Lab[0] <= BADGE_CONFIG.thresholds.s1MinLabL) {
    return { valid: false, refusalReason: 'No badge found' };
  }

  // 6. Fingerprint = Lab of S3 and S2 after gain (6 numbers)
  const s3Lab = correctedLab.S3;
  const s2Lab = correctedLab.S2;
  const fingerprint = [...s3Lab, ...s2Lab];

  // 7. Match against templates
  const match = matchBadgeFingerprint(fingerprint, learnedTemplates);

  const s2Hex = rgbToHex(correctedRgb.S2);
  const s3Hex = rgbToHex(correctedRgb.S3);

  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);
  const dose = match.classPpm * durationMinutes;

  return {
    valid: true,
    refusalReason: null,
    ppm: match.classPpm,
    approxPpm: match.approxPpm,
    classPpm: match.classPpm,
    confidence: match.confidence,
    status: match.status,
    matched: match.matched,
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

// Synthetic badge generator for unit tests and local simulations
function createSyntheticBadge({
  ppm = 20,
  s3Hex = null,
  s2Hex = null,
  gain = [1, 1, 1],
  brightness = 1.0,
  nonUniformStd = 0,
  clipped = false,
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

        // Clipping injection
        if (clipped && key === 'S3') {
          r = 255;
          g = 255;
          b = 255;
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

  if (s3El) s3El.textContent = `${reading.s3Hex} / matched ${reading.matchedHex?.s3 || '--'}`;
  if (s2El) s2El.textContent = `${reading.s2Hex} / matched ${reading.matchedHex?.s2 || '--'}`;
  if (gainsEl) gainsEl.textContent = `${reading.gains[0]}, ${reading.gains[1]}, ${reading.gains[2]}`;
  if (distEl) distEl.textContent = `d1: ${reading.d1}, d2: ${reading.d2}`;

  const panel = document.querySelector('#resultPanel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showRefusal(message) {
  const resultContent = document.querySelector('#resultContent');
  const resultEmpty = document.querySelector('#resultEmpty');
  const retakeContent = document.querySelector('#retakeContent');
  const retakeMsg = document.querySelector('#retakeMessage');

  if (resultContent) resultContent.hidden = true;
  if (resultEmpty) resultEmpty.hidden = true;
  if (retakeContent) retakeContent.hidden = false;
  if (retakeMsg) retakeMsg.textContent = message;

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

  async function captureFrames(count = 5) {
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
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    return frames;
  }

  // Handle capture button
  document.querySelector('#captureButton')?.addEventListener('click', async () => {
    const btn = document.querySelector('#captureButton');
    if (btn) btn.disabled = true;

    try {
      const frames = await captureFrames(5);
      if (!frames) {
        showRefusal('Camera feed not ready. Try uploading an image.');
        return;
      }

      lastCapturedFrames = frames;
      const reading = captureBadgeReading(frames, { rotated: isRotated });
      lastReading = reading;

      if (!reading.valid) {
        showRefusal(reading.refusalReason);
      } else {
        saveRecord(reading);
        renderRecords();
        showResult(reading);
      }

      if (isDebugActive) {
        drawDebugOverlay(frames[0], reading, isRotated);
      }
    } finally {
      if (btn) btn.disabled = false;
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
        if (stateEl) stateEl.textContent = 'Photo loaded • Ready to analyze or add PPM';

        const canvas = document.createElement('canvas');
        canvas.width = preview.naturalWidth;
        canvas.height = preview.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(preview, 0, 0);

        lastCapturedFrames = [canvas];
        
        // NO auto-capture: wait for user to click "Analyze badge" or "+ Add PPM"

        // Clear any previous retake refusal
        const retakeContent = document.querySelector('#retakeContent');
        if (retakeContent) retakeContent.hidden = true;
        const resultEmpty = document.querySelector('#resultEmpty');
        if (resultEmpty) {
          resultEmpty.hidden = false;
          const p = resultEmpty.querySelector('p');
          if (p) p.textContent = 'Photo ready. Click "Analyze badge" or enter PPM below to add.';
        }
        const resultContent = document.querySelector('#resultContent');
        if (resultContent) resultContent.hidden = true;

        if (isDebugActive) {
          drawDebugOverlay(canvas, null, isRotated);
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

  // Helper: Render Configured / Learned Templates list
  function renderLearnedTemplatesList() {
    const listEl = document.querySelector('#learnedTemplatesList');
    if (!listEl) return;
    const learned = getLearnedTemplates();
    const combined = getCombinedTemplates();
    const allPpms = Object.keys(combined).map(Number).sort((a, b) => a - b);

    listEl.innerHTML = allPpms.map((ppm) => {
      const isCustom = Boolean(learned[ppm]);
      return `<span class="template-chip ${isCustom ? 'custom' : 'factory'}" title="S3: ${combined[ppm].s3Hex}, S2: ${combined[ppm].s2Hex}">
        <span class="chip-dot"></span>
        <span class="chip-val">${ppm} ppm</span>
        ${isCustom ? '<span class="chip-badge">Trained</span>' : ''}
      </span>`;
    }).join('');
  }

  // Helper: Show Feedback in Add PPM card
  function showLearnFeedback(message, type = 'info') {
    const el = document.querySelector('#learnFeedback');
    if (!el) return;
    el.hidden = false;
    el.className = `learn-feedback ${type}`;
    el.textContent = message;
    if (type === 'success') {
      setTimeout(() => {
        if (el) el.hidden = true;
      }, 6000);
    }
  }

  // Add PPM / Learn This Badge
  const learnBtn = document.querySelector('#learnBadgeBtn');
  const learnInput = document.querySelector('#learnPpmInput');

  learnBtn?.addEventListener('click', async () => {
    const val = Number(learnInput?.value);
    if (isNaN(val) || val <= 0) {
      showLearnFeedback('Please enter a valid PPM concentration (e.g. 10, 20, 30, 50).', 'error');
      return;
    }

    let frames = lastCapturedFrames;
    if (!frames) {
      frames = await captureFrames(5);
    }

    if (!frames) {
      showLearnFeedback('Upload a photo or point camera at badge to add PPM.', 'error');
      return;
    }

    const reading = captureBadgeReading(frames, { rotated: isRotated });
    if (!reading.valid) {
      showRefusal(reading.refusalReason);
      showLearnFeedback(`Quality check failed: ${reading.refusalReason}. Adjust alignment or lighting and try again.`, 'error');
      return;
    }

    saveLearnedTemplate(val, reading.s3Hex, reading.s2Hex);
    showLearnFeedback(`✓ Added ${val} ppm badge template! S3: ${reading.s3Hex}, S2: ${reading.s2Hex}`, 'success');
    learnInput.value = '';
    renderLearnedTemplatesList();

    // Re-evaluate with newly learned templates and show result
    const rechecked = captureBadgeReading(frames, { rotated: isRotated });
    if (rechecked.valid) {
      showResult(rechecked);
    }
  });

  // Reset to defaults
  const resetBtn = document.querySelector('#resetLearnedBtn');
  resetBtn?.addEventListener('click', () => {
    showConfirmDialog('Reset all learned badges to factory defaults? This can\'t be undone.', () => {
      resetLearnedTemplates();
      renderLearnedTemplatesList();
      showLearnFeedback('Learned badges reset to factory defaults.', 'info');
    });
  });

  // Render templates on startup
  renderLearnedTemplatesList();

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
  };
}

})();
