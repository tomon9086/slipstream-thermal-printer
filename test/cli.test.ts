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
    ['raw', 'examples/demo.receipt', '--black-mark', '--dry-run']]) {
    const result = cli(...args);
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Connected'));
  }
});
