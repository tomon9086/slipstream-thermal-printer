#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { compileReceipt, compileImage, loadReceipt } from './src/receipt.ts';
import { makeSamples } from './src/samples.ts';
import { sendToPrinter } from './src/usb.ts';
import { paperLayout } from './src/paper.ts';

const help = `Usage: pnpm run print <command> [file] [options] (from repository root)
Commands:
  status                 Read USB status without printing
  samples                Print font, Japanese, and native QR samples
  receipt <file>         Print a UTF-8 ReceiptLine document
  image <file>           Resize, flatten transparency, and print an image
  raw <file>             Send an existing ESC/POS binary once
Options:
  --ignore-paper-status  Allow the observed 0x20 paper bit (check paper first)
  --dry-run              Build data without opening USB
  --output <file>        Save binary data without printing
  --preview <file.svg>   Save a ReceiptLine SVG preview without printing
  --paper-width <mm>     Paper width: 58 (default) or 80; receipt/image only
  --section <section>    samples: all (default) or japanese-qr
  --help                 Show this help`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'ignore-paper-status': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    output: { type: 'string' }, preview: { type: 'string' },
    'paper-width': { type: 'string' }, section: { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const [command, file] = positionals;
  const needsFile = ['receipt', 'image', 'raw'].includes(command);
  if (!['status', 'samples', 'receipt', 'image', 'raw'].includes(command)
      || positionals.length !== (needsFile ? 2 : 1)) throw new Error(help);
  for (const [option, valid] of [['preview', command === 'receipt'],
    ['paper-width', command === 'receipt' || command === 'image'],
    ['section', command === 'samples'], ['output', command !== 'status']] as const) {
    if (values[option] !== undefined && !valid) throw new Error(`--${option} is not valid for ${command}`);
  }
  const paperWidth = Number(values['paper-width'] ?? 58);
  paperLayout(paperWidth);
  if (command === 'status') {
    if (values['dry-run']) throw new Error('status requires a USB connection');
    return sendToPrinter(null, { statusOnly: true });
  }
  let payload: Buffer;
  switch (command) {
    case 'samples': payload = makeSamples(values.section); break;
    case 'raw': payload = await readFile(file); break;
    case 'image': payload = await compileImage(file, { paperWidth }); break;
    case 'receipt': {
      const document = await loadReceipt(file, { paperWidth });
      const options = { paperWidth };
      payload = compileReceipt(document, options);
      if (values.preview) await writeFile(values.preview, compileReceipt(document, { ...options, svg: true }));
      break;
    }
    default: throw new Error(help);
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
