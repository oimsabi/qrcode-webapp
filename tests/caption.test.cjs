const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../qr-tools.js');

function context(overrides = {}) {
  return { measureText(text) {
    const count = [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(text)].length;
    return { width: count * 10, actualBoundingBoxLeft: 0, actualBoundingBoxRight: count * 10,
      actualBoundingBoxAscent: text.trim() ? 18 : 0, actualBoundingBoxDescent: text.trim() ? 7 : 0 };
  }, ...overrides };
}
function bitmap(width = 300, height = 300, ctx = context()) { return { width, height, getContext: () => ctx }; }

test('caption: UTF-16 length matches textarea maxlength including emoji', () => {
  assert.equal(tools.validateCaption({ text: 'A'.repeat(1000) }).text.length, 1000);
  assert.equal(tools.validateCaption({ text: '😀'.repeat(500) }).text.length, 1000);
  assert.throws(() => tools.validateCaption({ text: 'A'.repeat(1001) }), /1,000/);
  assert.throws(() => tools.validateCaption({ text: null }), /1,000/);
});
test('caption: accepts size endpoints and rejects invalid sizes and colors', () => {
  for (const fontSize of [8, 24, 96]) assert.equal(tools.validateCaption({ fontSize }).fontSize, fontSize);
  for (const fontSize of [7, 97, 24.5, NaN, Infinity, '24']) assert.throws(() => tools.validateCaption({ fontSize }), /8 ถึง 96/);
  assert.equal(tools.validateCaption({ color: '#aB09F0' }).color, '#aB09F0');
  for (const color of ['red', '#fff', '#000000ff', 'url(x)', null]) assert.throws(() => tools.validateCaption({ color }), /สีข้อความ/);
});
test('caption: normalizes CRLF and skips whitespace-only font loads', async () => {
  assert.equal(tools.validateCaption({ text: 'a\r\nb\rc' }).text, 'a\nb\nc');
  await tools.loadCaptionFont({ text: ' \n\t' }, null);
  assert.equal(tools.validateCaption({ text: ' \n\t' }).hasText, false);
});
test('caption: font must load successfully and cannot silently use a fallback', async () => {
  const options = { text: 'สวัสดี' };
  await assert.rejects(tools.loadCaptionFont(options, null), /ไม่รองรับ/);
  await assert.rejects(tools.loadCaptionFont(options, { load: async () => [], check: () => true }), /ไม่พบฟอนต์/);
  await assert.rejects(tools.loadCaptionFont(options, { load: async () => [{}], check: () => false }), /ไม่พบฟอนต์/);
  await assert.rejects(tools.loadCaptionFont(options, { load: async () => { throw new Error('network'); }, check: () => true }), /network/);
  let requested;
  await tools.loadCaptionFont({ text: 'ไทย', fontSize: 96 }, { load: async font => { requested = font; return [{}]; }, check: () => true });
  assert.equal(requested, '96px "TH Sarabun New"');
});
test('caption: Thai and long URLs wrap without losing characters or splitting graphemes', () => {
  for (const text of ['กิ้กิ้กิ้กิ้กิ้กิ้', 'ภาษาไทยมีสระและวรรณยุกต์', 'https://example.com/very-long-path?abc=123', '👩‍💻👩‍💻👩‍💻']) {
    const layout = tools.layoutCaption(context(), text, 24, 30);
    assert.equal(layout.lines.map(line => line.text).join(''), text);
    assert.equal(layout.lines.every(line => line.width <= 30), true);
    const boundaries = new Set([...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(text)].map(part => part.index));
    let consumed = 0;
    for (const line of layout.lines.slice(0, -1)) { consumed += line.text.length; assert.equal(boundaries.has(consumed), true); }
  }
});
test('caption: explicit newlines and blank lines survive, baseline spacing equals font size', () => {
  const layout = tools.layoutCaption(context(), 'first\n\nlast\n', 24, 100);
  assert.deepEqual(layout.lines.map(line => line.text), ['first', '', 'last', '']);
  assert.equal(layout.lineHeight, 24);
  assert.equal(layout.top, -18);
  assert.equal(layout.bottom, 72);
});
test('caption: unavailable segmenter, metrics or an oversized grapheme fail clearly', () => {
  assert.throws(() => tools.layoutCaption(context(), 'ไทย', 24, 100, null), /ไม่รองรับการแบ่ง/);
  assert.throws(() => tools.layoutCaption(context({ measureText: () => ({ width: 10 }) }), 'a', 24, 100), /วัดขอบเขต/);
  assert.throws(() => tools.layoutCaption(context(), 'กิ้', 24, 9), /ตัวอักษรกว้างเกิน/);
});
test('caption: composes with integer QR position, exact 110% width, ink centered and 8px padding', () => {
  const fills = [], draws = [], texts = [];
  const source = bitmap(400, 400, context({ measureText: text => ({ width: text.length * 10,
    actualBoundingBoxLeft: text ? 2 : 0, actualBoundingBoxRight: text.length * 10,
    actualBoundingBoxAscent: text ? 18 : 0, actualBoundingBoxDescent: text ? 7 : 0 }) }));
  const output = bitmap(0, 0, { fillRect: (...args) => fills.push(args), drawImage: (...args) => draws.push(args), fillText: (...args) => texts.push(args) });
  const result = tools.composeQrCaption({ canvas: source, caption: { text: 'abc\ndef', fontSize: 24, color: '#123456' }, createCanvas: () => output });
  assert.equal(output.width, 440); assert.equal(output.height, 465);
  assert.equal(result.qrX, 20);
  assert.deepEqual(draws, [[source, 20, 0]]);
  assert.equal(texts[0][1] - 2, 204); assert.equal(texts[0][1] + 30, 236);
  assert.equal(texts[0][2] - 18, 408);
  assert.equal(texts[1][2] - texts[0][2], 24);
  assert.equal(output.height - (texts[1][2] + 7), 8);
  assert.equal(output.getContext().fillStyle, '#123456');
  assert.equal(source.width, 400); assert.equal(source.height, 400);
});
test('caption: empty caption preserves QR dimensions without measuring or loading fonts', () => {
  const source = bitmap(300, 300, { measureText: () => { throw Error('Unexpected measure'); } });
  const output = bitmap(0, 0, { fillRect() {}, drawImage() {} });
  const result = tools.composeQrCaption({ canvas: source, caption: { text: ' \n' }, createCanvas: () => output });
  assert.equal(output.width, 300); assert.equal(output.height, 300); assert.equal(result.layout, null);
});
test('caption: rejects excessive output height and pixel area before allocating canvas', () => {
  let allocations = 0;
  const createCanvas = () => { allocations++; };
  assert.throws(() => tools.composeQrCaption({ canvas: bitmap(), caption: { text: 'a' + '\n'.repeat(999), fontSize: 96 }, createCanvas }), /8,192/);
  assert.throws(() => tools.composeQrCaption({ canvas: bitmap(8192, 8192), caption: {}, createCanvas }), /24 ล้าน/);
  assert.equal(allocations, 0);
});
test('caption: a rendering failure releases the output and preserves the source', () => {
  const source = bitmap(), output = bitmap(0, 0, { fillRect() {}, drawImage() { throw Error('draw failed'); } });
  assert.throws(() => tools.composeQrCaption({ canvas: source, caption: {}, createCanvas: () => output }), /draw failed/);
  assert.equal(output.width, 0); assert.equal(output.height, 0);
  assert.equal(source.width, 300);
});
