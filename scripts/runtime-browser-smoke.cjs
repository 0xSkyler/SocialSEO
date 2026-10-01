const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// Playwright browsers are installed project-locally by this repository's
// `browsers:install` script (PLAYWRIGHT_BROWSERS_PATH=0). When this smoke test
// is invoked directly with `node`, that environment variable may be absent,
// causing Playwright to look in the user's global ms-playwright cache instead.
// Resolve the project-local browser directory before requiring Playwright.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const localBrowsers = path.resolve(
    __dirname,
    '..',
    'node_modules',
    'playwright-core',
    '.local-browsers'
  );
  if (fs.existsSync(localBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
  }
}

const { chromium } = require('playwright');

const TIMEOUT_MS = 25_000;

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    })
  ]).finally(() => clearTimeout(timer));
}

async function startSmokeServer() {
  const html = `<!doctype html><html><body>
    <input id="field" aria-label="field">
    <button id="go" onclick="document.querySelector('#out').textContent=document.querySelector('#field').value">Go</button>
    <div id="out"></div><div style="height:1400px"></div>
  </body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    });
    res.end(html);
  });

  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), 'smoke server start');

  const address = server.address();
  assert(address && typeof address !== 'string', 'Expected an IPv4/IPv6 server address');

  return {
    server,
    url: `http://127.0.0.1:${address.port}/`
  };
}

async function closeServer(server) {
  if (!server) return;
  await bounded(new Promise((resolve) => server.close(resolve)), 'smoke server close').catch(() => undefined);
}

async function checkChromium(url) {
  let browser;
  let context;
  let freshContext;

  try {
    browser = await bounded(chromium.launch({ headless: true }), 'Chromium launch');

    context = await bounded(
      browser.newContext({ viewport: { width: 390, height: 844 } }),
      'Chromium context'
    );
    const page = await bounded(context.newPage(), 'Chromium page');
    await bounded(page.goto(url, { waitUntil: 'domcontentloaded' }), 'Chromium local page load');

    await page.locator('#field').click();
    await page.keyboard.type('Social SEO');
    await page.locator('#go').click();
    assert.equal(await page.locator('#out').textContent(), 'Social SEO');
    await page.mouse.wheel(0, 500);

    // Storage is intentionally tested on a real local HTTP origin. about:blank,
    // data: URLs and page.setContent() can have opaque origins where Chromium
    // correctly denies localStorage access with SecurityError.
    await page.evaluate(() => localStorage.setItem('runtime-smoke', 'isolated'));
    assert.equal(
      await page.evaluate(() => localStorage.getItem('runtime-smoke')),
      'isolated'
    );

    await bounded(context.close(), 'Chromium context close');
    context = undefined;

    // Social SEO uses non-persistent contexts. Verify a fresh context does not
    // inherit storage from the previous task.
    freshContext = await bounded(
      browser.newContext({ viewport: { width: 390, height: 844 } }),
      'Chromium fresh context'
    );
    const freshPage = await bounded(freshContext.newPage(), 'Chromium fresh page');
    await bounded(freshPage.goto(url, { waitUntil: 'domcontentloaded' }), 'Chromium fresh local page load');
    assert.equal(
      await freshPage.evaluate(() => localStorage.getItem('runtime-smoke')),
      null,
      'Fresh non-persistent context unexpectedly inherited localStorage'
    );

    await bounded(freshContext.close(), 'Chromium fresh context close');
    freshContext = undefined;

    console.log('Chromium: PASS');
  } finally {
    if (freshContext) await bounded(freshContext.close(), 'Chromium fresh context cleanup').catch(() => undefined);
    if (context) await bounded(context.close(), 'Chromium context cleanup').catch(() => undefined);
    if (browser) await bounded(browser.close(), 'Chromium browser close').catch(() => undefined);
  }
}

(async () => {
  let server;
  try {
    const smoke = await startSmokeServer();
    server = smoke.server;
    await checkChromium(smoke.url);
    console.log('Bundled Playwright browser runtime smoke: PASS');
  } finally {
    await closeServer(server);
  }
})().catch((error) => {
  console.error('Bundled Playwright browser runtime smoke: FAIL');
  console.error(error);
  process.exitCode = 1;
});
