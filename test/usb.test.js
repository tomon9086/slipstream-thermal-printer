import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToPrinter } from '../src/usb.js';

function printer({ status = Buffer.from([0x18]), statusError, short = false,
  failChunk, claimError, releaseError } = {}) {
  const events = [];
  const chunks = [];
  const endpoint = {
    direction: 'out',
    transfer(data, callback) {
      chunks.push(Buffer.from(data));
      callback(chunks.length === failChunk ? new Error('timeout') : null,
        short ? data.length - 1 : data.length);
    },
  };
  const iface = {
    claim() { events.push('claim'); if (claimError) throw claimError; },
    release(callback) { events.push('release'); callback(releaseError); },
    endpoint(address) { assert.equal(address, 1); return endpoint; },
  };
  const device = {
    open() { events.push('open'); },
    close() { events.push('close'); },
    interface(index) { assert.equal(index, 0); return iface; },
    controlTransfer(...args) {
      const callback = args.pop();
      assert.deepEqual(args, [0xa1, 1, 0, 0, 1]);
      callback(statusError, status);
    },
  };
  return { events, chunks, endpoint, options: {
    findDevice(vid, pid) { assert.deepEqual([vid, pid], [0x0619, 0x0123]); return device; },
    log() {},
  } };
}

test('status-only claims, reads, and closes without sending on 0x38', async () => {
  const p = printer({ status: Buffer.from([0x38]) });
  await sendToPrinter(null, { ...p.options, statusOnly: true });
  assert.deepEqual(p.chunks, []);
  assert.deepEqual(p.events, ['open', 'claim', 'release', 'close']);
});

test('paper bit requires override, while override cannot suppress actual error', async () => {
  for (const [status, ignorePaperStatus] of [[0x38, false], [0x30, true]]) {
    const p = printer({ status: Buffer.from([status]) });
    await assert.rejects(sendToPrinter(Buffer.from('test'), { ...p.options, ignorePaperStatus }), /no print sent/);
    assert.equal(p.chunks.length, 0);
    assert.equal(p.events.at(-1), 'close');
  }
});

test('override permits 0x38 and sends ordered, bounded chunks with binary fidelity', async () => {
  const p = printer({ status: Buffer.from([0x38]) });
  const payload = Buffer.from(Array.from({ length: 10001 }, (_, i) => i % 256));
  await sendToPrinter(payload, { ...p.options, ignorePaperStatus: true });
  assert.deepEqual(p.chunks.map(b => b.length), [4096, 4096, 1809]);
  assert.deepEqual(Buffer.concat(p.chunks), payload);
  assert.equal(p.endpoint.timeout, 15000);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('short transfer is never retried and stops later chunks', async () => {
  const p = printer({ short: true });
  await assert.rejects(sendToPrinter(Buffer.alloc(9000), p.options), /Inspect receipt before retrying/);
  assert.equal(p.chunks.length, 1);
  assert.deepEqual(p.events.slice(-2), ['release', 'close']);
});

test('timeout after a successful chunk stops sending and preserves error through cleanup', async () => {
  const p = printer({ failChunk: 2, releaseError: new Error('release failed') });
  await assert.rejects(sendToPrinter(Buffer.alloc(9000), p.options), error => {
    assert.match(error.message, /4096 bytes previously accepted/);
    assert.equal(error.cause.message, 'timeout');
    return true;
  });
  assert.equal(p.chunks.length, 2);
  assert.equal(p.events.at(-1), 'close');
});

test('only a stalled status request may be skipped for printing', async () => {
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

test('malformed status blocks printing', async () => {
  const p = printer({ status: Buffer.alloc(0) });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /response length/);
  assert.equal(p.chunks.length, 0);
});

test('failed claim closes device without releasing an unclaimed interface', async () => {
  const p = printer({ claimError: new Error('busy') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /busy/);
  assert.deepEqual(p.events, ['open', 'claim', 'close']);
});

test('cleanup failure is reported and device still closes', async () => {
  const p = printer({ releaseError: new Error('release failed') });
  await assert.rejects(sendToPrinter(Buffer.from('test'), p.options), /release failed/);
  assert.equal(p.events.at(-1), 'close');
});

test('missing device and empty payload fail before any transfer', async () => {
  await assert.rejects(sendToPrinter(Buffer.from('x'), { findDevice: () => undefined }), /not found/);
  await assert.rejects(sendToPrinter(Buffer.alloc(0)), /non-empty Buffer/);
});
