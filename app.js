'use strict';

const tabButtons = document.querySelectorAll('.tab-btn');
const panels = document.querySelectorAll('.tab-panel');
let activeTab = 'generate';
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    activeTab = btn.dataset.tab;
    btn.classList.add('active');
    document.getElementById(activeTab).classList.add('active');
    if (activeTab !== 'scan') { scanRequest++; stopCamera(); }
  });
});

// ---------- Generate and optional logo ----------
const qrText = document.getElementById('qr-text');
const qrSize = document.getElementById('qr-size');
const qrEcl = document.getElementById('qr-ecl');
const generateBtn = document.getElementById('generate-btn');
const qrCanvas = document.getElementById('qr-canvas');
const downloadBtn = document.getElementById('download-btn');
const generateStatus = document.getElementById('generate-status');
const logoInput = document.getElementById('logo-input');
const logoPreview = document.getElementById('logo-preview');
const logoRemoveBtn = document.getElementById('logo-remove-btn');
const logoEclHint = document.getElementById('logo-ecl-hint');
let logoCanvas = null;
let logoLoading = false;
let logoRequest = 0;
let generation = 0;
let generating = false;
let downloadable = false;
let preferredEcl = qrEcl.value;

function setGenerateStatus(message = '', kind = '') {
  generateStatus.textContent = message;
  generateStatus.className = 'status' + (kind ? ' ' + kind : '');
}
function syncGenerateControls() {
  generateBtn.disabled = generating || logoLoading;
  logoRemoveBtn.hidden = !logoCanvas && !logoLoading;
  qrEcl.disabled = !!logoCanvas;
  qrEcl.value = logoCanvas ? 'H' : preferredEcl;
  logoEclHint.hidden = !logoCanvas;
}
function invalidateGeneration() {
  generation++;
  downloadable = false;
  qrCanvas.hidden = true;
  downloadBtn.hidden = true;
  downloadBtn.disabled = true;
  setGenerateStatus();
}
function clearLogo() {
  QRTools.releaseCanvas(logoCanvas);
  logoCanvas = null;
  logoPreview.removeAttribute('src');
  logoPreview.hidden = true;
}
logoInput.addEventListener('change', async () => {
  const id = ++logoRequest;
  const file = logoInput.files[0];
  invalidateGeneration();
  clearLogo();
  logoLoading = !!file;
  syncGenerateControls();
  if (!file) return;
  setGenerateStatus('กำลังอ่านโลโก้...');
  try {
    const canvas = await QRTools.loadImageCanvas(file, QRTools.LIMITS.logoEdge);
    if (id !== logoRequest) { QRTools.releaseCanvas(canvas); return; }
    logoCanvas = canvas;
    logoPreview.src = canvas.toDataURL('image/png');
    logoPreview.hidden = false;
    setGenerateStatus('เลือกโลโก้แล้ว กดสร้าง QR Code เพื่อจัดขนาดและตรวจการสแกน');
  } catch (error) {
    if (id !== logoRequest) return;
    clearLogo();
    logoInput.value = '';
    setGenerateStatus(error.message, 'error');
  } finally {
    if (id === logoRequest) { logoLoading = false; syncGenerateControls(); }
  }
});
logoRemoveBtn.addEventListener('click', () => {
  logoRequest++;
  logoLoading = false;
  logoInput.value = '';
  clearLogo();
  invalidateGeneration();
  syncGenerateControls();
  setGenerateStatus('นำโลโก้ออกแล้ว กดสร้าง QR Code อีกครั้ง');
});
qrText.addEventListener('input', invalidateGeneration);
qrSize.addEventListener('change', invalidateGeneration);
qrEcl.addEventListener('change', () => {
  if (!logoCanvas) preferredEcl = qrEcl.value;
  invalidateGeneration();
});
generateBtn.addEventListener('click', async () => {
  if (generating || logoLoading) return;
  const text = qrText.value.trim();
  invalidateGeneration();
  if (!text) { qrText.focus(); setGenerateStatus('กรุณาพิมพ์ข้อความหรือลิงก์', 'error'); return; }
  const id = generation;
  generating = true;
  syncGenerateControls();
  setGenerateStatus('กำลังสร้างและตรวจอ่าน QR Code...');
  let result;
  try {
    result = await QRTools.buildQr({
      text, size: parseInt(qrSize.value, 10), errorCorrectionLevel: qrEcl.value,
      logo: logoCanvas, qr: QRCode, decode: jsQR,
      createCanvas: () => document.createElement('canvas'), isCurrent: () => id === generation
    });
    if (id !== generation) return;
    qrCanvas.width = result.canvas.width;
    qrCanvas.height = result.canvas.height;
    qrCanvas.getContext('2d').drawImage(result.canvas, 0, 0);
    qrCanvas.hidden = false;
    downloadable = true;
    downloadBtn.disabled = false;
    downloadBtn.hidden = false;
    const suffix = result.logoRatio ? ' (กรอบโลโก้ ' + Math.round(result.logoRatio * 100) + '% ของด้าน QR)' : '';
    setGenerateStatus('สร้าง QR Code และตรวจอ่านสำเร็จ' + suffix, 'success');
  } catch (error) {
    if (id === generation) setGenerateStatus('สร้าง QR Code ไม่สำเร็จ: ' + error.message, 'error');
  } finally {
    if (result) QRTools.releaseCanvas(result.canvas);
    generating = false;
    syncGenerateControls();
  }
});
downloadBtn.addEventListener('click', () => {
  if (!downloadable) return;
  try {
    const link = document.createElement('a');
    link.download = 'qrcode.png';
    link.href = qrCanvas.toDataURL('image/png');
    link.click();
  } catch (error) { setGenerateStatus('ดาวน์โหลดไม่สำเร็จ: ' + error.message, 'error'); }
});

// ---------- Scan results and file upload ----------
const scanStatus = document.getElementById('scan-status');
const scanResultBox = document.getElementById('scan-result-box');
const scanResultText = document.getElementById('scan-result-text');
const copyResultBtn = document.getElementById('copy-result-btn');
const fileInput = document.getElementById('file-input');
let scanRequest = 0;
function setStatus(message = '', kind = '') {
  scanStatus.textContent = message;
  scanStatus.className = 'status' + (kind ? ' ' + kind : '');
}
function showResult(text) {
  scanResultText.textContent = text;
  scanResultBox.hidden = false;
  setStatus('อ่าน QR Code สำเร็จ', 'success');
}
copyResultBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(scanResultText.textContent);
    copyResultBtn.textContent = 'คัดลอกแล้ว';
    setTimeout(() => (copyResultBtn.textContent = 'คัดลอก'), 1500);
  } catch (error) { setStatus('คัดลอกไม่สำเร็จ', 'error'); }
});
fileInput.addEventListener('change', async () => {
  const id = ++scanRequest;
  stopCamera();
  scanResultBox.hidden = true;
  const file = fileInput.files[0];
  if (!file) return;
  setStatus('กำลังอ่านรูปภาพ...');
  let canvas;
  try {
    canvas = await QRTools.loadImageCanvas(file, QRTools.LIMITS.scanEdge);
    if (id !== scanRequest || activeTab !== 'scan') return;
    const result = QRTools.readQr(canvas, jsQR);
    if (result) showResult(result.data);
    else setStatus('ไม่พบ QR Code ในรูปภาพนี้ ลองใช้รูปที่ QR ชัดเจนและมีขนาดใหญ่ขึ้น', 'error');
  } catch (error) {
    if (id === scanRequest && activeTab === 'scan') setStatus(error.message, 'error');
  } finally { QRTools.releaseCanvas(canvas); }
});

// ---------- Camera lifecycle ----------
const video = document.getElementById('video');
const scanCanvas = document.getElementById('scan-canvas');
const cameraStartBtn = document.getElementById('camera-start-btn');
const cameraStopBtn = document.getElementById('camera-stop-btn');
let scanLoopId = null;
let lastScanTime = 0;
const camera = QRTools.createCameraController({
  isAllowed: () => activeTab === 'scan' && !document.hidden,
  getUserMedia: () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('ต้องเปิดผ่าน HTTPS หรือ localhost และใช้เบราว์เซอร์ที่รองรับกล้อง');
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  },
  attachAndPlay: async stream => { video.srcObject = stream; video.hidden = false; await video.play(); },
  onState: state => {
    cameraStartBtn.disabled = state !== 'stopped';
    cameraStartBtn.hidden = state === 'running';
    cameraStopBtn.hidden = state === 'stopped';
    if (state === 'opening') setStatus('กำลังเปิดกล้อง... กดปิดกล้องเพื่อยกเลิกได้');
  },
  onStop: () => {
    if (scanLoopId !== null) cancelAnimationFrame(scanLoopId);
    scanLoopId = null;
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    QRTools.releaseCanvas(scanCanvas);
  },
  onRunning: id => { setStatus('กำลังสแกน...'); lastScanTime = 0; tick(id); },
  onError: error => setStatus('เปิดกล้องไม่สำเร็จ: ' + error.message, 'error')
});
function stopCamera(clearStatus = true) { camera.stop(); if (clearStatus) setStatus(); }
function tick(id, time = performance.now()) {
  if (!camera.isCurrent(id)) return;
  try {
    if (time - lastScanTime >= 100 && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth && video.videoHeight) {
      lastScanTime = time;
      const fitted = QRTools.fitDimensions(video.videoWidth, video.videoHeight, 1000);
      scanCanvas.width = fitted.width;
      scanCanvas.height = fitted.height;
      const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('ใช้ canvas ไม่ได้');
      ctx.drawImage(video, 0, 0, fitted.width, fitted.height);
      const result = QRTools.readQr(scanCanvas, jsQR);
      if (result) { stopCamera(false); showResult(result.data); return; }
    }
    scanLoopId = requestAnimationFrame(nextTime => tick(id, nextTime));
  } catch (error) { stopCamera(false); setStatus('สแกนไม่สำเร็จ: ' + error.message, 'error'); }
}
cameraStartBtn.addEventListener('click', () => {
  if (camera.state !== 'stopped') return;
  scanRequest++;
  scanResultBox.hidden = true;
  camera.start();
});
cameraStopBtn.addEventListener('click', () => stopCamera());
document.addEventListener('visibilitychange', () => { if (document.hidden) { scanRequest++; stopCamera(); } });
window.addEventListener('pagehide', () => { scanRequest++; stopCamera(); });
