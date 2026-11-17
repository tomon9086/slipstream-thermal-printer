import receiptline from 'receiptline';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const HELLO = Buffer.from('1b4048656c6c6f2c20576f726c64210a0a0a0a0a1d5601', 'hex');

// Local extension: expand standalone {image:@path.png} lines before ReceiptLine.
// Paths are relative to the document, independent of the caller's working directory.
export async function loadReceipt(file: string): Promise<string> {
  const document = await readFile(file, 'utf8');
  const lines = await Promise.all(document.split(/\r?\n/).map(async line => {
    const match = line.match(/^([ \t]*)\{image:\s*@([^}\r\n]+)\}([ \t]*)$/);
    if (!match) return line;
    const image = await readFile(resolve(dirname(file), match[2].trim()));
    return `${match[1]}{image:${image.toString('base64')}}${match[3]}`;
  }));
  return lines.join('\n');
}

export function printerOptions(cpl = 30): receiptline.Printer {
  if (!Number.isInteger(cpl) || cpl < 1 || cpl > 36) {
    throw new Error('cpl must be an integer from 1 to 36 for this 58mm printer');
  }
  return { command: 'sii', encoding: 'shiftjis', cpl, spacing: true, cutting: true };
}

interface ReceiptOptions { cpl?: number; svg?: boolean }
export function compileReceipt(document: string, options?: ReceiptOptions & { svg?: false }): Buffer;
export function compileReceipt(document: string, options: ReceiptOptions & { svg: true }): string;
export function compileReceipt(document: string, { cpl = 30, svg = false }: ReceiptOptions = {}): Buffer | string {
  const options = printerOptions(cpl);
  if (svg) return receiptline.transform(document, { ...options, command: 'svg' });
  // ReceiptLine returns a binary string, not UTF-8. UTF-8 corrupts command/image bytes.
  return Buffer.from(receiptline.transform(document, options), 'latin1');
}

export async function compileImage(path: string | Buffer, { width = 360 }: { width?: number } = {}): Promise<Buffer> {
  if (!Number.isInteger(width) || width < 8 || width > 432 || width % 8) {
    throw new Error('width must be a multiple of 8 from 8 to 432 for 58mm paper');
  }
  const { data, info } = await sharp(path).autoOrient().flatten({ background: '#ffffff' })
    .resize({ width }).png().toBuffer({ resolveWithObject: true });
  if (info.height > 65535) throw new Error('Image is too tall');
  const document = `{image:${data.toString('base64')}}`;
  const options = { ...printerOptions(), cpl: Math.ceil(width / 12), gradient: true };
  return Buffer.from(receiptline.transform(document, options), 'latin1');
}
