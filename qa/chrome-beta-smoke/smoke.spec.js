// Chrome Beta smoke gate for HAI's browser-critical PWA paths (MYAG-238/239).
//
// Deliberately small: this is a gate over existing behavior, not a general
// regression suite. See MATRIX.md for the full path list, including rows
// this file does not automate (offline queue drain needs two live accounts
// and Redis orchestration; WebRTC calling and OS-level notifications/badging
// have no implementation to test against yet).
//
// Never assert on or log message plaintext, private key material, or
// credentials. Screenshots/traces are failure-only (see playwright.config.js)
// and must be scrubbed before attaching to an issue.
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CHROME_BETA_SMOKE_BASE_URL;
const TEST_USERNAME = process.env.CHROME_BETA_SMOKE_USERNAME;
const TEST_PASSWORD = process.env.CHROME_BETA_SMOKE_PASSWORD;

test.describe('installability', () => {
  test('manifest.json is present and declares a standalone installable app', async ({ request }) => {
    test.skip(!BASE_URL, 'CHROME_BETA_SMOKE_BASE_URL not set — no app instance to test against');
    const res = await request.get(`${BASE_URL}/manifest.json`);
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.scope).toBeTruthy();
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining([expect.stringContaining('192')]));
    expect(sizes).toEqual(expect.arrayContaining([expect.stringContaining('512')]));
  });
});

test.describe('service worker', () => {
  // Skip declared at describe level (not inside the test body): a page/context
  // fixture is resolved as soon as it's destructured in a test's parameter
  // list, which forces a browser launch before an in-body test.skip() runs.
  // Declaring the skip here avoids that launch entirely when unconfigured.
  test.skip(!BASE_URL, 'CHROME_BETA_SMOKE_BASE_URL not set — no app instance to test against');

  test('registers and stays a passthrough (no stale-cache regression)', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForFunction(() => navigator.serviceWorker.ready);
    const controller = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    expect(controller).toBeTruthy();

    // service-worker.js is intentionally non-caching (see qa/chrome-beta-smoke/MATRIX.md
    // row 3 and the filed offline-caching defect). Guard the inverse regression:
    // a future SW change that starts caching stale responses without the app
    // being ready for it.
    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames).toEqual([]);
  });
});

test.describe('login / unlock', () => {
  test.skip(!BASE_URL || !TEST_USERNAME || !TEST_PASSWORD,
    'CHROME_BETA_SMOKE_BASE_URL / _USERNAME / _PASSWORD not set — no seeded test account to log in with');

  test('seeded account can log in and reach the chat shell', async ({ page }) => {
    await page.goto(BASE_URL);
    // Selectors are illustrative placeholders — fill in against the real
    // login form's ids/data-testids the first time this is run live; the
    // app is a single-file frontend (frontend/index.html) with no
    // data-testid convention yet, so this needs one pass of hands-on
    // inspection before it can run unattended.
    await page.fill('input[type="email"], input[name="email"]', TEST_USERNAME);
    await page.fill('input[type="password"], input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#messages, #chatShell')).toBeVisible({ timeout: 15_000 });
  });

  test('device key survives a reload (IndexedDB-backed CryptoKey)', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.fill('input[type="email"], input[name="email"]', TEST_USERNAME);
    await page.fill('input[type="password"], input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#messages, #chatShell')).toBeVisible({ timeout: 15_000 });

    const dbNamesBefore = await page.evaluate(() => indexedDB.databases().then((dbs) => dbs.map((d) => d.name)));
    await page.reload();
    await expect(page.locator('#messages, #chatShell')).toBeVisible({ timeout: 15_000 });
    const dbNamesAfter = await page.evaluate(() => indexedDB.databases().then((dbs) => dbs.map((d) => d.name)));
    expect(dbNamesAfter).toEqual(expect.arrayContaining(dbNamesBefore));
  });
});

test.describe('microphone permission', () => {
  test.skip(!BASE_URL || !TEST_USERNAME || !TEST_PASSWORD,
    'CHROME_BETA_SMOKE_BASE_URL / _USERNAME / _PASSWORD not set — no seeded test account to log in with');

  test('getUserMedia(audio) grant path does not throw with a fake device', async ({ page, context }) => {
    await context.grantPermissions(['microphone'], { origin: BASE_URL });
    await page.goto(BASE_URL);
    await page.fill('input[type="email"], input[name="email"]', TEST_USERNAME);
    await page.fill('input[type="password"], input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    const err = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(err).toBeNull();
  });
});
