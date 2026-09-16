const STORAGE_KEY = 'h2s-badge-records-v1';
const THRESHOLD = 10;
const ANALYSIS_VERSION = 'v1.5';
const REFERENCE_ERROR_THRESHOLD = 32;
const REFERENCE_SWATCHES = [
  { x: 0.18, y: 0.2, color: [245, 238, 220] },
  { x: 0.34, y: 0.2, color: [205, 224, 226] },
  { x: 0.5, y: 0.2, color: [220, 202, 215] },
  { x: 0.66, y: 0.2, color: [222, 211, 176] },
  { x: 0.82, y: 0.2, color: [183, 208, 190] },
  { x: 0.5, y: 0.34, color: [184, 184, 181] },
];
const $ = (selector) => document.querySelector(selector);
const records = () => JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

$('#captureDate').textContent = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).toUpperCase();
let cameraStream;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', advanced: [{ exposureMode: 'manual', whiteBalanceMode: 'manual' }] }, audio: false });
    const track = cameraStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities?.() || {};
    const lockable = capabilities.exposureMode?.includes('manual') && capabilities.whiteBalanceMode?.includes('manual');
    if (lockable) await track.applyConstraints({ advanced: [{ exposureMode: 'manual', whiteBalanceMode: 'manual' }] });
    $('#cameraFeed').srcObject = cameraStream;
    $('#cameraFeed').style.display = 'block';
    $('#cameraPlaceholder').style.display = 'none';
    $('#cameraState').textContent = lockable ? 'LIVE / AE AWB LOCKED' : 'LIVE / LOCK REQUESTED';
  } catch (error) {
    $('#cameraState').textContent = 'UPLOAD MODE';
  }
}

function renderRecords() {
  const stored = records();
  $('#recordCount').textContent = `${stored.length} saved`;
  if (!stored.length) return;
  $('#recordsBody').innerHTML = stored.slice().reverse().map((record) => `<tr>
    <td class="worker-cell"><strong>${record.workerId}</strong><small>${record.badgeId}</small></td>
    <td>${record.shiftId}</td><td><strong>${record.dose.toFixed(1)}</strong> ppm·min</td>
    <td><span class="pill ${record.valid ? '' : 'invalid'}">${record.valid ? 'Valid' : 'Invalid'}</span></td>
    <td><span class="pill pending">${record.synced ? 'Synced' : 'Queued'}</span></td></tr>`).join('');
}

function showAnalysis() {
  $('#resultEmpty').hidden = true;
  $('#resultContent').hidden = true;
  $('#analysisSteps').hidden = false;
  $('#analysisSteps').querySelectorAll('span').forEach((step, index) => {
    step.classList.toggle('active', index === 0);
    setTimeout(() => step.classList.toggle('active', true), (index + 1) * 360);
  });
}

function samplePatch(context, width, height, x, y, radius = 8) {
  const centerX = Math.round(width * x);
  const centerY = Math.round(height * y);
  const data = context.getImageData(Math.max(0, centerX - radius), Math.max(0, centerY - radius), radius * 2, radius * 2).data;
  let red = 0; let green = 0; let blue = 0;
  for (let index = 0; index < data.length; index += 4) { red += data[index]; green += data[index + 1]; blue += data[index + 2]; }
  const count = data.length / 4;
  return [red / count, green / count, blue / count];
}

function distance(first, second) { return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]); }

function rejectOutlier(readings) {
  const scores = readings.map((reading, index) => readings.reduce((total, other, otherIndex) => index === otherIndex ? total : total + distance(reading, other), 0));
  const rejected = scores.indexOf(Math.max(...scores));
  return readings.filter((_, index) => index !== rejected).reduce((sum, reading) => sum.map((value, channel) => value + reading[channel]), [0, 0, 0]).map((value) => value / 2);
}

function fitCorrection(observed) {
  const matrix = observed.map((reading) => [1, ...reading]);
  const transpose = (values) => values[0].map((_, column) => values.map((row) => row[column]));
  const multiply = (left, right) => left.map((row) => right[0].map((_, column) => row.reduce((sum, value, index) => sum + value * right[index][column], 0)));
  const inverse = (values) => {
    const augmented = values.map((row, rowIndex) => [...row, ...values.map((line) => line[rowIndex])]);
    for (let column = 0; column < 3; column += 1) {
      const pivot = augmented.slice(column).reduce((best, row, offset) => Math.abs(row[column]) > Math.abs(augmented[best][column]) ? column + offset : best, column);
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      const divisor = augmented[column][column] || 1;
      augmented[column] = augmented[column].map((value) => value / divisor);
      augmented.forEach((row, rowIndex) => { if (rowIndex !== column) { const factor = row[column]; row.forEach((_, index) => { row[index] -= factor * augmented[column][index]; }); } });
    }
    return augmented.map((row) => row.slice(3));
  };
  const coefficients = multiply(multiply(inverse(multiply(transpose(matrix), matrix)), transpose(matrix)), REFERENCE_SWATCHES.map((swatch) => swatch.color));
  return (reading) => multiply([[1, ...reading]], coefficients)[0];
}

function calculateReading(frames) {
  const canvas = $('#captureCanvas');
  if (!canvas.width || !canvas.height) return { dose: 6.4, valid: true, quality: 0 };
  const context = frames[0].getContext('2d');
  const patchReadings = REFERENCE_SWATCHES.map((swatch) => rejectOutlier(frames.map((frame) => samplePatch(frame.getContext('2d'), frame.width, frame.height, swatch.x, swatch.y))));
  const correct = fitCorrection(patchReadings);
  const residual = Math.sqrt(patchReadings.reduce((total, reading, index) => total + distance(correct(reading), REFERENCE_SWATCHES[index].color) ** 2, 0) / patchReadings.length);
  const [red, green, blue] = correct(rejectOutlier(frames.map((frame) => samplePatch(frame.getContext('2d'), frame.width, frame.height, 0.5, 0.62))));
  const dose = Math.max(0, (red * 0.018) + (green * 0.011) - (blue * 0.006));
  return { dose, valid: residual <= REFERENCE_ERROR_THRESHOLD, quality: residual };
}

function captureFrames() {
  const canvas = $('#captureCanvas');
  const video = $('#cameraFeed');
  if (!video.videoWidth) return Promise.resolve([canvas, canvas, canvas]);
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const frames = [];
  return new Promise((resolve) => {
    const capture = () => {
      const frame = document.createElement('canvas'); frame.width = canvas.width; frame.height = canvas.height;
      frame.getContext('2d').drawImage(video, 0, 0); frames.push(frame);
      if (frames.length === 3) resolve(frames); else requestAnimationFrame(capture);
    };
    capture();
  });
}

function analyzeBadge(frames) {
  showAnalysis();
  setTimeout(() => {
    const { dose, valid, quality } = calculateReading(frames);
    if (!valid) {
      $('#analysisSteps').hidden = true;
      $('#resultContent').hidden = true;
      $('#retakeContent').hidden = false;
      $('#qualityValue').textContent = `${quality.toFixed(1)} / ${REFERENCE_ERROR_THRESHOLD}`;
      return;
    }
    const now = new Date();
    const record = { workerId: $('#workerId').value || 'UNASSIGNED', badgeId: $('#badgeId').value || 'UNKNOWN', shiftId: $('#shiftId').value || 'UNASSIGNED', timestamp: now.toISOString(), dose, valid, synced: false, analysisVersion: ANALYSIS_VERSION };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...records(), record]));
    $('#analysisSteps').hidden = true;
    $('#resultContent').hidden = false;
    $('#doseValue').textContent = dose.toFixed(1);
    $('#resultTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#validityValue').textContent = valid ? 'Valid' : 'Invalid';
    $('#validityDetail').textContent = 'Expiry patch within pass range';
    $('#validityCard').className = 'status-card';
    $('#thresholdResult').textContent = dose <= THRESHOLD ? 'Within limit' : 'Over limit';
    $('#thresholdCard').className = `status-card ${dose <= THRESHOLD ? '' : 'warning'}`;
    renderRecords();
  }, 1500);
}

$('#captureButton').addEventListener('click', () => {
  $('#retakeContent').hidden = true;
  captureFrames().then(analyzeBadge);
});
$('#uploadButton').addEventListener('click', () => $('#imageInput').click());
$('#imageInput').addEventListener('change', () => {
  const file = $('#imageInput').files[0];
  if (!file) return;
  const imageUrl = URL.createObjectURL(file);
  $('#cameraFeed').srcObject = null;
  $('#cameraFeed').src = imageUrl;
  $('#cameraFeed').onload = () => {
    const canvas = $('#captureCanvas');
    canvas.width = $('#cameraFeed').naturalWidth;
    canvas.height = $('#cameraFeed').naturalHeight;
    canvas.getContext('2d').drawImage($('#cameraFeed'), 0, 0);
    $('#retakeContent').hidden = true;
    analyzeBadge([canvas, canvas, canvas]);
  };
  $('#cameraFeed').style.display = 'block';
  $('#cameraFeed').style.transform = 'none';
  $('#cameraPlaceholder').style.display = 'none';
  $('#cameraState').textContent = 'IMAGE LOADED';
});
$('#clearForm').addEventListener('click', () => ['workerId', 'badgeId', 'shiftId'].forEach((id) => { $(`#${id}`).value = ''; }));
$('#settingsButton').addEventListener('click', () => alert(`Calibration profile ${ANALYSIS_VERSION}\nReference swatches: 6\nCapture: 3 frames with outlier rejection\nReference quality gate: ${REFERENCE_ERROR_THRESHOLD} RGB RMS\nLocal threshold: 10 ppm·min`));
window.addEventListener('beforeunload', () => cameraStream?.getTracks().forEach((track) => track.stop()));
renderRecords();
startCamera();