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

function estimateBandFromLab(lab) {
  let bestMatch = { ppm: 0, label: getBandLabel(0), distance: Number.POSITIVE_INFINITY };
  for (const ppm of H2S_BANDS) {
    const target = BAND_BASE_LAB[ppm];
    const currentDistance = distance(lab, target);
    if (currentDistance < bestMatch.distance) {
      bestMatch = { ppm, label: getBandLabel(ppm), distance: currentDistance };
    }
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
  const band = estimateBandFromLab(stripLab);
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
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
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

function fitCorrection(observed) {
  const design = observed.map((reading) => [1, reading[0], reading[1], reading[2]]);
  const coefficients = Array.from({ length: 3 }, (_, channel) => {
    const targets = REFERENCE_SWATCHES.map((swatch) => swatch.color[channel]);
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

    return solveLinearSystem(xtx, xty);
  });

  return (reading) => {
    const [red, green, blue] = reading;
    return coefficients.map((coefficientsForChannel) => coefficientsForChannel[0]
      + coefficientsForChannel[1] * red
      + coefficientsForChannel[2] * green
      + coefficientsForChannel[3] * blue);
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

function calculateReading(frames, { backgroundRGB = null } = {}) {
  if (!frames?.length || frames.some((frame) => !frame?.width || !frame?.height)) {
    return refuseReading('Badge crop unavailable. Align the badge and try again.');
  }

  const allRois = [
    { key: 'strip', ...ROI_LAYOUT.strip },
    ...REFERENCE_SWATCHES,
    { key: 'sealedReference', ...ROI_LAYOUT.sealedReference },
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
    roiLayoutVersion: ROI_LAYOUT_VERSION,
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

  const referenceReadings = REFERENCE_SWATCHES.map((swatch) => roiMedians[swatch.key]);
  const correct = fitCorrection(referenceReadings);
  const residual = Math.sqrt(referenceReadings.reduce((total, reading, index) => total + distance(correct(reading), REFERENCE_SWATCHES[index].color) ** 2, 0) / referenceReadings.length);
  if (residual > REFERENCE_ERROR_THRESHOLD) return refuseReading(`Reference correction failed (${residual.toFixed(1)} RGB RMS)`, residual, diagnostics);

  const stripRGB = correct(roiMedians.strip);
  const sealedReferenceRGB = correct(roiMedians.sealedReference);
  const stripLab = rgbToLab(stripRGB);
  const sealedReferenceLab = rgbToLab(sealedReferenceRGB);
  const compensationFactor = computeCompensationFactor(sealedReferenceLab);
  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);
  return {
    ...summarizeReading({ stripLab, sealedReferenceLab, durationMinutes, compensationFactor }),
    valid: true,
    quality: residual,
    stripLab,
    sealedReferenceLab,
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
    <td><strong>${record.dose.toFixed(1)}</strong> ppm·min</td>
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

function drawDebugOverlay(frame, roiMedians) {
  const overlay = document.querySelector('#roiDebugOverlay');
  if (!overlay) return;
  overlay.width = frame.width;
  overlay.height = frame.height;
  const context = overlay.getContext('2d');
  context.clearRect(0, 0, overlay.width, overlay.height);
  context.drawImage(frame, 0, 0);
  const rois = [{ key: 'strip', ...ROI_LAYOUT.strip }, ...REFERENCE_SWATCHES, { key: 'sealedReference', ...ROI_LAYOUT.sealedReference }];
  rois.forEach((roi) => {
    const inner = shrinkRoi(roi);
    const x = inner.x * overlay.width;
    const y = inner.y * overlay.height;
    const width = inner.w * overlay.width;
    const height = inner.h * overlay.height;
    const label = `${roi.key}: ${roiMedians[roi.key].map((channel) => Math.round(channel)).join(',')}`;
    context.strokeStyle = roi.key === 'strip' ? '#d9ee55' : roi.key === 'sealedReference' ? '#e77760' : '#69b8db';
    context.lineWidth = Math.max(2, overlay.width / 500);
    context.strokeRect(x, y, width, height);
    context.font = `${Math.max(12, overlay.width / 90)}px sans-serif`;
    const labelY = y > overlay.height * 0.08 ? y - 5 : y + height + 16;
    context.fillStyle = 'rgba(0,0,0,.78)';
    context.fillRect(x, labelY - 14, Math.min(context.measureText(label).width + 8, overlay.width - x), 18);
    context.fillStyle = '#fff';
    context.fillText(label, x + 4, labelY);
  });
}

function showDebugCapture(frame, roiMedians) {
  lastDebugCapture = { frame, roiMedians };
  const overlay = document.querySelector('#roiDebugOverlay');
  const enabled = document.querySelector('#debugToggle').checked;
  overlay.hidden = !enabled;
  if (enabled) drawDebugOverlay(frame, roiMedians);
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

function analyzeBadge(capture) {
  showAnalysis();
  const reading = calculateReading(capture.frames, { backgroundRGB: capture.backgroundRGB });
  if (!reading.valid) {
    if (reading.roiMedians) showDebugCapture(capture.frames[0], reading.roiMedians);
    showRefusal(reading.refusalReason);
    return;
  }

  const now = new Date();
  const record = {
    workerId: document.querySelector('#workerId').value || 'UNASSIGNED',
    badgeId: document.querySelector('#badgeId').value || 'UNKNOWN',
    shiftId: document.querySelector('#shiftId').value || 'UNASSIGNED',
    timestamp: now.toISOString(),
    dose: reading.dose,
    valid: true,
    synced: false,
    analysisVersion: ANALYSIS_VERSION,
    roiLayoutVersion: reading.roiLayoutVersion,
    roiMedians: reading.roiMedians,
    badgeThumbnail: reading.thumbnail,
    concentrationBandEstimate: reading.concentrationBandEstimate,
    confidenceLevel: reading.confidenceLevel,
    tempHumidityDriftFlag: reading.tempHumidityDriftFlag,
    durationMinutes: reading.durationMinutes,
    compensationFactor: reading.compensationFactor,
    temperatureC: reading.temperatureC,
    humidityPct: reading.humidityPct,
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
  document.querySelector('#validityValue').textContent = 'Valid';
  document.querySelector('#validityDetail').textContent = `Band fit ${record.concentrationBandEstimate}; drift ${record.tempHumidityDriftFlag.toLowerCase()}`;
  document.querySelector('#validityCard').className = 'status-card';
  document.querySelector('#thresholdResult').textContent = record.dose <= THRESHOLD ? 'Within limit' : 'Over limit';
  document.querySelector('#thresholdCard').className = `status-card ${record.dose <= THRESHOLD ? '' : 'warning'}`;
  const debugToggle = document.querySelector('#debugToggle');
  if (debugToggle?.checked) showDebugCapture(capture.frames[0], reading.roiMedians);
  renderRecords();
  const resultPanel = document.querySelector('#resultPanel');
  if (resultPanel) resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      let lockable = false;
      if (track?.getCapabilities) {
        try {
          const capabilities = track.getCapabilities() || {};
          lockable = Boolean(capabilities.exposureMode?.includes('manual') && capabilities.whiteBalanceMode?.includes('manual'));
          if (lockable) {
            await track.applyConstraints({ advanced: [{ exposureMode: 'manual', whiteBalanceMode: 'manual' }] });
          }
        } catch (e) {
          // ignore manual lock constraint failure
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
      if (cameraState) cameraState.textContent = lockable ? 'LIVE / AE AWB LOCKED' : 'LIVE PREVIEW';
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
        source.getContext('2d').drawImage(video, 0, 0, source.width, source.height);
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

  window.addEventListener('resize', updateCropSelection);
  document.querySelector('#debugToggle').addEventListener('change', (event) => {
    const overlay = document.querySelector('#roiDebugOverlay');
    overlay.hidden = !event.target.checked || !lastDebugCapture;
    if (event.target.checked && lastDebugCapture) drawDebugOverlay(lastDebugCapture.frame, lastDebugCapture.roiMedians);
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
  };
}
