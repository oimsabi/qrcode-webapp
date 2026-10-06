const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function checkValidation(context, url, artifacts, logoBuffer) {
  const page = await context.newPage();
  const errors = [], ui = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.QRTools && window.QRCode && window.jsQR);
    const capacityCases = await page.evaluate(() => {
      const checks = [];
      function check(label, text, level, expected) {
        const result = QRTools.inspectQrCapacity({ text, errorCorrectionLevel: level, qr: QRCode });
        if (result.fits !== expected || result.bytes !== new TextEncoder().encode(text.trim()).length) throw Error('Capacity mismatch: ' + label);
        checks.push({ label, level, bytes: result.bytes, fits: result.fits, version: result.version,
          alternatives: result.alternatives.map(item => item.level) });
      }
      for (const [level, limit] of [['H', 1273], ['Q', 1663], ['M', 2331], ['L', 2953]]) {
        check('byte boundary', 'a'.repeat(limit), level, true);
        check('byte overflow', 'a'.repeat(limit + 1), level, false);
      }
      check('Thai below H byte boundary', 'ก'.repeat(424), 'H', true);
      check('Thai above H byte boundary', 'ก'.repeat(425), 'H', false);
      check('emoji below H byte boundary', '😀'.repeat(318), 'H', true);
      check('emoji above H byte boundary', '😀'.repeat(319), 'H', false);
      check('numeric exceeds H byte count but fits', '1'.repeat(3000), 'H', true);
      check('mixed alphanumeric/byte', 'A'.repeat(1500) + 'abc', 'H', true);
      check('trimmed Thai/emoji URL', ' https://example.com/ไทย/😀 ', 'H', true);
      check('global numeric boundary', '1'.repeat(7089), 'L', true);
      check('global numeric overflow', '1'.repeat(7090), 'L', false);
      return checks;
    });
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    await page.locator('#generate-btn').click();
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#qr-text-error').textContent(), /กรุณาพิมพ์/);
    await page.locator('#qr-text').fill(' ไทย😀 ');
    await page.waitForFunction(() => document.getElementById('qr-text-info').textContent.includes('13 ไบต์'));
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    ui.push('empty input / trimmed Thai and emoji byte counter / error cleared');

    await page.locator('#qr-size').selectOption('512');
    await page.locator('#qr-ecl').selectOption('H');
    const largePayload = 'a'.repeat(1274);
    await page.locator('#qr-text').fill(largePayload);
    await page.waitForFunction(() => document.getElementById('qr-text').getAttribute('aria-invalid') === 'true');
    assert.match(await page.locator('#qr-text-error').textContent(), /ระดับ H/);
    assert.match(await page.locator('#qr-fix-btn').textContent(), /ลองใช้ระดับ Q/);
    assert.equal(await page.locator('#qr-ecl').inputValue(), 'H');
    // A full diagnostic verifies a readable alternative rather than promising one from capacity alone.
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled && document.getElementById('qr-text-error').textContent.includes('ตรวจอ่านผ่าน'));
    const lowerLevel = await page.locator('#qr-fix-btn').textContent();
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.locator('#qr-fix-btn').click();
    await page.locator('#download-btn').waitFor({ state: 'visible' });
    assert.notEqual(await page.locator('#qr-ecl').inputValue(), 'H');
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    ui.push('selected-level capacity overflow / verified lower-level repair');

    await page.locator('#qr-ecl').selectOption('M');
    await page.locator('#qr-caption').fill('ข้อความใต้ภาพยังอยู่');
    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled && document.getElementById('qr-text-error').textContent.includes('ตรวจอ่านผ่าน'));
    assert.equal(await page.locator('#logo-preview').isVisible(), true);
    assert.equal(await page.locator('#qr-ecl').inputValue(), 'H');
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    const verifiedNoLogo = await page.locator('#qr-text-error').textContent();
    const recommendedLevel = (await page.locator('#qr-fix-btn').textContent()).match(/ระดับ ([HQML])/)[1];
    await page.screenshot({ path: path.join(artifacts, 'validation-desktop.png'), fullPage: true });
    const lightBorder = await page.locator('#qr-text').evaluate(element => getComputedStyle(element).borderColor);
    assert.equal(lightBorder, 'rgb(220, 38, 38)');
    await page.emulateMedia({ colorScheme: 'dark' });
    const darkBorder = await page.locator('#qr-text').evaluate(element => getComputedStyle(element).borderColor);
    assert.equal(darkBorder, 'rgb(248, 113, 113)');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'validation-mobile-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#qr-fix-btn').click();
    await page.locator('#download-btn').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#logo-preview').isVisible(), false);
    assert.equal(await page.locator('#qr-ecl').inputValue(), recommendedLevel);
    const downloadPending = page.waitForEvent('download'); await page.locator('#download-btn').click();
    const download = await downloadPending; const pngPath = path.join(artifacts, 'validation-repaired.png');
    await download.saveAs(pngPath);
    const png = await fs.readFile(pngPath);
    const roundTrip = await page.evaluate(async data => {
      const file = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'download.png', { type: 'image/png' });
      const canvas = await QRTools.loadImageCanvas(file, 2000);
      const result = { payload: QRTools.readQr(canvas, jsQR)?.data, height: canvas.height };
      QRTools.releaseCanvas(canvas); return result;
    }, png.toString('base64'));
    assert.equal(roundTrip.payload, largePayload); assert.ok(roundTrip.height > 512);
    ui.push('H logo capacity overflow / manual logo removal / caption PNG round-trip / light-dark mobile border');

    const shortPayload = 'https://example.com/validation';
    await page.locator('#qr-text').fill(shortPayload);
    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.evaluate(() => {
      window.validationOriginalBuild = QRTools.buildQrImage;
      QRTools.buildQrImage = options => window.validationOriginalBuild({ ...options, decode: options.logo ? () => null : options.decode });
    });
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled && document.getElementById('qr-text-error').textContent.includes('ตรวจอ่านผ่าน'));
    assert.doesNotMatch(await page.locator('#qr-text-error').textContent(), /เกินความจุ/);
    assert.equal(await page.locator('#logo-preview').isVisible(), true);
    await page.locator('#qr-fix-btn').click(); await page.locator('#download-btn').waitFor({ state: 'visible' });
    await page.evaluate(() => { QRTools.buildQrImage = window.validationOriginalBuild; });
    ui.push('logo decode failure distinguished from capacity / verified manual repair');

    await page.evaluate(() => { window.validationDecoder = window.jsQR; window.jsQR = () => null; });
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => document.getElementById('generate-status').classList.contains('error'));
    assert.match(await page.locator('#qr-text-error').textContent(), /ข้อมูลใส่ใน QR ได้/);
    assert.doesNotMatch(await page.locator('#qr-text-error').textContent(), /เกินความจุ/);
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.evaluate(() => { window.jsQR = window.validationDecoder; });
    ui.push('plain decode failure is not a length overflow and offers no false repair');

    await page.locator('#qr-text').fill('a'.repeat(2954));
    await page.waitForFunction(() => document.getElementById('qr-text-error').textContent.includes('ทุกระดับ'));
    await page.evaluate(() => {
      window.validationCreate = document.createElement.bind(document); window.validationCanvasCount = 0;
      document.createElement = (...args) => { if (args[0] === 'canvas') window.validationCanvasCount++; return window.validationCreate(...args); };
    });
    await page.locator('#generate-btn').click();
    assert.equal(await page.evaluate(() => window.validationCanvasCount), 0);
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.evaluate(() => { document.createElement = window.validationCreate; });
    ui.push('overflow at all levels fails before canvas allocation');

    await page.locator('#qr-text').fill(shortPayload);
    const whiteLogo = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 50;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 50, 50); return canvas.toDataURL('image/png').split(',')[1]; });
    await page.locator('#logo-input').setInputFiles({ name: 'white.png', mimeType: 'image/png', buffer: Buffer.from(whiteLogo, 'base64') });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => document.getElementById('generate-status').classList.contains('error'));
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('#logo-input').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false);
    ui.push('invisible logo is a logo error, not a length error');

    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.evaluate(() => {
      window.validationOriginalAlternative = QRTools.findPlainAlternative;
      QRTools.findPlainAlternative = () => new Promise(resolve => { window.validationFinish = resolve; });
      QRTools.buildQrImage = options => window.validationOriginalBuild({ ...options, decode: options.logo ? () => null : options.decode });
    });
    await page.locator('#generate-btn').click(); await page.waitForFunction(() => !!window.validationFinish);
    await page.locator('#qr-text').fill(shortPayload + '/new');
    await page.evaluate(() => window.validationFinish({ level: 'M' }));
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    await page.evaluate(() => { QRTools.findPlainAlternative = window.validationOriginalAlternative; QRTools.buildQrImage = window.validationOriginalBuild; });
    ui.push('edited input invalidates a deferred diagnosis');
    await page.evaluate(() => { window.validationQrLibrary = window.QRCode; window.QRCode = null; });
    await page.locator('#qr-text').fill(shortPayload + '/library');
    await page.waitForFunction(() => document.getElementById('generate-status').textContent.includes('เครื่องมือสร้าง QR Code'));
    assert.equal(await page.locator('#qr-text').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.locator('#qr-fix-btn').isVisible(), false);
    assert.match(await page.locator('#qr-text-info').textContent(), /ไบต์/);
    await page.evaluate(() => { window.QRCode = window.validationQrLibrary; });
    ui.push('unavailable generator library is not a text-capacity error');
    assert.deepEqual(errors, []);
    return { capacityCases, ui, lowerLevel, verifiedNoLogo, downloadedBytes: Buffer.byteLength(roundTrip.payload),
      downloadedHeight: roundTrip.height, pageErrors: errors };
  } finally { await page.close(); }
};
