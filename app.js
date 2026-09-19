const STORAGE_KEY = 'h2s-badge-records-v1';
const THRESHOLD = 10;
const ANALYSIS_VERSION = 'v1.6-bands';
const REFERENCE_ERROR_THRESHOLD = 32;
const H2S_BANDS = [0, 1, 2, 5, 10, 20, 50, 100];
const REFERENCE_SWATCHES = [
  { x: 0.18, y: 0.2, color: [245, 238, 220] },
  { x: 0.34, y: 0.2, color: [205, 224, 226] },
  { x: 0.5, y: 0.2, color: [220, 202, 215] },
  { x: 0.66, y: 0.2, color: [222, 211, 176] },
  { x: 0.82, y: 0.2, color: [183, 208, 190] },
  { x: 0.5, y: 0.34, color: [184, 184, 181] },
];
const SEALED_REFERENCE_PATCH = { x: 0.5, y: 0.14 };
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

function samplePatch(context, width, height, x, y, radius = 8) {
  const centerX = Math.round(width * x);
  const centerY = Math.round(height * y);
  const data = context.getImageData(Math.max(0, centerX - radius), Math.max(0, centerY - radius), radius * 2, radius * 2).data;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let index = 0; index < data.length; index += 4) {
    red += data[index];
    green += data[index + 1];
    blue += data[index + 2];
  }
  const count = data.length / 4;
  return [red / count, green / count, blue / count];
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

function calculateReading(frames) {
  const canvas = typeof document !== 'undefined' ? document.querySelector('#captureCanvas') : null;
  if (!canvas || !canvas.width || !canvas.height) {
    return { dose: 0, valid: true, quality: 0, concentrationBandEstimate: '0 ppm-equivalent', confidenceLevel: 'High', tempHumidityDriftFlag: 'Low drift', durationMinutes: 15, compensationFactor: 1, temperatureC: 25, humidityPct: 50, bandDistance: 0, ppm: 0, stripLab: [0, 0, 0], sealedReferenceLab: SEALED_REFERENCE_BASELINE };
  }

  const patchReadings = REFERENCE_SWATCHES.map((swatch) => rejectOutlier(frames.map((frame) => samplePatch(frame.getContext('2d'), frame.width, frame.height, swatch.x, swatch.y))));
  const correct = fitCorrection(patchReadings);
  const residual = Math.sqrt(patchReadings.reduce((total, reading, index) => total + distance(correct(reading), REFERENCE_SWATCHES[index].color) ** 2, 0) / patchReadings.length);
  const stripRGB = correct(rejectOutlier(frames.map((frame) => samplePatch(frame.getContext('2d'), frame.width, frame.height, 0.5, 0.62))));
  const sealedReferenceRGB = correct(rejectOutlier(frames.map((frame) => samplePatch(frame.getContext('2d'), frame.width, frame.height, SEALED_REFERENCE_PATCH.x, SEALED_REFERENCE_PATCH.y))));
  const stripLab = rgbToLab(stripRGB);
  const sealedReferenceLab = rgbToLab(sealedReferenceRGB);
  const compensationFactor = computeCompensationFactor(sealedReferenceLab);
  const durationMinutes = Number((typeof document !== 'undefined' ? document.querySelector('#exposureMinutes')?.value : '15') || 15);
  const summary = summarizeReading({ stripLab, sealedReferenceLab, durationMinutes, compensationFactor });

  return {
    ...summary,
    valid: residual <= REFERENCE_ERROR_THRESHOLD,
    quality: residual,
    stripLab,
    sealedReferenceLab,
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

  body.innerHTML = stored.slice().reverse().map((record) => `<tr>
    <td class="worker-cell"><strong>${record.workerId}</strong><small>${record.badgeId}</small></td>
    <td>${record.shiftId}</td>
    <td><strong>${record.concentrationBandEstimate || '0 ppm-equivalent'}</strong></td>
    <td><strong>${record.dose.toFixed(1)}</strong> ppm·min</td>
    <td><span class="pill ${record.confidenceLevel ? record.confidenceLevel.toLowerCase() : 'medium'}">${record.confidenceLevel || 'Medium'}</span></td>
    <td><span class="pill subtle">${record.tempHumidityDriftFlag || 'Low drift'}</span></td>
  </tr>`).join('');

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

function captureFrames() {
  const canvas = document.querySelector('#captureCanvas');
  const video = document.querySelector('#cameraFeed');
  if (!video || !video.videoWidth) return Promise.resolve([canvas, canvas, canvas]);
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const frames = [];
  return new Promise((resolve) => {
    const capture = () => {
      const frame = document.createElement('canvas');
      frame.width = canvas.width;
      frame.height = canvas.height;
      frame.getContext('2d').drawImage(video, 0, 0);
      frames.push(frame);
      if (frames.length === 3) resolve(frames); else requestAnimationFrame(capture);
    };
    capture();
  });
}

function analyzeBadge(frames) {
  showAnalysis();
  setTimeout(() => {
    const reading = calculateReading(frames);
    if (!reading.valid) {
      const analysisSteps = document.querySelector('#analysisSteps');
      const resultContent = document.querySelector('#resultContent');
      const retakeContent = document.querySelector('#retakeContent');
      if (analysisSteps) analysisSteps.hidden = true;
      if (resultContent) resultContent.hidden = true;
      if (retakeContent) {
        retakeContent.hidden = false;
        document.querySelector('#qualityValue').textContent = `${reading.quality.toFixed(1)} / ${REFERENCE_ERROR_THRESHOLD}`;
      }
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
      concentrationBandEstimate: reading.concentrationBandEstimate,
      confidenceLevel: reading.confidenceLevel,
      tempHumidityDriftFlag: reading.tempHumidityDriftFlag,
      durationMinutes: reading.durationMinutes,
      compensationFactor: reading.compensationFactor,
      temperatureC: reading.temperatureC,
      humidityPct: reading.humidityPct,
    };

    const nextRecords = [...records(), record];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));

    const resultContent = document.querySelector('#resultContent');
    const analysisSteps = document.querySelector('#analysisSteps');
    if (analysisSteps) analysisSteps.hidden = true;
    if (resultContent) resultContent.hidden = false;

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
    renderRecords();
  }, 1500);
}

function initBrowser() {
  const dateTarget = document.querySelector('#captureDate');
  if (dateTarget) dateTarget.textContent = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).toUpperCase();

  let cameraStream;
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', advanced: [{ exposureMode: 'manual', whiteBalanceMode: 'manual' }] }, audio: false });
      const track = cameraStream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() || {};
      const lockable = capabilities.exposureMode?.includes('manual') && capabilities.whiteBalanceMode?.includes('manual');
      if (lockable) await track.applyConstraints({ advanced: [{ exposureMode: 'manual', whiteBalanceMode: 'manual' }] });
      const cameraFeed = document.querySelector('#cameraFeed');
      const cameraPlaceholder = document.querySelector('#cameraPlaceholder');
      const cameraState = document.querySelector('#cameraState');
      if (cameraFeed) {
        cameraFeed.srcObject = cameraStream;
        cameraFeed.style.display = 'block';
      }
      if (cameraPlaceholder) cameraPlaceholder.style.display = 'none';
      if (cameraState) cameraState.textContent = lockable ? 'LIVE / AE AWB LOCKED' : 'LIVE / LOCK REQUESTED';
    } catch (error) {
      const cameraState = document.querySelector('#cameraState');
      if (cameraState) cameraState.textContent = 'UPLOAD MODE';
    }
  }

  document.querySelector('#captureButton').addEventListener('click', () => {
    const retakeContent = document.querySelector('#retakeContent');
    if (retakeContent) retakeContent.hidden = true;
    captureFrames().then(analyzeBadge);
  });

  document.querySelector('#uploadButton').addEventListener('click', () => document.querySelector('#imageInput').click());
  document.querySelector('#imageInput').addEventListener('change', () => {
    const file = document.querySelector('#imageInput').files[0];
    if (!file) return;

    const imageUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.querySelector('#captureCanvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const cameraFeed = document.querySelector('#cameraFeed');
      if (cameraFeed) {
        cameraFeed.srcObject = null;
        if (cameraFeed.pause) cameraFeed.pause();
      }
      const retakeContent = document.querySelector('#retakeContent');
      if (retakeContent) retakeContent.hidden = true;
      const cameraPlaceholder = document.querySelector('#cameraPlaceholder');
      if (cameraPlaceholder) cameraPlaceholder.style.display = 'none';
      const cameraState = document.querySelector('#cameraState');
      if (cameraState) cameraState.textContent = 'IMAGE LOADED';
      analyzeBadge([canvas, canvas, canvas]);
    };

    image.src = imageUrl;
    const cameraFeed = document.querySelector('#cameraFeed');
    if (cameraFeed) {
      cameraFeed.style.display = 'block';
      cameraFeed.style.transform = 'none';
    }
  });

  document.querySelector('#clearForm').addEventListener('click', () => ['workerId', 'badgeId', 'shiftId'].forEach((id) => {
    const element = document.querySelector(`#${id}`);
    if (element) element.value = '';
  }));

  document.querySelector('#settingsButton').addEventListener('click', () => alert(`Calibration profile ${ANALYSIS_VERSION}\nBand targets: ${H2S_BANDS.join(', ')} ppm\nConditions: 2 temp/humidity states per band\nSealed reference cell: drift compensation enabled\nConfidence: Lab distance to nearest band`));

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
    CALIBRATION_DATASET,
    estimateBandFromLab,
    summarizeReading,
    computeIncrementalExposure,
    computeCompensationFactor,
    estimateTemperatureHumidityFromDrift,
    rgbToLab,
    distance,
  };
}
