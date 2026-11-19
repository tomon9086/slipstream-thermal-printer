import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPaperSetHandle, parsePaperSetMode, setPaperSetHandle } from '../src/paper-set.ts';
import type { PrinterIO } from '../src/usb.ts';

function mockPrinter({ ms5 = 0xd8, hardware = 0, paper = 0, flashBusy = false,
  corrupt = false, writeFailure = false, readFailure = false } = {}) {
  const settings = Buffer.from(Array.from({ length: 40 }, (_, i) => i * 6));
  settings[4] = ms5;
  const writes: Buffer[] = [];
  let queued: Buffer = Buffer.alloc(0);
  let updated = false;
  const io: PrinterIO = {
    async write(data) {
      writes.push(Buffer.from(data));
      if (data.equals(Buffer.from([0x12, 0x6c, 0]))) {
        if (updated && readFailure) return;
        const encoded = Buffer.from([14,
          ...[...settings].flatMap(byte => [0xe0 | (byte & 15), 0xf0 | (byte >> 4)]), 0]);
        queued = Buffer.concat([queued, encoded, Buffer.from([0xc0, ...Array(7).fill(0xd0)])]);
      } else if (data[0] === 0x1d && data[1] === 0x72 && data.length === 3) {
        assert.ok([0, 1, 4].includes(data[2]));
        const status = data[2] === 0 ? hardware : data[2] === 1 ? paper : Number(flashBusy);
        queued = Buffer.concat([queued, Buffer.from([0xa0 | status])]);
      } else {
        // 送り・カット・実行応答要求を禁止し、MS5単独の設定変更だけを受け付ける。
        assert.equal(data.length, 5);
        assert.deepEqual([...data.subarray(0, 2), data[4]], [0x12, 0x77, 0]);
        assert.ok([5, 0x85].includes(data[2]));
        if (writeFailure) throw new Error('USB disconnected');
        settings[4] = data[3];
        if (corrupt) settings[3] ^= 1;
        updated = true;
      }
    },
    async read(timeout) {
      assert.ok(timeout !== undefined && timeout > 0 && timeout <= 5000);
      if (!queued.length) throw new Error('USB response timeout');
      const chunk = queued.subarray(0, 3);
      queued = queued.subarray(chunk.length);
      return chunk;
    },
  };
  return { io, writes, settings, changes: () => writes.filter(data => data[1] === 0x77) };
}

test('現在値の確認は紙送りや設定変更をせず、無効の両表現を読み取る', async () => {
  for (const [ms5, mode] of [[0x98, 'off'], [0xf8, 'off'], [0xd8, 'initial-cut'], [0xb8, 'stamp-cut']] as const) {
    const p = mockPrinter({ ms5, paper: 9 });
    assert.deepEqual(await inspectPaperSetHandle(p.io), { mode, ms5: `0x${ms5.toString(16)}` });
    assert.deepEqual(p.writes, [Buffer.from([0x12, 0x6c, 0])]);
  }
});

test('各モードはMS5の対象ビットだけを変更し、保存指定に応じた単独書き込みを行う', async () => {
  for (const mode of ['off', 'initial-cut', 'stamp-cut'] as const) {
    for (const save of [false, true]) {
      for (const ms5 of [0, 0x18, 0x98, 0xd8, 0xff]) {
        const p = mockPrinter({ ms5 });
        const original = Buffer.from(p.settings);
        const expected = Buffer.from(original);
        expected[4] = (ms5 & ~0x60) | (mode === 'off' ? 0 : mode === 'initial-cut' ? 0x40 : 0x20);
        const result = await setPaperSetHandle(p.io, mode, save);
        assert.deepEqual(p.settings, expected);
        assert.equal(result.saved, save);
        assert.equal(result.changed, !expected.equals(original));
        assert.equal(result.after.mode, mode);
        assert.equal(result.before.ms5, `0x${ms5.toString(16).padStart(2, '0')}`);
        assert.deepEqual(p.changes(), result.changed || save
          ? [Buffer.from([0x12, 0x77, save ? 0x85 : 5, expected[4], 0])] : []);
      }
    }
  }
});

test('カバー開放・紙なしの用紙交換中でも無効化し、実行応答要求は送らない', async () => {
  const p = mockPrinter({ paper: 9 });
  const result = await setPaperSetHandle(p.io, 'off', true);
  assert.deepEqual(result, { before: { mode: 'initial-cut', ms5: '0xd8' },
    after: { mode: 'off', ms5: '0x98' }, saved: true, changed: true });
  assert.ok(!p.writes.some(data => data[1] === 0x71));
});

test('対象値が一致する場合はRAM書き込みを省き、保存指定時は現在値でもFLASHへ書く', async () => {
  const p = mockPrinter({ ms5: 0x98 });
  assert.equal((await setPaperSetHandle(p.io, 'off')).changed, false);
  assert.equal(p.writes.length, 1);
  assert.equal((await setPaperSetHandle(p.io, 'off', true)).saved, true);
  assert.equal(p.changes().length, 1);
});

test('不正なモードはUSBへ要求を送る前に拒否する', async () => {
  const p = mockPrinter();
  for (const value of ['', 'disable', 'status', 'toString', '__proto__']) {
    assert.throws(() => parsePaperSetMode(value), /mode must be/);
    await assert.rejects(setPaperSetHandle(p.io, value as 'off'), /mode must be/);
  }
  assert.equal(p.writes.length, 0);
});

test('用紙交換以外の実エラーでは設定を書き換えない', async () => {
  for (const options of [{ hardware: 1 }, { hardware: 4 }, { hardware: 8 }, { paper: 2 }, { paper: 4 }]) {
    const p = mockPrinter(options);
    await assert.rejects(setPaperSetHandle(p.io, 'off', true), /Printer error/);
    assert.equal(p.changes().length, 0);
    assert.equal(p.settings[4], 0xd8);
  }
});

test('他項目の読み戻し不一致やFLASH書き込み中を成功扱いせず、書き込みを再送しない', async () => {
  for (const options of [{ corrupt: true }, { flashBusy: true }]) {
    const p = mockPrinter(options);
    await assert.rejects(setPaperSetHandle(p.io, 'off', true), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Previous MS5: 0xd8/);
      assert.match((error.cause as Error).message, /readback|FLASH/);
      return true;
    });
    assert.equal(p.changes().length, 1);
  }
});

test('通信断や変更後の応答欠落は原因を保持し、再送や追加の設定変更をしない', async () => {
  for (const options of [{ writeFailure: true }, { readFailure: true }]) {
    const p = mockPrinter(options);
    await assert.rejects(setPaperSetHandle(p.io, 'off', true), /no automatic retry/);
    assert.equal(p.changes().length, 1);
    if ('writeFailure' in options) assert.equal(p.writes.at(-1)?.[1], 0x77);
  }
});
