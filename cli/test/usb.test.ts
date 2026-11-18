import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToPrinter, withPrinter } from '../src/usb.ts';
import type { PrinterDevice, PrinterInterface, PrinterOutEndpoint, PrinterInEndpoint, SendOptions, UsbError } from '../src/usb.ts';

interface PrinterFixtureOptions {
  status?: Buffer;
  statusError?: UsbError;
  short?: boolean;
  failChunk?: number;
  claimError?: Error;
  releaseError?: Error;
  inData?: Buffer;
  inError?: Error;
}
function printer({ status = Buffer.from([0x18]), statusError, short = false,
  failChunk, claimError, releaseError, inData, inError }: PrinterFixtureOptions = {}) {
  const events: string[] = [];
  const chunks: Buffer[] = [];
  const endpoint: PrinterOutEndpoint = {
    direction: 'out',
    timeout: 0,
    transfer(data, callback) {
      chunks.push(Buffer.from(data));
      callback(chunks.length === failChunk ? new Error('timeout') : null,
        short ? data.length - 1 : data.length);
    },
  };
  const incoming: PrinterInEndpoint = {
    direction: 'in', timeout: 0,
    transfer(length, callback) { assert.equal(length, 64); callback(inError, inData); },
  };
  const iface: PrinterInterface = {
    claim() { events.push('claim'); if (claimError) throw claimError; },
    release(callback) { events.push('release'); callback(releaseError); },
    endpoint(address) {
      assert.ok(address === 1 || address === 0x82);
      return address === 1 ? endpoint : incoming;
    },
  };
  const device: PrinterDevice = {
    timeout: 0,
    open() { events.push('open'); },
    close() { events.push('close'); },
    interface(index) { assert.equal(index, 0); return iface; },
    controlTransfer(type, request, value, index, length, callback) {
      assert.deepEqual([type, request, value, index, length], [0xa1, 1, 0, 0, 1]);
      callback(statusError, status);
    },
  };
  const options: SendOptions = {
    findDevice(vid, pid) { assert.deepEqual([vid, pid], [0x0619, 0x0123]); return device; },
    log() {},
  };
  return { events, chunks, endpoint, incoming, options };
}

test('状態取得のみなら0x38でも接続を確保・解放し、印刷データを送らない', async () => {
  const p = printer({ status: Buffer.from([0x38]) });
  await sendToPrinter(null, { ...p.options, statusOnly: true });
  assert.deepEqual(p.chunks, []);
  assert.deepEqual(p.events, ['open', 'claim', 'release', 'close']);
});

test('用紙状態ビットの無視には指定が必要で、本体エラーは無視できない', async () => {
  for (const [status, ignorePaperStatus] of [[0x38, false], [0x30, true]] as const) {
    const p = printer({ status: Buffer.from([status]) });
    await assert.rejects(sendToPrinter(Buffer.from('test'), { ...p.options, ignorePaperStatus }), /no print sent/);
    assert.equal(p.chunks.length, 0);
    assert.equal(p.events.at(-1), 'close');
  }
});

test('用紙状態の無視を指定すると0x38でもデータを変えず、順序と送信サイズ上限を守って送る', async () => {
  const p = printer({ status: Buffer.from([0x38]) });
  const payload = Buffer.from(Array.from({ length: 10001 }, (_, i) => i % 256));
  await sendToPrinter(payload, { ...p.options, ignorePaperStatus: true });
  assert.deepEqual(p.chunks.map(b => b.length), [4096, 4096, 1809]);
  assert.deepEqual(Buffer.concat(p.chunks), payload);
  assert.equal(p.endpoint.timeout, 15000);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('部分転送は再試行せず、後続チャンクの送信を停止する', async () => {
  const p = printer({ short: true });
  await assert.rejects(sendToPrinter(Buffer.alloc(9000), p.options), /Inspect receipt before retrying/);
  assert.equal(p.chunks.length, 1);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('一部送信後のタイムアウトで送信を停止し、終了処理後も元のエラーを保持する', async () => {
  const p = printer({ failChunk: 2, releaseError: new Error('release failed') });
  await assert.rejects(sendToPrinter(Buffer.alloc(9000), p.options), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /4096 bytes previously accepted/);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, 'timeout');
    return true;
  });
  assert.equal(p.chunks.length, 2);
  assert.equal(p.events.at(-1), 'close');
});

test('印刷時に省略できる状態取得の失敗はSTALLだけとする', async () => {
  const pipe = Object.assign(new Error('stalled'), { errno: -9 });
  const p = printer({ statusError: pipe });
  await sendToPrinter(Buffer.from('test'), p.options);
  assert.equal(p.chunks.length, 1);
  const q = printer({ statusError: pipe });
  await assert.rejects(sendToPrinter(null, { ...q.options, statusOnly: true }), /could not read/);
  assert.equal(q.chunks.length, 0);
  const r = printer({ statusError: new Error('USB disconnected') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), r.options), /disconnected/);
  assert.equal(r.chunks.length, 0);
});

test('不正な状態応答では印刷しない', async () => {
  const p = printer({ status: Buffer.alloc(0) });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /response length/);
  assert.equal(p.chunks.length, 0);
});

test('インターフェース確保に失敗したら未確保のインターフェースを解放せずデバイスを閉じる', async () => {
  const p = printer({ claimError: new Error('busy') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /busy/);
  assert.deepEqual(p.events, ['open', 'claim', 'close']);
});

test('終了処理の失敗を報告し、デバイスは閉じる', async () => {
  const p = printer({ releaseError: new Error('release failed') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /release failed/);
  assert.equal(p.events.at(-1), 'close');
});

test('デバイス未検出と空の印刷データは転送前にエラーにする', async () => {
  await assert.rejects(sendToPrinter(Buffer.from('x'), { findDevice: () => undefined }), /not found/);
  await assert.rejects(sendToPrinter(Buffer.alloc(0)), /non-empty Buffer/);
});

test('双方向セッションは一度のインターフェース確保を共有し、受信にタイムアウトを設定する', async () => {
  const p = printer({ inData: Buffer.from([0xa8]) });
  const response = await withPrinter(async io => {
    await io.write(Buffer.from([0x1d, 0x72, 8]));
    return io.read(1234);
  }, p.options);
  assert.deepEqual(response, Buffer.from([0xa8]));
  assert.equal(p.incoming.timeout, 1234);
  assert.deepEqual(p.events, ['open', 'claim', 'release', 'close']);
});

test('受信失敗や不正な応答でも再送せず、インターフェースを解放してデバイスを閉じる', async () => {
  for (const options of [{ inError: new Error('read timeout') }, {}]) {
    const p = printer(options);
    await assert.rejects(withPrinter(io => io.read(), p.options), /read timeout|Invalid USB response/);
    assert.equal(p.chunks.length, 0);
    assert.deepEqual(p.events.slice(-2), ['release', 'close']);
  }
});

test('長さゼロのパケットは元の受信期限内で読み飛ばし、再送しない', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const p = printer();
  const timeouts: number[] = [];
  p.incoming.transfer = (length, callback) => {
    assert.equal(length, 64);
    timeouts.push(p.incoming.timeout);
    now += 400;
    callback(null, timeouts.length < 3 ? Buffer.alloc(0) : Buffer.from([0x8f]));
  };
  assert.deepEqual(await withPrinter(io => io.read(1234), p.options), Buffer.from([0x8f]));
  assert.deepEqual(timeouts, [1234, 834, 434]);
  assert.equal(p.chunks.length, 0);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('長さゼロのパケットが続いても受信期限を延ばさず、USBを解放する', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const p = printer();
  let reads = 0;
  p.incoming.transfer = (_length, callback) => {
    reads++;
    now += 100;
    callback(null, Buffer.alloc(0));
  };
  await assert.rejects(withPrinter(io => io.read(250), p.options), /Timed out/);
  assert.equal(reads, 3);
  assert.equal(p.chunks.length, 0);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});
