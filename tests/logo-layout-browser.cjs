const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function checkLogoLayout(context, url, artifacts, logoBuffer) {
  const samples = process.env.QR_SAMPLE_DIR ? await Promise.all([6, 7, 8, 9, 10, 11].map(async n => ({
    name: 'qrcode (' + n + ').png', shape: ({ 6: 'none', 7: 'circle', 8: 'diamond', 9: 'circle', 10: 'square', 11: 'circle' })[n],
    png: (await fs.readFile(path.join(process.env.QR_SAMPLE_DIR, 'qrcode (' + n + ').png'))).toString('base64')
  }))) : [];
  const page = await context.newPage(), errors = [], ui = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForFunction(() => window.QRTools && window.QRCode && window.jsQR);
    const pixels = await page.evaluate(async samples => {
      const createCanvas = () => document.createElement('canvas');
      const source = createCanvas(); source.width = source.height = 100;
      source.getContext('2d').fillStyle = '#dc2626'; source.getContext('2d').fillRect(0, 0, 100, 100);
      const shapes = ['none', 'circle', 'square', 'diamond'], checks = [], sampleChecks = [];
      let central = '', version2 = '';
      for (let n = 1; n < 1000; n++) {
        if (!central && QRCode.create('A'.repeat(n), { errorCorrectionLevel: 'H' }).version === 7) central = 'A'.repeat(n);
        if (!version2 && QRCode.create('a'.repeat(n), { errorCorrectionLevel: 'H' }).version === 2) version2 = 'a'.repeat(n);
        if (central && version2) break;
      }
      await QRTools.loadCaptionFont({ text: 'ตรวจโลโก้', fontSize: 24 }, document.fonts);
      async function verified(text, size, shape, withCaption = false) {
        const allocated = [], trackedCanvas = () => { const c = createCanvas(); allocated.push(c); return c; };
        const logo = QRTools.cropLogoCanvas({ source, crop: { shape }, createCanvas });
        const matrix = QRCode.create(text, { errorCorrectionLevel: 'H' }); let result;
        try {
          result = await QRTools.buildQrImage({ text, size, errorCorrectionLevel: 'M', logo, logoShape: shape,
            caption: { text: withCaption ? 'ตรวจโลโก้' : '', fontSize: 24, color: '#000000' }, qr: QRCode, decode: jsQR, createCanvas: trackedCanvas });
          if (QRTools.readQr(result.canvas, jsQR)?.data !== text) throw Error('Payload changed');
          const mask = createCanvas(); mask.width = mask.height = size;
          const scale = size / (matrix.modules.size + 8), box = Math.max(6, Math.floor(matrix.modules.size * scale * result.logoRatio));
          const geometry = QRTools.drawLogoOverlay(mask.getContext('2d'), logo, shape, size, size, box);
          const alpha = mask.getContext('2d').getImageData(0, 0, size, size).data;
          const rects = QRTools.reservedModuleRects(matrix.modules, size, size, size);
          let reservedPixels = 0;
          for (const rect of rects) for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
            if (alpha[(y * size + x) * 4 + 3] !== 0) throw Error('Overlay touches a protected black or white module'); reservedPixels++;
          }
          const before = mask.getContext('2d').getImageData(0, 0, size, size).data.slice();
          // A successful placement needs no restored structure within the logo footprint.
          const base = createCanvas();
          await new Promise((resolve, reject) => QRCode.toCanvas(base, text, { width: size, margin: 4, errorCorrectionLevel: 'H',
            version: matrix.version, maskPattern: matrix.maskPattern }, e => e ? reject(e) : resolve()));
          const qrX = Math.floor((result.canvas.width - size) / 2);
          const final = result.canvas.getContext('2d').getImageData(qrX, 0, size, size).data;
          const original = base.getContext('2d').getImageData(0, 0, size, size).data;
          for (let i = 0; i < alpha.length; i += 4) {
            if (!before[i + 3]) for (let channel = 0; channel < 4; channel++) if (final[i + channel] !== original[i + channel]) throw Error('QR outside overlay changed');
          }
          if (geometry.pad !== Math.max(2, Math.floor(box * 0.08)) / 2) throw Error('Padding was not halved');
          const png = result.canvas.toDataURL('image/png'); QRTools.releaseCanvas(mask); QRTools.releaseCanvas(base);
          QRTools.releaseCanvas(result.canvas);
          if (allocated.some(c => c.width || c.height)) throw Error('Temporary canvas leaked on success');
          return { version: matrix.version, size, shape, withCaption, ratio: result.logoRatio, padding: geometry.pad, reservedPixels, png };
        } catch (error) {
          if (result) QRTools.releaseCanvas(result.canvas);
          if (allocated.some(c => c.width || c.height)) throw Error('Temporary canvas leaked on failure');
          if (error.code !== 'LOGO_LAYOUT' || !matrix.modules.isReserved(Math.floor(matrix.modules.size / 2), Math.floor(matrix.modules.size / 2))) throw error;
          return { version: matrix.version, size, shape, withCaption, rejected: error.code };
        } finally { QRTools.releaseCanvas(logo); }
      }
      let example;
      for (const text of ['1', version2, central]) for (const size of [200, 300, 512]) for (const shape of shapes) {
        const check = await verified(text, size, shape, true);
        if (check.version === 1 && !check.rejected && check.ratio >= 0.3) throw Error('Version 1 should shrink away from format information');
        if (check.version === 2 && shape === 'circle' && size === 300) example = check.png;
        delete check.png; checks.push(check);
      }
      for (const sample of samples) {
        const file = new File([Uint8Array.from(atob(sample.png), c => c.charCodeAt(0))], sample.name, { type: 'image/png' });
        const image = await QRTools.loadImageCanvas(file, 2000), decoded = QRTools.readQr(image, jsQR);
        if (!decoded) throw Error('Original sample did not decode: ' + sample.name);
        const matrix = QRCode.create(decoded.data, { errorCorrectionLevel: 'H' });
        if (matrix.version !== decoded.version) throw Error('Unexpected sample encoding version');
        const mask = createCanvas(); mask.width = mask.height = image.width;
        const box = Math.max(6, Math.floor(matrix.modules.size * image.width / (matrix.modules.size + 8) * 0.3));
        const logo = QRTools.cropLogoCanvas({ source, crop: { shape: sample.shape }, createCanvas });
        QRTools.drawLogoOverlay(mask.getContext('2d'), logo, sample.shape, mask.width, mask.height, box);
        const oldFrameCollides = QRTools.maskOverlapsReserved(mask, QRTools.reservedModuleRects(matrix.modules, mask.width, mask.height, image.width));
        const check = await verified(decoded.data, image.width, sample.shape);
        if (check.rejected) throw Error('Small sample has no usable centered placement');
        sampleChecks.push({ name: sample.name, version: decoded.version, oldFrameCollides, ratio: check.ratio, padding: check.padding,
          payloadPreserved: true, png: check.png });
        QRTools.releaseCanvas(image); QRTools.releaseCanvas(mask); QRTools.releaseCanvas(logo);
      }
      QRTools.releaseCanvas(source);
      return { checks, sampleChecks, central, example };
    }, samples);
    for (const check of pixels.sampleChecks) {
      await fs.writeFile(path.join(artifacts, 'layout-sample-' + check.name.match(/\d+/)[0] + '.png'), Buffer.from(check.png.split(',')[1], 'base64'));
      delete check.png;
    }
    await fs.writeFile(path.join(artifacts, 'layout-halved-padding.png'), Buffer.from(pixels.example.split(',')[1], 'base64'));
    delete pixels.example;
    const central = pixels.central; delete pixels.central;
    await page.locator('#qr-text').fill(central); await page.locator('#qr-caption').fill('ทดสอบโลโก้ตรงกลาง');
    await page.locator('#qr-size').selectOption('400'); await page.locator('#qr-ecl').selectOption('M');
    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled && document.getElementById('logo-crop-error').textContent.includes('ตรวจอ่านผ่าน'));
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('#logo-input').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#logo-preview').isVisible(), true); assert.equal(await page.locator('#qr-ecl').inputValue(), 'H');
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    const suggested = await page.locator('#qr-fix-btn').textContent(); assert.match(suggested, /นำโลโก้ออกและใช้ระดับ [HQML]/);
    await page.screenshot({ path: path.join(artifacts, 'layout-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'layout-mobile-dark.png'), fullPage: true });
    ui.push('central alignment is a logo error / no automatic removal / desktop and mobile layout');
    await page.locator('#qr-fix-btn').click(); await page.locator('#download-btn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#logo-preview').isVisible(), false); assert.equal(await page.locator('#logo-crop-error').isVisible(), false);
    const pending = page.waitForEvent('download'); await page.locator('#download-btn').click();
    const download = await pending, file = path.join(artifacts, 'layout-repaired-caption.png'); await download.saveAs(file);
    const png = await fs.readFile(file);
    const roundTrip = await page.evaluate(async data => {
      const file = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'repair.png', { type: 'image/png' });
      const canvas = await QRTools.loadImageCanvas(file, 2000), decoded = QRTools.readQr(canvas, jsQR);
      const result = { payload: decoded?.data, height: canvas.height }; QRTools.releaseCanvas(canvas); return result;
    }, png.toString('base64'));
    assert.equal(roundTrip.payload, central); assert.ok(roundTrip.height > 400);
    ui.push('manual verified logo removal / original payload and Thai caption PNG round-trip');
    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.evaluate(() => { window.layoutDecoder = window.jsQR; window.jsQR = () => null; });
    await page.locator('#generate-btn').click(); await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.match(await page.locator('#logo-crop-error').textContent(), /ยังตรวจอ่านไม่ผ่าน/);
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false); assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.evaluate(() => { window.jsQR = window.layoutDecoder; });
    ui.push('layout without passing plain alternative offers no false repair');
    await page.evaluate(() => { window.layoutAlternative = QRTools.findPlainAlternative;
      QRTools.findPlainAlternative = () => new Promise(resolve => { window.layoutResolve = resolve; }); });
    await page.locator('#generate-btn').click(); await page.waitForFunction(() => !!window.layoutResolve);
    await page.locator('#logo-shape').selectOption('circle');
    await page.evaluate(() => { window.layoutResolve({ level: 'M' }); QRTools.findPlainAlternative = window.layoutAlternative; });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false); assert.equal(await page.locator('#logo-crop-error').isVisible(), false);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    ui.push('crop edit cancels stale layout diagnosis');
    await page.locator('#qr-text').fill('1'); await page.locator('#logo-shape').selectOption('square');
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#generate-btn').click(); await page.locator('#download-btn').waitFor({ state: 'visible' });
    const ratio = Number((await page.locator('#generate-status').textContent()).match(/กรอบโลโก้ (\d+)%/)[1]); assert.ok(ratio < 30);
    await page.screenshot({ path: path.join(artifacts, 'layout-version1.png'), fullPage: true });
    ui.push('version 1 automatically shrinks away from format information');
    assert.deepEqual(errors, []);
    return { ...pixels, ui, suggested, repairedPayloadPreserved: true, pageErrors: errors };
  } finally { await page.close(); }
};
