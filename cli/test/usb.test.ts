import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToPrinter } from '../src/usb.ts';
import type { PrinterDevice, PrinterInterface, PrinterOutEndpoint, SendOptions, UsbError } from '../src/usb.ts';

interface PrinterFixtureOptions {
  status?: Buffer;
  statusError?: UsbError;
  short?: boolean;
  failChunk?: number;
  claimError?: Error;
  releaseError?: Error;
}
function printer({ status = Buffer.from([0x18]), statusError, short = false,
  failChunk, claimError, releaseError }: PrinterFixtureOptions = {}) {
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
  const iface: PrinterInterface = {
    claim() { events.push('claim'); if (claimError) throw claimError; },
    release(callback) { events.push('release'); callback(releaseError); },
    endpoint(address) { assert.equal(address, 1); return endpoint; },
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
  return { events, chunks, endpoint, options };
}

test('ステータス確認では0x38を取得し、印刷せずインターフェースを解放して閉じる', async () => {
  const p = printer({ status: Buffer.from([0x38]) });
  await sendToPrinter(null, { ...p.options, statusOnly: true });
  assert.deepEqual(p.chunks, []);
  assert.deepEqual(p.events, ['open', 'claim', 'release', 'close']);
});

test('紙ステータスの無視には明示指定が必要で、実際のエラーによる停止は回避できない', async () => {
  for (const [status, ignorePaperStatus] of [[0x38, false], [0x30, true]] as const) {
    const p = printer({ status: Buffer.from([status]) });
    await assert.rejects(sendToPrinter(Buffer.from('test'), { ...p.options, ignorePaperStatus }), /no print sent/);
    assert.equal(p.chunks.length, 0);
    assert.equal(p.events.at(-1), 'close');
  }
});

test('紙ステータス無視の指定により0x38で送信でき、バイト列を保って順番に分割転送する', async () => {
  const p = printer({ status: Buffer.from([0x38]) });
  const payload = Buffer.from(Array.from({ length: 10001 }, (_, i) => i % 256));
  await sendToPrinter(payload, { ...p.options, ignorePaperStatus: true });
  assert.deepEqual(p.chunks.map(b => b.length), [4096, 4096, 1809]);
  assert.deepEqual(Buffer.concat(p.chunks), payload);
  assert.equal(p.endpoint.timeout, 15000);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('転送バイト数が不足した場合は再送せず、後続チャンクの送信を停止する', async () => {
  const p = printer({ short: true });
  await assert.rejects(sendToPrinter(Buffer.alloc(9000), p.options), /Inspect receipt before retrying/);
  assert.equal(p.chunks.length, 1);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('一部送信後のタイムアウトでは送信を停止し、後処理で失敗しても元のエラーを保持する', async () => {
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

test('ステータス取得の省略は印刷時のSTALLだけに許可する', async () => {
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

test('不正なステータス応答を受け取った場合は印刷を停止する', async () => {
  const p = printer({ status: Buffer.alloc(0) });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /response length/);
  assert.equal(p.chunks.length, 0);
});

test('占有に失敗した場合は未占有のインターフェースを解放せずデバイスを閉じる', async () => {
  const p = printer({ claimError: new Error('busy') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /busy/);
  assert.deepEqual(p.events, ['open', 'claim', 'close']);
});

test('後処理の失敗を報告し、デバイスは閉じる', async () => {
  const p = printer({ releaseError: new Error('release failed') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /release failed/);
  assert.equal(p.events.at(-1), 'close');
});

test('機器が見つからない場合と印刷データが空の場合は転送前に失敗する', async () => {
  await assert.rejects(sendToPrinter(Buffer.from('x'), { findDevice: () => undefined }), /not found/);
  await assert.rejects(sendToPrinter(Buffer.alloc(0)), /non-empty Buffer/);
});
