import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiiReplyDecoder, inspectBlackMark, feedToMark, markAlignmentBytes, printMarkedJob, markedJobBytes, withPaperWidth } from '../src/black-mark.ts';
import { compileMarkedReceipt } from '../src/receipt.ts';
import type { PrinterIO } from '../src/usb.ts';

function encodeHex(data: Buffer) {
  return Buffer.from([14, ...[...data].flatMap(byte => [0xe0 | (byte & 15), 0xf0 | (byte >> 4)]), 0]);
}

function mockPrinter({ mode = true, paperError = 0, failAt = '', timeoutAt = '', ms4 = 0xff, asbAfterSettings = false } = {}) {
  let queued: Buffer = Buffer.alloc(0);
  const writes: Buffer[] = [];
  const stages: Buffer[] = [];
  const settings = Buffer.alloc(40, 0xff);
  settings[0] = mode ? 0xff : 0xfb;
  settings[3] = ms4;
  let errors = paperError;
  const io: PrinterIO = {
    async write(data) {
      writes.push(Buffer.from(data));
      if (data.equals(Buffer.from([0x12, 0x71, 15]))) {
        // 古い状態・完了応答、初期化通知、分割されたASBに続けて今回の同期用応答を返す。
        queued = Buffer.concat([queued, Buffer.from([0xa7, 0x80, 0xb2, 0xc0, ...Array(7).fill(0xd0), 0x8f])]);
      } else if (data.equals(Buffer.from([0x12, 0x6c, 0]))) {
        queued = Buffer.concat([queued, encodeHex(settings),
          ...(asbAfterSettings ? [Buffer.from([0xc0, ...Array(7).fill(0xd0)])] : [])]);
      } else if (data[0] === 0x1d && data[1] === 0x72) {
        const status = data[2] === 8 ? 0x0c : data[2] === 1 ? errors : 0;
        queued = Buffer.concat([queued, Buffer.from([0xa0 | status])]);
      } else {
        assert.deepEqual(data.subarray(-3, -1), Buffer.from([0x12, 0x71]));
        const body = Buffer.from(data.subarray(0, -3));
        stages.push(body);
        if (body[0] === 0x12 && body[1] === 0x77) {
          assert.deepEqual([body[2], body.length, body[4]], [4, 5, 0]); // MS4だけを変更し、FLASH保存ビットは立てない。
          settings[3] = body[3];
        }
        if (body.toString('hex') === failAt) errors |= 4;
        if (body.toString('hex') !== timeoutAt) {
          // 無関係な完了タグを無視し、対応するタグを待つ。
          queued = Buffer.concat([queued, Buffer.from([0x80, 0x80 | data.at(-1)!])]);
        }
      }
    },
    async read(timeout) {
      assert.ok(timeout !== undefined && timeout > 0 && timeout <= 5000);
      if (!queued.length) throw new Error('LIBUSB_ERROR_TIMEOUT');
      // 各バイトを表す2バイトのHEX符号化の途中でも意図的に分割する。
      const chunk = queued.subarray(0, 3);
      queued = queued.subarray(chunk.length);
      return chunk;
    },
  };
  return { io, writes, stages, settings };
}

test('SIIデコーダーはUSB応答の分割位置によらず40バイトのメモリースイッチを復元する', () => {
  const original = Buffer.from(Array.from({ length: 40 }, (_, i) => i * 6));
  const encoded = encodeHex(original);
  assert.equal(encoded.length, 82);
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new SiiReplyDecoder();
    const replies = [...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))];
    assert.deepEqual(replies, [{ kind: 'hex', data: original }]);
  }
});

test('デコーダーは状態・完了応答を初期化通知や分割された自動ステータスと区別する', () => {
  const decoder = new SiiReplyDecoder();
  assert.deepEqual(decoder.push(Buffer.from([0xb2, 0xc0, 0xd1])), []);
  assert.deepEqual(decoder.push(Buffer.from([0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xa8, 0x89])),
    [{ kind: 'status', value: 8 }, { kind: 'execution', value: 9 }]);
});

test('デコーダーは破損した応答や長さの上限を超えるフレームを拒否する', () => {
  assert.throws(() => new SiiReplyDecoder().push(Buffer.from([14, 0xe0, 0])), /Malformed/);
  assert.throws(() => new SiiReplyDecoder().push(Buffer.from([14, 0xe0, 0xe1, 0])), /Malformed/);
  assert.throws(() => new SiiReplyDecoder().push(Buffer.from([0xc0, ...Array(7).fill(0xa0)])), /Malformed/);
  assert.throws(() => new SiiReplyDecoder().push(Buffer.alloc(4097, 14)), /too large/);
});

test('mark-statusは紙送りや設定変更なしでモード・センサー・エラー状態を取得する', async () => {
  const p = mockPrinter();
  assert.deepEqual(await inspectBlackMark(p.io), {
    markMode: true, markDetected: true, paperEmpty: false, nearEnd: true,
    coverOpen: false, markError: false, sensors: 12, errors: 0,
  });
  assert.equal(p.stages.length, 0);
  assert.equal(p.writes.length, 4);
  assert.ok(!p.writes.some(data => data[0] === 0x12 && data[1] === 0x77));
});

test('マークモードが無効または本体にエラーがある場合は紙送り前に停止する', async () => {
  for (const operation of [feedToMark, (io: PrinterIO) => printMarkedJob(io, compileMarkedReceipt('test'))]) {
    const p = mockPrinter({ mode: false });
    await assert.rejects(operation(p.io), /MS1-3/);
    assert.equal(p.stages.length, 0);
    const q = mockPrinter({ paperError: 8 });
    await assert.rejects(operation(q.io), /Printer error/);
    assert.equal(q.stages.length, 0);
  }
});

test('mark-feedは完了応答を待ってからエラーを確認する', async () => {
  const p = mockPrinter();
  await feedToMark(p.io);
  assert.deepEqual(p.stages, [Buffer.from([0x1b, 0x40]), Buffer.from([0x1d, 0x3c])]);
  const q = mockPrinter({ failAt: '1d3c' });
  await assert.rejects(feedToMark(q.io), /Black mark detection failed/);
  assert.equal(q.stages.length, 2);
});

test('マーク印刷では初期化を分離し、既定のカットと原稿内のカットを無効にする', () => {
  const job = compileMarkedReceipt('test\n=\n日本語');
  assert.ok(job.setup.subarray(0, 2).equals(Buffer.from([0x1b, 0x40])));
  assert.ok(!job.body.includes(Buffer.from([0x1b, 0x40])));
  assert.ok(!job.body.includes(Buffer.from([0x1d, 0x56])));
  assert.ok(!job.body.includes(Buffer.from([0x12, 0x71])));
  assert.ok(job.body.includes(Buffer.from('93fa967b8cea', 'hex')));
  assert.ok(markedJobBytes(job).subarray(-2).equals(Buffer.from([0x1d, 0x0c])));
  assert.ok(markedJobBytes(job, true).subarray(-3).equals(Buffer.from([0x1d, 0x56, 1])));
});

test('印刷は初期化・頭出し・本文・終端位置合わせを個別に確認し、指定時だけカットする', async () => {
  const job = compileMarkedReceipt('test');
  for (const cut of [false, true]) {
    const p = mockPrinter();
    await printMarkedJob(p.io, job, cut);
    assert.deepEqual(p.stages, [job.setup, Buffer.from([0x1d, 0x3c]), job.body, Buffer.from([0x1d, 0x0c]),
      ...(cut ? [Buffer.from([0x1d, 0x56, 1])] : [])]);
    assert.ok(!p.writes.some(data => data[0] === 0x12 && [0x77, 0x6b].includes(data[1])));
  }
});

test('マーク探索エラーでは本文を印字せず再試行もしない', async () => {
  const p = mockPrinter({ failAt: '1d3c' });
  await assert.rejects(printMarkedJob(p.io, compileMarkedReceipt('test'), true), /mark-search paper jam/);
  assert.equal(p.stages.length, 2);
  assert.deepEqual(p.stages[1], Buffer.from([0x1d, 0x3c]));
});

test('完了応答がなければ後続の送り・カット・再送を行わず停止する', async () => {
  const job = compileMarkedReceipt('test');
  const p = mockPrinter({ timeoutAt: job.body.toString('hex') });
  await assert.rejects(printMarkedJob(p.io, job, true), /response failed/);
  assert.deepEqual(p.stages, [job.setup, Buffer.from([0x1d, 0x3c]), job.body]);
});

test('マーク補正値をドット単位に丸め、正負で異なる範囲外の値は入出力前に拒否する', async () => {
  for (const [mm, direction, dots] of [[3, 0, 24], [-3, 1, 24], [0, 0, 0], [0.2, 0, 2],
    [-9.25, 1, 74], [31.875, 0, 255]]) {
    assert.deepEqual(markAlignmentBytes(mm), Buffer.from([0x1d, 0x50, 0, 203, 0x1d, 0x3c, 0x1d, 0x41, direction, dots]));
  }
  for (const mm of [NaN, Infinity, -Infinity, -9.251, 31.876]) {
    const p = mockPrinter();
    assert.throws(() => markedJobBytes(compileMarkedReceipt('test'), false, mm), /mark-offset/);
    await assert.rejects(feedToMark(p.io, mm), /mark-offset/);
    await assert.rejects(printMarkedJob(p.io, compileMarkedReceipt('test'), false, mm), /mark-offset/);
    assert.equal(p.writes.length, 0);
  }
});

test('実機の送り・印刷と書き出したデータで、頭出し直後に補正コマンドを配置する', async () => {
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

test('補正付き頭出しのエラーやタイムアウトでは後続の印字とカットを行わない', async () => {
  const alignment = markAlignmentBytes(3).toString('hex');
  for (const failure of [{ failAt: alignment }, { timeoutAt: alignment }]) {
    const p = mockPrinter(failure);
    await assert.rejects(printMarkedJob(p.io, compileMarkedReceipt('test'), true, 3),
      /mark-search paper jam|response failed/);
    assert.equal(p.stages.length, 2);
  }
});

test('紙幅指定はMS4のレイアウト用ビットだけを一時変更し、処理完了後に復元する', async () => {
  for (const [ms4, width, expected] of [[0xff, 58, 0xe7], [0xa7, 80, 0xbf]]) {
    const p = mockPrinter({ ms4, asbAfterSettings: true });
    const original = Buffer.from(p.settings);
    const result = await withPaperWidth(p.io, width, async io => {
      assert.equal(p.settings[3], expected);
      await printMarkedJob(io, compileMarkedReceipt('test'), false, 3);
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(p.settings, original);
    assert.deepEqual(p.stages[0], Buffer.from([0x12, 0x77, 4, expected, 0]));
    assert.deepEqual(p.stages.at(-1), Buffer.from([0x12, 0x77, 4, ms4, 0]));
    // 本文・終端位置合わせの完了を待ってから復元し、処理途中の初期化を防ぐ。
    const restoreIndex = p.writes.findLastIndex(data => data[0] === 0x12 && data[1] === 0x77);
    assert.deepEqual(p.writes[restoreIndex - 1], Buffer.from([0x12, 0x71, 15]));
  }
});

test('紙幅の省略・一致時は設定を書き込まず、不正な紙幅では入出力を行わない', async () => {
  for (const width of [undefined, 80]) {
    const p = mockPrinter();
    assert.equal(await withPaperWidth(p.io, width, async () => 'done'), 'done');
    assert.equal(p.stages.length, 0);
    if (width === undefined) assert.equal(p.writes.length, 0);
  }
  const p = mockPrinter();
  await assert.rejects(withPaperWidth(p.io, 60, async () => assert.fail('must not run')), /paper-width/);
  assert.equal(p.writes.length, 0);
});

test('設定の検証に失敗したら印刷せず元のMS4を復元する', async () => {
  const p = mockPrinter();
  let changes = 0;
  const io: PrinterIO = { ...p.io, async write(data) {
    const altered = Buffer.from(data);
    if (data[0] === 0x12 && data[1] === 0x77 && ++changes === 1) altered[3] ^= 1;
    await p.io.write(altered);
  } };
  await assert.rejects(withPaperWidth(io, 58, async () => assert.fail('must not print')), /verification failed/);
  assert.equal(p.settings[3], 0xff);
  assert.equal(changes, 2);
});

test('処理中のエラーは原因を保持し、元の紙幅を復元する', async () => {
  const p = mockPrinter();
  const failure = new Error('print failed');
  await assert.rejects(withPaperWidth(p.io, 58, async () => { throw failure; }), error => error === failure);
  assert.equal(p.settings[3], 0xff);
  assert.equal(p.stages.length, 2);
});

test('USB書き込み失敗後は送信を停止し、設定の復元には再起動が必要と案内する', async () => {
  const p = mockPrinter();
  const failure = new Error('USB disconnected');
  const io: PrinterIO = { ...p.io, async write(data) {
    if (data.equals(Buffer.from('body'))) throw failure;
    await p.io.write(data);
  } };
  await assert.rejects(withPaperWidth(io, 58, io => io.write(Buffer.from('body'))), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Power-cycle/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(p.settings[3], 0xe7);
  assert.equal(p.stages.length, 1);
});

test('紙幅の復元に失敗した場合はエラーを報告する', async () => {
  const p = mockPrinter();
  let changes = 0;
  const io: PrinterIO = { ...p.io, async write(data) {
    const altered = Buffer.from(data);
    if (data[0] === 0x12 && data[1] === 0x77 && ++changes === 2) altered[3] = 0xe7;
    await p.io.write(altered);
  } };
  await assert.rejects(withPaperWidth(io, 58, async () => {}), /Could not restore printer paper width/);
  assert.equal(p.settings[3], 0xe7);
});
