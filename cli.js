#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { HELLO, compileReceipt, compileImage } from './src/receipt.js';
import { makeSamples } from './src/samples.js';
import { sendToPrinter } from './src/usb.js';

const help = `Usage: node cli.js <command> [file] [options]
Commands:
  status                 Read USB status without printing
  hello                  Print Hello, World!
  samples                Print font, Japanese, and native QR samples
  receipt <file>         Print a UTF-8 ReceiptLine document
  image <file>           Resize, flatten transparency, and print an image
  raw <file>             Send an existing ESC/POS binary once
Options:
  --ignore-paper-status  Allow the observed 0x20 paper bit (check paper first)
  --dry-run              Build data without opening USB
  --output <file>        Save binary data without printing
  --preview <file.svg>   Save a ReceiptLine SVG preview without printing
  --cpl <number>         Receipt width in half-width characters (default 30)
  --width <dots>         Image width (default 360; multiple of 8, up to 432)
  --section <section>    samples: all (default) or japanese-qr
  --help                 Show this help`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'ignore-paper-status': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    output: { type: 'string' }, preview: { type: 'string' },
    cpl: { type: 'string' }, width: { type: 'string' }, section: { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const [command, file] = positionals;
  const needsFile = ['receipt', 'image', 'raw'].includes(command);
  if (!['status', 'hello', 'samples', 'receipt', 'image', 'raw'].includes(command)
      || positionals.length !== (needsFile ? 2 : 1)) throw new Error(help);
  for (const [option, valid] of [['preview', command === 'receipt'], ['cpl', command === 'receipt'],
    ['width', command === 'image'], ['section', command === 'samples'], ['output', command !== 'status']]) {
    if (values[option] !== undefined && !valid) throw new Error(`--${option} is not valid for ${command}`);
  }
  if (command === 'status') {
    if (values['dry-run']) throw new Error('status requires a USB connection');
    return sendToPrinter(null, { statusOnly: true });
  }
  let payload;
  switch (command) {
    case 'hello': payload = HELLO; break;
    case 'samples': payload = makeSamples(values.section); break;
    case 'raw': payload = await readFile(file); break;
    case 'image': payload = await compileImage(file, { width: Number(values.width ?? 360) }); break;
    case 'receipt': {
      const document = await readFile(file, 'utf8');
      const options = { cpl: Number(values.cpl ?? 30) };
      payload = compileReceipt(document, options);
      if (values.preview) await writeFile(values.preview, compileReceipt(document, { ...options, svg: true }));
      break;
    }
  }
  console.log(`Prepared ${payload.length} bytes (${command})`);
  if (values.output) await writeFile(values.output, payload);
  if (values['dry-run'] || values.output || values.preview) return;
  await sendToPrinter(payload, { ignorePaperStatus: values['ignore-paper-status'] });
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  if (error.cause) console.error(`Cause: ${error.cause.message}`);
  process.exitCode = 1;
});
