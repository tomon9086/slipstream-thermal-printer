import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function unresponsiveUsb(page: Page, phase: 'open' | 'status' | 'transfer', closeHangs = false) {
  await page.addInitScript(({ phase, closeHangs }) => {
    const calls = { transfers: 0, closes: 0, claims: 0 };
    let resolveLate: () => void = () => {};
    const pending = new Promise<void>(resolve => { resolveLate = resolve; });
    Object.assign(window, { usbTestCalls: calls, finishUsbOperation: resolveLate });
    const iface = { interfaceNumber: 0, claimed: false, alternate: {
      endpoints: [{ direction: 'out', endpointNumber: 1, type: 'bulk' }],
    } };
    const device = {
      productName: 'Test SII', vendorId: 0x0619, productId: 0x0123, opened: false,
      configuration: { configurationValue: 1, interfaces: [iface] },
      async open() { if (phase === 'open') await pending; this.opened = true; },
      async claimInterface() { calls.claims++; iface.claimed = true; },
      async close() {
        calls.closes++;
        if (closeHangs) await new Promise(() => {});
        this.opened = false;
        iface.claimed = false;
      },
      async controlTransferIn() {
        if (phase === 'status') await pending;
        return { status: 'ok', data: new DataView(new Uint8Array([0x38]).buffer) };
      },
      async transferOut(_number: number, bytes: Uint8Array) {
        calls.transfers++;
        if (phase === 'transfer') await pending;
        return { status: 'ok', bytesWritten: bytes.length };
      },
    };
    Object.defineProperty(navigator, 'usb', { value: {
      getDevices: async () => [device], addEventListener() {}, removeEventListener() {},
    } });
  }, { phase, closeHangs });
}

const calls = (page: Page) => page.evaluate(() =>
  (window as unknown as { usbTestCalls: { transfers: number; closes: number; claims: number } }).usbTestCalls);
const finishLate = (page: Page) => page.evaluate(() =>
  (window as unknown as { finishUsbOperation: () => void }).finishUsbOperation());

test('接続前は印刷できず、WebUSB非対応の場合は理由を表示する', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'usb', { value: undefined }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '1回印刷する' })).toBeDisabled();
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await expect(page.getByTestId('log')).toContainText('WebUSB対応のChrome / Edge');
});

test('途中の短い転送で停止し、次のチャンクを送らず接続を解放する', async ({ page }) => {
  await page.addInitScript(() => {
    const calls = { transfers: 0, closed: false };
    Object.assign(window, { usbTestCalls: calls });
    const iface = { interfaceNumber: 0, claimed: false, alternate: {
      endpoints: [{ direction: 'out', endpointNumber: 1, type: 'bulk' }],
    } };
    const device = {
      productName: 'Test SII', opened: false,
      configuration: { configurationValue: 1, interfaces: [iface] },
      async open() { this.opened = true; },
      async claimInterface() { iface.claimed = true; },
      async releaseInterface() { iface.claimed = false; },
      async close() { this.opened = false; calls.closed = true; },
      async controlTransferIn() { return { status: 'ok', data: new DataView(new Uint8Array([0x38]).buffer) }; },
      async transferOut(_number: number, bytes: Uint8Array) {
        calls.transfers++;
        return { status: 'ok', bytesWritten: bytes.length - 1 };
      },
    };
    Object.defineProperty(navigator, 'usb', { value: {
      getDevices: async () => [],
      requestDevice: async () => device, addEventListener() {}, removeEventListener() {},
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await expect(page.getByTestId('state')).toHaveText('connected');
  await page.getByRole('combobox').selectOption('demo');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '1回印刷する' }).click();
  await expect(page.getByTestId('state')).toHaveText('error');
  await expect(page.getByTestId('log')).toContainText('4095/4096');
  await expect.poll(() => page.evaluate(() => (window as unknown as { usbTestCalls: object }).usbTestCalls))
    .toEqual({ transfers: 1, closed: true });
});

for (const phase of ['status', 'transfer'] as const) {
  test(`${phase === 'status' ? '状態取得' : '送信'}のタイムアウトで画面が復帰し、遅れた応答でも印刷を続けない`, async ({ page }) => {
    await unresponsiveUsb(page, phase);
    await page.goto('/');
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await expect(page.getByTestId('state')).toHaveText('connected');
    await page.getByRole('combobox').selectOption('demo');
    await page.getByRole('checkbox').check();
    await page.clock.install();
    await page.getByRole('button', { name: '1回印刷する' }).click();
    // ファイル取得後、対象のUSB要求が始まってから時計を進める。
    if (phase === 'transfer') await expect.poll(async () => (await calls(page)).transfers).toBe(1);
    else await expect(page.getByTestId('log')).toContainText('Payload: demo');
    await page.clock.fastForward(phase === 'status' ? 2_100 : 15_100);
    await expect(page.getByTestId('error')).toContainText('タイムアウト');
    await page.clock.fastForward(2_100);
    await expect(page.getByRole('button', { name: 'USB接続', exact: true })).toBeEnabled();
    await expect(page.getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await expect(page.getByTestId('error')).toContainText('前のUSB接続が終了処理中');
    await finishLate(page);
    await expect.poll(async () => (await calls(page)).transfers).toBe(phase === 'status' ? 0 : 1);
    await expect(page.getByTestId('state')).toHaveText('error');
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await expect(page.getByTestId('state')).toHaveText('connected');
    expect((await calls(page)).transfers).toBe(phase === 'status' ? 0 : 1);
  });
}

test('接続が遅れて完了しても占有せず閉じ、再接続できる', async ({ page }) => {
  await unresponsiveUsb(page, 'open');
  await page.goto('/');
  await page.clock.install();
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.clock.fastForward(17_100);
  await expect(page.getByTestId('error')).toContainText('USB接続がタイムアウト');
  await expect(page.getByRole('button', { name: 'USB接続', exact: true })).toBeEnabled();
  await finishLate(page);
  await expect.poll(async () => (await calls(page)).closes).toBe(2);
  expect((await calls(page)).claims).toBe(0);
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await expect(page.getByTestId('state')).toHaveText('connected');
});

test('USBの終了処理が無応答でも画面が復帰し、再読み込みの案内を表示する', async ({ page }) => {
  await unresponsiveUsb(page, 'status', true);
  await page.goto('/');
  await page.getByRole('button', { name: 'USB接続', exact: true }).click();
  await page.clock.install();
  await page.getByRole('button', { name: '切断', exact: true }).click();
  await page.clock.fastForward(4_100);
  await expect(page.getByTestId('error')).toContainText('ページを再読み込み');
  await expect(page.getByRole('button', { name: 'USB接続', exact: true })).toBeEnabled();
  expect((await calls(page)).transfers).toBe(0);
});
