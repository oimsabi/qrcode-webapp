/* Shared browser helpers, also importable by Node regression tests. */
(function (root, factory) {
  const tools = factory();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else root.QRTools = tools;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, pixels: 24000000, dimension: 8192, scanEdge: 2000, logoEdge: 512 });
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const LOGO_RATIOS = Object.freeze([0.15, 0.13, 0.11, 0.09, 0.07]);

  function validateFile(file) {
    if (!file || !IMAGE_TYPES.has(file.type)) throw new Error('รองรับเฉพาะไฟล์ PNG, JPEG และ WebP');
    if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('ไฟล์รูปภาพว่างหรือไม่ถูกต้อง');
    if (file.size > LIMITS.bytes) throw new Error('ไฟล์รูปภาพต้องไม่เกิน 10 MiB');
  }
  function validateDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('ขนาดรูปภาพไม่ถูกต้อง');
    if (width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels) {
      throw new Error('รูปภาพต้องไม่เกิน 24 ล้านพิกเซล และไม่เกิน 8,192 พิกเซลต่อด้าน');
    }
  }
  function fitDimensions(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  }
  async function validateImageHeader(file) {
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const matches = (offset, signature) => signature.every((value, index) => bytes[offset + index] === value);
    const png = matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) && matches(12, [73, 72, 68, 82]);
    const jpeg = matches(0, [255, 216, 255]);
    const webp = matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80]) &&
      (matches(12, [86, 80, 56, 32]) || matches(12, [86, 80, 56, 76]) || matches(12, [86, 80, 56, 88]));
    if (!((file.type === 'image/png' && png) || (file.type === 'image/jpeg' && jpeg) || (file.type === 'image/webp' && webp))) {
      throw new Error('เนื้อหาไฟล์ไม่ตรงกับรูปแบบ PNG, JPEG หรือ WebP ที่ระบุ');
    }
  }
  async function loadImageCanvas(file, maxEdge, env = {}) {
    validateFile(file);
    await validateImageHeader(file);
    const urls = env.urls || URL;
    const image = env.createImage ? env.createImage() : new Image();
    const createCanvas = env.createCanvas || (() => document.createElement('canvas'));
    const url = urls.createObjectURL(file);
    let canvas = null;
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ ไฟล์อาจเสียหรือรูปแบบไม่ถูกต้อง'));
        image.src = url;
      });
      // Check decoded dimensions before allocating a canvas or reading pixels.
      validateDimensions(image.naturalWidth, image.naturalHeight);
      const fitted = fitDimensions(image.naturalWidth, image.naturalHeight, maxEdge);
      canvas = createCanvas();
      canvas.width = fitted.width;
      canvas.height = fitted.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('เบราว์เซอร์ไม่รองรับการอ่านรูปภาพด้วย canvas');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, fitted.width, fitted.height);
      return canvas;
    } catch (error) {
      releaseCanvas(canvas);
      throw error;
    } finally {
      image.onload = image.onerror = null;
      image.src = '';
      urls.revokeObjectURL(url);
    }
  }
  function releaseCanvas(canvas) { if (canvas) canvas.width = canvas.height = 0; }
  function stopTracks(stream) { if (stream) stream.getTracks().forEach(track => track.stop()); }

  function createCameraController({ getUserMedia, attachAndPlay, isAllowed, onState, onStop, onRunning, onError }) {
    let state = 'stopped';
    let request = 0;
    let stream = null;
    function setState(next) { state = next; onState(next); }
    function stop() {
      request++;
      stopTracks(stream);
      stream = null;
      setState('stopped');
      onStop();
    }
    async function start() {
      if (state !== 'stopped' || !isAllowed()) return;
      const id = ++request;
      let acquired = null;
      setState('opening');
      try {
        acquired = await getUserMedia();
        if (id !== request || !isAllowed()) { stopTracks(acquired); return; }
        stream = acquired;
        await attachAndPlay(acquired);
        if (id !== request || !isAllowed()) { stopTracks(acquired); return; }
        setState('running');
        onRunning(id);
      } catch (error) {
        stopTracks(acquired);
        if (id === request) { stop(); onError(error); }
      }
    }
    return { start, stop, get state() { return state; }, isCurrent: id => id === request && state === 'running' && isAllowed() };
  }

  function readQr(canvas, decode) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('ใช้ canvas ไม่ได้');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decode(pixels.data, pixels.width, pixels.height);
  }
  function restoreFunctionalModules(target, base, modules, requestedSize) {
    // Match node-qrcode 1.4.4's mapping, including fractional pixel scales.
    const margin = 4;
    const scale = requestedSize >= modules.size + margin * 2 ? requestedSize / (modules.size + margin * 2) : 4;
    const ctx = target.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (!modules.isReserved(row, col)) continue;
        const x = Math.ceil((col + margin) * scale);
        const y = Math.ceil((row + margin) * scale);
        const right = Math.min(Math.ceil((col + margin + 1) * scale), Math.ceil(base.width - margin * scale));
        const bottom = Math.min(Math.ceil((row + margin + 1) * scale), Math.ceil(base.height - margin * scale));
        if (right > x && bottom > y) ctx.drawImage(base, x, y, right - x, bottom - y, x, y, right - x, bottom - y);
      }
    }
  }
  function hasVisibleLogo(canvas, modules, scale, width, height) {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const left = Math.max(0, Math.floor((canvas.width - width) / 2));
    const top = Math.max(0, Math.floor((canvas.height - height) / 2));
    const right = Math.min(canvas.width, Math.ceil((canvas.width + width) / 2));
    const bottom = Math.min(canvas.height, Math.ceil((canvas.height + height) / 2));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const row = Math.floor((y - 4 * scale) / scale);
        const col = Math.floor((x - 4 * scale) / scale);
        if (row < 0 || col < 0 || row >= modules.size || col >= modules.size || modules.isReserved(row, col)) continue;
        const index = (y * canvas.width + x) * 4;
        // Under the logo the non-reserved area was cleared to white. A non-white
        // pixel here must come from the logo rather than a restored QR pattern.
        if (pixels[index + 3] && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) return true;
      }
    }
    return false;
  }
  async function buildQr({ text, size, errorCorrectionLevel, logo, qr, decode, createCanvas, isCurrent = () => true }) {
    const assertCurrent = () => {
      if (!isCurrent()) { const error = new Error('ยกเลิกการสร้าง QR'); error.name = 'AbortError'; throw error; }
    };
    assertCurrent();
    const ecl = logo ? 'H' : errorCorrectionLevel;
    const matrix = qr.create(text, { errorCorrectionLevel: ecl });
    const base = createCanvas();
    let candidate = null;
    try {
      await new Promise((resolve, reject) => qr.toCanvas(base, text, {
        width: size, margin: 4, errorCorrectionLevel: ecl, version: matrix.version, maskPattern: matrix.maskPattern,
        color: { dark: '#000000ff', light: '#ffffffff' }
      }, error => error ? reject(error) : resolve()));
      assertCurrent();
      if (!logo) {
        const result = readQr(base, decode);
        if (!result || result.data !== text) throw new Error('ตรวจอ่าน QR ไม่ผ่าน กรุณาเพิ่มขนาด QR หรือลดความยาวข้อความ');
        return { canvas: base, logoRatio: null };
      }
      candidate = createCanvas();
      candidate.width = base.width;
      candidate.height = base.height;
      const ctx = candidate.getContext('2d');
      if (!ctx) throw new Error('ใช้ canvas ไม่ได้');
      const scale = size >= matrix.modules.size + 8 ? size / (matrix.modules.size + 8) : 4;
      const symbolWidth = matrix.modules.size * scale;
      for (const ratio of LOGO_RATIOS) {
        assertCurrent();
        ctx.drawImage(base, 0, 0);
        const box = Math.max(6, Math.floor(symbolWidth * ratio));
        const pad = Math.max(2, Math.floor(box * 0.08));
        const inner = box - pad * 2;
        const fit = Math.min(inner / logo.width, inner / logo.height);
        const w = logo.width * fit;
        const h = logo.height * fit;
        ctx.fillStyle = '#fff';
        ctx.fillRect(Math.floor((base.width - box) / 2), Math.floor((base.height - box) / 2), box, box);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(logo, (base.width - w) / 2, (base.height - h) / 2, w, h);
        restoreFunctionalModules(candidate, base, matrix.modules, size);
        if (!hasVisibleLogo(candidate, matrix.modules, scale, w, h)) continue;
        const result = readQr(candidate, decode);
        if (result && result.data === text) { releaseCanvas(base); return { canvas: candidate, logoRatio: ratio }; }
      }
      throw new Error('QR หลังใส่โลโก้อ่านไม่ผ่าน หรือโลโก้ถูกลายสำคัญบัง กรุณาเพิ่มขนาด QR เปลี่ยนโลโก้ หรือลดความยาวข้อความ');
    } catch (error) { releaseCanvas(base); releaseCanvas(candidate); throw error; }
  }
  return { LIMITS, LOGO_RATIOS, validateFile, validateDimensions, fitDimensions, validateImageHeader, loadImageCanvas, releaseCanvas, createCameraController, readQr, restoreFunctionalModules, buildQr };
});
