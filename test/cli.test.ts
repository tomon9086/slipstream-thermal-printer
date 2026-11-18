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

test('CLIは両方の紙幅に対応し、USBに接続せず指定幅でプレビューを保存する', async t => {
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

test('CLIは非対応の紙幅と廃止した紙幅オプションを拒否する', () => {
  for (const option of ['--paper-width=60', '--cpl=30', '--width=360']) {
    const result = cli('receipt', 'examples/demo.receipt', option, '--dry-run');
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Connected'));
  }
  assert.equal(cli('samples', '--paper-width=80', '--dry-run').status, 1);
});

test('ブラックマークCLIはUSBに接続せず送りのドライランと原稿・画像の書き出しができる', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-mark-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feed = cli('mark-feed', '--dry-run');
  assert.equal(feed.status, 0, feed.stderr);
  assert.ok(!feed.stdout.includes('Connected'));
  for (const [command, file] of [['receipt', 'test/fixtures/short.receipt'], ['image', 'examples/assets/slipstream-shop.png']]) {
    const output = join(directory, `${command}.bin`);
    const result = cli(command, file, '--black-mark', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('Connected'));
    const bytes = await readFile(output);
    assert.deepEqual(bytes.subarray(-2), Buffer.from([0x1d, 0x0c]));
  }
  const svg = join(directory, 'preview.svg');
  assert.equal(cli('receipt', 'test/fixtures/short.receipt', '--black-mark', '--preview', svg).status, 0);
  assert.match(await readFile(svg, 'utf8'), /<svg/);
});

test('不正なマークオプションは接続前にエラーにする', () => {
  for (const args of [['mark-status', '--dry-run'],
    ['raw', 'examples/demo.receipt', '--black-mark', '--dry-run'],
    ['receipt', 'examples/demo.receipt', '--mark-offset=3', '--dry-run'],
    ['status', '--mark-offset=3'], ['samples', '--mark-offset=3', '--dry-run'],
    ...['', 'abc', 'NaN', 'Infinity', '-9.251', '31.876'].map(value => ['mark-feed', `--mark-offset=${value}`, '--dry-run'])]) {
    const result = cli(...args);
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('Connected'));
  }
});

test('通常印刷のcut指定は既定と同じデータを生成し、マーク印刷では位置合わせ後のカットだけを追加する', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-cut-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [command, file] of [['receipt', 'test/fixtures/short.receipt'], ['image', 'examples/assets/slipstream-shop.png']]) {
    for (const marked of [false, true]) {
      const payloads: Buffer[] = [];
      for (const cut of [false, true]) {
        const output = join(directory, `${command}-${marked}-${cut}.bin`);
        const result = cli(command, file, ...(marked ? ['--black-mark'] : []), ...(cut ? ['--cut'] : []), '--output', output);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(!result.stdout.includes('Connected'));
        payloads.push(await readFile(output));
      }
      if (marked) {
        assert.deepEqual(payloads[0].subarray(-2), Buffer.from([0x1d, 0x0c]));
        assert.deepEqual(payloads[1], Buffer.concat([payloads[0], Buffer.from([0x1d, 0x56, 1])]));
      } else {
        assert.deepEqual(payloads[1], payloads[0]);
        assert.ok(payloads[0].includes(Buffer.from([0x1d, 0x56, 0x42, 0])));
      }
    }
  }
  for (const args of [['status'], ['mark-status'], ['mark-feed'], ['samples'], ['raw', 'test/fixtures/short.receipt']]) {
    const result = cli(...args, '--cut', '--dry-run');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--cut is not valid/);
    assert.ok(!result.stdout.includes('Connected'));
  }
});

test('mark-feedは位置合わせ用の紙幅を受け取り、書き出し時はUSBに接続しない', async t => {
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

test('CLIはUSBに接続せず、送り・原稿・画像の順送り・逆送り・ゼロ補正を書き出せる', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'slipstream-offset-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mm of [-3, 0, 3]) {
    for (const args of [['mark-feed'], ['receipt', 'test/fixtures/short.receipt', '--black-mark'],
      ['image', 'examples/assets/slipstream-shop.png', '--black-mark']]) {
      const output = join(directory, `${args[0]}-${mm}.bin`);
      const result = cli(...args, `--mark-offset=${mm}`, '--output', output);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes('Connected'));
      const bytes = await readFile(output);
      assert.ok(bytes.includes(Buffer.from([0x1d, 0x50, 0, 203, 0x1d, 0x3c, 0x1d, 0x41, mm < 0 ? 1 : 0, Math.abs(mm) * 8])));
      if (args[0] === 'mark-feed') assert.equal(bytes.length, 12);
      else assert.deepEqual(bytes.subarray(-2), Buffer.from([0x1d, 0x0c]));
    }
  }
});
