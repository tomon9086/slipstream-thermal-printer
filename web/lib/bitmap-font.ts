export const bitmapFontUrl = '/fonts/unifont_jp-18.0.01.bdf.gz';
export type BitmapGlyph = { width: number; rows: Uint16Array };
export type BitmapFont = Map<number, BitmapGlyph>;

let pendingFont: Promise<BitmapFont> | undefined;

// 同梱した16ドットBDFだけを扱い、別形式を誤って描画しない。
function parseFont(source: string): BitmapFont {
  if (!source.startsWith('STARTFONT 2.1\n') || !source.includes('FONT_ASCENT 14\n')) {
    throw new Error('ドットフォントの形式が不正です。');
  }
  const font: BitmapFont = new Map();
  for (const block of source.split('STARTCHAR ').slice(1)) {
    const code = /\nENCODING (\d+)\n/.exec(block);
    const width = /\nDWIDTH (8|16) 0\n/.exec(block);
    const bitmap = /\nBITMAP *\n([\dA-F\n]+)\nENDCHAR/.exec(block);
    if (!code || !width || !bitmap || !block.includes(`\nBBX ${width[1]} 16 0 -2\n`)) {
      throw new Error('ドットフォントの字形が不正です。');
    }
    const rows = bitmap[1].split('\n');
    if (rows.length !== 16 || rows.some(row => row.length !== Number(width[1]) / 4)) {
      throw new Error('ドットフォントの字形サイズが不正です。');
    }
    font.set(Number(code[1]), { width: Number(width[1]),
      rows: Uint16Array.from(rows, row => parseInt(row, 16) << (16 - Number(width[1]))) });
  }
  const count = /\nCHARS (\d+)\n/.exec(source);
  if (!count || font.size !== Number(count[1]) || !font.has(0x3012) || !font.has(0x4f4f)) {
    throw new Error('ドットフォントの読み込みが完了しませんでした。');
  }
  return font;
}

export function loadBitmapFont(): Promise<BitmapFont> {
  if (!pendingFont) {
    pendingFont = (async () => {
      if (typeof DecompressionStream === 'undefined') throw new Error('このブラウザはドットフォントの展開に対応していません。通常フォントへ切り替えてください。');
      const response = await fetch(bitmapFontUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !response.body) throw new Error('ドットフォントを読み込めませんでした。通常フォントへ切り替えるか、もう一度選択してください。');
      const source = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
      return parseFont(source);
    })().catch(cause => {
      pendingFont = undefined;
      throw new Error(`ドットフォントの読み込みに失敗しました：${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }
  return pendingFont;
}

export function paintBitmapText(canvas: HTMLCanvasElement, font: BitmapFont, text: string, scale: number, lineHeight: number) {
  if (![1, 2, 3].includes(scale) || !Number.isInteger(lineHeight) || lineHeight < 16 * scale) {
    throw new Error('ドットフォントは16pxの整数倍で指定してください。');
  }
  const lines = text.replace(/\r\n?/g, '\n').normalize('NFC').split('\n').map(line => [...line]);
  const missing = [...new Set(lines.flat().filter(char => !font.has(char.codePointAt(0)!)))];
  if (missing.length) throw new Error(`ドットフォントにない文字：${missing.slice(0, 8).join(' ')}。通常フォントへ切り替えてください。`);
  canvas.width = Math.max(1, ...lines.map(line => line.reduce((width, char) => width + font.get(char.codePointAt(0)!)!.width * scale, 0)));
  canvas.height = (lines.length - 1) * lineHeight + 16 * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ドット文字を描画できませんでした。');
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  lines.forEach((line, index) => {
    let left = 0;
    for (const char of line) {
      const glyph = font.get(char.codePointAt(0)!)!;
      for (let y = 0; y < 16; y++) for (let x = 0; x < glyph.width; x++) {
        if (glyph.rows[y] & (0x8000 >> x)) context.fillRect(left + x * scale, index * lineHeight + y * scale, scale, scale);
      }
      left += glyph.width * scale;
    }
  });
}

export async function waitForBitmapText(node: HTMLElement, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const loading = () => Boolean(node.querySelector('[data-bitmap-state="loading"]'));
  if (!loading()) return;
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => { if (!loading()) finish(); });
    const timeout = setTimeout(() => finish(new Error('ドット文字の準備が間に合いませんでした。もう一度お試しください。')), 15_000);
    const abort = () => finish(signal?.reason);
    function finish(error?: Error) {
      observer.disconnect(); clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
    observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-bitmap-state'] });
  });
}
