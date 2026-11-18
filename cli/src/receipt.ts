import receiptline from 'receiptline';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { paperLayout } from './paper.ts';
import type { MarkedJob } from './black-mark.ts';

// ローカル画像の参照を展開し、単独のPNG画像を用紙のレイアウトに収める。
// パスは原稿からの相対パスとし、呼び出し元の作業ディレクトリに依存させない。
export async function loadReceipt(file: string, { paperWidth = 58 }: { paperWidth?: number } = {}): Promise<string> {
  paperLayout(paperWidth);
  const document = await readFile(file, 'utf8');
  const lines = await Promise.all(document.split(/\r?\n/).map(async line => {
    const match = line.match(/^([ \t]*)\{(?:image|i):\s*([^}\r\n]+)\}([ \t]*)$/);
    if (!match) return line;
    const reference = match[2].trim();
    const source = reference.startsWith('@')
      ? await readFile(resolve(dirname(file), reference.slice(1)))
      : Buffer.from(reference, 'base64');
    const image = await prepareImage(source, paperWidth);
    return `${match[1]}{image:${image.toString('base64')}}${match[3]}`;
  }));
  return lines.join('\n');
}

export function printerOptions(paperWidth = 58): receiptline.Printer {
  const { cpl } = paperLayout(paperWidth);
  return { command: 'sii', encoding: 'shiftjis', cpl, spacing: true, cutting: true };
}

interface ReceiptOptions { paperWidth?: number; svg?: boolean }
export function compileReceipt(document: string, options?: ReceiptOptions & { svg?: false }): Buffer;
export function compileReceipt(document: string, options: ReceiptOptions & { svg: true }): string;
export function compileReceipt(document: string, { paperWidth = 58, svg = false }: ReceiptOptions = {}): Buffer | string {
  const options = printerOptions(paperWidth);
  if (svg) return receiptline.transform(document, { ...options, command: 'svg' });
  // ReceiptLineはバイナリー文字列を返す。UTF-8にするとコマンドや画像のバイト列が壊れる。
  return Buffer.from(receiptline.transform(document, options), 'latin1');
}

export async function prepareImage(path: string | Buffer, paperWidth = 58): Promise<Buffer> {
  const { dots } = paperLayout(paperWidth);
  const { data, info } = await sharp(path).autoOrient().flatten({ background: '#ffffff' })
    .resize({ width: dots, withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  if (info.height > 65535) throw new Error('Image is too tall');
  return data;
}

export async function compileImage(path: string | Buffer, { paperWidth = 58 }: { paperWidth?: number } = {}): Promise<Buffer> {
  const data = await prepareImage(path, paperWidth);
  const document = `{image:${data.toString('base64')}}`;
  const options = { ...printerOptions(paperWidth), gradient: true };
  return Buffer.from(receiptline.transform(document, options), 'latin1');
}

export function compileMarkedReceipt(document: string, { paperWidth = 58 }: { paperWidth?: number } = {}): MarkedJob {
  const base = receiptline.commands.sii;
  let setup: Buffer = Buffer.alloc(0);
  const command: receiptline.BaseCommand = {
    ...base,
    open(printer) {
      setup = Buffer.from(base.open.call(this, printer), 'latin1');
      return '';
    },
    close() { return ''; },
    // 原稿内の「=」によるカット指定も無効にする。
    cut() { return ''; },
  };
  const body = Buffer.from(receiptline.transform(document,
    { ...printerOptions(paperWidth), cutting: false, command }), 'latin1');
  return { setup, body };
}

export async function compileMarkedImage(path: string | Buffer, { paperWidth = 58 }: { paperWidth?: number } = {}): Promise<MarkedJob> {
  const data = await prepareImage(path, paperWidth);
  return compileMarkedReceipt(`{image:${data.toString('base64')}}`, { paperWidth });
}
