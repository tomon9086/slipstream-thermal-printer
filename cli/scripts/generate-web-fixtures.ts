import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeSamples } from '../src/samples.ts';
import { compileReceipt, loadReceipt } from '../src/receipt.ts';

const directory = new URL('../../web/public/fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
const demo = await loadReceipt(fileURLToPath(new URL('../../examples/demo.receipt', import.meta.url)));
const fixtures = { 'japanese-qr': makeSamples('japanese-qr'), demo: compileReceipt(demo) };
const manifest = Object.fromEntries(await Promise.all(Object.entries(fixtures).map(async ([name, bytes]) => {
  await writeFile(new URL(`${name}.bin`, directory), bytes);
  return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
})));
await writeFile(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest);
