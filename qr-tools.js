/* Shared browser helpers, also importable by Node regression tests. */
(function (root, factory) {
  const tools = factory();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else root.QRTools = tools;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, pixels: 24000000, dimension: 8192, scanEdge: 2000, logoEdge: 512, logoSourceEdge: 2000 });
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const LOGO_SHAPES = Object.freeze(['none', 'circle', 'square', 'diamond']);
  const LOGO_RATIOS = Object.freeze([0.30, 0.25, 0.20, 0.15, 0.13, 0.11, 0.09, 0.07]);
  const CAPTION = Object.freeze({ family: 'TH Sarabun New', maxLength: 1000, minSize: 8, maxSize: 96, gap: 8, bottom: 8 });
  const ECL_ORDER = Object.freeze(['H', 'Q', 'M', 'L']);
  class QrError extends Error {
    constructor(code, message) { super(message); this.name = code === 'ABORT' ? 'AbortError' : 'QrError'; this.code = code; }
  }
  function assertCurrent(isCurrent) { if (!isCurrent()) throw new QrError('ABORT', 'ยกเลิกการสร้าง QR'); }
  function levelsFrom(level) {
    const index = ECL_ORDER.indexOf(level);
    if (index < 0) throw new QrError('SETTINGS', 'ระดับแก้ไขข้อผิดพลาดไม่ถูกต้อง');
    return ECL_ORDER.slice(index);
  }
  function utf8ByteLength(text) { return new TextEncoder().encode(text).length; }
  function createQrMatrix(text, level, qr) {
    levelsFrom(level);
    if (!qr || typeof qr.create !== 'function') throw new QrError('LIBRARY', 'เครื่องมือสร้าง QR Code ยังโหลดไม่สำเร็จ กรุณาโหลดหน้าใหม่');
    if (!text) throw new QrError('EMPTY', 'กรุณาพิมพ์ข้อความหรือลิงก์');
    // Even numeric mode at level L cannot exceed 7,089 characters. Avoid running
    // the segmentation algorithm on arbitrarily large pasted input; do not truncate it.
    if (text.length > 7089) throw new QrError('CAPACITY', 'ข้อมูลยาวเกินความจุ QR Code');
    try { return qr.create(text, { errorCorrectionLevel: level }); }
    catch (error) {
      if (/amount of data is too big|data too big/i.test(error.message)) throw new QrError('CAPACITY', 'ข้อมูลยาวเกินความจุระดับ ' + level);
      throw error;
    }
  }
  function inspectQrCapacity({ text, errorCorrectionLevel, preferredLevel = errorCorrectionLevel, hasLogo = false, qr }) {
    text = text.trim();
    const bytes = utf8ByteLength(text);
    const level = hasLogo ? 'H' : errorCorrectionLevel;
    if (!text) return { text, bytes, level, empty: true, fits: false, alternatives: [] };
    function inspect(ecl) {
      try { return { level: ecl, fits: true, version: createQrMatrix(text, ecl, qr).version }; }
      catch (error) { if (error.code !== 'CAPACITY') throw error; return { level: ecl, fits: false }; }
    }
    const current = inspect(level);
    if (current.fits) return { text, bytes, ...current, empty: false, alternatives: [] };
    const levels = ECL_ORDER.map(ecl => ecl === level ? current : inspect(ecl));
    const order = hasLogo ? levelsFrom(preferredLevel) : levelsFrom(level).slice(1);
    return { text, bytes, ...current, empty: false, anyLevelFits: levels.some(item => item.fits),
      alternatives: order.map(ecl => levels.find(item => item.level === ecl)).filter(item => item.fits) };
  }

  function validateCaption({ text = '', fontSize = 24, color = '#000000' } = {}) {
    if (typeof text !== 'string' || text.length > CAPTION.maxLength) throw new Error('ข้อความใต้ QR ต้องไม่เกิน 1,000 ตัวอักษร');
    if (!Number.isInteger(fontSize) || fontSize < CAPTION.minSize || fontSize > CAPTION.maxSize) throw new Error('ขนาดฟอนต์ต้องเป็นจำนวนเต็มตั้งแต่ 8 ถึง 96 px');
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('สีข้อความไม่ถูกต้อง');
    return { text: text.replace(/\r\n?/g, '\n'), fontSize, color, hasText: !!text.trim() };
  }
  async function loadCaptionFont(options, fonts) {
    const { hasText, fontSize } = validateCaption(options);
    if (!hasText) return;
    if (!fonts || !fonts.load || !fonts.check) throw new Error('เบราว์เซอร์ไม่รองรับการโหลดฟอนต์ข้อความใต้ QR');
    const font = fontSize + 'px "' + CAPTION.family + '"';
    let timer;
    try {
      const faces = await Promise.race([
        fonts.load(font, 'กA'),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('โหลดฟอนต์ใช้เวลานานเกินไป')), 10000); })
      ]);
      if (!faces.length || !fonts.check(font, 'กA')) throw new Error('ไม่พบฟอนต์ TH Sarabun New');
    } catch (error) { throw new Error('โหลดฟอนต์ TH Sarabun New ไม่สำเร็จ กรุณาลองใหม่: ' + error.message); }
    finally { clearTimeout(timer); }
  }
  function measureCaption(ctx, text) {
    const metrics = ctx.measureText(text);
    const values = [metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight,
      metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent];
    if (!values.every(Number.isFinite)) throw new Error('เบราว์เซอร์ไม่รองรับการวัดขอบเขตข้อความใต้ QR');
    return { width: Math.max(metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight),
      left: metrics.actualBoundingBoxLeft, right: metrics.actualBoundingBoxRight,
      ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent };
  }
  function layoutCaption(ctx, text, fontSize, maxWidth, Segmenter = globalThis.Intl && Intl.Segmenter) {
    if (typeof Segmenter !== 'function') throw new Error('เบราว์เซอร์ไม่รองรับการแบ่งข้อความใต้ QR กรุณาใช้เบราว์เซอร์รุ่นใหม่');
    const words = new Segmenter('th', { granularity: 'word' });
    const graphemes = new Segmenter('th', { granularity: 'grapheme' });
    ctx.font = fontSize + 'px "' + CAPTION.family + '"';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const lines = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const { segment } of words.segment(paragraph)) {
        if (measureCaption(ctx, line + segment).width <= maxWidth) { line += segment; continue; }
        if (line) { lines.push(line); line = ''; }
        if (measureCaption(ctx, segment).width <= maxWidth) { line = segment; continue; }
        for (const { segment: glyph } of graphemes.segment(segment)) {
          if (measureCaption(ctx, glyph).width > maxWidth) throw new Error('ตัวอักษรกว้างเกินกรอบข้อความ กรุณาลดขนาดฟอนต์');
          if (line && measureCaption(ctx, line + glyph).width > maxWidth) { lines.push(line); line = ''; }
          line += glyph;
        }
      }
      lines.push(line);
    }
    const measured = lines.map(line => ({ text: line, ...measureCaption(ctx, line) }));
    const top = Math.min(...measured.map((line, i) => i * fontSize - line.ascent));
    const bottom = Math.max(...measured.map((line, i) => i * fontSize + line.descent));
    return { lines: measured, top, bottom, height: bottom - top, lineHeight: fontSize };
  }
  function composeQrCaption({ canvas, caption, createCanvas, Segmenter }) {
    const options = validateCaption(caption);
    const sourceCtx = canvas.getContext('2d');
    if (!sourceCtx) throw new Error('ใช้ canvas ไม่ได้');
    const maxWidth = canvas.width * 110 / 100;
    const layout = options.hasText ? layoutCaption(sourceCtx, options.text, options.fontSize, maxWidth, Segmenter) : null;
    const width = layout ? Math.ceil(maxWidth) : canvas.width;
    const height = layout ? Math.ceil(canvas.height + CAPTION.gap + layout.height + CAPTION.bottom) : canvas.height;
    // Determine and validate the entire layout before allocating the output bitmap.
    validateDimensions(width, height);
    const output = createCanvas();
    try {
      output.width = width;
      output.height = height;
      const ctx = output.getContext('2d');
      if (!ctx) throw new Error('ใช้ canvas ไม่ได้');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      const qrX = Math.floor((width - canvas.width) / 2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, qrX, 0);
      if (layout) {
        ctx.font = options.fontSize + 'px "' + CAPTION.family + '"';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = options.color;
        const firstBaseline = canvas.height + CAPTION.gap - layout.top;
        for (const [i, line] of layout.lines.entries()) {
          // Center the ink, including italic-like glyph overhangs, rather than only advance width.
          ctx.fillText(line.text, width / 2 + (line.left - line.right) / 2, firstBaseline + i * options.fontSize);
        }
      }
      return { canvas: output, layout, qrX };
    } catch (error) { releaseCanvas(output); throw error; }
  }

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
  function normalizeLogoCrop(source, { shape = 'none', zoom = 1, centerX = 0.5, centerY = 0.5 } = {}) {
    validateDimensions(source.width, source.height);
    if (!LOGO_SHAPES.includes(shape) || ![zoom, centerX, centerY].every(Number.isFinite) || zoom < 1 || zoom > 5) {
      throw new QrError('LOGO_CROP', 'ค่าการ Crop โลโก้ไม่ถูกต้อง');
    }
    const side = Math.min(source.width, source.height) / zoom;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    centerX = clamp(centerX, side / (2 * source.width), 1 - side / (2 * source.width));
    centerY = clamp(centerY, side / (2 * source.height), 1 - side / (2 * source.height));
    return { shape, zoom, centerX, centerY, side,
      x: clamp(centerX * source.width - side / 2, 0, source.width - side),
      y: clamp(centerY * source.height - side / 2, 0, source.height - side) };
  }
  function traceLogoShape(ctx, shape, x, y, side) {
    ctx.beginPath();
    if (shape === 'circle') ctx.arc(x + side / 2, y + side / 2, side / 2, 0, Math.PI * 2);
    else if (shape === 'diamond') {
      ctx.moveTo(x + side / 2, y); ctx.lineTo(x + side, y + side / 2);
      ctx.lineTo(x + side / 2, y + side); ctx.lineTo(x, y + side / 2); ctx.closePath();
    } else ctx.rect(x, y, side, side);
  }
  function pointInLogoShape(shape, x, y) {
    if (x < 0 || y < 0 || x > 1 || y > 1) return false;
    const dx = (x - 0.5) * 2, dy = (y - 0.5) * 2;
    return shape === 'circle' ? dx * dx + dy * dy <= 1 : shape === 'diamond' ? Math.abs(dx) + Math.abs(dy) <= 1 : true;
  }
  function cropLogoCanvas({ source, crop, createCanvas }) {
    const state = normalizeLogoCrop(source, crop);
    const fitted = state.shape === 'none' ? fitDimensions(source.width, source.height, LIMITS.logoEdge)
      : { width: Math.max(1, Math.floor(Math.min(LIMITS.logoEdge, state.side))), height: Math.max(1, Math.floor(Math.min(LIMITS.logoEdge, state.side))) };
    validateDimensions(fitted.width, fitted.height);
    const canvas = createCanvas();
    try {
      canvas.width = fitted.width; canvas.height = fitted.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new QrError('LOGO_CROP', 'เบราว์เซอร์ไม่รองรับการ Crop โลโก้');
      ctx.imageSmoothingQuality = 'high';
      if (state.shape === 'none') ctx.drawImage(source, 0, 0, fitted.width, fitted.height);
      else {
        traceLogoShape(ctx, state.shape, 0, 0, canvas.width); ctx.clip();
        ctx.drawImage(source, state.x, state.y, state.side, state.side, 0, 0, canvas.width, canvas.height);
      }
      return canvas;
    } catch (error) { releaseCanvas(canvas); throw error; }
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
  function hasVisibleLogo(canvas, modules, scale, width, height, shape) {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const left = Math.max(0, Math.floor((canvas.width - width) / 2));
    const top = Math.max(0, Math.floor((canvas.height - height) / 2));
    const right = Math.min(canvas.width, Math.ceil((canvas.width + width) / 2));
    const bottom = Math.min(canvas.height, Math.ceil((canvas.height + height) / 2));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (shape !== 'none' && !pointInLogoShape(shape,
          (x + 0.5 - (canvas.width - width) / 2) / width, (y + 0.5 - (canvas.height - height) / 2) / height)) continue;
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
  async function buildQr({ text, size, errorCorrectionLevel, logo, logoShape = 'none', qr, decode, createCanvas, isCurrent = () => true }) {
    assertCurrent(isCurrent);
    if (logo && !LOGO_SHAPES.includes(logoShape)) throw new QrError('LOGO_CROP', 'รูปทรงโลโก้ไม่ถูกต้อง');
    const ecl = logo ? 'H' : errorCorrectionLevel;
    const matrix = createQrMatrix(text, ecl, qr);
    const base = createCanvas();
    let candidate = null;
    try {
      await new Promise((resolve, reject) => qr.toCanvas(base, text, {
        width: size, margin: 4, errorCorrectionLevel: ecl, version: matrix.version, maskPattern: matrix.maskPattern,
        color: { dark: '#000000ff', light: '#ffffffff' }
      }, error => error ? reject(error) : resolve()));
      assertCurrent(isCurrent);
      if (!logo) {
        const result = readQr(base, decode);
        if (!result || result.data !== text) throw new QrError('PLAIN_DECODE', 'ตรวจอ่าน QR ไม่ผ่าน กรุณาเพิ่มขนาด QR หรือลดความยาวข้อความ');
        return { canvas: base, logoRatio: null };
      }
      candidate = createCanvas();
      candidate.width = base.width;
      candidate.height = base.height;
      const ctx = candidate.getContext('2d');
      if (!ctx) throw new Error('ใช้ canvas ไม่ได้');
      const scale = size >= matrix.modules.size + 8 ? size / (matrix.modules.size + 8) : 4;
      const symbolWidth = matrix.modules.size * scale;
      let visibleTrials = 0;
      for (const ratio of LOGO_RATIOS) {
        assertCurrent(isCurrent);
        ctx.drawImage(base, 0, 0);
        const box = Math.max(6, Math.floor(symbolWidth * ratio));
        const pad = Math.max(2, Math.floor(box * 0.08));
        const inner = box - pad * 2;
        const fit = Math.min(inner / logo.width, inner / logo.height);
        const w = logo.width * fit;
        const h = logo.height * fit;
        ctx.fillStyle = '#fff';
        if (logoShape === 'none' || logoShape === 'square') {
          ctx.fillRect(Math.floor((base.width - box) / 2), Math.floor((base.height - box) / 2), box, box);
        } else {
          traceLogoShape(ctx, logoShape, (base.width - box) / 2, (base.height - box) / 2, box); ctx.fill();
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(logo, (base.width - w) / 2, (base.height - h) / 2, w, h);
        restoreFunctionalModules(candidate, base, matrix.modules, size);
        if (!hasVisibleLogo(candidate, matrix.modules, scale, w, h, logoShape)) continue;
        visibleTrials++;
        const result = readQr(candidate, decode);
        if (result && result.data === text) { releaseCanvas(base); return { canvas: candidate, logoRatio: ratio }; }
      }
      if (!visibleTrials) throw new QrError('LOGO_INVISIBLE', 'โลโก้ไม่มีส่วนที่มองเห็นบนพื้นขาว หรือโลโก้ถูกลายสำคัญบัง กรุณาเปลี่ยนโลโก้');
      throw new QrError('LOGO_DECODE', 'QR หลังใส่โลโก้อ่านไม่ผ่าน กรุณาเพิ่มขนาด QR เปลี่ยนโลโก้ หรือลดความยาวข้อความ');
    } catch (error) { releaseCanvas(base); releaseCanvas(candidate); throw error; }
  }
  async function buildQrImage(options) {
    const isCurrent = options.isCurrent || (() => true);
    let base, composed;
    try {
      base = await buildQr(options);
      assertCurrent(isCurrent);
      composed = composeQrCaption({ canvas: base.canvas, caption: options.caption, createCanvas: options.createCanvas });
      const checked = readQr(composed.canvas, options.decode);
      if (!checked || checked.data !== options.text) throw new QrError('FINAL_IMAGE_DECODE', 'ตรวจอ่านภาพรวมไม่ผ่าน กรุณาปรับข้อความใต้ภาพหรือเพิ่มขนาด QR');
      assertCurrent(isCurrent);
      return { canvas: composed.canvas, logoRatio: base.logoRatio };
    } catch (error) { releaseCanvas(composed && composed.canvas); throw error; }
    finally { releaseCanvas(base && base.canvas); }
  }
  async function findPlainAlternative(options, { preferredLevel, skipLevels = [], buildImage = buildQrImage }) {
    const isCurrent = options.isCurrent || (() => true);
    for (const level of levelsFrom(preferredLevel).filter(ecl => !skipLevels.includes(ecl))) {
      assertCurrent(isCurrent);
      let result;
      try {
        result = await buildImage({ ...options, logo: null, errorCorrectionLevel: level });
        assertCurrent(isCurrent);
        return { level };
      } catch (error) {
        if (!['CAPACITY', 'PLAIN_DECODE', 'FINAL_IMAGE_DECODE'].includes(error.code)) throw error;
      } finally { releaseCanvas(result && result.canvas); }
    }
    return null;
  }
  return { LIMITS, LOGO_RATIOS, LOGO_SHAPES, normalizeLogoCrop, traceLogoShape, pointInLogoShape, cropLogoCanvas,
    CAPTION, ECL_ORDER, QrError, utf8ByteLength, createQrMatrix, inspectQrCapacity, buildQrImage, findPlainAlternative,
    validateCaption, loadCaptionFont, layoutCaption, composeQrCaption,
    validateFile, validateDimensions, fitDimensions, validateImageHeader, loadImageCanvas, releaseCanvas,
    createCameraController, readQr, restoreFunctionalModules, buildQr };
});
