/* Called by browser.cjs so caption checks use the same Chromium and CDN bundles. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function checkCaptions(context, url, artifacts, logoBuffer) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ui = [];
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.QRTools && window.QRCode && window.jsQR);
    const pixelChecks = await page.evaluate(async () => {
      const createCanvas = () => document.createElement('canvas');
      const logo = createCanvas(); logo.width = logo.height = 100;
      const logoCtx = logo.getContext('2d'); logoCtx.fillStyle = '#dc2626'; logoCtx.fillRect(10, 10, 80, 80);
      const payload = 'https://example.com/caption';
      const checks = [];
      function compareQr(base, composed) {
        const a = base.getContext('2d').getImageData(0, 0, base.width, base.height).data;
        const b = composed.canvas.getContext('2d').getImageData(composed.qrX, 0, base.width, base.height).data;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw Error('Caption changed a QR/quiet-zone/logo pixel');
      }
      for (const size of [200, 300, 400, 512]) {
        for (const fontSize of [8, 24, 96]) {
          const text = fontSize === 8 ? 'https://example.com/' + 'very-long-path-'.repeat(8)
            : fontSize === 24 ? 'สแกนเพื่อดูข้อมูล น้ำ ผู้ใช้\n\nEnglish caption'
              : 'น้ำ ผู้ใช้ สแกนเพื่อดูข้อมูล กิ้กิ้กิ้';
          for (const withLogo of [false, true]) {
            const caption = { text, fontSize, color: fontSize === 8 ? '#000000' : '#8b1c64' };
            await QRTools.loadCaptionFont(caption, document.fonts);
            const base = await QRTools.buildQr({ text: payload, size, errorCorrectionLevel: 'M', logo: withLogo ? logo : null,
              qr: QRCode, decode: jsQR, createCanvas });
            let composed;
            try {
              composed = QRTools.composeQrCaption({ canvas: base.canvas, caption, createCanvas });
              if (composed.canvas.width !== Math.ceil(base.canvas.width * 110 / 100)) throw Error('Incorrect 110% image width');
              compareQr(base.canvas, composed);
              if (QRTools.readQr(composed.canvas, jsQR)?.data !== payload) throw Error('Caption PNG decode mismatch');
              if (composed.layout.lineHeight !== fontSize || !composed.layout.lines.every(line => line.width <= base.canvas.width * 110 / 100)) throw Error('Invalid caption line layout');
              if (composed.layout.lines.map(line => line.text).join('') !== text.replace(/\n/g, '')) throw Error('Caption text lost while wrapping');
              const pixels = composed.canvas.getContext('2d').getImageData(0, base.canvas.height, composed.canvas.width, composed.canvas.height - base.canvas.height);
              let ink = 0, firstInk = pixels.height, lastInk = -1, strongInk = 0;
              const color = caption.color.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16));
              const darkestChannel = color.indexOf(Math.min(...color));
              for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
                const i = (y * pixels.width + x) * 4;
                if (pixels.data[i] < 255 || pixels.data[i + 1] < 255 || pixels.data[i + 2] < 255) {
                  ink++; firstInk = Math.min(firstInk, y); lastInk = Math.max(lastInk, y);
                  // Thin Sarabun strokes can contain only antialiased pixels. Check the
                  // selected color blended onto white, instead of demanding opaque ink.
                  const coverage = (255 - pixels.data[i + darkestChannel]) / (255 - color[darkestChannel]);
                  if (!color.every((value, channel) => Math.abs(pixels.data[i + channel] - (255 + (value - 255) * coverage)) <= 2)) throw Error('Caption color not applied');
                  if (coverage > 0.1) strongInk++;
                }
              }
              if (!ink || firstInk < 8 || pixels.height - lastInk - 1 < 8) throw Error('Caption missing or clipped/padding insufficient: ' + JSON.stringify({ size, fontSize, firstInk, lastInk, height: pixels.height }));
              if (!strongInk) throw Error('Caption ink not visible');
              checks.push({ size, fontSize, withLogo, width: composed.canvas.width, height: composed.canvas.height,
                lines: composed.layout.lines.length, firstInk, bottomPadding: pixels.height - lastInk - 1, ink });
            } finally { QRTools.releaseCanvas(composed?.canvas); QRTools.releaseCanvas(base.canvas); }
          }
        }
      }
      for (const text of ['', ' \n\t']) {
        const base = await QRTools.buildQr({ text: payload, size: 300, errorCorrectionLevel: 'M', qr: QRCode, decode: jsQR, createCanvas });
        const composed = QRTools.composeQrCaption({ canvas: base.canvas, caption: { text }, createCanvas });
        if (composed.canvas.width !== 300 || composed.canvas.height !== 300 || composed.layout) throw Error('Blank caption changed image dimensions');
        compareQr(base.canvas, composed);
        checks.push({ blank: true, width: 300, height: 300 });
        QRTools.releaseCanvas(base.canvas); QRTools.releaseCanvas(composed.canvas);
      }
      const whiteCaption = { text: 'ข้อความสีขาว', fontSize: 24, color: '#ffffff' };
      await QRTools.loadCaptionFont(whiteCaption, document.fonts);
      const whiteBase = await QRTools.buildQr({ text: payload, size: 300, errorCorrectionLevel: 'M', qr: QRCode, decode: jsQR, createCanvas });
      const whiteOutput = QRTools.composeQrCaption({ canvas: whiteBase.canvas, caption: whiteCaption, createCanvas });
      const whitePixels = whiteOutput.canvas.getContext('2d').getImageData(0, 300, whiteOutput.canvas.width, whiteOutput.canvas.height - 300).data;
      if (!whitePixels.every(channel => channel === 255) || QRTools.readQr(whiteOutput.canvas, jsQR)?.data !== payload) throw Error('White caption boundary color failed');
      compareQr(whiteBase.canvas, whiteOutput);
      checks.push({ color: '#ffffff', width: whiteOutput.canvas.width, height: whiteOutput.canvas.height });
      QRTools.releaseCanvas(whiteBase.canvas); QRTools.releaseCanvas(whiteOutput.canvas);
      QRTools.releaseCanvas(logo);
      return checks;
    });

    const payload = 'https://example.com/caption-download';
    await page.locator('#qr-text').fill(payload);
    await page.locator('#qr-size').selectOption('400');
    await page.locator('#qr-caption').fill('สแกนเพื่อดูรายละเอียด น้ำ ผู้ใช้\n\nQR Code with a caption');
    await page.locator('#caption-size').fill('32');
    await page.locator('#caption-color').fill('#8b1c64');
    await page.locator('#logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoBuffer });
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    await page.locator('#generate-btn').click();
    await page.locator('#download-btn').waitFor({ state: 'visible' });
    const downloadPending = page.waitForEvent('download');
    await page.locator('#download-btn').click();
    const download = await downloadPending;
    const pngPath = path.join(artifacts, 'qrcode-with-caption.png');
    await download.saveAs(pngPath);
    const png = await fs.readFile(pngPath);
    const roundTrip = await page.evaluate(async bytes => {
      const file = new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], 'caption.png', { type: 'image/png' });
      const canvas = await QRTools.loadImageCanvas(file, 2000);
      const decoded = QRTools.readQr(canvas, jsQR);
      const result = { width: canvas.width, height: canvas.height, payload: decoded?.data };
      QRTools.releaseCanvas(canvas); return result;
    }, png.toString('base64'));
    assert.equal(roundTrip.width, 440); assert.ok(roundTrip.height > 400); assert.equal(roundTrip.payload, payload);
    ui.push('caption + logo PNG download round-trip');
    await page.screenshot({ path: path.join(artifacts, 'desktop-caption.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'mobile-caption.png'), fullPage: true });
    ui.push('caption mobile layout');

    for (const [selector, value] of [['#qr-caption', 'ข้อความใหม่'], ['#caption-size', '36'], ['#caption-color', '#123456']]) {
      await page.locator(selector).fill(value);
      assert.equal(await page.locator('#download-btn').isVisible(), false);
      await page.locator('#generate-btn').click();
      await page.locator('#download-btn').waitFor({ state: 'visible' });
    }
    ui.push('caption / size / color edits invalidate download');

    // Defer the actual font load API and edit input during the pending generation.
    await page.evaluate(() => {
      window.actualFontLoad = document.fonts.load.bind(document.fonts);
      document.fonts.load = (...args) => new Promise(resolve => { window.finishFontLoad = async () => resolve(await window.actualFontLoad(...args)); });
    });
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => !!window.finishFontLoad);
    await page.locator('#qr-caption').fill('ค่าล่าสุดหลังรอโหลดฟอนต์');
    await page.evaluate(() => window.finishFontLoad());
    await page.waitForFunction(() => !document.getElementById('generate-btn').disabled);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.evaluate(() => { document.fonts.load = window.actualFontLoad; });
    ui.push('caption edit during font load cancels stale result');

    await page.locator('#logo-remove-btn').click();
    await page.evaluate(() => {
      window.captionOriginalDecoder = window.jsQR;
      let calls = 0;
      window.jsQR = (...args) => ++calls === 2 ? null : window.captionOriginalDecoder(...args);
    });
    await page.locator('#generate-btn').click();
    await page.waitForFunction(() => document.getElementById('generate-status').classList.contains('error'));
    assert.match(await page.locator('#generate-status').textContent(), /ตรวจอ่านภาพรวมไม่ผ่าน/);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    await page.evaluate(() => { window.jsQR = window.captionOriginalDecoder; });
    ui.push('final caption decode failure prevents download');

    await page.locator('#caption-size').fill('97');
    await page.locator('#generate-btn').click();
    assert.match(await page.locator('#generate-status').textContent(), /8 ถึง 96/);
    assert.equal(await page.locator('#download-btn').isVisible(), false);
    ui.push('invalid font size rejected');

    const failurePage = await context.newPage();
    failurePage.on('pageerror', error => errors.push(error.message));
    try {
      await failurePage.route('**/assets/fonts/THSarabunNew.ttf', route => route.abort());
      await failurePage.goto(url);
      await failurePage.locator('#qr-text').fill(payload);
      await failurePage.locator('#qr-caption').fill('ฟอนต์โหลดไม่สำเร็จ');
      await failurePage.locator('#generate-btn').click();
      await failurePage.waitForFunction(() => document.getElementById('generate-status').classList.contains('error'));
      assert.match(await failurePage.locator('#generate-status').textContent(), /โหลดฟอนต์ TH Sarabun New ไม่สำเร็จ/);
      assert.equal(await failurePage.locator('#download-btn').isVisible(), false);
      // Font failure must not prevent QR generation when caption is empty.
      await failurePage.locator('#qr-caption').fill('');
      await failurePage.locator('#generate-btn').click();
      await failurePage.locator('#download-btn').waitFor({ state: 'visible' });
      assert.equal(await failurePage.locator('#qr-canvas').evaluate(canvas => canvas.width), 300);
      ui.push('real font request failure / blank-caption recovery');
    } finally { await failurePage.close(); }

    assert.deepEqual(errors, []);
    return { pixelChecks, ui, pngRoundTrip: roundTrip, pageErrors: errors };
  } finally { await page.close(); }
};
