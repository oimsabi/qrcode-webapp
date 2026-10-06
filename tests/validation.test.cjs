const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../qr-tools.js');
const capacityQr = { create(text, { errorCorrectionLevel }) {
  if (text.length > ({ H: 4, Q: 6, M: 8, L: 10 })[errorCorrectionLevel]) throw Error('The amount of data is too big to be stored in a QR Code');
  return { version: 1 };
} };
test('capacity: counts trimmed UTF-8 bytes and evaluates actual library encoding', () => {
  const calls = [];
  const info = tools.inspectQrCapacity({ text: ' ก😀 ', errorCorrectionLevel: 'M', qr: { create: (...args) => { calls.push(args); return { version: 3 }; } } });
  assert.equal(info.bytes, 7); assert.equal(info.text, 'ก😀'); assert.equal(info.version, 3);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], info.text);
});
test('capacity: H is required for logos and alternatives start at remembered level', () => {
  const info = tools.inspectQrCapacity({ text: '12345', errorCorrectionLevel: 'H', preferredLevel: 'M', hasLogo: true, qr: capacityQr });
  assert.equal(info.fits, false); assert.equal(info.level, 'H'); assert.equal(info.anyLevelFits, true);
  assert.deepEqual(info.alternatives.map(item => item.level), ['M', 'L']);
});
test('capacity: empty text and global overflow do not invoke expensive encoding', () => {
  let calls = 0; const qr = { create: () => { calls++; return { version: 40 }; } };
  assert.equal(tools.inspectQrCapacity({ text: ' \n', errorCorrectionLevel: 'M', qr }).empty, true);
  const huge = tools.inspectQrCapacity({ text: '1'.repeat(7090), errorCorrectionLevel: 'M', qr });
  assert.equal(huge.anyLevelFits, false); assert.equal(calls, 0);
  assert.equal(tools.inspectQrCapacity({ text: '1'.repeat(7089), errorCorrectionLevel: 'L', qr }).fits, true);
});
test('capacity: unrelated encoding/library/settings errors are not called overflow', () => {
  assert.throws(() => tools.createQrMatrix('a', 'M', null), { code: 'LIBRARY' });
  assert.throws(() => tools.createQrMatrix('a', 'X', capacityQr), { code: 'SETTINGS' });
  assert.throws(() => tools.createQrMatrix('a', 'M', { create() { throw Error('unexpected internal error'); } }), /unexpected internal/);
});
function renderFixture(decode) {
  const canvases = [];
  const createCanvas = () => {
    const canvas = { width: 300, height: 300, getContext: () => ({ drawImage() {}, fillRect() {}, clearRect() {},
      getImageData: () => ({ data: new Uint8ClampedArray(300 * 300 * 4).fill(100), width: 300, height: 300 }) }) };
    canvases.push(canvas); return canvas;
  };
  const qr = { create: () => ({ version: 1, maskPattern: 0, modules: { size: 21, isReserved: () => false } }), toCanvas: (canvas, text, options, done) => done() };
  return { canvases, options: { text: 'payload', size: 300, errorCorrectionLevel: 'M', caption: {}, qr, decode, createCanvas } };
}
test('image generation: final decode mismatch is typed and releases both temporary canvases', async () => {
  let calls = 0; const f = renderFixture(() => ++calls === 1 ? { data: 'payload' } : { data: 'wrong' });
  await assert.rejects(tools.buildQrImage(f.options), { code: 'FINAL_IMAGE_DECODE' });
  assert.equal(calls, 2); assert.equal(f.canvases.length, 2); assert.ok(f.canvases.every(canvas => canvas.width === 0));
});
test('image generation: successful output is caller-owned while the base is released', async () => {
  const f = renderFixture(() => ({ data: 'payload' })); const result = await tools.buildQrImage(f.options);
  assert.equal(f.canvases[0].width, 0); assert.equal(result.canvas.width, 300);
  tools.releaseCanvas(result.canvas);
});
test('logo diagnosis: visible decode failure and invisible logo have distinct error codes and release canvases', async () => {
  const failed = renderFixture(() => null); failed.options.logo = { width: 100, height: 100 };
  await assert.rejects(tools.buildQr(failed.options), { code: 'LOGO_DECODE' });
  assert.ok(failed.canvases.every(canvas => canvas.width === 0));
  const invisible = renderFixture(() => ({ data: 'payload' })); invisible.options.logo = { width: 100, height: 100 };
  const create = invisible.options.createCanvas;
  invisible.options.createCanvas = () => {
    const canvas = create(), get = canvas.getContext;
    canvas.getContext = () => ({ ...get(), getImageData: () => ({ data: new Uint8ClampedArray(300 * 300 * 4).fill(255) }) });
    return canvas;
  };
  await assert.rejects(tools.buildQr(invisible.options), { code: 'LOGO_INVISIBLE' });
  assert.ok(invisible.canvases.every(canvas => canvas.width === 0));
});
test('alternatives: tests complete images at remembered/weaker levels, releases successful preview and preserves caption', async () => {
  const calls = [], preview = { width: 300, height: 350 }, caption = { text: 'caption' };
  const result = await tools.findPlainAlternative({ logo: {}, caption }, { preferredLevel: 'M', buildImage: async options => {
    calls.push(options); if (options.errorCorrectionLevel === 'M') throw new tools.QrError('FINAL_IMAGE_DECODE', 'failed');
    return { canvas: preview };
  } });
  assert.deepEqual(calls.map(call => call.errorCorrectionLevel), ['M', 'L']);
  assert.equal(calls.every(call => call.logo === null && call.caption === caption), true);
  assert.equal(result.level, 'L'); assert.equal(preview.width, 0);
});
test('alternatives: no pass returns null, skips known failed level and never masks unrelated failures', async () => {
  const levels = [];
  assert.equal(await tools.findPlainAlternative({}, { preferredLevel: 'M', skipLevels: ['M'], buildImage: async options => {
    levels.push(options.errorCorrectionLevel); throw new tools.QrError('PLAIN_DECODE', 'failed');
  } }), null);
  assert.deepEqual(levels, ['L']);
  await assert.rejects(tools.findPlainAlternative({}, { preferredLevel: 'H', buildImage: async () => { throw Error('font failed'); } }), /font failed/);
});
test('alternatives: cancellation releases the completed preview and cannot offer it', async () => {
  let current = true; const preview = { width: 300, height: 350 };
  await assert.rejects(tools.findPlainAlternative({ isCurrent: () => current }, { preferredLevel: 'M', buildImage: async () => {
    current = false; return { canvas: preview };
  } }), { code: 'ABORT', name: 'AbortError' });
  assert.equal(preview.width, 0);
});
