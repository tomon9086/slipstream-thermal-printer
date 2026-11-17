import iconv from 'iconv-lite';

const ascii = text => Buffer.from(text, 'ascii');
const sjis = text => iconv.encode(text, 'shiftjis');
const QR_DATA = ascii('https://example.com/');

export function qrCommand(data, moduleSize) {
  if (!Number.isInteger(moduleSize) || moduleSize < 2 || moduleSize > 11) {
    throw new Error('QR module size must be 2..11 dots');
  }
  if (!Buffer.isBuffer(data) || data.length < 1 || data.length > 7089) {
    throw new Error('QR data must be a Buffer of 1..7089 bytes');
  }
  const length = Buffer.alloc(2);
  length.writeUInt16LE(data.length);
  return Buffer.concat([Buffer.from([0x12, 0x3b, moduleSize, 0x1d, 0x70, 1, 2, 0x4d, 0, 0x42]), length, data]);
}

export function makeSamples(section = 'all') {
  if (!['all', 'japanese-qr'].includes(section)) throw new Error('Unknown sample section');
  const parts = [ascii('\x1b@\x1ba\x00FONT SIZE / QR TEST\n\n')];
  for (const font of section === 'all' ? [0, 1] : []) {
    parts.push(Buffer.from([0x1b, 0x4d, font]), ascii(`FONT ${font === 0 ? 'A' : 'B'}\n`));
    for (const [width, height] of [[1, 1], [1, 2], [2, 1], [2, 2], [3, 3], [4, 4]]) {
      parts.push(ascii(`Size ${width}x${height} (W x H)\n`),
        Buffer.from([0x1d, 0x21, ((width - 1) << 4) | (height - 1)]),
        ascii('Ab123\n\x1d!\x00\n'));
    }
  }
  parts.push(ascii('\x1bM\x00\x1ba\x00JAPANESE / SHIFT JIS\n\x1cC\x01\x1bR\x08\x1bt\x01'));
  for (const font of [0, 1]) {
    parts.push(ascii(`KANJI FONT ${font === 0 ? 'A' : 'B'}\n`), Buffer.from([0x1c, 0x21, font]));
    for (const text of ['こんにちは、世界！', 'ひらがな カタカナ 漢字', '日本語印刷テスト', '半角: ｱｲｳｴｵ 123 ABC']) {
      parts.push(sjis(text + '\n'));
    }
    parts.push(ascii('Double size\n'), Buffer.from([0x1c, 0x21, font | 0x0c]),
      sjis('日本語テスト\n'), ascii('\x1c!\x00\n'));
  }
  parts.push(ascii('\x1bM\x00\x1ba\x01SII QR / MODEL 2\n'), QR_DATA, ascii('\n'));
  for (const size of [3, 5, 7]) {
    parts.push(ascii(`Module: ${size} dots\n`), qrCommand(QR_DATA, size), ascii('\n'));
  }
  parts.push(ascii('\x1ba\x00\nEND OF TEST\n\n\n\n\n\x1dV\x01'));
  return Buffer.concat(parts);
}
