import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

test('実機にWebUSBから日本語・QR見本を1回送信する', async ({ page, context }, testInfo) => {
  test.skip(process.env.RUN_USB_PRINT !== '1', '実印刷はpnpm test:usbで明示的に実行');
  const manifest = JSON.parse(await readFile(new URL('../public/fixtures/manifest.json', import.meta.url), 'utf8'));
  try {
    await page.goto('/');
    const countGranted = await page.evaluate(async () => {
      if (!navigator.usb) return 0;
      return (await navigator.usb.getDevices())
        .filter(d => d.vendorId === 0x0619 && d.productId === 0x0123).length;
    });
    expect(countGranted, 'ヘッドレス実印刷には対象機器1台への事前許可が必要です。web/README.mdを参照。').toBe(1);
    await page.getByRole('button', { name: 'USB接続', exact: true }).click();
    await expect(page.getByTestId('state')).toHaveText('connected', { timeout: 15_000 });
    await page.getByRole('button', { name: 'ステータス取得' }).click();
    await expect(page.getByTestId('state')).toHaveText('status-read');
    // This observed unit reports 0x38 even with paper loaded (CONNECTION.md).
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '1回印刷する' }).click();
    await expect(page.getByTestId('state')).toHaveText('sent', { timeout: 15_000 });
    await expect(page.getByTestId('log')).toContainText(manifest['japanese-qr'].sha256);
    const count = manifest['japanese-qr'].bytes;
    await expect(page.getByTestId('log')).toContainText(`USB accepted ${count}/${count} bytes`);
    await page.getByRole('button', { name: '切断', exact: true }).click();
    await expect(page.getByTestId('state')).toHaveText('disconnected');
  } finally {
    const logs = await page.getByTestId('log').textContent().catch(() => 'No page log');
    const report = { browser: context.browser()?.version(), platform: process.platform,
      log: logs, physicalPrintVerified: false };
    const output = testInfo.outputPath('usb-report.json');
    await writeFile(output, JSON.stringify(report, null, 2));
    await testInfo.attach('usb-report', { path: output, contentType: 'application/json' });
  }
});
