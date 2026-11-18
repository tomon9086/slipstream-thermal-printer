import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { printTrace, traceSvg } from '../examples/mark-trace.ts';
import type { TraceReport } from '../examples/mark-trace.ts';
import type { PrinterIO } from '../src/usb.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
function report(options: Partial<TraceReport> = {}): TraceReport {
  return { id: 'TEST', paperWidth: 58, length: 8, cut: 'none', offset: 0,
    simulated: false, samples: [], cutExecuted: false, ...options };
}

function printer({ marks = [false, true, true, false], failStep = 0, timeoutStep = 0, failFormFeed = false } = {}) {
  const settings = Buffer.alloc(40, 0xff);
  settings[0] = 0xfb;
  settings[7] = settings[8] = 0;
  settings.writeUInt16LE(300, 9);
  const original = Buffer.from(settings);
  let queue: Buffer = Buffer.alloc(0);
  let step = 0, errors = 0;
  const stages: Buffer[] = [];
  const writes: Buffer[] = [];
  const io: PrinterIO = {
    async write(data) {
      writes.push(Buffer.from(data));
      let reply: Buffer;
      if (data.equals(Buffer.from([0x12, 0x6c, 0]))) {
        reply = Buffer.from([14, ...[...settings].flatMap(byte => [0xe0 | (byte & 15), 0xf0 | (byte >> 4)]), 0]);
      } else if (data[0] === 0x1d && data[1] === 0x72) {
        reply = Buffer.from([0xa0 | (data[2] === 1 ? errors : data[2] === 8 && (settings[0] & 4) && marks[step] ? 8 : 0)]);
      } else {
        assert.deepEqual(data.subarray(-3, -1), Buffer.from([0x12, 0x71]));
        const body = Buffer.from(data.subarray(0, -3));
        stages.push(body);
        if (body[0] === 0x12 && body[1] === 0x77) {
          assert.ok([1, 4, 8, 9, 10, 11].includes(body[2])); // No FLASH-setting selectors.
          assert.equal(body[4], 0);
          settings[body[2] - 1] = body[3];
          assert.ok(settings.readUInt16LE(9) <= 300); // Changing 300mm to 100mm must not pass through 356mm.
        }
        if (body[0] === 0x1d && body[1] === 0x76) {
          step++;
          if (step === failStep) throw new Error('USB disconnected');
          if (step === timeoutStep) return;
        }
        if (body[0] === 0x1d && body[1] === 0x0c && failFormFeed) errors = 4;
        reply = Buffer.from([0x80 | data.at(-1)!]);
      }
      queue = Buffer.concat([queue, reply]);
    },
    async read(timeout) {
      assert.ok(timeout !== undefined && timeout > 0 && timeout <= 5000);
      if (!queue.length) throw new Error('LIBUSB_ERROR_TIMEOUT');
      const chunk = queue.subarray(0, 3);
      queue = queue.subarray(chunk.length);
      return chunk;
    },
  };
  return { io, stages, writes, settings, original };
}

test('live trace uses sensor values for the second rail and keeps FF/correction adjacent before cutting', async () => {
  const p = printer();
  const run = report({ cut: 'mark', offset: 3 });
  await printTrace(p.io, run, () => {});
  assert.deepEqual(run.samples.map(sample => sample.markDetected), [false, true, true, false]);
  const steps = p.stages.filter(data => data[0] === 0x1d && data[1] === 0x76);
  for (const [index, step] of steps.entries()) {
    assert.deepEqual(step.subarray(0, 8), Buffer.from([0x1d, 0x76, 0x30, 0, 45, 0, 7, 0]));
    assert.deepEqual(step.subarray(-3), Buffer.from([0x1b, 0x4a, 1]));
    assert.equal(step[8 + 12], 0xf0);
    assert.equal(step[8 + 15], index === 1 || index === 2 ? 0xf0 : 0);
  }
  const feed = p.stages.findIndex(data => data[0] === 0x1d && data[1] === 0x0c);
  assert.deepEqual(p.stages[feed], Buffer.from([0x1d, 0x0c, 0x1d, 0x41, 0, 24]));
  assert.deepEqual(p.stages[feed + 1], Buffer.from([0x1d, 0x56, 1]));
  assert.ok(p.stages.some(data => data.includes(Buffer.from('TRACE TEST +3mm'))));
  assert.ok(run.cutExecuted && run.restored);
  assert.deepEqual(p.settings, p.original);
  assert.equal(run.originalSettings, run.restoredSettings);
  const svg = traceSvg(run);
  assert.match(svg, /TRACE TEST \+3mm/);
  assert.ok(svg.includes('<rect x="120" y="56"'));
  assert.ok(!svg.includes('<rect x="120" y="48"'));
});

test('none/current cut modes complete the requested length and preserve the paper settings', async () => {
  for (const cut of ['none', 'current'] as const) {
    const p = printer();
    const run = report({ cut, paperWidth: 80, length: 5 });
    await printTrace(p.io, run, () => {});
    assert.equal(run.samples.length, 5);
    assert.equal(run.cutExecuted, cut === 'current');
    assert.ok(!p.stages.some(data => data[0] === 0x1d && data[1] === 0x0c));
    const step = p.stages.find(data => data[0] === 0x1d && data[1] === 0x76)!;
    assert.equal(step[4], 72);
    assert.deepEqual(p.settings, p.original);
  }
});

test('missing marks and mark-search errors stop before subsequent feed or cut and restore settings', async () => {
  for (const fixture of [{ marks: [false, false] }, { failFormFeed: true }]) {
    const p = printer(fixture);
    const run = report({ cut: 'mark', length: 5 });
    await assert.rejects(printTrace(p.io, run, () => {}), /No mark found|mark-search paper jam/);
    assert.ok(!p.stages.some(data => data[0] === 0x1d && data[1] === 0x56));
    if (!fixture.failFormFeed) assert.ok(!p.stages.some(data => data[0] === 0x1d && data[1] === 0x0c));
    assert.deepEqual(p.settings, p.original);
    assert.equal(run.restored, true);
  }
});

test('failed writes stop every later command; missing completion restores settings without retrying a strip', async () => {
  const p = printer({ failStep: 2 });
  const run = report({ cut: 'mark' });
  await assert.rejects(printTrace(p.io, run, () => {}), /USB write failed/);
  assert.equal(run.samples.length, 1);
  assert.ok(p.writes.at(-1)!.subarray(0, 2).equals(Buffer.from([0x1d, 0x76])));
  const q = printer({ timeoutStep: 2 });
  const other = report({ cut: 'mark' });
  await assert.rejects(printTrace(q.io, other, () => {}), /response failed/);
  assert.equal(q.stages.filter(data => data[0] === 0x1d && data[1] === 0x76).length, 2);
  assert.ok(!q.stages.some(data => data[0] === 0x1d && [0x0c, 0x56].includes(data[1])));
  assert.deepEqual(q.settings, q.original);
});

test('trace preview and argument validation never require USB', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-trace-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const width of [58, 80]) {
    const file = join(directory, `${width}.svg`);
    const result = spawnSync(process.execPath, ['examples/mark-trace.ts', `--paper-width=${width}`,
      '--cut=mark', '--mark-offset=3', '--preview', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SIMULATED/);
    assert.ok(!result.stdout.includes('Connected'));
    const svg = await readFile(file, 'utf8');
    assert.match(svg, /SIMULATED/);
    assert.match(svg, /TRACE PREVIEW \+3mm/);
    assert.ok(svg.includes(`width="${width === 58 ? 360 : 576}"`));
    assert.ok(svg.includes('<rect x="120"'));
  }
  for (const args of [['--cut=unknown'], ['--length=0'], ['--length=151'], ['--paper-width=60'],
    ['--mark-offset=3'], ['--cut=mark', '--mark-offset=Infinity']]) {
    const result = spawnSync(process.execPath, ['examples/mark-trace.ts', ...args, '--dry-run'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Connected'));
  }
  const p = printer();
  await assert.rejects(printTrace(p.io, report({ length: 0 }), () => {}), /length/);
  assert.equal(p.writes.length, 0);
});
