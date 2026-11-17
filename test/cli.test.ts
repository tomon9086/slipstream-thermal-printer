import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function cli(...args: string[]) {
  return spawnSync(process.execPath, ['cli.ts', ...args], { cwd: root, encoding: 'utf8' });
}

test('CLI accepts both paper widths and uses them in saved previews without USB access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [paperWidth, dots] of [[58, 360], [80, 576]]) {
    const output = join(directory, `${paperWidth}.svg`);
    const result = cli('receipt', 'examples/demo.receipt', `--paper-width=${paperWidth}`, '--preview', output);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await readFile(output, 'utf8')).includes(`width="${dots}px"`));
    assert.ok(!result.stdout.includes('Connected'));
  }
});

test('CLI rejects unsupported paper widths and does not silently accept obsolete width options', () => {
  for (const option of ['--paper-width=60', '--cpl=30', '--width=360']) {
    const result = cli('receipt', 'examples/demo.receipt', option, '--dry-run');
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Connected'));
  }
  assert.equal(cli('samples', '--paper-width=80', '--dry-run').status, 1);
});

test('black-mark CLI supports feed dry-run and marked receipt/image export without USB access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-mark-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feed = cli('mark-feed', '--dry-run');
  assert.equal(feed.status, 0, feed.stderr);
  assert.ok(!feed.stdout.includes('Connected'));
  for (const [command, file] of [['receipt', 'examples/mark-test.receipt'], ['image', 'examples/assets/slipstream-shop.png']]) {
    const output = join(directory, `${command}.bin`);
    const result = cli(command, file, '--black-mark', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('Connected'));
    const bytes = await readFile(output);
    assert.deepEqual(bytes.subarray(-2), Buffer.from([0x1d, 0x0c]));
  }
  const svg = join(directory, 'preview.svg');
  assert.equal(cli('receipt', 'examples/mark-test.receipt', '--black-mark', '--preview', svg).status, 0);
  assert.match(await readFile(svg, 'utf8'), /<svg/);
});

test('invalid mark options fail before connecting', () => {
  for (const args of [['mark-status', '--dry-run'], ['receipt', 'examples/demo.receipt', '--cut', '--dry-run'],
    ['raw', 'examples/demo.receipt', '--black-mark', '--dry-run'],
    ['receipt', 'examples/demo.receipt', '--mark-offset-mm=3', '--dry-run'],
    ['status', '--mark-offset-mm=3'], ['samples', '--mark-offset-mm=3', '--dry-run'],
    ...['', 'abc', 'NaN', 'Infinity', '-9.251', '31.876'].map(value => ['mark-feed', `--mark-offset-mm=${value}`, '--dry-run'])]) {
    const result = cli(...args);
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Connected'));
  }
});

test('mark-feed accepts paper width for actual positioning without USB access during export', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-feed-width-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const width of [58, 80]) {
    const output = join(directory, `${width}.bin`);
    const result = cli('mark-feed', `--paper-width=${width}`, '--output', output);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('Connected'));
    assert.deepEqual(await readFile(output), Buffer.from([0x1b, 0x40, 0x1d, 0x3c]));
  }
});

test('CLI exports forward/reverse/zero correction for feed, receipt and image without USB', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-offset-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mm of [-3, 0, 3]) {
    for (const args of [['mark-feed'], ['receipt', 'examples/mark-test.receipt', '--black-mark'],
      ['image', 'examples/assets/slipstream-shop.png', '--black-mark']]) {
      const output = join(directory, `${args[0]}-${mm}.bin`);
      const result = cli(...args, `--mark-offset-mm=${mm}`, '--output', output);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes('Connected'));
      const bytes = await readFile(output);
      assert.ok(bytes.includes(Buffer.from([0x1d, 0x50, 0, 203, 0x1d, 0x3c, 0x1d, 0x41, mm < 0 ? 1 : 0, Math.abs(mm) * 8])));
      if (args[0] === 'mark-feed') assert.equal(bytes.length, 12);
      else assert.deepEqual(bytes.subarray(-2), Buffer.from([0x1d, 0x0c]));
    }
  }
});
