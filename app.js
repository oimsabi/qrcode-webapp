// ---------- Tabs ----------
const tabButtons = document.querySelectorAll('.tab-btn');
const panels = document.querySelectorAll('.tab-panel');

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab !== 'scan') stopCamera();
  });
});

// ---------- Generate ----------
const qrText = document.getElementById('qr-text');
const qrSize = document.getElementById('qr-size');
const qrEcl = document.getElementById('qr-ecl');
const generateBtn = document.getElementById('generate-btn');
const qrCanvas = document.getElementById('qr-canvas');
const downloadBtn = document.getElementById('download-btn');

generateBtn.addEventListener('click', () => {
  const text = qrText.value.trim();
  if (!text) {
    qrText.focus();
    return;
  }
  const size = parseInt(qrSize.value, 10);
  QRCode.toCanvas(
    qrCanvas,
    text,
    { width: size, margin: 2, errorCorrectionLevel: qrEcl.value },
    (err) => {
      if (err) {
        alert('สร้าง QR Code ไม่สำเร็จ: ' + err.message);
        return;
      }
      qrCanvas.hidden = false;
      downloadBtn.hidden = false;
    }
  );
});

downloadBtn.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'qrcode.png';
  link.href = qrCanvas.toDataURL('image/png');
  link.click();
});

// ---------- Scan: shared helpers ----------
const scanStatus = document.getElementById('scan-status');
const scanResultBox = document.getElementById('scan-result-box');
const scanResultText = document.getElementById('scan-result-text');
const copyResultBtn = document.getElementById('copy-result-btn');

function setStatus(message, kind) {
  scanStatus.textContent = message || '';
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
  } catch (e) {
    setStatus('คัดลอกไม่สำเร็จ', 'error');
  }
});

// ---------- Scan: file upload ----------
const fileInput = document.getElementById('file-input');

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  scanResultBox.hidden = true;
  setStatus('กำลังอ่านรูปภาพ...');

  const img = new Image();
  const reader = new FileReader();
  reader.onload = (e) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) {
        showResult(code.data);
      } else {
        setStatus('ไม่พบ QR Code ในรูปภาพนี้', 'error');
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

// ---------- Scan: camera ----------
const video = document.getElementById('video');
const scanCanvas = document.getElementById('scan-canvas');
const cameraStartBtn = document.getElementById('camera-start-btn');
const cameraStopBtn = document.getElementById('camera-stop-btn');

let stream = null;
let scanLoopId = null;

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
  } catch (e) {
    setStatus('เปิดกล้องไม่สำเร็จ: ' + e.message, 'error');
    return;
  }
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
  cameraStartBtn.hidden = true;
  cameraStopBtn.hidden = false;
  scanResultBox.hidden = true;
  setStatus('กำลังสแกน...');
  tick();
}

function stopCamera() {
  if (scanLoopId) cancelAnimationFrame(scanLoopId);
  scanLoopId = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.hidden = true;
  cameraStartBtn.hidden = false;
  cameraStopBtn.hidden = true;
  setStatus('');
}

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    scanCanvas.width = video.videoWidth;
    scanCanvas.height = video.videoHeight;
    const ctx = scanCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    const imageData = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code) {
      showResult(code.data);
      stopCamera();
      return;
    }
  }
  scanLoopId = requestAnimationFrame(tick);
}

cameraStartBtn.addEventListener('click', startCamera);
cameraStopBtn.addEventListener('click', stopCamera);
