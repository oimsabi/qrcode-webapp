/* Requires Playwright and Chromium/Chrome. See README for running this check. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.env.ARTIFACT_DIR || path.join(root, '.test-artifacts'));
const libraries = [
  'https://cdn.jsdelivr.net/npm/qrcode@1.4.4/build/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  // Use precisely the existing CDN bundles, fetched once for deterministic browser requests.
  const bundles = await Promise.all(libraries.map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Cannot fetch test dependency: ' + url);
    return [url, await response.text()];
  }));
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(await fs.readFile(file));
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 900, height: 1100 }, acceptDownloads: true });
    for (const [url, body] of bundles) await context.route(url, route => route.fulfill({ contentType: 'text/javascript', body }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.QRTools && window.QRCode && window.jsQR);

    const pixelChecks = await page.evaluate(async () => {
      const createCanvas = () => document.createElement('canvas');
      const logo = (width, height, color, inset = 0.1) => {
        const canvas = createCanvas(); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = color; ctx.fillRect(width * inset, height * inset, width * (1 - 2 * inset), height * (1 - 2 * inset));
        return canvas;
      };
      const logos = [logo(100, 100, '#dc2626'), logo(250, 60, '#2563eb'), logo(60, 250, '#16a34a')];
      const opaqueSquare = logo(100, 100, '#dc2626', 0);
      let centralAlignmentText = '';
      for (let n = 1; n < 1000; n++) {
        const text = 'A'.repeat(n);
        if (QRCode.create(text, { errorCorrectionLevel: 'H' }).version === 7) { centralAlignmentText = text; break; }
      }
      if (!centralAlignmentText) throw new Error('No version 7 test payload');
      const texts = ['https://example.com/qr?hello=world', 'สวัสดีครับ ทดสอบ QR ภาษาไทย ๑๒๓', 'QR-CODE-'.repeat(60), centralAlignmentText];
      const checks = [];
      let samplePng;
      for (const [textIndex, text] of texts.entries()) {
        const highMatrix = QRCode.create(text, { errorCorrectionLevel: 'H' });
        const center = Math.floor(highMatrix.modules.size / 2);
        const centeredPattern = highMatrix.modules.isReserved(center, center);
        for (const size of [200, 300, 400, 512]) {
          for (const chosenLogo of [null, centeredPattern ? opaqueSquare : logos[(textIndex + size) % logos.length]]) {
            const ecl = chosenLogo ? 'H' : 'M';
            const matrix = QRCode.create(text, { errorCorrectionLevel: ecl });
            let result;
            try {
              result = await QRTools.buildQr({ text, size, errorCorrectionLevel: 'M', logo: chosenLogo,
                qr: QRCode, decode: jsQR, createCanvas });
            } catch (error) {
              if (chosenLogo && centeredPattern && error.code === 'LOGO_LAYOUT') {
                checks.push({ textIndex, size, version: matrix.version, logo: true, rejected: error.code }); continue;
              }
              throw new Error(error.message + ' ' + JSON.stringify({ textIndex, size, version: matrix.version,
                logo: chosenLogo && [chosenLogo.width, chosenLogo.height] }));
            }
            const base = createCanvas();
            await new Promise((resolve, reject) => QRCode.toCanvas(base, text, {
              width: size, margin: 4, errorCorrectionLevel: ecl, version: matrix.version, maskPattern: matrix.maskPattern
            }, error => error ? reject(error) : resolve()));
            const actual = result.canvas.getContext('2d').getImageData(0, 0, result.canvas.width, result.canvas.height);
            const original = base.getContext('2d').getImageData(0, 0, base.width, base.height);
            const decoded = jsQR(actual.data, actual.width, actual.height);
            if (!decoded || decoded.data !== text) throw new Error('Decode mismatch');
            const scale = size / (matrix.modules.size + 8), margin = 4 * scale;
            let reservedPixels = 0, coloredPixels = 0;
            for (let y = 0; y < actual.height; y++) {
              for (let x = 0; x < actual.width; x++) {
                const index = (y * actual.width + x) * 4;
                const quiet = x < margin || y < margin || x >= actual.width - margin || y >= actual.height - margin;
                if (quiet && (actual.data[index] !== 255 || actual.data[index + 1] !== 255 || actual.data[index + 2] !== 255 || actual.data[index + 3] !== 255)) {
                  throw new Error('Quiet zone modified');
                }
                if (!quiet) {
                  const row = Math.floor((y - margin) / scale), col = Math.floor((x - margin) / scale);
                  if (matrix.modules.isReserved(row, col)) {
                    reservedPixels++;
                    for (let channel = 0; channel < 4; channel++) {
                      if (actual.data[index + channel] !== original.data[index + channel]) throw new Error('Functional module modified');
                    }
                  }
                }
                if (actual.data[index] !== actual.data[index + 1] || actual.data[index + 1] !== actual.data[index + 2]) coloredPixels++;
              }
            }
            if (chosenLogo && !coloredPixels) throw new Error('Logo disappeared: ' + JSON.stringify({ textIndex, size, version: matrix.version, ratio: result.logoRatio }));
            if (textIndex === 0 && size === 400 && chosenLogo) samplePng = result.canvas.toDataURL('image/png');
            checks.push({ textIndex, size, version: matrix.version, logo: !!chosenLogo, ratio: result.logoRatio, reservedPixels, coloredPixels });
            QRTools.releaseCanvas(result.canvas); QRTools.releaseCanvas(base);
          }
        }
      }
      // Exercise retries with real rendering while forcing the first two decoder failures.
      let attempts = 0;
      const reduced = await QRTools.buildQr({ text: texts[0], size: 400, errorCorrectionLevel: 'M', logo: logos[0], qr: QRCode,
        decode: (...args) => ++attempts <= 2 ? null : jsQR(...args), createCanvas });
      if (attempts !== 3 || reduced.logoRatio !== 0.20) throw new Error('Automatic reduction failed');
      QRTools.releaseCanvas(reduced.canvas);
      let erasedLogoRejected = false;
      try {
        await QRTools.buildQr({ text: centralAlignmentText, size: 400, errorCorrectionLevel: 'M', logo: logo(100, 100, '#dc2626', 0.48),
          qr: QRCode, decode: jsQR, createCanvas });
      } catch (error) { erasedLogoRejected = error.code === 'LOGO_LAYOUT'; }
      if (!erasedLogoRejected) throw new Error('Completely obscured logo should not be downloadable');

      const large = createCanvas(); large.width = 3000; large.height = 2000;
      const blob = await new Promise(resolve => large.toBlob(resolve));
      const loaded = await QRTools.loadImageCanvas(new File([blob], 'large.png', { type: 'image/png' }), 2000);
      if (loaded.width !== 2000 || loaded.height !== 1333) throw new Error('Real image resizing failed');
      QRTools.releaseCanvas(large); QRTools.releaseCanvas(loaded);
      const realFormats = [];
      for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
        const blob = await new Promise(resolve => logos[0].toBlob(resolve, type));
        if (blob.type !== type) throw new Error('Browser cannot encode test format ' + type);
        const canvas = await QRTools.loadImageCanvas(new File([blob], 'logo', { type }), 512);
        if (canvas.width !== 100 || canvas.height !== 100) throw new Error('Wrong decoded format dimensions');
        QRTools.releaseCanvas(canvas); realFormats.push(type);
      }
      return { checks, samplePng, logoPng: logos[0].toDataURL('image/png'), realFormats, reductionAttempts: attempts };
    });

    const logoBuffer = Buffer.from(pixelChecks.logoPng.split(',')[1], 'base64');
    const payload = 'https://example.com/custom-logo';
    await page.locator('#qr-text').fill(payload);
    await page.locator('#qr-size').selectOption('400');
    await page.locator('#qr-ecl').selectOption('Q');
    await page.locator('#logo-input').setInputFiles({ name: 'transparent-logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('logo-preview').hidden && !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#qr-ecl').inputValue(), 'H');
    assert.equal(await page.locator('#qr-ecl').isDisabled(), true);
    await page.locator('#generate-btn').click();
    await page.locator('#download-btn').waitFor({ state: 'visible' });
    const downloadPending = page.waitForEvent('download');
    await page.locator('#download-btn').click();
    const download = await downloadPending;
    const pngFile = path.join(artifacts, 'qrcode-with-logo.png');
    await download.saveAs(pngFile);
    const downloaded = await fs.readFile(pngFile);
    const decodedPng = await page.evaluate(async data => {
      const file = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'download.png', { type: 'image/png' });
      const canvas = await QRTools.loadImageCanvas(file, 2000);
      const result = QRTools.readQr(canvas, jsQR); QRTools.releaseCanvas(canvas); return result && result.data;
    }, downloaded.toString('base64'));
    assert.equal(decodedPng, payload);
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    await page.locator('#qr-text').fill(payload + '/changed');
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.locator('#logo-remove-btn').click();
    assert.equal(await page.locator('#qr-ecl').inputValue(), 'Q');
    assert.equal(await page.locator('#qr-ecl').isDisabled(), false);

    // Test failure at every logo size through the actual UI.
    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.evaluate(() => { window.originalDecoder = window.jsQR; window.jsQR = () => null; });
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => document.getElementById('generate-status').classList.contains('error'));
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.evaluate(() => { window.jsQR = window.originalDecoder; });
    await page.locator('[data-tab="scan"]').click();
    await page.locator('#file-input').setInputFiles({ name: 'download.png', mimeType: 'image/png', buffer: downloaded });
    await page.waitForFunction(value => document.getElementById('scan-result-text').textContent === value, payload);
    await page.locator('#file-input').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
    await page.waitForFunction(() => document.getElementById('scan-status').classList.contains('error'));
    assert.equal(await page.locator('#scan-result-box').isVisible(), false);

    // A real MediaStream from canvas, with deferred permission; never access a physical camera.
    await page.evaluate(() => {
      const source = document.createElement('canvas'); source.width = source.height = 40;
      source.getContext('2d').fillRect(0, 0, 40, 40);
      window.testStream = source.captureStream(1);
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.allowTestCamera = resolve; });
    });
    await page.locator('#camera-start-btn').click();
    assert.equal(await page.locator('#camera-start-btn').isDisabled(), true);
    assert.equal(await page.locator('#camera-stop-btn').isVisible(), true);
    await page.locator('[data-tab="generate"]').click();
    await page.evaluate(() => window.allowTestCamera(window.testStream));
    await page.waitForFunction(() => window.testStream.getTracks().every(track => track.readyState === 'ended'));
    assert.equal(await page.evaluate(() => document.getElementById('video').srcObject === null), true);
    const captions = await require('./caption-browser.cjs')(context, page.url(), artifacts, logoBuffer);
    const validation = await require('./validation-browser.cjs')(context, page.url(), artifacts, logoBuffer);
    const crops = await require('./crop-browser.cjs')(context, page.url(), artifacts);
    const layout = await require('./logo-layout-browser.cjs')(context, page.url(), artifacts, logoBuffer);
    assert.deepEqual(errors, []);
    const report = { browser: await browser.version(), pixelChecks: pixelChecks.checks,
      realImageFormats: pixelChecks.realFormats,
      reductionAttempts: pixelChecks.reductionAttempts, downloadedPayload: decodedPng, captions, validation, crops, layout,
      ui: ['logo upload / force H / restore Q', 'PNG round-trip', 'mobile layout', 'changed input invalidates download',
        'all logo sizes rejected', 'uploaded PNG scan', 'corrupt image error', 'late real stream released after tab switch'], pageErrors: errors };
    await fs.writeFile(path.join(artifacts, 'browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ browser: report.browser, realQrCases: report.pixelChecks.length, uiChecks: report.ui.length,
      captionCases: captions.pixelChecks.length, captionUiChecks: captions.ui.length,
      capacityCases: validation.capacityCases.length, validationUiChecks: validation.ui.length,
      cropMaskCases: crops.maskChecks.length, cropQrCases: crops.qrChecks.length, cropUiChecks: crops.ui.length,
      layoutCases: layout.checks.length, sampleCases: layout.sampleChecks.length, layoutUiChecks: layout.ui.length,
      reductionAttempts: report.reductionAttempts, artifacts, pageErrors: errors }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
