const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const tools = require('../qr-tools.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function stream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getTracks: () => tracks };
}
function controller(overrides = {}) {
  const states = [], errors = [], running = [];
  let stops = 0;
  const camera = tools.createCameraController({
    getUserMedia: async () => stream(), attachAndPlay: async () => {}, isAllowed: () => true,
    onState: state => states.push(state), onStop: () => stops++,
    onRunning: id => running.push(id), onError: error => errors.push(error), ...overrides
  });
  return { camera, states, errors, running, get stops() { return stops; } };
}

test('camera: stopping pending permission releases a late stream', async () => {
  const permission = deferred(), live = stream();
  let played = false;
  const f = controller({ getUserMedia: () => permission.promise, attachAndPlay: async () => { played = true; } });
  const start = f.camera.start();
  f.camera.stop();
  permission.resolve(live);
  await start;
  assert.equal(live.tracks[0].stopped, true);
  assert.equal(played, false);
  assert.equal(f.camera.state, 'stopped');
  assert.equal(f.running.length, 0);
});
test('camera: duplicate start produces just one permission request', async () => {
  const permission = deferred();
  let count = 0;
  const f = controller({ getUserMedia: () => { count++; return permission.promise; } });
  const first = f.camera.start();
  await f.camera.start();
  assert.equal(count, 1);
  const live = stream(); permission.resolve(live); await first;
  assert.equal(f.camera.state, 'running');
  f.camera.stop(); assert.equal(live.tracks[0].stopped, true);
});
test('camera: stop while play is pending cannot restart scanning', async () => {
  const playback = deferred(), live = stream();
  const f = controller({ getUserMedia: async () => live, attachAndPlay: () => playback.promise });
  const start = f.camera.start(); await flush();
  f.camera.stop(); playback.resolve(); await start;
  assert.equal(live.tracks[0].stopped, true);
  assert.equal(f.running.length, 0);
  assert.equal(f.camera.state, 'stopped');
});
test('camera: permission denial resets state and reports error', async () => {
  const f = controller({ getUserMedia: async () => { throw new Error('denied'); } });
  await f.camera.start();
  assert.equal(f.camera.state, 'stopped'); assert.equal(f.errors[0].message, 'denied');
});
test('camera: playback failure stops the acquired track', async () => {
  const live = stream();
  const f = controller({ getUserMedia: async () => live, attachAndPlay: async () => { throw new Error('play failed'); } });
  await f.camera.start();
  assert.equal(live.tracks[0].stopped, true);
  assert.equal(f.camera.state, 'stopped'); assert.equal(f.errors.length, 1);
});
test('camera: an old completion cannot stop or replace a newer session', async () => {
  const old = deferred(), fresh = stream(), late = stream();
  let count = 0;
  const f = controller({ getUserMedia: () => ++count === 1 ? old.promise : Promise.resolve(fresh) });
  const pending = f.camera.start(); f.camera.stop(); await f.camera.start();
  old.resolve(late); await pending;
  assert.equal(late.tracks[0].stopped, true); assert.equal(fresh.tracks[0].stopped, false);
  assert.equal(f.camera.state, 'running'); f.camera.stop();
});
test('camera: old rejection does not overwrite the current session', async () => {
  const old = deferred(); let count = 0;
  const f = controller({ getUserMedia: () => ++count === 1 ? old.promise : Promise.resolve(stream()) });
  const pending = f.camera.start(); f.camera.stop(); await f.camera.start();
  old.reject(new Error('old denial')); await pending;
  assert.equal(f.errors.length, 0); assert.equal(f.camera.state, 'running'); f.camera.stop();
});
test('camera: hidden or inactive UI cannot start a session', async () => {
  let calls = 0;
  const f = controller({ isAllowed: () => false, getUserMedia: async () => { calls++; return stream(); } });
  await f.camera.start(); assert.equal(calls, 0); assert.equal(f.camera.state, 'stopped');
});

test('files: exact byte boundary is accepted, overflow/empty/wrong type rejected', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.doesNotThrow(() => tools.validateFile({ type, size: tools.LIMITS.bytes }));
  }
  assert.throws(() => tools.validateFile({ type: 'image/png', size: tools.LIMITS.bytes + 1 }), /10 MiB/);
  assert.throws(() => tools.validateFile({ type: 'image/png', size: 0 }));
  assert.throws(() => tools.validateFile({ type: 'image/svg+xml', size: 100 }));
});
test('dimensions: pixel and edge boundaries, malformed sizes', () => {
  assert.doesNotThrow(() => tools.validateDimensions(6000, 4000));
  assert.doesNotThrow(() => tools.validateDimensions(8192, 1));
  assert.throws(() => tools.validateDimensions(6000, 4001), /24/);
  assert.throws(() => tools.validateDimensions(8193, 1), /8,192/);
  for (const width of [0, -1, NaN, Infinity, 3.5]) assert.throws(() => tools.validateDimensions(width, 10));
});
test('resizing: preserves proportions, caps long edge and never upscales', () => {
  assert.deepEqual(tools.fitDimensions(6000, 4000, 2000), { width: 2000, height: 1333 });
  assert.deepEqual(tools.fitDimensions(4000, 6000, 2000), { width: 1333, height: 2000 });
  assert.deepEqual(tools.fitDimensions(400, 200, 2000), { width: 400, height: 200 });
  assert.deepEqual(tools.fitDimensions(8192, 1, 2000), { width: 2000, height: 1 });
});
function imageEnv(width, height, fails = false) {
  const canvases = [], revoked = [];
  const image = { naturalWidth: width, naturalHeight: height,
    set src(value) { if (value) queueMicrotask(() => fails ? this.onerror() : this.onload()); } };
  const env = {
    urls: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) },
    createImage: () => image,
    createCanvas: () => { const canvas = { getContext: () => ({ drawImage() {} }) }; canvases.push(canvas); return canvas; }
  };
  return { env, canvases, revoked };
}
function imageFile(type = 'image/png', size = 100) {
  const headers = {
    'image/png': [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82],
    'image/jpeg': [255, 216, 255],
    'image/webp': [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76]
  };
  return { type, size, slice: () => new Blob([Uint8Array.from(headers[type])]) };
}
test('image header: supported signatures pass and disguised SVG is rejected before decode', async () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) await tools.validateImageHeader(imageFile(type));
  const disguised = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/png' });
  const f = imageEnv(100, 100);
  await assert.rejects(tools.loadImageCanvas(disguised, 2000, f.env), /เนื้อหาไฟล์/);
  assert.equal(f.canvases.length, 0); assert.equal(f.revoked.length, 0);
});
test('image loading: over-limit dimensions allocate no canvas and revoke URL', async () => {
  const f = imageEnv(6000, 4001);
  await assert.rejects(tools.loadImageCanvas(imageFile(), 2000, f.env), /24/);
  assert.equal(f.canvases.length, 0); assert.deepEqual(f.revoked, ['blob:test']);
});
test('image loading: valid image allocates only the downscaled canvas', async () => {
  const f = imageEnv(6000, 4000);
  const canvas = await tools.loadImageCanvas(imageFile('image/jpeg', tools.LIMITS.bytes), 2000, f.env);
  assert.equal(canvas.width, 2000); assert.equal(canvas.height, 1333);
  assert.equal(f.canvases.length, 1); assert.deepEqual(f.revoked, ['blob:test']);
});
test('image loading: corrupt file rejects and revokes URL', async () => {
  const f = imageEnv(200, 200, true);
  await assert.rejects(tools.loadImageCanvas(imageFile('image/webp'), 512, f.env), /อ่านไฟล์/);
  assert.equal(f.canvases.length, 0); assert.deepEqual(f.revoked, ['blob:test']);
});
test('image loading: canvas failure releases both canvas and Object URL', async () => {
  const f = imageEnv(200, 200);
  const canvas = { getContext: () => ({ drawImage() { throw new Error('draw failed'); } }) };
  f.env.createCanvas = () => canvas;
  await assert.rejects(tools.loadImageCanvas(imageFile(), 512, f.env), /draw failed/);
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.deepEqual(f.revoked, ['blob:test']);
});

function qrEnv(decode) {
  const canvases = [], renderOptions = [];
  const createCanvas = () => {
    const canvas = { width: 300, height: 300, getContext: () => ({
      drawImage() {}, fillRect() {}, getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(100), width: canvas.width, height: canvas.height })
    }) };
    canvases.push(canvas); return canvas;
  };
  const qr = { create: () => ({ version: 1, maskPattern: 2, modules: { size: 21, isReserved: () => false } }),
    toCanvas: (canvas, text, options, done) => { renderOptions.push(options); done(null); } };
  return { options: { text: 'payload', size: 300, errorCorrectionLevel: 'M', logo: { width: 100, height: 50 }, qr, decode, createCanvas }, canvases, renderOptions };
}
test('logo: retries smaller sizes, forces H and returns the first verified result', async () => {
  let count = 0;
  const f = qrEnv(() => ++count === 3 ? { data: 'payload' } : null);
  const result = await tools.buildQr(f.options);
  assert.equal(result.logoRatio, 0.20); assert.equal(count, 3);
  assert.equal(f.renderOptions[0].margin, 4); assert.equal(f.renderOptions[0].errorCorrectionLevel, 'H');
  assert.equal(f.canvases[0].width, 0); assert.equal(result.canvas.width, 300);
});
test('logo: a different decoded payload is rejected and all temporary canvases released', async () => {
  let count = 0;
  const f = qrEnv(() => { count++; return { data: 'wrong' }; });
  await assert.rejects(tools.buildQr(f.options), /โลโก้อ่านไม่ผ่าน/);
  assert.equal(count, 8); assert.ok(f.canvases.every(canvas => canvas.width === 0));
});

test('logo: chooses the enlarged 30% frame when the largest trial decodes correctly', async () => {
  let count = 0;
  const f = qrEnv(() => { count++; return { data: 'payload' }; });
  const result = await tools.buildQr(f.options);
  assert.equal(result.logoRatio, 0.30); assert.equal(count, 1);
  assert.equal(f.renderOptions[0].errorCorrectionLevel, 'H');
  tools.releaseCanvas(result.canvas);
});
test('plain QR: preserves chosen ECL and requires an exact decode match', async () => {
  const f = qrEnv(() => ({ data: 'payload' })); f.options.logo = null;
  const result = await tools.buildQr(f.options);
  assert.equal(f.renderOptions[0].errorCorrectionLevel, 'M'); assert.equal(result.logoRatio, null);
  const bad = qrEnv(() => null); bad.options.logo = null;
  await assert.rejects(tools.buildQr(bad.options), /ตรวจอ่าน QR ไม่ผ่าน/);
});
test('generation: invalidated request cannot publish a rendered canvas', async () => {
  const pending = deferred(); let current = true;
  const f = qrEnv(() => ({ data: 'payload' }));
  f.options.isCurrent = () => current;
  f.options.qr.toCanvas = (canvas, text, options, done) => pending.promise.then(() => done(null));
  const build = tools.buildQr(f.options); current = false; pending.resolve();
  await assert.rejects(build, { name: 'AbortError' }); assert.equal(f.canvases[0].width, 0);
});

function appEnv(overrides = {}) {
  const elements = new Map(), documentEvents = {}, windowEvents = {}, frames = new Map();
  let frameId = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: ({ 'qr-ecl': 'M', 'qr-size': '300', 'caption-size': '24', 'caption-color': '#000000' })[id] || '', hidden: true, disabled: false,
      textContent: '', files: [], handlers: {}, dataset: {}, style: {}, classList: { add() {}, remove() {} },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      removeAttribute(name) { delete this[name]; }, focus() {}, pause() {}, play: async () => {},
      readyState: 0, HAVE_ENOUGH_DATA: 4, getContext: () => ({ drawImage() {} }),
      set innerHTML(value) { throw new Error('Unsafe HTML insertion'); }
    });
    return elements.get(id);
  }
  const tabs = ['generate', 'scan'].map(id => { const tab = element('tab-' + id); tab.dataset.tab = id; return tab; });
  const document = { hidden: false,
    querySelectorAll: selector => selector === '.tab-btn' ? tabs : ['generate', 'scan'].map(element),
    getElementById: element, createElement: () => ({ getContext: () => ({ drawImage() {} }) }),
    addEventListener: (name, handler) => { documentEvents[name] = handler; }
  };
  const context = vm.createContext({ document, window: { addEventListener: (name, handler) => { windowEvents[name] = handler; } },
    navigator: { mediaDevices: { getUserMedia: overrides.getUserMedia || (async () => stream()) } },
    QRTools: { ...tools, ...overrides.tools }, QRCode: {}, jsQR: () => null, performance: { now: () => 1000 }, setTimeout,
    requestAnimationFrame: handler => { frames.set(++frameId, handler); return frameId; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8'), context);
  return { context, elements, document, documentEvents, windowEvents, frames,
    clickTab: id => element('tab-' + id).handlers.click(), read: expr => vm.runInContext(expr, context) };
}
test('app: changing tabs while permission is pending releases the late track', async () => {
  const permission = deferred(), live = stream();
  const f = appEnv({ getUserMedia: () => permission.promise });
  f.clickTab('scan'); f.elements.get('camera-start-btn').handlers.click();
  assert.equal(f.elements.get('camera-start-btn').disabled, true);
  assert.equal(f.elements.get('camera-stop-btn').hidden, false);
  f.clickTab('generate'); permission.resolve(live); await flush();
  assert.equal(live.tracks[0].stopped, true); assert.equal(f.elements.get('video').srcObject, null);
  assert.equal(f.frames.size, 0);
});
test('app: hidden page and pagehide stop tracks and cancel animation frames', async () => {
  for (const event of ['visibilitychange', 'pagehide']) {
    const live = stream(), f = appEnv({ getUserMedia: async () => live });
    f.clickTab('scan'); f.elements.get('camera-start-btn').handlers.click(); await flush();
    assert.equal(f.frames.size, 1);
    if (event === 'visibilitychange') { f.document.hidden = true; f.documentEvents[event](); }
    else f.windowEvents[event]();
    assert.equal(live.tracks[0].stopped, true); assert.equal(f.frames.size, 0);
    assert.equal(f.elements.get('video').srcObject, null);
  }
});
test('app: stale uploaded file cannot overwrite a newer result', async () => {
  const first = deferred(), second = deferred(), released = [];
  let count = 0;
  const f = appEnv({ tools: {
    loadImageCanvas: () => ++count === 1 ? first.promise : second.promise,
    readQr: canvas => ({ data: canvas.payload }), releaseCanvas: canvas => { if (canvas) released.push(canvas); }
  } });
  f.clickTab('scan'); const input = f.elements.get('file-input'); input.files = [{}];
  const a = input.handlers.change(); const b = input.handlers.change();
  second.resolve({ payload: 'latest' }); await b;
  first.resolve({ payload: 'old' }); await a;
  assert.equal(f.elements.get('scan-result-text').textContent, 'latest');
  assert.deepEqual(released.filter(canvas => canvas.payload).map(canvas => canvas.payload), ['latest', 'old']);
});
test('app: QR result remains text, never HTML', () => {
  const f = appEnv(); f.read('showResult("<img src=x onerror=alert(1)>")');
  assert.equal(f.elements.get('scan-result-text').textContent, '<img src=x onerror=alert(1)>');
});
test('app: successful camera scan stops tracks and keeps the success result/status', async () => {
  const live = stream();
  const f = appEnv({ getUserMedia: async () => live, tools: { readQr: () => ({ data: 'camera result' }) } });
  const video = f.elements.get('video'); video.readyState = 4; video.videoWidth = video.videoHeight = 400;
  f.clickTab('scan'); f.elements.get('camera-start-btn').handlers.click(); await flush();
  assert.equal(live.tracks[0].stopped, true); assert.equal(f.frames.size, 0);
  assert.equal(f.elements.get('scan-result-text').textContent, 'camera result');
  assert.equal(f.elements.get('scan-status').className, 'status success');
});
test('app: stale logo completion cannot overwrite the latest preview', async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  const f = appEnv({ tools: { loadImageCanvas: () => ++calls === 1 ? a.promise : b.promise } });
  const input = f.elements.get('logo-input'); input.files = [{}];
  const first = input.handlers.change(); const second = input.handlers.change();
  const old = { width: 100, height: 100, toDataURL: () => 'old' };
  b.resolve({ width: 100, height: 100, toDataURL: () => 'latest' }); await second;
  a.resolve(old); await first;
  assert.equal(old.width, 0); assert.equal(f.elements.get('logo-preview').src, 'latest');
  assert.equal(f.elements.get('qr-ecl').value, 'H');
});

test('app: editing caption during font loading cancels publication before QR rendering', async () => {
  const font = deferred(); let renders = 0;
  const f = appEnv({ tools: { loadCaptionFont: () => font.promise, buildQr: () => { renders++; } } });
  f.elements.get('qr-text').value = 'https://example.com';
  f.elements.get('qr-caption').value = 'ข้อความเก่า';
  const pending = f.elements.get('generate-btn').handlers.click();
  f.elements.get('qr-caption').value = 'ข้อความใหม่';
  f.elements.get('qr-caption').handlers.input();
  font.resolve(); await pending;
  assert.equal(renders, 0);
  assert.equal(f.elements.get('download-btn').hidden, true);
  assert.equal(f.elements.get('generate-btn').disabled, false);
});

test('app: font loading failure reports an error without creating QR', async () => {
  let renders = 0;
  const f = appEnv({ tools: { loadCaptionFont: async () => { throw new Error('font failed'); }, buildQr: () => { renders++; } } });
  f.elements.get('qr-text').value = 'test';
  f.elements.get('qr-caption').value = 'caption';
  await f.elements.get('generate-btn').handlers.click();
  assert.equal(renders, 0);
  assert.match(f.elements.get('generate-status').textContent, /font failed/);
  assert.equal(f.elements.get('download-btn').hidden, true);
});

test('app: final decode failure releases temporary canvases and prevents download', async () => {
  const base = { width: 300, height: 300 }, final = { width: 330, height: 350 };
  const f = appEnv({ tools: { loadCaptionFont: async () => {}, buildQr: async () => ({ canvas: base }),
    composeQrCaption: () => ({ canvas: final }), readQr: () => null } });
  f.elements.get('qr-text').value = 'test';
  await f.elements.get('generate-btn').handlers.click();
  assert.equal(base.width, 0); assert.equal(final.width, 0);
  assert.equal(f.elements.get('qr-canvas').hidden, true);
  assert.equal(f.elements.get('download-btn').hidden, true);
  assert.match(f.elements.get('generate-status').textContent, /ตรวจอ่านภาพรวมไม่ผ่าน/);
});

test('app: caption text, size and color changes invalidate a previously downloadable image', () => {
  const f = appEnv();
  for (const id of ['qr-caption', 'caption-size', 'caption-color']) {
    f.read('downloadable = true; qrCanvas.hidden = false; downloadBtn.hidden = false; downloadBtn.disabled = false;');
    f.elements.get(id).handlers.input();
    assert.equal(f.read('downloadable'), false);
    assert.equal(f.elements.get('download-btn').disabled, true);
    assert.equal(f.elements.get('qr-canvas').hidden, true);
  }
});
