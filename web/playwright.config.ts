import { defineConfig } from '@playwright/test';

const port = Number(process.env.WEB_TEST_PORT || 3123);
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  outputDir: './test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    channel: process.env.USB_BROWSER_CHANNEL || 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'ui', testMatch: /(?:ui|editor)\.spec\.ts/ },
    { name: 'hardware', testMatch: 'hardware.spec.ts' },
  ],
});
