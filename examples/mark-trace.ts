#!/usr/bin/env node
// Live ruler: print seven raster rows, feed one dot, settle, then read the sensor.
import { parseArgs } from 'node:util';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { SiiClient, markCorrectionBytes } from '../src/black-mark.ts';
import { paperLayout } from '../src/paper.ts';
import { withPrinter } from '../src/usb.ts';
import type { PrinterIO } from '../src/usb.ts';

type Cut = 'none' | 'current' | 'mark';
export interface TraceReport {
  id: string;
  paperWidth: number;
  length: number;
  cut: Cut;
  offset: number;
  simulated: boolean;
  samples: { mm: number; markDetected: boolean; sensors: number }[];
  cutExecuted: boolean;
  restored?: boolean;
  originalSettings?: string;
  restoredSettings?: string;
}

const help = `Usage: pnpm run mark-trace [options]
  --preview <file.svg>  Simulate sensor readings and save SVG without USB
  --dry-run             Simulate without USB
  --paper-width <mm>    58 (default) or 80; temporarily configure the printer
  --length <mm>         Maximum trace length, integer 1..150 (default 75)
  --cut <mode>          none (default), current, or mark
  --mark-offset <mm>    Correction after GS FF; requires --cut=mark (default 0)
  --record <directory>  Save live report.json and trace.svg (default: temporary directory)
  --ignore-paper-status  Allow the observed USB paper-status bit
  --help                Show this help
With --cut=mark, stop after one black band, then feed to the marked cut position.
Live runs temporarily enable mark mode and restore all changed settings without FLASH writes.`;

// Five-by-seven digits, doubled for a readable ruler label every 10mm.
const digits = ['01110100011001110101110011000101110', '00100011000010000100001000010001110',
  '01110100010000100010001000100011111', '11110000010000101110000010000111110',
  '00010001100101010010111110001000010', '11111100001000011110000010000111110',
  '01110100001000011110100011000101110', '11111000010001000100010000100001000',
  '01110100011000101110100011000101110', '01110100011000101111000010000101110'];

export function traceStrip(mm: number, marked: boolean, paperWidth: number): Buffer {
  const stride = paperLayout(paperWidth).dots / 8;
  const data = Buffer.alloc(stride * 8);
  const pixel = (x: number, y: number) => { data[y * stride + (x >> 3)] |= 0x80 >> (x & 7); };
  for (let y = 0; y < 7; y++) {
    for (let x = 96; x < 100; x++) pixel(x, y);
    if (marked) for (let x = 120; x < 124; x++) pixel(x, y);
    if (y === 0) for (let x = mm % 10 === 0 ? 48 : mm % 5 === 0 ? 64 : 80; x < 92; x++) pixel(x, y);
    const labelY = (mm % 10) * 8 + y;
    if (labelY < 14) {
      const label = String(Math.floor(mm / 10) * 10).padStart(2, '0');
      for (let n = 0; n < label.length; n++) for (let x = 0; x < 10; x++) {
        if (digits[Number(label[n])][Math.floor(labelY / 2) * 5 + Math.floor(x / 2)] === '1') pixel(8 + n * 12 + x, y);
      }
    }
  }
  return data; // Last row is the one-dot normal feed, not another printed raster row.
}

function header(report: TraceReport): string[] {
  const offset = `${report.offset >= 0 ? '+' : ''}${report.offset}mm`;
  return [`TRACE ${report.id} ${offset}`, `1=PAPER 2=MARK CUT=${report.cut}`];
}

export function traceSvg(report: TraceReport): string {
  const { dots } = paperLayout(report.paperWidth);
  const rectangles: string[] = [];
  for (const sample of report.samples) {
    const data = traceStrip(sample.mm, sample.markDetected, report.paperWidth);
    for (let y = 0; y < 8; y++) {
      let start = -1;
      for (let x = 0; x <= dots; x++) {
        const black = x < dots && (data[y * dots / 8 + (x >> 3)] & (0x80 >> (x & 7)));
        if (black && start < 0) start = x;
        if (!black && start >= 0) {
          rectangles.push(`<rect x="${start}" y="${48 + sample.mm * 8 + y}" width="${x - start}" height="1"/>`);
          start = -1;
        }
      }
    }
  }
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const title = report.simulated ? ['SIMULATED 1=PAPER 2=MARK', header(report)[0]] : header(report);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dots}" height="${48 + report.samples.length * 8}">`
    + '<rect width="100%" height="100%" fill="white"/>'
    + title.map((line, i) => `<text x="0" y="${18 + i * 24}" font-family="monospace" font-size="20">${escape(line)}</text>`).join('')
    + `<g fill="black">${rectangles.join('')}</g></svg>`;
}

function validate(report: TraceReport) {
  paperLayout(report.paperWidth);
  if (!Number.isInteger(report.length) || report.length < 1 || report.length > 150) throw new Error('--length must be 1..150 (mm)');
  if (!['none', 'current', 'mark'].includes(report.cut)) throw new Error('--cut must be none, current, or mark');
  markCorrectionBytes(report.offset);
  if (report.offset !== 0 && report.cut !== 'mark') throw new Error('--mark-offset requires --cut=mark');
}

export async function printTrace(io: PrinterIO, report: TraceReport, log: (text: string) => void = console.log) {
  validate(report);
  let writeFailed = false;
  const session: PrinterIO = { read: timeout => io.read(timeout), async write(data) {
    try { await io.write(data); } catch (error) { writeFailed = true; throw error; }
  } };
  const client = new SiiClient(session);
  const state = async () => {
    await client.assertReady();
    const sensors = await client.status(8);
    if (sensors & 3) throw new Error('Paper missing or cover open; stopped');
    return { sensors, markDetected: Boolean(sensors & 8) };
  };
  await client.synchronize();
  const original = await client.settings();
  report.originalSettings = original.toString('hex');
  await state();
  await client.execute(Buffer.from([0x1b, 0x40])); // Initialize before applying temporary settings.
  const ms4 = (original[3] & ~0x18) | (report.paperWidth === 80 ? 0x18 : 0);
  const changes = [[4, ms4], [1, original[0] | 4], ...(report.cut === 'mark' ? [[11, 0], [10, 100]] : [])];
  const attempted: number[] = [];
  const setting = (index: number, value: number) => Buffer.from([0x12, 0x77, index, value, 0]);
  let failure: unknown;
  try {
    const expected = Buffer.from(original);
    for (const [index, value] of changes) {
      attempted.push(index);
      await client.execute(setting(index, value));
      expected[index - 1] = value;
    }
    if (!(await client.settings()).equals(expected)) throw new Error('Temporary settings verification failed');
    const { dots } = paperLayout(report.paperWidth);
    const stride = dots / 8;
    await client.execute(Buffer.concat([Buffer.from([0x1b, 0x33, 24, 0x1d, 0x50, 0, 203,
      0x12, 0x49, 1, 0x12, 0x3d, 1, 0x1d, 0x4c, 0, 0, 0x1d, 0x57, dots & 255, dots >> 8]),
    Buffer.from(header(report).join('\n') + '\n', 'ascii')]));
    let sawMark = false;
    for (let mm = 0; mm < report.length; mm++) {
      const sample = { mm, ...await state() };
      log(JSON.stringify(sample));
      sawMark ||= sample.markDetected;
      await client.execute(Buffer.concat([Buffer.from([0x1d, 0x76, 0x30, 0, stride, 0, 7, 0]),
        traceStrip(mm, sample.markDetected, report.paperWidth).subarray(0, stride * 7), Buffer.from([0x1b, 0x4a, 1])]));
      report.samples.push(sample);
      await pause(20);
      if (report.cut === 'mark' && sawMark && !sample.markDetected) break;
    }
    await state();
    if (report.cut === 'mark') {
      if (!sawMark) throw new Error('No mark found; no form-feed or cut sent');
      attempted.push(8, 9); // Restore the temporary correction even if it is absent from MS readback.
      await client.execute(Buffer.concat([Buffer.from([0x1d, 0x0c]), markCorrectionBytes(report.offset)]));
      await state();
    }
    if (report.cut !== 'none') {
      await client.execute(Buffer.from([0x1d, 0x56, 1]));
      report.cutExecuted = true;
      await state();
    }
  } catch (error) { failure = error; throw error; }
  finally {
    if (writeFailed) throw new Error('USB write failed; stopped without restoration commands. Power-cycle to restore saved settings', { cause: failure });
    try {
      for (const index of [...new Set(attempted.reverse())]) await client.execute(setting(index, original[index - 1]));
      const restored = await client.settings();
      report.restoredSettings = restored.toString('hex');
      report.restored = restored.equals(original);
      if (!report.restored) throw new Error('Settings did not match the original 40 bytes');
    } catch (error) {
      throw new Error('Could not restore settings; power-cycle the printer',
        { cause: failure === undefined ? error : new AggregateError([failure, error], 'Trace and restoration failed') });
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    preview: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'paper-width': { type: 'string', default: '58' },
    length: { type: 'string', default: '75' }, cut: { type: 'string', default: 'none' },
    'mark-offset': { type: 'string', default: '0' }, record: { type: 'string' },
    'ignore-paper-status': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const simulated = Boolean(values.preview || values['dry-run']);
  const report: TraceReport = {
    id: simulated ? 'PREVIEW' : new Date().toISOString().replace(/\D/g, '').slice(2, 14),
    paperWidth: Number(values['paper-width']), length: Number(values.length), cut: values.cut as Cut,
    offset: values['mark-offset'].trim() === '' ? NaN : Number(values['mark-offset']),
    simulated, samples: [], cutExecuted: false,
  };
  validate(report);
  if (simulated) {
    let sawMark = false;
    for (let mm = 0; mm < report.length; mm++) {
      const markDetected = mm % 50 >= 34 && mm % 50 < 41;
      report.samples.push({ mm, markDetected, sensors: markDetected ? 8 : 0 });
      sawMark ||= markDetected;
      if (report.cut === 'mark' && sawMark && !markDetected) break;
    }
    if (values.preview) await writeFile(values.preview, traceSvg(report));
    console.log(`SIMULATED sensor data: ${report.samples.length}mm; no USB connection.`);
    return;
  }
  const directory = values.record ?? await mkdtemp(join(tmpdir(), 'slipstream-mark-trace-'));
  if (values.record) await mkdir(directory, { recursive: true });
  else await chmod(directory, 0o755); // Make artifacts readable when USB access requires sudo.
  try {
    await withPrinter(io => printTrace(io, report), { ignorePaperStatus: values['ignore-paper-status'] });
  } finally {
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(directory, 'trace.svg'), traceSvg(report));
    console.log(`Run ${report.id}: results saved to ${directory}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    if (error.cause) console.error(`Cause: ${error.cause.message}`);
    process.exitCode = 1;
  });
}
