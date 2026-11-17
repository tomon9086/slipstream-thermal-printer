import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { HELLO, compileReceipt, compileImage } from '../src/receipt.js';
import { makeSamples } from '../src/samples.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');

test('native samples and hello match the Python receipts confirmed on hardware', () => {
  assert.equal(sha256(HELLO), '37041454f27691fc73b50e1ded40a1fab75d54f07907cb14ec81757c66e53599');
  assert.equal(sha256(makeSamples()), '28ef4ada49cae62f61718047a7d932abfead4b9f22789e43c7b07a759ae8dc2b');
  assert.equal(sha256(makeSamples('japanese-qr')), 'd9772f6f102cd6b2f7f29156ad36f9995fd308d5c19c7a0760fef74bdc4f3403');
});

test('ReceiptLine encodes Japanese as Shift JIS and returns binary, not UTF-8', () => {
  const payload = compileReceipt('日本語');
  assert.ok(Buffer.isBuffer(payload));
  assert.ok(payload.includes(Buffer.from('93fa967b8cea', 'hex')));
  assert.ok(!payload.includes(Buffer.from('日本語', 'utf8')));
});

test('SII QR is rendered as graphics rather than the unsupported Epson QR command', () => {
  const payload = compileReceipt('{code:https://example.com/; option:qrcode,5,m}');
  assert.ok(payload.includes(Buffer.from([0x1d, 0x38, 0x4c])));
  assert.ok(!payload.includes(Buffer.from([0x1d, 0x28, 0x6b])));
});

test('SVG preview and width validation require no USB connection', () => {
  assert.match(compileReceipt('こんにちは', { svg: true }), /<svg/);
  for (const cpl of [0, 37, 2.5, NaN]) assert.throws(() => compileReceipt('test', { cpl }), /cpl/);
});

test('image conversion flattens transparent black pixels to white before printing', async () => {
  const input = await sharp({ create: { width: 8, height: 1, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const payload = await compileImage(input, { width: 8 });
  const marker = payload.indexOf(Buffer.from([0x1d, 0x38, 0x4c]));
  assert.ok(marker >= 0);
  // GS 8 L has 7 framing bytes and 10 graphics parameters, followed by bitmap data.
  assert.equal(payload[marker + 17], 0);
  await assert.rejects(compileImage(input, { width: 361 }), /multiple of 8/);
});
