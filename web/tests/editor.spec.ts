import { test, expect, type Page } from '@playwright/test';

type UsbState = { events: { type: string; dots?: number; height?: number; width?: number; at?: number }[]; settings: number[]; settingWrites: { index: number; value: number }[]; transfers: number; closes: number; replyBlocked: boolean };
const usbState = (page: Page) => page.evaluate(() => (window as unknown as { editorUsb: UsbState }).editorUsb);

async function readyPreview(page: Page) {
  await expect(page.getByTestId('raster-preview-panel')).toHaveAttribute('data-preview-state', 'ready');
  await expect(page.getByTestId('raster-preview')).toBeVisible();
}

async function observeRasterWork(page: Page) {
  await page.addInitScript(() => {
    const state = { encodings: 0, delayNextDecode: false, blocked: false, release: () => {} };
    Object.assign(window, { rasterWork: state });
    const encode = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (args[0] === 'image/png' && this.width === 432 && this.height === 304) state.encodings++;
      return encode.apply(this, args);
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (state.delayNextDecode && this.src.endsWith('/label-logo.svg')) {
        state.delayNextDecode = false; state.blocked = true;
        return new Promise<void>((resolve, reject) => {
          state.release = () => { void decode.call(this).then(resolve, reject); };
        });
      }
      return decode.call(this);
    };
  });
}

type RasterWork = { encodings: number; delayNextDecode: boolean; blocked: boolean; release: () => void };
const rasterWork = (page: Page) => page.evaluate(() => {
  const { encodings, blocked } = (window as unknown as { rasterWork: RasterWork }).rasterWork;
  return { encodings, blocked };
});

type PrinterFailure = 'none' | 'short-raster' | 'missing-mark' | 'missing-mark-after-raster' | 'sensor-error-during-back' | 'reply-timeout-before-print' | 'reply-timeout-after-raster' | 'reply-timeout-after-cut';

async function mockPrinter(page: Page, failure: PrinterFailure = 'none', markDelayMm = 0, markWidth = 3, initialPaperDots = 0) {
  await page.addInitScript(({ failure, markDelayMm, markWidth, initialPaperDots }) => {
    const state = { events: [] as { type: string; dots?: number; height?: number; width?: number; at?: number }[], settings: Array(40).fill(255), settingWrites: [] as { index: number; value: number }[], transfers: 0, closes: 0, replyBlocked: false };
    state.settings[0] = 251;
    Object.assign(window, { editorUsb: state });
    let bytes: number[] = [], queued: number[] = [], paperDots = initialPaperDots;
    let replyReleased = false;
    const parse = () => {
      while (bytes.length >= 2) {
        let length = 0;
        if (bytes[0] === 0x12 && bytes[1] === 0x71) {
          length = 3; if (bytes.length < length) return;
          queued.push(0x80 | bytes[2]);
        } else if (bytes[0] === 0x12 && bytes[1] === 0x6c) {
          length = 3; if (bytes.length < length) return;
          queued.push(14, ...state.settings.flatMap(value => [0xe0 | (value & 15), 0xf0 | (value >> 4)]), 0,
            0xc0, ...Array(7).fill(0xd0));
        } else if (bytes[0] === 0x12 && bytes[1] === 0x77) {
          length = 5; if (bytes.length < length) return;
          state.settingWrites.push({ index: bytes[2], value: bytes[3] });
          state.settings[bytes[2] - 1] = bytes[3];
        } else if (bytes[0] === 0x1d && bytes[1] === 0x72) {
          length = 3; if (bytes.length < length) return;
          const position = ((paperDots % 392) + 392) % 392;
          const missing = failure === 'missing-mark'
            || (failure === 'missing-mark-after-raster' && state.events.some(event => event.type === 'raster' && event.height === 304));
          // 市販紙で確認した3mm幅を既定とし、黒帯終端の位置と49mmピッチを保つ。
          const black = !missing && paperDots >= markDelayMm * 8 && position >= 232 - markWidth * 8 && position < 232;
          const error = failure === 'sensor-error-during-back' && bytes[2] === 1 && state.events.some(event => event.type === 'back');
          queued.push(0xa0 | (error ? 1 : bytes[2] === 8 && black ? 8 : 0));
        } else if (bytes[0] === 0x1d && bytes[1] === 0x76) {
          if (bytes.length < 8) return;
          const rowBytes = bytes[4] + bytes[5] * 256, height = bytes[6] + bytes[7] * 256;
          length = 8 + rowBytes * height; if (bytes.length < length) return;
          state.events.push({ type: 'raster', width: rowBytes * 8, height }); paperDots += height;
        } else if (bytes[0] === 0x1b && [0x4a, 0x6a].includes(bytes[1])) {
          length = 3; if (bytes.length < length) return;
          const reverse = bytes[1] === 0x6a;
          paperDots += bytes[2] * (reverse ? -1 : 1);
          state.events.push({ type: reverse ? 'back' : 'feed', dots: bytes[2] });
        } else if (bytes[0] === 0x1d && bytes[1] === 0x56) {
          length = 3; if (bytes.length < length) return;
          state.events.push({ type: 'cut', at: Date.now() });
        } else if (bytes[0] === 0x1d && [0x50, 0x4c, 0x57].includes(bytes[1])) length = 4;
        else if (bytes[0] === 0x1b && bytes[1] === 0x61) length = 3;
        else if (bytes[0] === 0x1b && bytes[1] === 0x40) length = 2;
        else throw new Error(`未対応のテストコマンド ${bytes.slice(0, 8)}`);
        if (bytes.length < length) return;
        bytes = bytes.slice(length);
      }
    };
    const iface = { interfaceNumber: 0, claimed: false, alternate: {
      endpoints: [{ direction: 'out', endpointNumber: 1, type: 'bulk' }, { direction: 'in', endpointNumber: 2, type: 'bulk' }],
    } };
    const device = {
      vendorId: 0x0619, productId: 0x0123, productName: 'SII mock', opened: false,
      configuration: { configurationValue: 1, interfaces: [iface] },
      async open() { this.opened = true; }, async claimInterface() { iface.claimed = true; },
      async close() { state.closes++; this.opened = false; iface.claimed = false; },
      async controlTransferIn() { return { status: 'ok', data: new DataView(new Uint8Array([0x18]).buffer) }; },
      async transferOut(_endpoint: number, chunk: Uint8Array) {
        state.transfers++;
        if (failure === 'short-raster' && chunk.length === 4096) return { status: 'ok', bytesWritten: 100 };
        bytes.push(...chunk); parse(); return { status: 'ok', bytesWritten: chunk.length };
      },
      async transferIn() {
        const timeout = failure === 'reply-timeout-before-print'
          || (failure === 'reply-timeout-after-raster' && state.events.some(event => event.type === 'raster' && event.height === 304))
          || (failure === 'reply-timeout-after-cut' && state.events.some(event => event.type === 'cut'));
        if (timeout && !replyReleased) {
          state.replyBlocked = true;
          await new Promise<void>(resolve => {
            Object.assign(window, { finishEditorReply: () => { replyReleased = true; resolve(); } });
          });
        }
        if (!queued.length) throw new Error('テストの応答がありません。');
        // HEX応答や8バイトの自動ステータスがパケット境界をまたぐ状況を再現する。
        const chunk = new Uint8Array(queued.slice(0, 3)); queued = queued.slice(chunk.length);
        return { status: 'ok', data: new DataView(chunk.buffer) };
      },
    };
    Object.defineProperty(navigator, 'usb', { value: {
      getDevices: async () => [device], addEventListener() {}, removeEventListener() {},
    } });
  }, { failure, markDelayMm, markWidth, initialPaperDots });
}

test('操作ボタンなしで編集内容を白黒プレビューへ反映し、画面倍率に依存しないPNGを保存できる', async ({ page }) => {
  await page.goto('/editor');
  await page.getByLabel('氏名・宛名', { exact: true }).fill('編集 花子 様');
  await expect(page.getByTestId('label-component')).toContainText('編集 花子 様');
  await expect(page.getByRole('button', { name: '白黒画像を生成', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: /住所の文字サイズ/ })).toHaveValue('20');
  await expect(page.getByRole('slider', { name: /氏名の文字サイズ/ })).toHaveValue('32');
  await expect(page.getByRole('slider', { name: /白黒のしきい値/ })).toHaveValue('192');
  for (const side of ['上', '下', '左', '右']) await expect(page.getByRole('spinbutton', { name: `${side}余白（mm）`, exact: true })).toHaveValue('1');
  await expect(page.getByTestId('label-component').locator('[data-label-part="住所"]')).toHaveCSS('font-size', '20px');
  await expect(page.getByTestId('label-component').locator('[data-label-part="氏名"]')).toHaveCSS('font-size', '32px');
  await page.getByLabel('表示倍率', { exact: true }).selectOption('2');
  await readyPreview(page);
  const image = page.getByTestId('raster-preview');
  await expect(image).toBeVisible();
  const output = await image.evaluate(node => {
    const image = node as HTMLImageElement;
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, binary: pixels.every((value, index) => index % 4 === 3 ? value === 255 : value === 0 || value === 255), black: pixels.some((value, index) => index % 4 === 0 && value === 0) };
  });
  expect(output).toEqual({ width: 432, height: 304, binary: true, black: true });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PNGを保存' }).click();
  expect((await downloaded).suggestedFilename()).toBe('label-432x304.png');
  await page.getByLabel('郵便番号', { exact: true }).fill('〒000-0000');
  await expect(page.getByTestId('raster-preview-panel')).toHaveAttribute('data-preview-state', 'pending');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  const previous = await image.getAttribute('src');
  await readyPreview(page);
  await expect(image).not.toHaveAttribute('src', previous!);
});

test('はみ出す住所の出力を止め、80mmの印刷幅へ変更できる', async ({ page }) => {
  await page.goto('/editor');
  await page.getByRole('textbox', { name: '住所', exact: true }).fill('長い住所'.repeat(20));
  await expect(page.getByRole('main').getByRole('alert').first()).toContainText('はみ出し');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await page.getByRole('textbox', { name: '住所', exact: true }).fill('架空県サンプル市');
  await page.getByRole('combobox', { name: '用紙幅', exact: true }).selectOption('80');
  await readyPreview(page);
  await expect(page.getByTestId('raster-preview')).toHaveAttribute('width', '576');
});

test('上下左右の余白を両フォントの配置と白黒画像へ反映し、再読み込みで既定値に戻す', async ({ page }) => {
  await page.goto('/editor');
  const parts = () => page.getByTestId('label-component').evaluate(node => {
    const area = node.getBoundingClientRect();
    return Object.fromEntries([...node.querySelectorAll<HTMLElement>('[data-label-part]')].map(element => {
      const rect = element.getBoundingClientRect();
      return [element.dataset.labelPart, { x: rect.left - area.left, y: rect.top - area.top }];
    }));
  });
  for (const mode of ['outline', 'bitmap']) {
    for (const side of ['上', '下', '左', '右']) await page.getByRole('spinbutton', { name: `${side}余白（mm）`, exact: true }).fill('1');
    await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption(mode);
    await readyPreview(page);
    const before = await parts();
    for (const side of ['上', '下', '左', '右']) await page.getByRole('spinbutton', { name: `${side}余白（mm）`, exact: true }).fill('2');
    await readyPreview(page);
    const after = await parts();
    expect(after['住所']).toEqual({ x: before['住所'].x + 8, y: before['住所'].y + 8 });
    expect(after['氏名']).toEqual({ x: before['氏名'].x + 8, y: before['氏名'].y - 8 });
    expect(after.QR).toEqual({ x: before.QR.x - 8, y: before.QR.y + 8 });
    expect(after['ロゴ']).toEqual({ x: before['ロゴ'].x - 8, y: before['ロゴ'].y - 8 });
    const blankMargins = await page.getByTestId('raster-preview').evaluate(node => {
      const image = node as HTMLImageElement, canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if ((x < 16 || x >= canvas.width - 16 || y < 16 || y >= canvas.height - 16) && pixels[(y * canvas.width + x) * 4] !== 255) return false;
      }
      return true;
    });
    expect(blankMargins).toBe(true);
  }
  await page.reload();
  for (const side of ['上', '下', '左', '右']) await expect(page.getByRole('spinbutton', { name: `${side}余白（mm）`, exact: true })).toHaveValue('1');
  await readyPreview(page);
});

test('空欄・不正な刻み・大きすぎる余白では保存と印刷を止め、既定値に戻すと復帰する', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await readyPreview(page);
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const top = page.getByRole('spinbutton', { name: '上余白（mm）', exact: true });
  await top.fill('');
  await expect(page.getByRole('main').getByRole('alert').first()).toContainText('余白は0〜20mm');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'このラベルを1枚印刷する' })).toBeDisabled();
  await top.fill('1.1');
  await expect(page.getByRole('main').getByRole('alert').first()).toContainText('0.125mm刻み');
  await top.fill('20');
  await page.getByRole('spinbutton', { name: '下余白（mm）', exact: true }).fill('20');
  await expect(page.getByRole('main').getByRole('alert').first()).toContainText('余白の合計が印刷幅・高さ以上');
  await expect(page.getByTestId('raster-preview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'このラベルを1枚印刷する' })).toBeDisabled();
  expect((await usbState(page)).transfers).toBe(0);
  await page.getByRole('button', { name: '見本の内容に戻す', exact: true }).click();
  await readyPreview(page);
  await expect(top).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'このラベルを1枚印刷する' })).toBeEnabled();
});

test.describe('スマホのラスタライズ', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('通常・ドット両フォントで郵便番号・住所・氏名が実際のPNGに描画される', async ({ page }) => {
    await page.goto('/editor');
    for (const mode of ['outline', 'bitmap']) {
      await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption(mode);
      await readyPreview(page);
      const textPixels = await page.getByTestId('raster-preview').evaluate(async node => {
        const image = node as HTMLImageElement; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const root = document.querySelector('[data-testid="label-component"]')!.getBoundingClientRect();
        return ['郵便番号', '住所', '氏名'].map(part => {
          const rect = document.querySelector(`[data-label-part="${part}"]`)!.getBoundingClientRect();
          let black = 0;
          for (let y = Math.ceil(rect.top - root.top); y < Math.min(canvas.height, rect.bottom - root.top); y++) {
            for (let x = Math.ceil(rect.left - root.left); x < Math.min(canvas.width, rect.right - root.left); x++) {
              if (pixels[(y * canvas.width + x) * 4] === 0) black++;
            }
          }
          return { part, black };
        });
      });
      for (const part of textPixels) expect(part.black, `${mode}：${part.part}に文字の黒画素がある`).toBeGreaterThan(100);
      await expect(page.getByTestId('raster-preview')).toHaveAttribute('width', '432');
    }
  });

  test('文字のフォント読み込みが終わるまで白紙のプレビューを確定しない', async ({ page }) => {
    await page.addInitScript(() => {
      const load = document.fonts.load.bind(document.fonts);
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      Object.assign(window, { releaseTextFont: release, textFontStarted: false });
      document.fonts.load = async (font, text) => {
        Object.assign(window, { textFontStarted: true });
        await pending; return load(font, text);
      };
    });
    await page.goto('/editor');
    await expect.poll(() => page.evaluate(() => (window as unknown as { textFontStarted: boolean }).textFontStarted)).toBe(true);
    await expect(page.getByTestId('raster-preview-panel')).toHaveAttribute('data-preview-state', 'pending');
    await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
    await expect(page.getByTestId('raster-preview')).toHaveCount(0);
    await page.evaluate(() => { (window as unknown as { releaseTextFont: () => void }).releaseTextFont(); });
    await readyPreview(page);
  });
});

test('連続入力をまとめて画像化し、表示倍率の変更では画像化し直さない', async ({ page }) => {
  await observeRasterWork(page);
  await page.goto('/editor');
  await readyPreview(page);
  const before = (await rasterWork(page)).encodings;
  const image = page.getByTestId('raster-preview');
  const previous = await image.getAttribute('src');
  const input = page.getByRole('textbox', { name: '氏名・宛名', exact: true });
  await input.fill('');
  await input.pressSequentially('ABCDEF', { delay: 10 });
  await readyPreview(page);
  expect((await rasterWork(page)).encodings).toBe(before + 1);
  await expect(image).not.toHaveAttribute('src', previous!);
  const current = await image.getAttribute('src');
  await page.getByRole('combobox', { name: '表示倍率', exact: true }).selectOption('2');
  await expect(image).toHaveCSS('width', '864px');
  await expect(image).toHaveAttribute('src', current!);
  expect((await rasterWork(page)).encodings).toBe(before + 1);
});

test('画像化中も編集でき、古い処理を破棄して最新画像の完成後だけ印刷できる', async ({ page }) => {
  await observeRasterWork(page);
  await mockPrinter(page);
  await page.goto('/editor');
  await readyPreview(page);
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('roll');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const print = page.getByRole('button', { name: 'このラベルを1枚印刷する' });
  await expect(print).toBeEnabled();
  const before = (await rasterWork(page)).encodings;
  await page.evaluate(() => { (window as unknown as { rasterWork: RasterWork }).rasterWork.delayNextDecode = true; });
  await page.getByRole('textbox', { name: '氏名・宛名', exact: true }).fill('途中の内容');
  await expect.poll(async () => (await rasterWork(page)).blocked).toBe(true);
  await expect(print).toBeDisabled();
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await expect(page.getByTestId('raster-preview')).toHaveCSS('opacity', '0.35');
  await page.getByRole('textbox', { name: '氏名・宛名', exact: true }).fill('確定 花子 様');
  await expect(page.getByRole('textbox', { name: '氏名・宛名', exact: true })).toBeEnabled();
  expect((await usbState(page)).transfers).toBe(0);
  await page.evaluate(() => { (window as unknown as { rasterWork: RasterWork }).rasterWork.release(); });
  await readyPreview(page);
  expect((await rasterWork(page)).encodings).toBe(before + 1);
  await expect(page.getByTestId('raster-preview')).toHaveCSS('opacity', '1');
  await print.click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
});

test('ドットフォントを読み込み中でも通常フォントへ戻せば待たずに更新できる', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/fonts/unifont_jp-18.0.01.bdf.gz', async route => { await pending; await route.continue(); });
  await page.goto('/editor');
  await readyPreview(page);
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('bitmap');
  // デバウンス後の字形待ちが始まってから、未取得のフォントを使わない表示へ戻す。
  await page.waitForTimeout(250);
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('outline');
  try { await readyPreview(page); } finally { release(); }
});

test('ドット文字を整数倍で描き、表示倍率・しきい値によらず同じドットをPNGへ渡す', async ({ page }) => {
  await page.goto('/editor');
  await page.getByRole('textbox', { name: '住所', exact: true }).fill('東京 A');
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('bitmap');
  const address = page.getByTestId('label-component').locator('canvas[data-label-part="住所"]');
  await expect(address).toHaveAttribute('data-bitmap-state', 'ready');
  const original = await address.evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height, pixels: [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data] };
  });
  expect(original.width).toBe(48);
  expect(original.height).toBe(16);
  await page.getByRole('combobox', { name: '住所のドットサイズ', exact: true }).selectOption('2');
  await expect(address).toHaveAttribute('data-bitmap-state', 'ready');
  const doubled = await address.evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height, pixels: [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data] };
  });
  expect(doubled.width).toBe(96);
  expect(doubled.height).toBe(32);
  expect(doubled.pixels.every((value, i) => {
    const pixel = Math.floor(i / 4), x = pixel % doubled.width, y = Math.floor(pixel / doubled.width);
    return value === original.pixels[(Math.floor(y / 2) * original.width + Math.floor(x / 2)) * 4 + i % 4];
  })).toBe(true);
  await page.getByRole('slider', { name: /白黒のしきい値/ }).press('Home');
  await page.getByRole('combobox', { name: '表示倍率', exact: true }).selectOption('2');
  await readyPreview(page);
  const raster = page.getByTestId('raster-preview');
  await expect(raster).toBeVisible();
  const printedPixels = await raster.evaluate(node => {
    const image = node as HTMLImageElement, canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return [...context.getImageData(8, 77, 96, 32).data];
  });
  expect(printedPixels).toEqual(doubled.pixels);
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('outline');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await readyPreview(page);
  await expect(page.getByRole('slider', { name: /住所の文字サイズ/ })).toHaveValue('20');
});

test('未収録のドット文字を印刷せず、通常フォントへの切り替えで復帰できる', async ({ page }) => {
  await page.goto('/editor');
  await page.getByRole('textbox', { name: '氏名・宛名', exact: true }).fill('𠮷田 様');
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('bitmap');
  await expect(page.getByRole('main').getByRole('alert').first()).toContainText('ドットフォントにない文字：𠮷');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'このラベルを1枚印刷する' })).toBeDisabled();
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('outline');
  await readyPreview(page);
});

test('ドットフォントの読み込み完了まで画像生成を待つ', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/fonts/unifont_jp-18.0.01.bdf.gz', async route => { await pending; await route.continue(); });
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('bitmap');
  await expect(page.getByTestId('raster-preview-panel')).toHaveAttribute('data-preview-state', 'pending');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '住所', exact: true })).toBeEnabled();
  release();
  await readyPreview(page);
  await expect(page.getByTestId('raster-preview')).toBeVisible();
  await expect(page.getByTestId('label-component').locator('[data-bitmap-state="ready"]')).toHaveCount(3);
});

test('フォント取得失敗を表示し、空の文字で画像生成しない', async ({ page }) => {
  await page.route('**/fonts/unifont_jp-18.0.01.bdf.gz', route => route.abort());
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '文字の描き方', exact: true }).selectOption('bitmap');
  await expect(page.getByRole('main').getByRole('alert').first()).toContainText('ドットフォントの読み込みに失敗');
  await expect(page.getByRole('button', { name: 'PNGを保存' })).toBeDisabled();
  await expect(page.getByTestId('raster-preview')).toHaveCount(0);
});

test('通常ロールの画像印字とカットの完了を確認し、本体設定を復元する', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await expect(page.getByRole('combobox', { name: '用紙の種類', exact: true })).toHaveValue('roll');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
  const state = await usbState(page);
  expect(state.events.filter(event => event.type === 'raster')).toEqual([{ type: 'raster', width: 432, height: 304 }]);
  expect(state.events.filter(event => event.type === 'cut')).toHaveLength(1);
  expect(state.settingWrites).toContainEqual({ index: 4, value: 0xf7 });
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('通常ロールはカット済みの次の紙だけ74ドット戻し、紙を動かした後は戻さない', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('roll');
  await page.getByRole('combobox', { name: '枚数', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを2枚印刷する' }).click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('2枚の印字・カットの完了応答を確認');
  const first = await usbState(page);
  expect(first.events.map(event => event.type)).toEqual(['raster', 'feed', 'cut', 'back', 'raster', 'feed', 'cut']);
  expect(first.events.filter(event => event.type === 'back')).toEqual([{ type: 'back', dots: 74 }]);

  await page.getByRole('combobox', { name: '枚数', exact: true }).selectOption('1');
  const print = page.getByRole('button', { name: 'このラベルを1枚印刷する' });
  await print.click();
  await expect.poll(async () => (await usbState(page)).events.filter(event => event.type === 'cut').length).toBe(3);
  await expect(print).toBeEnabled();
  const second = await usbState(page);
  expect(second.events.slice(first.events.length, first.events.length + 2)).toEqual([
    { type: 'back', dots: 74 }, { type: 'raster', width: 432, height: 304 },
  ]);

  await page.getByRole('button', { name: '紙を交換・手動で動かした', exact: true }).click();
  await print.click();
  await expect.poll(async () => (await usbState(page)).events.filter(event => event.type === 'cut').length).toBe(4);
  await expect(print).toBeEnabled();
  const final = await usbState(page);
  expect(final.events.slice(second.events.length).map(event => event.type)).toEqual(['raster', 'feed', 'cut']);
  expect(final.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('通常ロールでもカットしない連続印刷は逆送りしない', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('roll');
  await page.getByRole('combobox', { name: '枚数', exact: true }).selectOption('2');
  await page.getByRole('checkbox', { name: '1枚ごとにカットする', exact: true }).uncheck();
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを2枚印刷する' }).click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('2枚の印字の完了応答を確認');
  const state = await usbState(page);
  expect(state.events.map(event => event.type)).toEqual(['raster', 'feed', 'raster', 'feed']);
});

test('位置不明からの1枚は補正プラス1mmでも印字し、カット後の再開は戻し量の上限で止める', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByText('印刷の詳細設定', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'カット位置の補正（mm）', exact: true }).fill('1');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const print = page.getByRole('button', { name: 'このラベルを1枚印刷する' });
  await print.click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
  const state = await usbState(page);
  expect(state.events.filter(event => event.type === 'raster' && event.height === 304)).toHaveLength(1);
  expect(state.events.filter(event => event.type === 'cut')).toHaveLength(1);
  expect(state.events.filter(event => event.type === 'back').reduce((sum, event) => sum + event.dots!, 0)).toBe(74);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
  await expect(print).toBeDisabled();
  await expect(page.getByText('カット後の戻し量が本体の上限9.25mmを超えます。補正値を見直してください。', { exact: true })).toBeVisible();

  // 次回カットを無効にしても、カット済み位置からの再開には逆送りが必要になる。
  await page.getByRole('checkbox', { name: '1枚ごとにカットする', exact: true }).uncheck();
  await expect(print).toBeDisabled();
  expect((await usbState(page)).transfers).toBe(state.transfers);
});

test('位置不明からのカットなし単枚ジョブは補正プラス1mmでも初回探索で続けて印字できる', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('checkbox', { name: '1枚ごとにカットする', exact: true }).uncheck();
  await page.getByText('印刷の詳細設定', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'カット位置の補正（mm）', exact: true }).fill('1');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const print = page.getByRole('button', { name: 'このラベルを1枚印刷する' });
  for (const copies of [1, 2]) {
    await print.click();
    await expect.poll(async () => (await usbState(page)).events.filter(event => event.type === 'raster' && event.height === 304).length).toBe(copies);
    await expect(print).toBeEnabled();
    await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字の完了応答を確認');
  }
  const state = await usbState(page);
  expect(state.events.filter(event => event.type === 'back').reduce((sum, event) => sum + event.dots!, 0)).toBe(148);
  expect(state.events.some(event => event.type === 'cut')).toBe(false);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('カットする複数枚ジョブは最初の送信前に補正プラス1mmの逆送り上限超過を拒否する', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await readyPreview(page);
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('combobox', { name: '枚数', exact: true }).selectOption('2');
  await page.getByText('印刷の詳細設定', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'カット位置の補正（mm）', exact: true }).fill('1');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await expect(page.getByRole('button', { name: 'このラベルを2枚印刷する' })).toBeDisabled();
  await expect(page.getByText('カット後の戻し量が本体の上限9.25mmを超えます。補正値を見直してください。', { exact: true })).toBeVisible();
  expect((await usbState(page)).transfers).toBe(0);
});

for (const initialPaperDots of [232, 274, 305]) {
  test(`紙交換後に黒帯終端を${(initialPaperDots - 232) / 8}mm通り過ぎていても逆送りで頭出しし、区画を飛ばさない`, async ({ page }) => {
    await mockPrinter(page, 'none', 0, 3, initialPaperDots);
    await page.goto('/editor');
    await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
    await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
    const state = await usbState(page);
    const imageIndex = state.events.findIndex(event => event.type === 'raster' && event.height === 304);
    expect(imageIndex).toBeGreaterThan(0);
    const alignment = state.events.slice(0, imageIndex);
    const reversed = alignment.filter(event => event.type === 'back').reduce((sum, event) => sum + event.dots!, 0);
    expect(reversed).toBeGreaterThan(initialPaperDots - 232);
    expect(reversed).toBeLessThanOrEqual(74);
    if (initialPaperDots === 305) expect(alignment.filter(event => event.type === 'back').at(-1)?.dots).toBe(2);
    const printStart = initialPaperDots + alignment.reduce((sum, event) => sum + (event.type === 'raster'
      ? event.height! : event.dots! * (event.type === 'back' ? -1 : 1)), 0);
    // 次の区画へ進まず、直前の黒帯終端＋5.5mm（探索刻みの誤差内）から印字する。
    expect(printStart).toBeGreaterThanOrEqual(232 + 44);
    expect(printStart).toBeLessThan(232 + 44 + 8);
    expect(state.events.slice(imageIndex + 1).filter(event => event.type === 'back')).toHaveLength(0);
    expect(state.events.filter(event => event.type === 'cut')).toHaveLength(1);
    expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
  });
}

test('開始時に黒帯上なら逆方向を探索せず、その黒帯の終端から頭出しする', async ({ page }) => {
  await mockPrinter(page, 'none', 0, 3, 216);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
  const state = await usbState(page);
  expect(state.events.filter(event => event.type === 'back')).toHaveLength(0);
  const imageIndex = state.events.findIndex(event => event.type === 'raster' && event.height === 304);
  expect(state.events.slice(0, imageIndex).filter(event => event.type === 'raster')).toHaveLength(2);
});

test('黒帯が9.25mmより後方なら開始位置へ戻してから次の黒帯を前方探索する', async ({ page }) => {
  await mockPrinter(page, 'none', 0, 3, 307);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
  const state = await usbState(page);
  const restoreIndex = state.events.findIndex(event => event.type === 'feed' && event.dots === 74);
  expect(restoreIndex).toBeGreaterThan(0);
  expect(state.events.slice(0, restoreIndex).every(event => event.type === 'back')).toBe(true);
  expect(state.events.slice(0, restoreIndex).reduce((sum, event) => sum + event.dots!, 0)).toBe(74);
  expect(state.events[restoreIndex + 1]).toEqual({ type: 'raster', width: 432, height: 7 });
  const imageIndex = state.events.findIndex(event => event.type === 'raster' && event.height === 304);
  expect(state.events.slice(restoreIndex + 1, imageIndex).filter(event => event.type === 'raster')).toHaveLength(40);
});

test('逆方向探索中に本体エラーが出たら後続の紙送り・印字・カットを止める', async ({ page }) => {
  await mockPrinter(page, 'sensor-error-during-back');
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('本体を確認してください');
  const state = await usbState(page);
  expect(state.events).toEqual([{ type: 'back', dots: 8 }]);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('3mm幅の黒帯でマーク紙を印字し、次のジョブは同じ接続のカット位置から空送りせずに再開する', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const print = page.getByRole('button', { name: 'このラベルを1枚印刷する' });
  await print.click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('完了応答を確認');
  await expect(page.getByText('前回のカット位置から再開します。', { exact: false })).toBeVisible();
  const first = await usbState(page);
  await print.click();
  await expect.poll(async () => (await usbState(page)).events.filter(event => event.type === 'cut').length).toBe(2);
  await expect(print).toBeEnabled();
  const second = await usbState(page);
  const nextEvents = second.events.slice(first.events.length);
  expect(nextEvents.slice(0, 3)).toEqual([{ type: 'feed', dots: 8 }, { type: 'back', dots: 69 }, { type: 'raster', width: 432, height: 304 }]);
  const cuts = second.events.filter(event => event.type === 'cut');
  expect(cuts[1].at! - cuts[0].at!).toBeGreaterThanOrEqual(2000);
  expect(second.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('3mm幅の黒帯で2枚の印字とカットを交互に実行し、間の用紙を飛ばさない', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('combobox', { name: '枚数', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const print = page.getByRole('button', { name: 'このラベルを2枚印刷する' });
  await print.click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('2枚の印字・カットの完了応答を確認');
  const state = await usbState(page);
  const imagesAndCuts = state.events.filter(event => event.type === 'cut' || (event.type === 'raster' && event.height === 304));
  expect(imagesAndCuts.map(event => event.type)).toEqual(['raster', 'cut', 'raster', 'cut']);
  const cuts = state.events.filter(event => event.type === 'cut');
  expect(cuts[1].at! - cuts[0].at!).toBeGreaterThanOrEqual(2000);
  const firstCut = state.events.findIndex(event => event.type === 'cut');
  expect(state.events.slice(firstCut + 1, firstCut + 4)).toEqual([
    { type: 'feed', dots: 8 }, { type: 'back', dots: 69 }, { type: 'raster', width: 432, height: 304 },
  ]);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

for (const markWidth of [2, 6]) {
  test(`検出幅${markWidth}mmの黒帯でも80mm設定の宛名を印字し、カット後に設定を復元する`, async ({ page }) => {
    await mockPrinter(page, 'none', 0, markWidth);
    await page.goto('/editor');
    await page.getByRole('combobox', { name: '用紙幅', exact: true }).selectOption('80');
    await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
    await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
    const state = await usbState(page);
    expect(state.events.filter(event => event.type === 'raster' && event.height === 304)).toEqual([
      { type: 'raster', width: 576, height: 304 },
    ]);
    expect(state.events.filter(event => event.type === 'cut')).toHaveLength(1);
    expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
  });
}

test('白から読んだ黒帯の検出幅が1mmなら宛名を印字せず停止する', async ({ page }) => {
  await mockPrinter(page, 'none', 0, 1);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('黒帯の幅が想定範囲外です');
  const state = await usbState(page);
  expect(state.events.some(event => event.type === 'raster' && event.height === 304)).toBe(false);
  expect(state.events.some(event => event.type === 'cut')).toBe(false);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('画像の途中送信に失敗したら再送・カットをせず、接続と位置を破棄する', async ({ page }) => {
  await mockPrinter(page, 'short-raster');
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('roll');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('USB送信が失敗');
  const state = await usbState(page);
  expect(state.events.filter(event => event.type === 'cut')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'このラベルを1枚印刷する' })).toBeDisabled();
  const transfers = state.transfers;
  await page.waitForTimeout(200);
  expect((await usbState(page)).transfers).toBe(transfers);
});

for (const scenario of [
  { failure: 'reply-timeout-before-print', name: '印字前', rasters: 0, cuts: 0 },
  { failure: 'reply-timeout-after-raster', name: '印字後', rasters: 1, cuts: 0 },
  { failure: 'reply-timeout-after-cut', name: 'カット後', rasters: 1, cuts: 1 },
] as const) {
  test(`${scenario.name}の完了応答が来なければ後続の印字・カットを止め、遅延応答でも再開しない`, async ({ page }) => {
    await mockPrinter(page, scenario.failure);
    await page.goto('/editor');
    await readyPreview(page);
    await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('roll');
    await page.getByRole('combobox', { name: '枚数', exact: true }).selectOption('2');
    await page.getByText('印刷の詳細設定', { exact: true }).click();
    const ignorePaper = page.getByRole('checkbox', { name: /状態ビット0x20を無視/ });
    await ignorePaper.check();
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await page.clock.install();
    const print = page.getByRole('button', { name: 'このラベルを2枚印刷する' });
    await print.click();
    if (scenario.cuts) {
      await expect.poll(async () => (await usbState(page)).events.some(event => event.type === 'raster')).toBe(true);
      await page.clock.fastForward(2100);
    }
    await expect.poll(async () => (await usbState(page)).replyBlocked).toBe(true);
    await page.clock.fastForward(5100);
    await page.clock.fastForward(2100);
    const connect = page.getByRole('button', { name: 'USB接続', exact: true });
    await expect(connect).toBeEnabled();
    await expect(print).toBeDisabled();
    await expect(ignorePaper).not.toBeChecked();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(scenario.rasters ? '電源を入れ直してください' : '本体応答の受信がタイムアウト');
    const stopped = await usbState(page);
    expect(stopped.closes).toBeGreaterThan(0);
    expect(stopped.events.filter(event => event.type === 'raster')).toHaveLength(scenario.rasters);
    expect(stopped.events.filter(event => event.type === 'cut')).toHaveLength(scenario.cuts);
    if (!scenario.rasters) expect(stopped.settings).toEqual([251, ...Array(39).fill(255)]);

    // 前のUSB要求が残る間は再接続も止め、遅延応答を受け取っても自動で続行しない。
    await connect.click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('前のUSB接続が終了処理中');
    await page.evaluate(() => { (window as unknown as { finishEditorReply: () => void }).finishEditorReply(); });
    await page.clock.fastForward(5000);
    const late = await usbState(page);
    expect(late.transfers).toBe(stopped.transfers);
    expect(late.events).toEqual(stopped.events);
    await expect(print).toBeDisabled();
    await connect.click();
    await expect(page.getByText('● 接続済み', { exact: true })).toBeVisible();
    expect((await usbState(page)).transfers).toBe(stopped.transfers);
  });
}

test('黒帯が見つからなければ宛名とカットへ進まない', async ({ page }) => {
  await mockPrinter(page, 'missing-mark');
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('60mm以内に黒帯を検出できません');
  const state = await usbState(page);
  expect(state.events.filter(event => event.type === 'raster' && event.height === 304)).toHaveLength(0);
  expect(state.events.filter(event => event.type === 'cut')).toHaveLength(0);
  expect(state.events.filter(event => event.type === 'raster')).toHaveLength(60);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

for (const limit of [1, 80]) {
  test(`黒帯がないときは設定した${limit}mmで探索を止め、設定値をエラーに表示する`, async ({ page }) => {
    await mockPrinter(page, 'missing-mark');
    await page.goto('/editor');
    await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
    await page.getByText('印刷の詳細設定', { exact: true }).click();
    const searchLimit = page.getByRole('spinbutton', { name: '黒帯の探索上限（mm）', exact: true });
    await expect(searchLimit).toHaveValue('60');
    await searchLimit.fill(String(limit));
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(`${limit}mm以内に黒帯を検出できません`);
    const state = await usbState(page);
    expect(state.events.filter(event => event.type === 'raster')).toHaveLength(limit);
    expect(state.events.filter(event => event.type === 'raster').every(event => event.height === 7)).toBe(true);
    const restored = state.events.findIndex(event => event.type === 'feed' && event.dots === 74);
    expect(restored).toBeGreaterThan(0);
    expect(state.events.slice(0, restored).reduce((sum, event) => sum + event.dots!, 0)).toBe(74);
    const forwardFeeds = state.events.slice(restored + 1).filter(event => event.type === 'feed');
    expect(forwardFeeds).toHaveLength(limit);
    expect(forwardFeeds.every(event => event.dots === 1)).toBe(true);
    expect(state.events.filter(event => event.type === 'cut')).toHaveLength(0);
    expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
  });
}

test('探索上限を増やすと60mmより先にある黒帯を上限位置で検出して印字できる', async ({ page }) => {
  await mockPrinter(page, 'none', 60);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByText('印刷の詳細設定', { exact: true }).click();
  await page.getByRole('spinbutton', { name: '黒帯の探索上限（mm）', exact: true }).fill('78');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
  const state = await usbState(page);
  const imageIndex = state.events.findIndex(event => event.type === 'raster' && event.height === 304);
  expect(state.events.slice(0, imageIndex).filter(event => event.type === 'raster')).toHaveLength(78);
  expect(state.events.filter(event => event.type === 'cut')).toHaveLength(1);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('印字後の黒帯探索にも指定した上限を適用し、未検出ならカットしない', async ({ page }) => {
  await mockPrinter(page, 'missing-mark-after-raster');
  await page.goto('/editor');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByText('印刷の詳細設定', { exact: true }).click();
  await page.getByRole('spinbutton', { name: '黒帯の探索上限（mm）', exact: true }).fill('32');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.getByRole('button', { name: 'このラベルを1枚印刷する' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('32mm以内に黒帯を検出できません');
  const state = await usbState(page);
  const imageIndex = state.events.findIndex(event => event.type === 'raster' && event.height === 304);
  expect(imageIndex).toBeGreaterThan(0);
  expect(state.events.slice(imageIndex + 1).filter(event => event.type === 'raster')).toHaveLength(32);
  expect(state.events.filter(event => event.type === 'cut')).toHaveLength(0);
  expect(state.settings).toEqual([251, ...Array(39).fill(255)]);
});

test('不正な探索上限ではUSB送信せず、通常ロールへ戻すと印刷できる', async ({ page }) => {
  await mockPrinter(page);
  await page.goto('/editor');
  await readyPreview(page);
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('marked');
  await page.getByText('印刷の詳細設定', { exact: true }).click();
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  const searchLimit = page.getByRole('spinbutton', { name: '黒帯の探索上限（mm）', exact: true });
  const print = page.getByRole('button', { name: 'このラベルを1枚印刷する' });
  for (const value of ['', '0', '-1', '1.5', '9007199254740991']) {
    await searchLimit.fill(value);
    await expect(page.getByText('黒帯の探索上限は1mm以上の整数で指定してください。', { exact: true })).toBeVisible();
    await expect(print).toBeDisabled();
    expect((await usbState(page)).transfers).toBe(0);
  }
  await searchLimit.fill('60');
  await expect(print).toBeEnabled();
  await searchLimit.fill('');
  await page.getByRole('combobox', { name: '用紙の種類', exact: true }).selectOption('roll');
  await print.click();
  await expect(page.getByRole('status', { name: '処理結果' })).toContainText('1枚の印字・カットの完了応答を確認');
});
