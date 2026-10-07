import { defineConfig, devices } from '@playwright/test';

// Runs the built bundle (strict CSP from index.html, no dev relaxations) with the MSW mock.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

export default defineConfig({
  testDir: './e2e',
  testMatch: /csp\.spec\.ts/,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5174', locale: 'en-IE' },
  webServer: {
    command: 'npm run build:mock && npm run preview:mock',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
