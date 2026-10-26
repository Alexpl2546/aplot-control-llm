import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['ui-audit.e2e.ts', 'chat-history.e2e.ts', 'languages.e2e.ts'],
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'artifacts/ui-audit/playwright-results',
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'chrome', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: true },
});
