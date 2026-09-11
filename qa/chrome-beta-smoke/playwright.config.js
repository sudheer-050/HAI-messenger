// Chrome Beta smoke gate config (MYAG-238/MYAG-239).
//
// Targets the "chrome-beta" channel deliberately, not Playwright's bundled
// Chromium — the whole point of this matrix is catching regressions in a
// specific upcoming Chrome milestone before it reaches Stable. Requires
// Google Chrome Beta to be installed on the host running the tests
// (`npx playwright install chrome-beta` or a system install), which this
// harness does not attempt to provision itself.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: process.env.CHROME_BETA_SMOKE_BASE_URL,
    trace: 'retain-on-failure',
    // Evidence must never capture message plaintext — see README.
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome-beta',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome-beta',
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
});
