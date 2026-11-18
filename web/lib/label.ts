import { waitForBitmapText } from './bitmap-font';

export type LabelDraft = {
  postal: string;
  address: string;
  recipient: string;
  qrValue: string;
  showQr: boolean;
  showLogo: boolean;
  paperWidth: 58 | 80;
  heightMm: number;
  fontSize: number;
  nameSize: number;
  bold: boolean;
  threshold: number;
  textRenderer: 'outline' | 'bitmap';
  bitmapScale: 1 | 2;
  bitmapNameScale: 1 | 2 | 3;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
};

export const initialLabel: LabelDraft = {
  postal: '〒123-4567', address: '架空県サンプル市\nテスト町二丁目3番1号\nサンプルビル 1F',
  recipient: '見本 太郎 様', qrValue: 'https://example.com/', showQr: true, showLogo: true,
  paperWidth: 58, heightMm: 38, fontSize: 20, nameSize: 32, bold: false, threshold: 192,
  textRenderer: 'outline', bitmapScale: 1, bitmapNameScale: 2,
  marginTopMm: 1, marginRightMm: 1, marginBottomMm: 1, marginLeftMm: 1,
};

export function labelSize(draft: LabelDraft) {
  return { width: draft.paperWidth === 58 ? 360 : 576, height: Math.round(draft.heightMm * 8) };
}

export function labelContentBox(draft: LabelDraft) {
  const margins = [draft.marginTopMm, draft.marginRightMm, draft.marginBottomMm, draft.marginLeftMm];
  const valid = margins.every(value => Number.isFinite(value) && value >= 0 && value <= 20 && Number.isInteger(value * 8));
  const [top, right, bottom, left] = valid ? margins.map(value => value * 8) : [0, 0, 0, 0];
  const size = labelSize(draft);
  const width = size.width - left - right, height = size.height - top - bottom;
  const error = !valid ? '余白は0〜20mmの範囲で、0.125mm刻みで入力してください。'
    : width <= 0 || height <= 0 ? '余白の合計が印刷幅・高さ以上です。余白を小さくしてください。' : '';
  return { left, top, width: Math.max(0, width), height: Math.max(0, height), error };
}

export function layoutErrors(node: HTMLElement): string[] {
  if (node.dataset.layoutError) return [node.dataset.layoutError];
  const errors: string[] = [];
  const area = (node.querySelector('[data-label-content]') ?? node).getBoundingClientRect();
  const elements = [...node.querySelectorAll<HTMLElement>('[data-label-part]')];
  for (const element of elements) {
    if (element.dataset.bitmapError) errors.push(`${element.dataset.labelPart}：${element.dataset.bitmapError}`);
    if (element.dataset.bitmapState === 'loading') continue;
    const rect = element.getBoundingClientRect();
    if (rect.left < area.left - 1 || rect.top < area.top - 1 || rect.right > area.right + 1 || rect.bottom > area.bottom + 1) {
      errors.push(`${element.dataset.labelPart}が余白を除く印刷範囲からはみ出しています。`);
    }
  }
  for (let a = 0; a < elements.length; a++) for (let b = a + 1; b < elements.length; b++) {
    const first = elements[a].getBoundingClientRect(), second = elements[b].getBoundingClientRect();
    if (first.left < second.right - 1 && first.right > second.left + 1 && first.top < second.bottom - 1 && first.bottom > second.top + 1) {
      errors.push(`${elements[a].dataset.labelPart}と${elements[b].dataset.labelPart}が重なっています。`);
    }
  }
  return errors;
}

export type RasterLabel = { width: number; height: number; pixels: Uint8ClampedArray; dataUrl: string };

const textFont = (style: CSSStyleDeclaration) => `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

async function loadTextFonts(node: HTMLElement) {
  await Promise.all([...node.querySelectorAll<HTMLElement>('[data-label-text]')].map(async element => {
    const text = element.textContent ?? '';
    if (!text.trim()) return;
    const faces = await document.fonts.load(textFont(getComputedStyle(element)), text);
    if (!faces.length) throw new Error(`${element.dataset.labelPart}のフォントを読み込めませんでした。ページを再読み込みしてください。`);
  }));
}

function paintLabelText(context: CanvasRenderingContext2D, node: HTMLElement) {
  const area = node.getBoundingClientRect();
  context.save();
  context.fillStyle = '#000000'; context.textAlign = 'left'; context.textBaseline = 'alphabetic';
  for (const element of node.querySelectorAll<HTMLElement>('[data-label-text]')) {
    const text = element.textContent ?? '';
    if (!text.trim()) continue;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const baseline = element.querySelector('[data-text-baseline]')?.getBoundingClientRect();
    if (!baseline) throw new Error('文字の描画位置を取得できませんでした。');
    context.font = textFont(style);
    const lineHeight = parseFloat(style.lineHeight);
    text.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      context.fillText(line, rect.left - area.left, baseline.top - area.top + index * lineHeight);
    });
  }
  context.imageSmoothingEnabled = false;
  for (const canvas of node.querySelectorAll<HTMLCanvasElement>('canvas[data-bitmap-state="ready"]')) {
    const rect = canvas.getBoundingClientRect();
    context.drawImage(canvas, rect.left - area.left, rect.top - area.top);
  }
  context.restore();
}

export async function rasterizeLabel(node: HTMLElement, draft: LabelDraft, signal?: AbortSignal): Promise<RasterLabel> {
  await waitForBitmapText(node, signal);
  await loadTextFonts(node);
  await document.fonts.ready;
  await Promise.all([...node.querySelectorAll('img')].map(image => image.decode()));
  signal?.throwIfAborted();
  const errors = layoutErrors(node);
  if (errors.length) throw new Error(errors.join('\n'));
  const { width, height } = labelSize(draft);
  const { toCanvas } = await import('html-to-image');
  signal?.throwIfAborted();
  // ディスプレイの倍率に関係なく、1ピクセルをプリンターの1ドットに固定する。
  const canvas = await toCanvas(node, { width, height, canvasWidth: width, canvasHeight: height,
    pixelRatio: 1, backgroundColor: '#ffffff', skipAutoScale: true, fontEmbedCSS: '',
    // SVG内のWebフォント描画に依存せず、通常文字は読み込み済みフォントで直接描く。
    filter: element => !element.hasAttribute?.('data-label-text') && !element.hasAttribute?.('data-bitmap-state') });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('画像を生成できませんでした。');
  signal?.throwIfAborted();
  paintLabelText(context, node);
  const image = context.getImageData(0, 0, width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3] / 255;
    const light = (image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114) * alpha + 255 * (1 - alpha);
    const value = light < draft.threshold ? 0 : 255;
    image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return { width, height, pixels: image.data, dataUrl: canvas.toDataURL('image/png') };
}

export function rasterBytes(label: Pick<RasterLabel, 'width' | 'height' | 'pixels'>): Uint8Array<ArrayBuffer> {
  const { width, height, pixels } = label;
  if (width % 8 || width <= 0 || height <= 0 || height > 65535 || pixels.length !== width * height * 4) {
    throw new Error('ラスタ画像の寸法が不正です。');
  }
  const rowBytes = width / 8;
  const bytes = new Uint8Array(8 + rowBytes * height);
  bytes.set([0x1d, 0x76, 0x30, 0, rowBytes & 255, rowBytes >> 8, height & 255, height >> 8]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4] < 128) bytes[8 + y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return bytes;
}
