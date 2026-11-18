import receiptline from 'receiptline';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { paperLayout } from './paper.ts';

// 原稿内の画像参照を展開し、PNG画像を選択した印字幅に収める。
// 参照パスは実行時の作業ディレクトリではなく、原稿ファイルを基準に解決する。
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
  // ReceiptLineの出力はバイナリー文字列。UTF-8変換によるコマンド・画像の破損を防ぐ。
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
