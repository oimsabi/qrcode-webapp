const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../qr-tools.js');

test('logo layout: padding is exactly half for odd/even old padding and has minimum 1 px', () => {
  for (const box of [6, 14, 25, 50, 65, 75, 100]) {
    assert.equal(tools.logoPadding(box), Math.max(2, Math.floor(box * 0.08)) / 2);
  }
  assert.equal(tools.logoPadding(65), 2.5); assert.equal(tools.logoPadding(6), 1);
});
test('logo layout: protected rectangles match fractional renderer pixels and the fallback scale', () => {
  const modules = { size: 21, isReserved: (row, col) => row === 8 && col === 8 };
  assert.deepEqual(tools.reservedModuleRects(modules, 300, 300, 300), [{ x: 125, y: 125, width: 10, height: 10 }]);
  assert.deepEqual(tools.reservedModuleRects(modules, 116, 116, 20), [{ x: 48, y: 48, width: 4, height: 4 }]);
  const calls = [], base = { width: 300, height: 300 }, ctx = { drawImage: (...args) => calls.push(args) };
  tools.restoreFunctionalModules({ getContext: () => ctx }, base, modules, 300);
  assert.deepEqual(calls, [[base, 125, 125, 10, 10, 125, 125, 10, 10]]);
});
test('logo layout: any alpha including one antialiased pixel collides with black or white protected cells', () => {
  const data = new Uint8ClampedArray(10 * 10 * 4);
  const mask = { width: 10, height: 10, getContext: () => ({ getImageData: () => ({ data }) }) };
  const rects = [{ x: 2, y: 3, width: 2, height: 2 }];
  assert.equal(tools.maskOverlapsReserved(mask, rects), false);
  data[(4 * 10 + 3) * 4 + 3] = 1;
  assert.equal(tools.maskOverlapsReserved(mask, rects), true);
  data.fill(0); data[(3 * 10 + 4) * 4 + 3] = 255;
  assert.equal(tools.maskOverlapsReserved(mask, rects), false);
  data[(3 * 10 + 2) * 4] = data[(3 * 10 + 2) * 4 + 1] = data[(3 * 10 + 2) * 4 + 2] = 255;
  data[(3 * 10 + 2) * 4 + 3] = 255;
  assert.equal(tools.maskOverlapsReserved(mask, rects), true);
});
function fixture(reserved = false) {
  const canvases = [], calls = [];
  const createCanvas = () => {
    const canvas = { width: 300, height: 300 };
    canvas.getContext = () => ({ drawImage: (...args) => calls.push(args), fillRect() {}, clearRect() {},
      beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {}, fill() {},
      getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(100) }) });
    canvases.push(canvas); return canvas;
  };
  const qr = { create: () => ({ version: 1, maskPattern: 0, modules: { size: 21, isReserved: (r, c) => reserved && r === 10 && c === 10 } }),
    toCanvas: (canvas, text, opts, done) => done() };
  return { canvases, calls, options: { text: 'payload', size: 300, logo: { width: 100, height: 100 }, errorCorrectionLevel: 'M',
    createCanvas, qr, decode: () => ({ data: 'payload' }) } };
}
test('logo layout: all forbidden sizes fail before decoding and release base, candidate and mask', async () => {
  for (const logoShape of tools.LOGO_SHAPES) {
    const f = fixture(true); let reads = 0; f.options.logoShape = logoShape;
    f.options.decode = () => { reads++; return { data: 'payload' }; };
    await assert.rejects(tools.buildQr(f.options), { code: 'LOGO_LAYOUT' });
    assert.equal(reads, 0); assert.equal(f.canvases.length, 3);
    assert.ok(f.canvases.every(c => c.width === 0 && c.height === 0));
  }
});
test('logo layout: successful output remains caller-owned and mask is always released', async () => {
  const f = fixture(); const result = await tools.buildQr(f.options);
  assert.equal(result.logoRatio, 0.3); assert.equal(f.canvases[0].width, 0); assert.equal(f.canvases[2].width, 0);
  assert.equal(result.canvas.width, 300); tools.releaseCanvas(result.canvas);
});
test('logo layout: cancelled retry releases the collision mask and cannot publish', async () => {
  const f = fixture(); let current = true;
  f.options.isCurrent = () => current; f.options.decode = () => { current = false; return null; };
  await assert.rejects(tools.buildQr(f.options), { code: 'ABORT' });
  assert.ok(f.canvases.every(c => c.width === 0));
});
