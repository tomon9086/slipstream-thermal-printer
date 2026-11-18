import { test, expect } from '@playwright/test';

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
