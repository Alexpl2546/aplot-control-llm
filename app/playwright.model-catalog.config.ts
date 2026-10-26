import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'model-catalog.e2e.ts', workers: 1, timeout: 30000,
  reporter: [['list']], outputDir: 'artifacts/model-catalog-2026-10-24/playwright-results',
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'chrome', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: true },
});
