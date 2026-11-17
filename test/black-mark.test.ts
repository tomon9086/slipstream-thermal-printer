import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiiReplyDecoder, inspectBlackMark, feedToMark, markAlignmentBytes, printMarkedJob, markedJobBytes } from '../src/black-mark.ts';
import { compileMarkedReceipt } from '../src/receipt.ts';
import type { PrinterIO } from '../src/usb.ts';

function encodeHex(data: Buffer) {
  return Buffer.from([14, ...[...data].flatMap(byte => [0xe0 | (byte & 15), 0xf0 | (byte >> 4)]), 0]);
}

function mockPrinter({ mode = true, paperError = 0, failAt = '', timeoutAt = '' } = {}) {
  let queued: Buffer = Buffer.alloc(0);
  const writes: Buffer[] = [];
  const stages: Buffer[] = [];
  const settings = Buffer.alloc(40, 0xff);
  settings[0] = mode ? 0xff : 0xfb;
  let errors = paperError;
  const io: PrinterIO = {
    async write(data) {
      writes.push(Buffer.from(data));
      if (data.equals(Buffer.from([0x12, 0x71, 15]))) {
        // Old status/ack, an initialization, fragmented ASB, then our fence.
        queued = Buffer.concat([queued, Buffer.from([0xa7, 0x80, 0xb2, 0xc0, ...Array(7).fill(0xd0), 0x8f])]);
      } else if (data.equals(Buffer.from([0x12, 0x6c, 0]))) {
        queued = Buffer.concat([queued, encodeHex(settings)]);
      } else if (data[0] === 0x1d && data[1] === 0x72) {
        const status = data[2] === 8 ? 0x0c : data[2] === 1 ? errors : 0;
        queued = Buffer.concat([queued, Buffer.from([0xa0 | status])]);
      } else {
        assert.deepEqual(data.subarray(-3, -1), Buffer.from([0x12, 0x71]));
        const body = Buffer.from(data.subarray(0, -3));
        stages.push(body);
        if (body.toString('hex') === failAt) errors |= 4;
        if (body.toString('hex') !== timeoutAt) {
          // Ignore an unrelated completion tag and wait for the matching one.
          queued = Buffer.concat([queued, Buffer.from([0x80, 0x80 | data.at(-1)!])]);
        }
      }
    },
    async read(timeout) {
      assert.ok(timeout !== undefined && timeout > 0 && timeout <= 5000);
      if (!queued.length) throw new Error('LIBUSB_ERROR_TIMEOUT');
      // Intentionally split even the two-byte HEX encoding of individual bytes.
      const chunk = queued.subarray(0, 3);
      queued = queued.subarray(chunk.length);
      return chunk;
    },
  };
  return { io, writes, stages };
}

test('SII decoder reconstructs 40 memory switches across all USB split boundaries', () => {
  const original = Buffer.from(Array.from({ length: 40 }, (_, i) => i * 6));
  const encoded = encodeHex(original);
  assert.equal(encoded.length, 82);
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new SiiReplyDecoder();
    const replies = [...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))];
    assert.deepEqual(replies, [{ kind: 'hex', data: original }]);
  }
});

test('decoder separates status/completion from initialization and fragmented automatic status', () => {
  const decoder = new SiiReplyDecoder();
  assert.deepEqual(decoder.push(Buffer.from([0xb2, 0xc0, 0xd1])), []);
  assert.deepEqual(decoder.push(Buffer.from([0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xa8, 0x89])),
    [{ kind: 'status', value: 8 }, { kind: 'execution', value: 9 }]);
});

test('decoder rejects corrupted or unbounded response frames', () => {
  assert.throws(() => new SiiReplyDecoder().push(Buffer.from([14, 0xe0, 0])), /Malformed/);
  assert.throws(() => new SiiReplyDecoder().push(Buffer.from([14, 0xe0, 0xe1, 0])), /Malformed/);
  assert.throws(() => new SiiReplyDecoder().push(Buffer.from([0xc0, ...Array(7).fill(0xa0)])), /Malformed/);
  assert.throws(() => new SiiReplyDecoder().push(Buffer.alloc(4097, 14)), /too large/);
});

test('mark-status reads mode, sensor and error state without movement or configuration writes', async () => {
  const p = mockPrinter();
  assert.deepEqual(await inspectBlackMark(p.io), {
    markMode: true, markDetected: true, paperEmpty: false, nearEnd: true,
    coverOpen: false, markError: false, sensors: 12, errors: 0,
  });
  assert.equal(p.stages.length, 0);
  assert.equal(p.writes.length, 4);
  assert.ok(!p.writes.some(data => data[0] === 0x12 && data[1] === 0x77));
});

test('disabled mode and existing printer errors stop before paper movement', async () => {
  for (const operation of [feedToMark, (io: PrinterIO) => printMarkedJob(io, compileMarkedReceipt('test'))]) {
    const p = mockPrinter({ mode: false });
    await assert.rejects(operation(p.io), /MS1-3/);
    assert.equal(p.stages.length, 0);
    const q = mockPrinter({ paperError: 8 });
    await assert.rejects(operation(q.io), /Printer error/);
    assert.equal(q.stages.length, 0);
  }
});

test('mark-feed waits for completion and verifies errors afterwards', async () => {
  const p = mockPrinter();
  await feedToMark(p.io);
  assert.deepEqual(p.stages, [Buffer.from([0x1b, 0x40]), Buffer.from([0x1d, 0x3c])]);
  const q = mockPrinter({ failAt: '1d3c' });
  await assert.rejects(feedToMark(q.io), /Black mark detection failed/);
  assert.equal(q.stages.length, 2);
});

test('marked receipt separates initialization and disables default and in-document cuts', () => {
  const job = compileMarkedReceipt('test\n=\n日本語');
  assert.ok(job.setup.subarray(0, 2).equals(Buffer.from([0x1b, 0x40])));
  assert.ok(!job.body.includes(Buffer.from([0x1b, 0x40])));
  assert.ok(!job.body.includes(Buffer.from([0x1d, 0x56])));
  assert.ok(!job.body.includes(Buffer.from([0x12, 0x71])));
  assert.ok(job.body.includes(Buffer.from('93fa967b8cea', 'hex')));
  assert.ok(markedJobBytes(job).subarray(-2).equals(Buffer.from([0x1d, 0x0c])));
  assert.ok(markedJobBytes(job, true).subarray(-3).equals(Buffer.from([0x1d, 0x56, 1])));
});

test('printing checks initialization, alignment, body and end positioning separately; cut is opt-in', async () => {
  const job = compileMarkedReceipt('test');
  for (const cut of [false, true]) {
    const p = mockPrinter();
    await printMarkedJob(p.io, job, cut);
    assert.deepEqual(p.stages, [job.setup, Buffer.from([0x1d, 0x3c]), job.body, Buffer.from([0x1d, 0x0c]),
      ...(cut ? [Buffer.from([0x1d, 0x56, 1])] : [])]);
    assert.ok(!p.writes.some(data => data[0] === 0x12 && [0x77, 0x6b].includes(data[1])));
  }
});

test('mark search errors prevent body printing and are never retried', async () => {
  const p = mockPrinter({ failAt: '1d3c' });
  await assert.rejects(printMarkedJob(p.io, compileMarkedReceipt('test'), true), /mark-search paper jam/);
  assert.equal(p.stages.length, 2);
  assert.deepEqual(p.stages[1], Buffer.from([0x1d, 0x3c]));
});

test('missing completion stops the job without later feed/cut commands or retransmission', async () => {
  const job = compileMarkedReceipt('test');
  const p = mockPrinter({ timeoutAt: job.body.toString('hex') });
  await assert.rejects(printMarkedJob(p.io, job, true), /response failed/);
  assert.deepEqual(p.stages, [job.setup, Buffer.from([0x1d, 0x3c]), job.body]);
});

test('mark offsets round to dots, respect asymmetric limits and reject invalid values before I/O', async () => {
  for (const [mm, direction, dots] of [[3, 0, 24], [-3, 1, 24], [0, 0, 0], [0.2, 0, 2],
    [-9.25, 1, 74], [31.875, 0, 255]]) {
    assert.deepEqual(markAlignmentBytes(mm), Buffer.from([0x1d, 0x50, 0, 203, 0x1d, 0x3c, 0x1d, 0x41, direction, dots]));
  }
  for (const mm of [NaN, Infinity, -Infinity, -9.251, 31.876]) {
    const p = mockPrinter();
    assert.throws(() => markedJobBytes(compileMarkedReceipt('test'), false, mm), /mark-offset-mm/);
    await assert.rejects(feedToMark(p.io, mm), /mark-offset-mm/);
    await assert.rejects(printMarkedJob(p.io, compileMarkedReceipt('test'), false, mm), /mark-offset-mm/);
    assert.equal(p.writes.length, 0);
  }
});

test('offset correction immediately follows alignment in live feed/print and exported jobs', async () => {
  const job = compileMarkedReceipt('test');
  for (const mm of [-3, 0, 3]) {
    const alignment = markAlignmentBytes(mm);
    const p = mockPrinter();
    await feedToMark(p.io, mm);
    assert.deepEqual(p.stages, [Buffer.from([0x1b, 0x40]), alignment]);
    const q = mockPrinter();
    await printMarkedJob(q.io, job, true, mm);
    assert.deepEqual(q.stages, [job.setup, alignment, job.body, Buffer.from([0x1d, 0x0c]), Buffer.from([0x1d, 0x56, 1])]);
    assert.deepEqual(Buffer.concat(q.stages), markedJobBytes(job, true, mm));
  }
});

test('corrected alignment errors and timeouts prevent subsequent printing and cutting', async () => {
  const alignment = markAlignmentBytes(3).toString('hex');
  for (const failure of [{ failAt: alignment }, { timeoutAt: alignment }]) {
    const p = mockPrinter(failure);
    await assert.rejects(printMarkedJob(p.io, compileMarkedReceipt('test'), true, 3),
      /mark-search paper jam|response failed/);
    assert.equal(p.stages.length, 2);
  }
});
