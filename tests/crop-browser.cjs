/* Actual crop pixels, pointer controls and PNG round-trips in Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function checkCrop(context, url, artifacts) {
  const page = await context.newPage(), errors = [], ui = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.QRTools && window.QRCode && window.jsQR);
    const pixels = await page.evaluate(async () => {
      const createCanvas = () => document.createElement('canvas');
      function source(w, h) {
        const c = createCanvas(); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#dc2626'; ctx.fillRect(0, 0, w / 2, h);
        ctx.fillStyle = '#2563eb'; ctx.fillRect(w / 2, 0, w / 2, h); return c;
      }
      const maskChecks = [], qrChecks = [], shapes = ['none', 'circle', 'square', 'diamond'];
      for (const [w, h] of [[800, 400], [400, 800], [400, 400], [20, 40]]) {
        const original = source(w, h);
        for (const shape of shapes) for (const zoom of [1, 2, 5]) {
          const c = QRTools.cropLogoCanvas({ source: original, crop: { shape, zoom, centerX: 0, centerY: 1 }, createCanvas });
          if (Math.max(c.width, c.height) > 512) throw Error('Crop too large');
          const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const alpha = (x, y) => data[(y * c.width + x) * 4 + 3];
          if (alpha(Math.floor(c.width / 2), Math.floor(c.height / 2)) !== 255) throw Error('Crop center lost');
          // Tiny masks have partially covered corner pixels from antialiasing.
          if ((shape === 'circle' || shape === 'diamond') && (c.width >= 8 ? alpha(0, 0) !== 0 : alpha(0, 0) === 255)) throw Error('Outside mask is opaque');
          if (shape === 'square' && alpha(0, 0) !== 255) throw Error('Square corner clipped');
          maskChecks.push({ w, h, shape, zoom, width: c.width, height: c.height }); QRTools.releaseCanvas(c);
        }
        QRTools.releaseCanvas(original);
      }
      const landscape = source(800, 400);
      const colors = [0, 1].map(centerX => {
        const c = QRTools.cropLogoCanvas({ source: landscape, crop: { shape: 'circle', centerX }, createCanvas });
        const rgb = [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; QRTools.releaseCanvas(c); return rgb;
      });
      if (colors[0][0] <= colors[0][2] || colors[1][2] <= colors[1][0]) throw Error('Focus did not move on source');
      const transparent = source(200, 200); transparent.getContext('2d').clearRect(70, 70, 60, 60);
      for (const shape of shapes) {
        const c = QRTools.cropLogoCanvas({ source: transparent, crop: { shape }, createCanvas });
        if (c.getContext('2d').getImageData(100, 100, 1, 1).data[3] !== 0) throw Error('Original alpha lost');
        QRTools.releaseCanvas(c);
      }
      QRTools.releaseCanvas(transparent);
      const large = source(3200, 2400), blob = await new Promise(resolve => large.toBlob(resolve));
      const bounded = await QRTools.loadImageCanvas(new File([blob], 'large.png', { type: 'image/png' }), QRTools.LIMITS.logoSourceEdge);
      if (bounded.width !== 2000 || bounded.height !== 1500) throw Error('Crop source not bounded');
      QRTools.releaseCanvas(large); QRTools.releaseCanvas(bounded);
      let centered = '';
      for (let n = 1; n < 1000; n++) if (QRCode.create('A'.repeat(n), { errorCorrectionLevel: 'H' }).version === 7) { centered = 'A'.repeat(n); break; }
      const texts = ['https://example.com/crop?hello=world', 'ทดสอบโลโก้รูปทรงต่าง ๆ ภาษาไทย', centered];
      await QRTools.loadCaptionFont({ text: 'ข้อความใต้ QR', fontSize: 24 }, document.fonts);
      for (const text of texts) for (const size of [300, 512]) for (const shape of shapes) {
        const crop = QRTools.cropLogoCanvas({ source: landscape, crop: { shape, zoom: 2 }, createCanvas });
        const options = { text, size, errorCorrectionLevel: 'M', logo: crop, logoShape: shape, qr: QRCode, decode: jsQR, createCanvas };
        const matrix = QRCode.create(text, { errorCorrectionLevel: 'H' }), base = createCanvas();
        await new Promise((resolve, reject) => QRCode.toCanvas(base, text, { width: size, margin: 4,
          errorCorrectionLevel: 'H', version: matrix.version, maskPattern: matrix.maskPattern }, e => e ? reject(e) : resolve()));
        for (const withCaption of [false, true]) {
          let result;
          try { result = await QRTools.buildQrImage({ ...options, caption: { text: withCaption ? 'ข้อความใต้ QR' : '', fontSize: 24, color: '#000000' } }); }
          catch (error) {
            const center = Math.floor(matrix.modules.size / 2);
            if (matrix.modules.isReserved(center, center) && error.code === 'LOGO_LAYOUT') {
              qrChecks.push({ version: matrix.version, size, shape, withCaption, rejected: error.code }); continue;
            }
            throw error;
          }
          if (QRTools.readQr(result.canvas, jsQR)?.data !== text) throw Error('Cropped QR decode mismatch');
          const qrX = Math.floor((result.canvas.width - base.width) / 2);
          const actual = result.canvas.getContext('2d').getImageData(qrX, 0, size, size).data;
          const original = base.getContext('2d').getImageData(0, 0, size, size).data;
          const scale = size / (matrix.modules.size + 8), margin = scale * 4;
          const box = Math.max(6, Math.floor(matrix.modules.size * scale * result.logoRatio));
          let reserved = 0, outside = 0, color = 0;
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const index = (y * size + x) * 4;
            const quiet = x < margin || y < margin || x >= size - margin || y >= size - margin;
            const row = Math.floor((y - margin) / scale), col = Math.floor((x - margin) / scale);
            const protectedPixel = quiet || matrix.modules.isReserved(row, col);
            const dx = Math.abs(x + 0.5 - size / 2), dy = Math.abs(y + 0.5 - size / 2);
            const beyond = shape === 'circle' ? Math.hypot(dx, dy) > box / 2 + 2
              : shape === 'diamond' ? dx + dy > box / 2 + 3 : Math.max(dx, dy) > box / 2 + 2;
            if (protectedPixel || beyond) {
              for (let channel = 0; channel < 4; channel++) if (actual[index + channel] !== original[index + channel]) throw Error('Protected or outside-shape QR pixel changed');
              if (protectedPixel) reserved++; else outside++;
            }
            if (actual[index] !== actual[index + 1] || actual[index + 1] !== actual[index + 2]) color++;
          }
          if (!color) throw Error('No visible crop logo');
          qrChecks.push({ version: matrix.version, size, shape, withCaption, ratio: result.logoRatio, reserved, outside, color });
          QRTools.releaseCanvas(result.canvas);
        }
        QRTools.releaseCanvas(base); QRTools.releaseCanvas(crop);
      }
      const reductions = [];
      for (const shape of ['circle', 'square', 'diamond']) {
        const crop = QRTools.cropLogoCanvas({ source: landscape, crop: { shape }, createCanvas }); let attempts = 0;
        const r = await QRTools.buildQr({ text: texts[0], size: 300, errorCorrectionLevel: 'M', logo: crop, logoShape: shape,
          qr: QRCode, decode: (...args) => ++attempts <= 2 ? null : jsQR(...args), createCanvas });
        if (r.logoRatio > 0.2 || attempts < 3) throw Error('Cropped logo did not reduce after failed scans');
        reductions.push({ shape, attempts, ratio: r.logoRatio }); QRTools.releaseCanvas(r.canvas); QRTools.releaseCanvas(crop);
      }
      for (const color of ['white', 'transparent']) for (const shape of ['circle', 'square', 'diamond']) {
        const c = createCanvas(); c.width = c.height = 100;
        if (color === 'white') { c.getContext('2d').fillStyle = '#fff'; c.getContext('2d').fillRect(0, 0, 100, 100); }
        const crop = QRTools.cropLogoCanvas({ source: c, crop: { shape }, createCanvas });
        let rejected = false;
        try { const r = await QRTools.buildQr({ text: texts[0], size: 300, errorCorrectionLevel: 'M', logo: crop, logoShape: shape, qr: QRCode, decode: jsQR, createCanvas }); QRTools.releaseCanvas(r.canvas); }
        catch (e) { rejected = e.code === 'LOGO_INVISIBLE'; }
        if (!rejected) throw Error('QR pixels outside crop were counted as logo');
        QRTools.releaseCanvas(c); QRTools.releaseCanvas(crop);
      }
      const sourcePng = landscape.toDataURL('image/png'); QRTools.releaseCanvas(landscape);
      return { maskChecks, qrChecks, sourcePng, invisibleChecks: 6, preservedAlpha: 4, reductions };
    });
    const buffer = Buffer.from(pixels.sourcePng.split(',')[1], 'base64'); delete pixels.sourcePng;
    await page.locator('#qr-text').fill('https://example.com/cropped-download');
    await page.locator('#qr-caption').fill('ทดสอบ Crop โลโก้');
    await page.locator('#qr-size').selectOption('400');
    await page.locator('#qr-ecl').selectOption('Q');
    await page.locator('#logo-input').setInputFiles({ name: 'landscape.png', mimeType: 'image/png', buffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#logo-shape').inputValue(), 'none');
    assert.equal(await page.locator('#logo-crop-controls').isVisible(), false);
    ui.push('default original image / crop source retained');
    await page.locator('#logo-shape').selectOption('circle');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#logo-zoom').fill('2');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    const beforeDrag = await page.evaluate(() => logoCrop.centerX);
    const box = await page.locator('#logo-crop-editor').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 30, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.ok(await page.evaluate(() => logoCrop.centerX) < beforeDrag);
    await page.locator('#logo-position-x').focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.evaluate(() => logoCrop.x + logoCrop.side), 800);
    const focused = await page.evaluate(() => [logoCrop.centerX, logoCrop.centerY, logoCrop.zoom]);
    await page.locator('#logo-shape').selectOption('diamond');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.deepEqual(await page.evaluate(() => [logoCrop.centerX, logoCrop.centerY, logoCrop.zoom]), focused);
    await page.locator('#logo-crop-reset').click(); await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.deepEqual(await page.evaluate(() => [logoCrop.centerX, logoCrop.centerY, logoCrop.zoom]), [0.5, 0.5, 1]);
    ui.push('mouse drag / keyboard position / preserved shape focus / reset');
    await page.locator('#logo-zoom').fill('2'); await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('#logo-crop-editor').scrollIntoViewIfNeeded();
    const touchBox = await page.locator('#logo-crop-editor').boundingBox(), session = await context.newCDPSession(page);
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const touchBefore = await page.evaluate(() => logoCrop.centerX);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchBox.x + 128, y: touchBox.y + 128 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchBox.x + 88, y: touchBox.y + 148 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.ok(await page.evaluate(() => logoCrop.centerX) > touchBefore);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.waitForFunction(() => document.getElementById('qr-text-info').textContent.includes('36 ไบต์'));
    await page.screenshot({ path: path.join(artifacts, 'crop-mobile-dark.png'), fullPage: true });
    await session.detach(); ui.push('touch pointer drag / mobile dark layout');
    await page.setViewportSize({ width: 900, height: 1100 }); await page.emulateMedia({ colorScheme: 'light' });
    const downloads = [];
    for (const shape of ['circle', 'square', 'diamond']) {
      await page.locator('#logo-shape').selectOption(shape);
      await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
      await page.locator('#generate-btn').click(); await page.locator('#download-btn').waitFor({ state: 'visible' });
      const pending = page.waitForEvent('download'); await page.locator('#download-btn').click();
      const downloaded = await pending, output = path.join(artifacts, 'crop-' + shape + '.png'); await downloaded.saveAs(output);
      const png = await fs.readFile(output);
      const payload = await page.evaluate(async data => {
        const f = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'qr.png', { type: 'image/png' });
        const canvas = await QRTools.loadImageCanvas(f, 2000), result = QRTools.readQr(canvas, jsQR)?.data;
        QRTools.releaseCanvas(canvas); return result;
      }, png.toString('base64'));
      assert.equal(payload, 'https://example.com/cropped-download'); downloads.push({ shape, payload });
    }
    await page.screenshot({ path: path.join(artifacts, 'crop-desktop.png'), fullPage: true });
    ui.push('three shape PNG downloads with Thai caption round-trip');
    await page.locator('#logo-zoom').fill('5'); assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#logo-shape').selectOption('none'); await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#logo-crop-controls').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => [logoCanvas.width, logoCanvas.height]), [512, 256]);
    ui.push('crop edit invalidates download / original restores complete aspect');
    const partlyWhite = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 800; c.height = 400;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 400);
      ctx.fillStyle = '#2563eb'; ctx.fillRect(400, 0, 400, 400); return c.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#logo-input').setInputFiles({ name: 'partly-white.png', mimeType: 'image/png', buffer: Buffer.from(partlyWhite, 'base64') });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#logo-shape').selectOption('circle');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#logo-zoom').fill('2');
    await page.locator('#logo-position-x').fill('0');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#generate-btn').click(); await page.locator('#logo-crop-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('#logo-input').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.locator('#logo-position-x').fill('100');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#logo-crop-error').isVisible(), false);
    await page.locator('#generate-btn').click(); await page.locator('#download-btn').waitFor({ state: 'visible' });
    ui.push('crop into white-only area is a logo error / moved crop recovers');
    await page.evaluate(() => {
      window.cropFontLoader = QRTools.loadCaptionFont;
      QRTools.loadCaptionFont = () => new Promise(resolve => { window.cropFinishFont = resolve; });
    });
    await page.locator('#generate-btn').click(); await page.waitForFunction(() => !!window.cropFinishFont);
    await page.locator('#logo-shape').selectOption('diamond');
    await page.evaluate(() => { window.cropFinishFont(); QRTools.loadCaptionFont = window.cropFontLoader; });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    assert.equal(await page.locator('#qr-canvas').isVisible(), false);
    ui.push('crop change during font wait cancels stale generation');
    await page.locator('#logo-input').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.deepEqual(await page.evaluate(() => [logoCrop.shape, logoCrop.zoom, logoCrop.centerX, logoCrop.centerY]), ['none', 1, 0.5, 0.5]);
    await page.locator('#logo-remove-btn').click(); assert.equal(await page.locator('#logo-crop-section').isVisible(), false);
    assert.equal(await page.locator('#qr-ecl').inputValue(), 'Q');
    assert.equal(await page.evaluate(() => logoSourceCanvas === null && logoCanvas === null && cropFrameId === null && cropDrag === null), true);
    ui.push('new upload resets / removal releases resources and restores ECL');
    assert.deepEqual(errors, []);
    return { ...pixels, ui, downloads, pageErrors: errors };
  } finally { await page.close(); }
};
