#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { compileReceipt, compileImage, loadReceipt, compileMarkedReceipt, compileMarkedImage } from './src/receipt.ts';
import { makeSamples } from './src/samples.ts';
import { sendToPrinter, withPrinter } from './src/usb.ts';
import { paperLayout } from './src/paper.ts';
import { inspectBlackMark, feedToMark, markAlignmentBytes, markedJobBytes, printMarkedJob } from './src/black-mark.ts';
import type { MarkedJob } from './src/black-mark.ts';

const help = `Usage: node cli.ts <command> [file] [options]
Commands:
  status                 Read USB status without printing
  mark-status            Read black-mark sensor and mode (no paper movement)
  mark-feed              Align marked paper to print start (requires MS1-3 enabled)
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
  --black-mark           Use marked-paper positioning; receipt/image only
  --mark-offset-mm <mm>   Mark correction: positive forward, negative reverse; mark-feed/--black-mark
  --cut                  Cut after marked-paper positioning (requires --black-mark)
  --section <section>    samples: all (default) or japanese-qr
  --help                 Show this help`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'ignore-paper-status': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    output: { type: 'string' }, preview: { type: 'string' },
    'paper-width': { type: 'string' }, section: { type: 'string' },
    'black-mark': { type: 'boolean' }, cut: { type: 'boolean' },
    'mark-offset-mm': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const [command, file] = positionals;
  const needsFile = ['receipt', 'image', 'raw'].includes(command);
  if (!['status', 'mark-status', 'mark-feed', 'samples', 'receipt', 'image', 'raw'].includes(command)
      || positionals.length !== (needsFile ? 2 : 1)) throw new Error(help);
  for (const [option, valid] of [['preview', command === 'receipt'],
    ['paper-width', command === 'receipt' || command === 'image'],
    ['black-mark', command === 'receipt' || command === 'image'],
    ['mark-offset-mm', command === 'mark-feed' || Boolean(values['black-mark'])],
    ['cut', Boolean(values['black-mark'])],
    ['section', command === 'samples'], ['output', !['status', 'mark-status'].includes(command)]] as const) {
    if (values[option] !== undefined && !valid) throw new Error(`--${option} is not valid for ${command}`);
  }
  const paperWidth = Number(values['paper-width'] ?? 58);
  paperLayout(paperWidth);
  const offsetMm = values['mark-offset-mm'] === undefined ? undefined
    : values['mark-offset-mm'].trim() === '' ? NaN : Number(values['mark-offset-mm']);
  const alignment = markAlignmentBytes(offsetMm); // Validate before opening USB or writing files.
  if (command === 'status') {
    if (values['dry-run']) throw new Error('status requires a USB connection');
    return sendToPrinter(null, { statusOnly: true });
  }
  if (command === 'mark-status') {
    if (values['dry-run']) throw new Error('mark-status requires a USB connection');
    const status = await withPrinter(inspectBlackMark, { statusOnly: true });
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (command === 'mark-feed') {
    if (values.output) await writeFile(values.output, Buffer.concat([Buffer.from([0x1b, 0x40]), alignment]));
    if (values['dry-run'] || values.output) {
      console.log('Prepared marked-paper alignment; actual use requires marked paper and MS1-3 enabled');
      return;
    }
    await withPrinter(io => feedToMark(io, offsetMm), { ignorePaperStatus: values['ignore-paper-status'] });
    console.log('Marked-paper alignment completed; inspect the physical position.');
    return;
  }
  let payload: Buffer;
  let marked: MarkedJob | undefined;
  switch (command) {
    case 'samples': payload = makeSamples(values.section); break;
    case 'raw': payload = await readFile(file); break;
    case 'image':
      if (values['black-mark']) {
        marked = await compileMarkedImage(file, { paperWidth });
        payload = markedJobBytes(marked, values.cut, offsetMm);
      } else payload = await compileImage(file, { paperWidth });
      break;
    case 'receipt': {
      const document = await loadReceipt(file, { paperWidth });
      const options = { paperWidth };
      if (values['black-mark']) {
        marked = compileMarkedReceipt(document, options);
        payload = markedJobBytes(marked, values.cut, offsetMm);
      } else payload = compileReceipt(document, options);
      if (values.preview) await writeFile(values.preview, compileReceipt(document, { ...options, svg: true }));
      break;
    }
    default: throw new Error(help);
  }
  console.log(`Prepared ${payload.length} bytes (${command})`);
  if (values.output) await writeFile(values.output, payload);
  if (values['dry-run'] || values.output || values.preview) return;
  if (marked) {
    const job = marked;
    await withPrinter(io => printMarkedJob(io, job, values.cut, offsetMm),
      { ignorePaperStatus: values['ignore-paper-status'] });
    console.log('Marked-paper print stages completed; inspect the physical output.');
  } else await sendToPrinter(payload, { ignorePaperStatus: values['ignore-paper-status'] });
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  if (error.cause) console.error(`Cause: ${error.cause.message}`);
  process.exitCode = 1;
});
