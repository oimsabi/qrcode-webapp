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
const qrTextInfo = document.getElementById('qr-text-info');
const qrTextError = document.getElementById('qr-text-error');
const qrFixBtn = document.getElementById('qr-fix-btn');
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
const qrCaption = document.getElementById('qr-caption');
const captionSize = document.getElementById('caption-size');
const captionColor = document.getElementById('caption-color');
let logoCanvas = null;
let logoLoading = false;
let logoRequest = 0;
let generation = 0;
let generating = false;
let downloadable = false;
let preferredEcl = qrEcl.value;
let capacityTimer = null;
let fixAction = null;

function showQrIssue(message = '', action = null) {
  qrText.setAttribute('aria-invalid', message ? 'true' : 'false');
  qrTextError.textContent = message;
  qrTextError.hidden = !message;
  fixAction = action ? { ...action, revision: generation } : null;
  qrFixBtn.hidden = !action;
  qrFixBtn.textContent = action ? (action.verified ? '' : 'ลอง') +
    (action.removeLogo ? 'นำโลโก้ออกและ' : '') + 'ใช้ระดับ ' + action.level + ' แล้วสร้างใหม่' : '';
}
function capacityMessage(info) {
  if (!info.fits && !info.anyLevelFits) return 'ข้อมูลยาวเกินความจุ QR Code ทุกระดับ กรุณาลดข้อความหรือใช้ลิงก์สั้น';
  const reason = 'ข้อมูลยาวเกินความจุระดับ ' + info.level + (logoCanvas ? ' ที่ต้องใช้กับโลโก้' : ' ที่เลือก');
  const alternative = info.alternatives[0];
  return reason + (alternative ? ' ระดับ ' + alternative.level + ' รองรับปริมาณข้อมูล แต่ยังต้องทดลองตรวจอ่าน' : ' กรุณาลดข้อความหรือเปลี่ยนระดับ');
}
function refreshCapacity() {
  qrTextInfo.textContent = 'ข้อมูล QR: ' + QRTools.utf8ByteLength(qrText.value.trim()).toLocaleString('th-TH') + ' ไบต์ (UTF-8)';
  const info = QRTools.inspectQrCapacity({ text: qrText.value, errorCorrectionLevel: qrEcl.value,
    preferredLevel: preferredEcl, hasLogo: !!logoCanvas, qr: typeof QRCode === 'undefined' ? null : QRCode });
  qrTextInfo.textContent = 'ข้อมูล QR: ' + info.bytes.toLocaleString('th-TH') + ' ไบต์ (UTF-8)' +
    (info.fits ? ' • ระดับ ' + info.level + ' • QR version ' + info.version + ' • กดสร้างเพื่อตรวจอ่าน' : '');
  if (!info.empty && !info.fits) {
    const alternative = info.alternatives[0];
    showQrIssue(capacityMessage(info), alternative ? { level: alternative.level, removeLogo: !!logoCanvas, verified: false } : null);
  }
  return info;
}
function scheduleCapacityCheck() {
  clearTimeout(capacityTimer);
  const id = generation;
  capacityTimer = setTimeout(() => {
    capacityTimer = null;
    if (id !== generation || generating || logoLoading) return;
    try { refreshCapacity(); }
    catch (error) { setGenerateStatus(error.message, 'error'); }
  }, 250);
}

function setGenerateStatus(message = '', kind = '') {
  generateStatus.textContent = message;
  generateStatus.className = 'status' + (kind ? ' ' + kind : '');
}
function syncGenerateControls() {
  generateBtn.disabled = generating || logoLoading;
  qrFixBtn.disabled = generating || logoLoading;
  logoRemoveBtn.hidden = !logoCanvas && !logoLoading;
  qrEcl.disabled = !!logoCanvas;
  qrEcl.value = logoCanvas ? 'H' : preferredEcl;
  logoEclHint.hidden = !logoCanvas;
}
function invalidateGeneration(checkCapacity = true) {
  generation++;
  clearTimeout(capacityTimer);
  capacityTimer = null;
  showQrIssue();
  logoInput.removeAttribute('aria-invalid');
  downloadable = false;
  qrCanvas.hidden = true;
  downloadBtn.hidden = true;
  downloadBtn.disabled = true;
  setGenerateStatus();
  if (checkCapacity) scheduleCapacityCheck();
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
    if (id === logoRequest) { logoLoading = false; syncGenerateControls(); scheduleCapacityCheck(); }
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
qrCaption.addEventListener('input', invalidateGeneration);
captionSize.addEventListener('input', () => {
  const size = Number(captionSize.value);
  if (Number.isInteger(size) && size >= 8 && size <= 96) qrCaption.style.fontSize = size + 'px';
  invalidateGeneration();
});
captionColor.addEventListener('input', () => { qrCaption.style.color = captionColor.value; invalidateGeneration(); });
qrSize.addEventListener('change', invalidateGeneration);
qrEcl.addEventListener('change', () => {
  if (!logoCanvas) preferredEcl = qrEcl.value;
  invalidateGeneration();
});
async function generateQr() {
  if (generating || logoLoading) return;
  const text = qrText.value.trim();
  invalidateGeneration(false);
  if (!text) { qrTextInfo.textContent = 'ข้อมูล QR: 0 ไบต์ (UTF-8)'; showQrIssue('กรุณาพิมพ์ข้อความหรือลิงก์'); qrText.focus(); return; }
  const id = generation;
  const hadLogo = !!logoCanvas;
  const preferredLevel = preferredEcl;
  generating = true;
  syncGenerateControls();
  setGenerateStatus('กำลังสร้างและตรวจอ่าน QR Code...');
  let result;
  let capacity;
  let options;
  try {
    capacity = refreshCapacity();
    if (!capacity.fits && !capacity.anyLevelFits) throw new QRTools.QrError('CAPACITY', capacityMessage(capacity));
    const caption = QRTools.validateCaption({ text: qrCaption.value, fontSize: Number(captionSize.value), color: captionColor.value });
    options = { text, size: parseInt(qrSize.value, 10), errorCorrectionLevel: qrEcl.value,
      logo: logoCanvas, caption, qr: QRCode, decode: jsQR,
      createCanvas: () => document.createElement('canvas'), isCurrent: () => id === generation };
    await QRTools.loadCaptionFont(caption, document.fonts);
    if (id !== generation) return;
    result = await QRTools.buildQrImage(options);
    if (id !== generation) return;
    showQrIssue();
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
    if (id !== generation) return;
    if (error.code === 'LOGO_INVISIBLE') {
      logoInput.setAttribute('aria-invalid', 'true');
      setGenerateStatus(error.message, 'error');
    } else if (['CAPACITY', 'LOGO_DECODE', 'PLAIN_DECODE'].includes(error.code)) {
      let message = error.code === 'CAPACITY' ? capacityMessage(capacity)
        : error.code === 'LOGO_DECODE' ? 'QR พร้อมโลโก้ที่เลือกตรวจอ่านไม่ผ่านที่ขนาดนี้'
          : 'ข้อมูลใส่ใน QR ได้ แต่ภาพที่ขนาดนี้ตรวจอ่านไม่ผ่าน กรุณาเพิ่มขนาดภาพหรือลดข้อมูล';
      showQrIssue(message);
      if (options && (capacity.fits || capacity.anyLevelFits)) {
        setGenerateStatus('กำลังตรวจทางเลือกแบบไม่มีโลโก้...');
        try {
          const alternative = await QRTools.findPlainAlternative(options, { preferredLevel,
            skipLevels: hadLogo ? [] : [options.errorCorrectionLevel] });
          if (id !== generation) return;
          if (alternative) {
            message = (error.code === 'CAPACITY' ? 'ข้อมูลยาวเกินความจุระดับ ' + capacity.level + (hadLogo ? ' ที่ต้องใช้กับโลโก้' : ' ที่เลือก')
              : hadLogo ? 'QR พร้อมโลโก้ที่เลือกตรวจอ่านไม่ผ่านที่ขนาดนี้' : 'ภาพระดับ ' + options.errorCorrectionLevel + ' ตรวจอ่านไม่ผ่านที่ขนาดนี้') +
              ' แต่แบบไม่มีโลโก้ระดับ ' + alternative.level + ' ตรวจอ่านผ่าน';
            showQrIssue(message, { level: alternative.level, removeLogo: hadLogo, verified: true });
          } else {
            message += ' ตัวเลือกแบบไม่มีโลโก้ที่ทดลองยังไม่ผ่าน กรุณาเพิ่มขนาดภาพหรือลดข้อมูล';
            showQrIssue(message);
          }
        } catch (alternativeError) {
          if (id === generation) setGenerateStatus('ตรวจทางเลือกไม่สำเร็จ: ' + alternativeError.message, 'error');
          return;
        }
      }
      setGenerateStatus(message, 'error');
    } else setGenerateStatus('สร้าง QR Code ไม่สำเร็จ: ' + error.message, 'error');
  } finally {
    if (result) QRTools.releaseCanvas(result.canvas);
    generating = false;
    syncGenerateControls();
    if (id !== generation) scheduleCapacityCheck();
  }
}
generateBtn.addEventListener('click', generateQr);
qrFixBtn.addEventListener('click', async () => {
  const action = fixAction;
  if (!action || action.revision !== generation || generating || logoLoading) return;
  if (action.removeLogo) {
    logoRequest++;
    logoLoading = false;
    logoInput.value = '';
    clearLogo();
  }
  preferredEcl = action.level;
  syncGenerateControls();
  await generateQr();
});
try { refreshCapacity(); }
catch (error) { setGenerateStatus(error.message, 'error'); }
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
