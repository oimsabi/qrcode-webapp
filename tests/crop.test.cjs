const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../qr-tools.js');

test('crop: normalized geometry covers frame and clamps all image edges at zoom 1/5', () => {
  for (const [width, height] of [[1200, 800], [800, 1200], [400, 400], [1, 7]]) {
    for (const zoom of [1, 5]) for (const center of [-10, 0.5, 10]) {
      const state = tools.normalizeLogoCrop({ width, height }, { shape: 'circle', zoom, centerX: center, centerY: center });
      assert.equal(state.side, Math.min(width, height) / zoom);
      assert.ok(state.x >= 0 && state.y >= 0);
      assert.ok(state.x + state.side <= width + 1e-10 && state.y + state.side <= height + 1e-10);
    }
  }
});
test('crop: invalid shapes, zooms and nonfinite focus fail before canvas allocation', () => {
  for (const crop of [{ shape: 'triangle' }, { zoom: 0 }, { zoom: 5.01 }, { zoom: NaN }, { centerX: Infinity }]) {
    let created = false;
    assert.throws(() => tools.cropLogoCanvas({ source: { width: 100, height: 100 }, crop, createCanvas: () => { created = true; } }), { code: 'LOGO_CROP' });
    assert.equal(created, false);
  }
});
function fixture() {
  const calls = [], canvas = { width: 0, height: 0 };
  const ctx = Object.fromEntries(['beginPath', 'arc', 'rect', 'moveTo', 'lineTo', 'closePath', 'clip', 'drawImage'].map(name =>
    [name, (...args) => calls.push([name, ...args])]));
  canvas.getContext = () => ctx;
  return { calls, canvas, createCanvas: () => canvas };
}
test('crop: original image preserves aspect and small images are not enlarged', () => {
  for (const [width, height, expected] of [[1200, 800, [512, 341]], [40, 20, [40, 20]]]) {
    const f = fixture(), source = { width, height };
    const result = tools.cropLogoCanvas({ source, crop: { shape: 'none', zoom: 5 }, createCanvas: f.createCanvas });
    assert.deepEqual([result.width, result.height], expected);
    assert.equal(f.calls.some(call => call[0] === 'clip'), false);
    assert.deepEqual(f.calls.at(-1), ['drawImage', source, 0, 0, ...expected]);
  }
});
test('crop: all shapes clip only the chosen source square and return at most 512 pixels', () => {
  for (const shape of ['circle', 'square', 'diamond']) {
    const f = fixture(), source = { width: 1600, height: 1000 };
    const result = tools.cropLogoCanvas({ source, crop: { shape, zoom: 2, centerX: 1, centerY: 0 }, createCanvas: f.createCanvas });
    assert.deepEqual([result.width, result.height], [500, 500]);
    assert.deepEqual(f.calls.at(-1), ['drawImage', source, 1100, 0, 500, 500, 0, 0, 500, 500]);
    assert.equal(f.calls.filter(call => call[0] === 'clip').length, 1);
  }
});
test('crop: mask includes center and diamond vertices but excludes circle/diamond corners', () => {
  for (const shape of tools.LOGO_SHAPES) assert.equal(tools.pointInLogoShape(shape, 0.5, 0.5), true);
  for (const shape of ['circle', 'diamond']) {
    assert.equal(tools.pointInLogoShape(shape, 0, 0), false);
    assert.equal(tools.pointInLogoShape(shape, 0.5, 0), true);
  }
  assert.equal(tools.pointInLogoShape('square', 0, 0), true);
  assert.equal(tools.pointInLogoShape('diamond', 0.25, 0.25), true);
  assert.equal(tools.pointInLogoShape('circle', -0.1, 0.5), false);
});
test('crop: failure releases allocated canvas and leaves caller-owned source intact', () => {
  const source = { width: 300, height: 300 }, f = fixture();
  f.canvas.getContext = () => null;
  assert.throws(() => tools.cropLogoCanvas({ source, createCanvas: f.createCanvas }), { code: 'LOGO_CROP' });
  assert.deepEqual([f.canvas.width, f.canvas.height], [0, 0]); assert.equal(source.width, 300);
});
