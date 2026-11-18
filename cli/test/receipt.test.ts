import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileReceipt, compileImage, loadReceipt } from '../src/receipt.ts';
import { makeSamples } from '../src/samples.ts';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('ローカルPNGの参照は原稿からの相対パスで解決し、通常の内容を保持する', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await readFile(new URL('../../examples/assets/slipstream-shop.png', import.meta.url));
  await writeFile(join(directory, 'logo.png'), image);
  const embedded = `{image:${image.toString('base64')}}`;
  await writeFile(join(directory, 'test.receipt'), `日本語\r\n{image:@logo.png}\r\n${embedded}\r\n`);
  const document = await loadReceipt(join(directory, 'test.receipt'));
  const lines = document.trimEnd().split('\n');
  assert.equal(lines[0], '日本語');
  assert.equal(lines[1], lines[2]);
  const normalized = Buffer.from(lines[1].slice('{image:'.length, -1), 'base64');
  assert.deepEqual(await sharp(normalized).removeAlpha().raw().toBuffer(),
    await sharp(image).removeAlpha().raw().toBuffer());
  const svg = compileReceipt(document, { svg: true });
  assert.ok(svg.includes(normalized.toString('base64')));
  assert.ok(compileReceipt(document).length > image.length);
  await writeFile(join(directory, 'missing.receipt'), '{image:@missing.png}');
  await assert.rejects(loadReceipt(join(directory, 'missing.receipt')), { code: 'ENOENT' });
});

test('ネイティブコマンドのサンプルは実機確認済みの原稿データと一致する', () => {
  assert.equal(sha256(makeSamples()), '28ef4ada49cae62f61718047a7d932abfead4b9f22789e43c7b07a759ae8dc2b');
  assert.equal(sha256(makeSamples('japanese-qr')), 'd9772f6f102cd6b2f7f29156ad36f9995fd308d5c19c7a0760fef74bdc4f3403');
});

test('ReceiptLineは日本語をShift JISで符号化し、UTF-8ではなくバイナリーを返す', () => {
  const payload = compileReceipt('日本語');
  assert.ok(Buffer.isBuffer(payload));
  assert.ok(payload.includes(Buffer.from('93fa967b8cea', 'hex')));
  assert.ok(!payload.includes(Buffer.from('日本語', 'utf8')));
});

test('SII向けQRは非対応のEpson用QRコマンドではなく画像として描画する', () => {
  const payload = compileReceipt('{code:https://example.com/; option:qrcode,5,m}');
  assert.ok(payload.includes(Buffer.from([0x1d, 0x38, 0x4c])));
  assert.ok(!payload.includes(Buffer.from([0x1d, 0x28, 0x6b])));
});

test('SVGプレビューと紙幅の検証はUSBに接続しない', () => {
  assert.match(compileReceipt('こんにちは', { svg: true }), /<svg/);
  assert.match(compileReceipt('test', { svg: true }), /width="360px"/);
  assert.match(compileReceipt('test', { svg: true, paperWidth: 80 }), /width="576px"/);
  for (const paperWidth of [0, 59, 81, NaN]) {
    assert.throws(() => compileReceipt('test', { paperWidth }), /paper-width/);
  }
});

test('画像変換は透明な黒画素を白地に合成してから印刷する', async () => {
  const input = await sharp({ create: { width: 8, height: 1, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const payload = await compileImage(input);
  const marker = payload.indexOf(Buffer.from([0x1d, 0x38, 0x4c]));
  assert.ok(marker >= 0);
  // GS 8 Lは7バイトのヘッダー、10バイトの画像パラメーター、ビットマップデータの順に並ぶ。
  assert.equal(payload[marker + 17], 0);
  assert.equal(payload.readUInt16LE(marker + 13), 8); // 小さい画像は拡大しない。
  await assert.rejects(compileImage(input, { paperWidth: 59 }), /paper-width/);
});

test('単独・参照・埋め込み画像を紙幅に収め、プレビューと同じ画像データを使う', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-width-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await sharp({ create: { width: 720, height: 100, channels: 3,
    background: 'black' } }).png().toBuffer();
  await writeFile(join(directory, 'wide.png'), input);
  await writeFile(join(directory, 'test.receipt'),
    `{image:@wide.png}\n{image:${input.toString('base64')}}`);
  for (const [paperWidth, dots, height] of [[58, 360, 50], [80, 576, 80]]) {
    const document = await loadReceipt(join(directory, 'test.receipt'), { paperWidth });
    const lines = document.split('\n');
    assert.equal(lines[0], lines[1]);
    const image = Buffer.from(lines[0].slice('{image:'.length, -1), 'base64');
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, dots);
    assert.equal(metadata.height, height);
    assert.ok(compileReceipt(document, { paperWidth, svg: true }).includes(image.toString('base64')));
    const payload = await compileImage(input, { paperWidth });
    const marker = payload.indexOf(Buffer.from([0x1d, 0x38, 0x4c]));
    assert.equal(payload.readUInt16LE(marker + 13), dots);
    assert.equal(payload.readUInt16LE(marker + 15), height);
    assert.ok(compileReceipt(document, { paperWidth }).includes(payload.subarray(marker, marker + 18)));
  }
});
