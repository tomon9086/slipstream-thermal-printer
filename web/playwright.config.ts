import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  outputDir: './test-results',
  use: {
    baseURL: 'http://localhost:3123',
    headless: true,
    channel: process.env.USB_BROWSER_CHANNEL || 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev --port 3123',
    url: 'http://localhost:3123',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'ui', testMatch: 'ui.spec.ts' },
    { name: 'hardware', testMatch: 'hardware.spec.ts' },
  ],
});
