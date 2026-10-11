/* Regenerates the store images: two 1280x800 screenshots of the real extension drawing a real repository
   (github.com/udaykishore-resu/idem), and the 440x280 promo tile.

   The repository archive is downloaded by the extension itself. Where GitHub's archive hosts are blocked but
   `git clone` works, the script clones the repository and answers the extension's request with the zip that
   `git archive` makes. To use a zip you already have:  REPODAG_E2E_ZIP=/path/to/idem.zip npm run screenshots */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cloneArchive, serveArchive } = require('../e2e/real-archive.js');

const EXT = path.resolve(__dirname, '..', 'extension');
const OUT = __dirname;
const REPO = 'udaykishore-resu/idem';
const LOCAL_ZIP = process.env.REPODAG_E2E_ZIP || '';

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const opts = {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
  };
  if (process.env.HTTPS_PROXY) opts.proxy = { server: process.env.HTTPS_PROXY };
  const ctx = await chromium.launchPersistentContext(dir, opts);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  return { ctx, id: new URL(sw.url()).host };
}

async function clickNode(page, id) {
  const box = await page.evaluate((nid) => {
    const el = [...document.querySelectorAll('#nodes .node')].find((n) => n.getAttribute('data-id') === nid);
    if (!el) return null;
    const r = el.querySelector('.box').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  if (box) await page.mouse.click(box.x, box.y);
  return !!box;
}

const PROMO = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 440px; height: 280px; }
  body { background: #f1f3ee; color: #18222b; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; position: relative; overflow: hidden; }
  h1 { position: absolute; left: 28px; top: 30px; margin: 0; font-size: 34px; font-weight: 680; letter-spacing: -0.5px; }
  p { position: absolute; left: 28px; top: 78px; margin: 0; width: 250px; font-size: 15px; line-height: 1.35; color: #51606b; }
  svg { position: absolute; left: 0; top: 0; }
</style></head><body>
<svg width="440" height="280" viewBox="0 0 440 280" xmlns="http://www.w3.org/2000/svg">
  <g fill="#e2e6dc"><rect x="26" y="146" width="96" height="112" rx="6"/><rect x="172" y="146" width="96" height="112" rx="6"/><rect x="318" y="146" width="96" height="112" rx="6"/></g>
  <g fill="none" stroke="#7d8a92" stroke-width="1.6">
    <path d="M112 202 C142 202 142 176 182 176"/><path d="M112 202 C142 202 142 228 182 228"/>
    <path d="M258 176 C288 176 288 202 328 202"/><path d="M258 228 C288 228 288 202 328 202"/>
  </g>
  <path d="M328 210 C250 262 190 262 112 210" fill="none" stroke="#b3261e" stroke-width="1.8" stroke-dasharray="6 4"/>
  <path d="M112 210 l9 1 l-5 7 z" fill="#b3261e"/>
  <g fill="#7d8a92"><path d="M182 176 l-8 -4 v8 z"/><path d="M182 228 l-8 -4 v8 z"/><path d="M328 202 l-8 -4 v8 z"/></g>
  <g fill="#ffffff" stroke="#9aa59f"><rect x="36" y="190" width="76" height="24" rx="3"/><rect x="182" y="164" width="76" height="24" rx="3"/><rect x="182" y="216" width="76" height="24" rx="3"/><rect x="328" y="190" width="76" height="24" rx="3"/></g>
  <rect x="37.5" y="191.5" width="5" height="21" rx="1.5" fill="#e69f00"/><rect x="183.5" y="165.5" width="5" height="21" rx="1.5" fill="#56b4e9"/>
  <rect x="183.5" y="217.5" width="5" height="21" rx="1.5" fill="#56b4e9"/><rect x="329.5" y="191.5" width="5" height="21" rx="1.5" fill="#009e73"/>
  <g fill="#18222b" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="11"><text x="48" y="206">cmd/</text><text x="194" y="180">api/</text><text x="194" y="232">store/</text><text x="340" y="206">log/</text></g>
</svg>
<h1>RepoDAG</h1>
<p>See how a repository fits together, left to right.</p>
</body></html>`;

(async () => {
  const { ctx, id } = await launch();
  if (LOCAL_ZIP) await serveArchive(ctx, REPO, LOCAL_ZIP);
  const page = await ctx.newPage();
  const settled = () => page.waitForFunction(() => !document.getElementById('strip').hasAttribute('hidden') || document.getElementById('error-text'), null, { timeout: 120000 });
  await page.goto('chrome-extension://' + id + '/viewer.html?repo=' + REPO + '&ref=HEAD');
  await settled();
  if (!LOCAL_ZIP && (await page.$('#error-text'))) {
    console.log('the extension could not download the archive here; cloning ' + REPO + ' instead');
    const made = cloneArchive(REPO);
    if (made.error) throw new Error(made.error + '. Pass a zip with REPODAG_E2E_ZIP.');
    await serveArchive(ctx, REPO, made.file);
    await page.goto('chrome-extension://' + id + '/viewer.html?repo=' + REPO + '&ref=HEAD');
    await settled();
  }
  if (await page.$('#error-text')) throw new Error('The repository did not load: ' + (await page.textContent('#message')));

  // 1: code imports, with one package selected so the details panel is filled
  await page.click('#tab-code');
  await page.waitForTimeout(300);
  const ids = await page.evaluate(() => [...document.querySelectorAll('#nodes .node')].map((n) => n.getAttribute('data-id')));
  const pick = ids.includes('idemhttp/') ? 'idemhttp/' : ids[0];
  await clickNode(page, pick);
  await page.mouse.move(640, 790);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'repodag-screenshot-1.png') });
  console.log('screenshot 1: code imports,', ids.length, 'nodes, selected', pick);

  // 2: the same repository with tests included: the external test packages (package x_test) appear as nodes of
  // their own, and one package is selected to show which of them use it. No cycle is staged: Go has none.
  await page.keyboard.press('Escape');
  await page.check('#include-tests');
  await page.waitForTimeout(300);
  const withTests = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('#nodes .node')].map((n) => n.getAttribute('data-id')),
    testPackages: document.querySelectorAll('#nodes .node.tests').length,
    cycles: document.querySelectorAll('#cycles button').length,
  }));
  const pick2 = withTests.ids.includes('memstore/') ? 'memstore/' : withTests.ids[0];
  await page.click('#zoom-fit');
  await clickNode(page, pick2);
  await page.mouse.move(640, 790);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'repodag-screenshot-2.png') });
  console.log('screenshot 2: tests included,', withTests.ids.length, 'nodes,', withTests.testPackages, 'external test packages,', withTests.cycles, 'cycles, selected', pick2);

  // promo tile
  const promo = await ctx.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  await promo.setContent(PROMO);
  await promo.screenshot({ path: path.join(OUT, 'repodag-promo-440x280.png') });
  console.log('promo tile written');
  await ctx.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
