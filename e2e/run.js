/* End-to-end check: loads the unpacked extension in Chromium and drives the real viewer and popup pages.

   The "real archive" part maps github.com/udaykishore-resu/idem through the extension, exactly as a user would.
   The extension's own download is tried first. Where GitHub's archive hosts are blocked but `git clone` works
   (some sandboxes and proxies), the harness clones the repository, makes the same zip with `git archive` and answers
   the extension's request with it; the log says which of the two happened. To skip both and use a zip you already
   have:  REPODAG_E2E_ZIP=/path/to/idem.zip npm run e2e
   Everything else uses the small repository in e2e/fixtures/demo-repo, whose graph is known exactly. */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeZip, zipDirectory } = require('../test/helpers/make-zip.js');
const { cloneArchive, serveArchive } = require('./real-archive.js');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(__dirname, 'out');
const FIXTURE = path.join(__dirname, 'fixtures', 'demo-repo');
const REAL_ZIP = process.env.REPODAG_E2E_ZIP || '';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repodag-e2e-'));
  const opts = {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
  };
  if (process.env.HTTPS_PROXY) opts.proxy = { server: process.env.HTTPS_PROXY };
  const ctx = await chromium.launchPersistentContext(dir, opts);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  return { ctx, sw, id: new URL(sw.url()).host };
}

/* ---- helpers that look at the page the way a user would ---- */

const loaded = (page) =>
  page.waitForFunction(() => !document.getElementById('strip').hasAttribute('hidden') || document.getElementById('error-text'), null, { timeout: 120000 });

const snapshot = (page) =>
  page.evaluate(() => {
    const num = (label) => {
      for (const div of document.querySelectorAll('#summary div')) {
        if (div.querySelector('dt').textContent.startsWith(label)) return Number(div.querySelector('dd').textContent.replace(/,/g, ''));
      }
      return null;
    };
    const msg = document.getElementById('message');
    return {
      nodes: document.querySelectorAll('#nodes .node').length,
      edges: document.querySelectorAll('#edges .edge').length,
      cycleEdges: document.querySelectorAll('#edges .edge.cycle').length,
      summaryNodes: num('node'),
      summaryEdges: num('edge'),
      summaryCycles: num('cycle'),
      scanned: num('files scanned'),
      skipped: num('skipped'),
      message: msg.hasAttribute('hidden') ? null : msg.textContent,
      graphShown: !document.getElementById('graph').hasAttribute('hidden'),
    };
  });

const nodeIds = (page) => page.evaluate(() => [...document.querySelectorAll('#nodes .node')].map((n) => n.getAttribute('data-id')).sort());

/* Clicks the middle of a node with a real mouse click. */
async function clickNode(page, id) {
  const box = await page.evaluate((nid) => {
    const el = [...document.querySelectorAll('#nodes .node')].find((n) => n.getAttribute('data-id') === nid);
    if (!el) return null;
    const r = el.querySelector('.box').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  if (!box) throw new Error('node not drawn: ' + id);
  await page.mouse.click(box.x, box.y);
}

const transformOf = (page) => page.evaluate(() => document.getElementById('viewport').getAttribute('transform'));

/* Clicks a Download button and returns the file. Headless Chromium now and then drops one of several downloads
   made in quick succession (its multiple-download guard has no prompt to show), so a silent miss gets one more click. */
async function download(page, selector) {
  let dl = null;
  for (let attempt = 0; attempt < 2 && !dl; attempt++) {
    [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click(selector)]);
  }
  if (!dl) throw new Error('no download after two clicks on ' + selector);
  const file = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(file, 'utf8') };
}

/* Collects page errors and console errors. Chromium itself logs "Failed to load resource" for every 4xx answer;
   on the page that provokes 403 and 404 on purpose those lines are expected and left out. */
function watch(page, sink, expectHttpErrors) {
  page.on('pageerror', (e) => sink.push('pageerror: ' + String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectHttpErrors && /^Failed to load resource: the server responded with a status of 40[34]/.test(m.text())) return;
    sink.push('console: ' + m.text());
  });
}

/* ------------------------------------------------------------------ 1. a real repository, end to end */

async function realRepository(ctx, id, errors) {
  const SLUG = 'udaykishore-resu/idem';
  console.log('\n=== A real repository through the GitHub path (' + SLUG + ') ===');
  const page = await ctx.newPage();
  // a blocked archive host shows up as a 403 in the console; that is the case the fallback below handles
  watch(page, errors, !REAL_ZIP);
  let answered = null;
  let how = 'downloaded by the extension from github.com';
  if (REAL_ZIP) {
    answered = await serveArchive(ctx, SLUG, REAL_ZIP);
    how = 'answered from ' + REAL_ZIP;
  }
  await page.goto('chrome-extension://' + id + '/viewer.html?repo=' + SLUG + '&ref=HEAD');
  await loaded(page);
  if (!REAL_ZIP && (await page.$('#error-text'))) {
    const why = (await page.textContent('#message')).replace(/\s+/g, ' ').slice(0, 110);
    console.log('(the extension could not download the archive here: "' + why + '…")');
    const made = cloneArchive(SLUG);
    if (made.error) {
      check('real archive: downloaded, unpacked and scanned', false, made.error + '. Pass a zip with REPODAG_E2E_ZIP.');
      await page.close();
      return;
    }
    answered = await serveArchive(ctx, SLUG, made.file);
    how = 'answered from a fresh clone, ' + made.note;
    await page.click('button:has-text("Try again")');
    await page.waitForFunction(() => !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 120000 }).catch(() => {});
  }
  console.log('(archive ' + how + ')');
  const first = await snapshot(page);
  check('real archive: downloaded, unpacked and scanned', first.message === null && first.scanned > 10, { scanned: first.scanned, message: first.message && first.message.slice(0, 160) });
  if (answered) check('real archive: the request the extension made was the GitHub archive URL', answered() === 1, answered());
  check('real archive: header names the repository and links to it', (await page.textContent('#repo-link')) === SLUG && (await page.getAttribute('#repo-link', 'href')) === 'https://github.com/' + SLUG);
  const perTab = {};
  for (const tab of ['code', 'ci', 'packages']) {
    await page.click('#tab-' + tab);
    perTab[tab] = await snapshot(page);
  }
  check('real archive: code imports tab draws nodes and edges', perTab.code.nodes >= 3 && perTab.code.edges >= 2 && perTab.code.nodes === perTab.code.summaryNodes, perTab.code);
  check('real archive: CI pipeline tab draws its jobs', perTab.ci.nodes >= 1 && perTab.ci.nodes === perTab.ci.summaryNodes, { nodes: perTab.ci.nodes });
  check('real archive: third-party packages tab draws manifests and packages', perTab.packages.nodes >= 2 && perTab.packages.edges >= 1, { nodes: perTab.packages.nodes, edges: perTab.packages.edges });
  await page.click('#tab-code');
  const stats = await page.evaluate(() => [...document.querySelectorAll('#stats tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)));
  check('real archive: import counts per language are listed', stats.length >= 1 && stats[0][0] === 'Go' && Number(stats[0][2].replace(/,/g, '')) > 0, stats);
  await page.screenshot({ path: path.join(OUT, 'real-code.png') });
  await page.close();
  if (answered) await ctx.unroute('https://github.com/' + SLUG + '/archive/**');
}

/* ------------------------------------------------------------------ 2. the fixture, every feature */

async function fixtureThroughGitHubPath(ctx, id, errors) {
  console.log('\n=== Fixture repository through the GitHub path (acme/demo) ===');
  const zip = zipDirectory(FIXTURE, 'demo-v1');
  const requests = [];
  await ctx.route('https://github.com/acme/**', async (r) => {
    const url = r.request().url();
    requests.push(url);
    if (url === 'https://github.com/acme/demo/archive/slow.zip') {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return r.fulfill({ status: 200, contentType: 'application/zip', body: zip }).catch(() => {});
    }
    if (url === 'https://github.com/acme/demo/archive/v1.zip') return r.fulfill({ status: 200, contentType: 'application/zip', body: zip });
    if (url === 'https://github.com/acme/demo/archive/html.zip') return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in</title>' });
    if (url === 'https://github.com/acme/demo/archive/forbidden.zip') return r.fulfill({ status: 403, contentType: 'text/plain', body: 'no' });
    return r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
  });
  const page = await ctx.newPage();
  watch(page, errors, true);
  await page.goto('chrome-extension://' + id + '/viewer.html?repo=acme/demo&ref=v1');
  await loaded(page);

  let s = await snapshot(page);
  check('fixture: files view has the 12 expected nodes and 12 edges', s.nodes === 12 && s.edges === 12 && s.summaryNodes === 12 && s.summaryEdges === 12, s);
  check('fixture: 18 files scanned, none skipped', s.scanned === 18 && s.skipped === 0, { scanned: s.scanned, skipped: s.skipped });
  check('fixture: Go is drawn per package, TypeScript and Python per file',
    JSON.stringify(await nodeIds(page)) === JSON.stringify([
      'cmd/demo/', 'internal/api/', 'internal/store/', 'internal/testkit/', 'scripts/helpers.py', 'scripts/tool.py',
      'web/src/app.ts', 'web/src/events.ts', 'web/src/main.ts', 'web/src/orphan.ts', 'web/src/state.ts', 'web/src/util/format.ts',
    ]), await nodeIds(page));
  check('fixture: one cycle found, one edge drawn against the flow (red and dashed)', s.summaryCycles === 1 && s.cycleEdges === 1, { cycles: s.summaryCycles, cycleEdges: s.cycleEdges });
  const cycleStyle = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#edges .edge.cycle'));
    const normal = getComputedStyle(document.querySelector('#edges .edge:not(.cycle)'));
    return { stroke: cs.stroke, dash: cs.strokeDasharray, normalStroke: normal.stroke, normalDash: normal.strokeDasharray };
  });
  check('fixture: the cycle edge differs by colour and by dash, not colour alone', cycleStyle.stroke !== cycleStyle.normalStroke && cycleStyle.dash !== 'none' && cycleStyle.normalDash === 'none', cycleStyle);

  // layout sanity straight from the DOM: no overlapping boxes, edges run left to right
  const geometry = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#nodes .node .box')].map((b) => b.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps++;
      }
    }
    let backwards = 0;
    for (const p of document.querySelectorAll('#edges .edge')) {
      const len = p.getTotalLength();
      if (p.getPointAtLength(len).x < p.getPointAtLength(0).x) backwards++;
    }
    const stage = document.getElementById('graph').getBoundingClientRect();
    const inside = boxes.every((b) => b.left >= stage.left && b.right <= stage.right && b.top >= stage.top && b.bottom <= stage.bottom);
    return { overlaps, backwards, inside };
  });
  check('fixture: no node overlaps another, every path runs left to right, the first view shows the whole graph', geometry.overlaps === 0 && geometry.backwards === 0 && geometry.inside, geometry);

  // search
  await page.fill('#search', 'events');
  await page.waitForFunction(() => document.querySelectorAll('#nodes .node.hit').length > 0, null, { timeout: 5000 }).catch(() => {});
  const hits = await page.evaluate(() => [...document.querySelectorAll('#nodes .node.hit')].map((n) => n.getAttribute('data-id')));
  check('search: typing a name highlights the matching node and says how many match', hits.length === 1 && hits[0] === 'web/src/events.ts' && /1 of 12 match/.test(await page.textContent('#search-count')), { hits, text: await page.textContent('#search-count') });
  await page.press('#search', 'Enter');
  check('search: Enter jumps to the match and opens its details', (await page.textContent('#detail-title')) === 'web/src/events.ts');
  await page.fill('#search', 'zzz-nothing');
  await page.waitForFunction(() => /No node matches/.test(document.getElementById('search-count').textContent), null, { timeout: 5000 }).catch(() => {});
  check('search: no match is said in words', /No node matches "zzz-nothing"/.test(await page.textContent('#search-count')));
  await page.fill('#search', '');
  await page.waitForFunction(() => !document.getElementById('graph').classList.contains('has-search'), null, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press('Escape');

  // click a node
  await page.click('#zoom-fit');
  await clickNode(page, 'web/src/app.ts');
  const detail = await page.evaluate(() => ({
    title: document.getElementById('detail-title').textContent,
    text: document.getElementById('detail').textContent,
    link: (document.querySelector('#detail a') || {}).href,
    lit: [...document.querySelectorAll('#nodes .node.on')].map((n) => n.getAttribute('data-id')).sort(),
    litEdges: document.querySelectorAll('#edges .edge.on').length,
    dimmed: document.getElementById('graph').classList.contains('has-focus'),
  }));
  check('node click: side panel shows the path, what it depends on and what uses it',
    detail.title === 'web/src/app.ts' && /Depends on \(2\)/.test(detail.text) && /Used by \(2\)/.test(detail.text) && /TypeScript file/.test(detail.text), detail.text.slice(0, 200));
  check('node click: the node, its two dependencies and its two users are highlighted, the rest dimmed',
    JSON.stringify(detail.lit) === JSON.stringify(['web/src/app.ts', 'web/src/events.ts', 'web/src/main.ts', 'web/src/state.ts', 'web/src/util/format.ts']) && detail.litEdges === 4 && detail.dimmed, detail.lit);
  check('node click: link goes to the file on GitHub at the loaded ref', detail.link === 'https://github.com/acme/demo/blob/v1/web/src/app.ts', detail.link);
  await page.click('#detail .links button');
  check('side panel: choosing a listed neighbour moves the selection there', (await page.textContent('#detail-title')) !== 'web/src/app.ts');
  await page.click('#detail .close');
  check('side panel: Close clears the selection', (await page.evaluate(() => document.querySelectorAll('#nodes .node.on').length)) === 0 && (await page.isHidden('#detail')));

  // keyboard
  await page.focus('#nodes .node[tabindex="0"]');
  const focus0 = await page.evaluate(() => document.activeElement.getAttribute('data-id'));
  await page.keyboard.press('ArrowRight');
  const focus1 = await page.evaluate(() => document.activeElement.getAttribute('data-id'));
  await page.keyboard.press('Enter');
  const kbTitle = await page.textContent('#detail-title').catch(() => null);
  check('keyboard: exactly one node is in the tab order, arrows move between nodes, Enter selects',
    (await page.evaluate(() => document.querySelectorAll('#nodes .node[tabindex="0"]').length)) === 1 && !!focus0 && !!focus1 && focus0 !== focus1 && kbTitle === focus1.replace(/^\.\/$/, ''), { focus0, focus1, kbTitle });
  await page.keyboard.press('Escape');

  // zoom and pan
  const t0 = await transformOf(page);
  await page.click('#zoom-in');
  const t1 = await transformOf(page);
  const box = await page.locator('#graph').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.wheel(0, 240);
  const t2 = await transformOf(page);
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 90, { steps: 5 });
  await page.mouse.up();
  const t3 = await transformOf(page);
  await page.click('#zoom-fit');
  const t4 = await transformOf(page);
  check('zoom buttons, wheel and drag each move the view; Fit restores it', t1 !== t0 && t2 !== t1 && t3 !== t2 && t4 === t0, { t0, t4 });

  // aggregation
  await page.check('input[name="level"][value="packages"]');
  s = await snapshot(page);
  check('aggregation: Packages collapses files into 7 folders with 6 edges, and the in-folder cycle disappears', s.nodes === 7 && s.edges === 6 && s.summaryCycles === 0, s);
  const agg = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#nodes .node')].find((n) => n.getAttribute('data-id') === 'web/src/');
    return { badge: el.querySelector('.badge').textContent, selfLoops: 0 };
  });
  check('aggregation: a folder node shows how many files it holds', agg.badge === '5', agg);
  await clickNode(page, 'web/src/');
  const aggDetail = await page.textContent('#detail');
  check('aggregation: merged edges carry a count', /util\/.*×2/.test(aggDetail.replace(/\s+/g, ' ')), aggDetail.replace(/\s+/g, ' ').slice(0, 220));
  await page.click('#detail .close');
  await page.evaluate(() => {
    const d = document.getElementById('depth');
    d.value = '1';
    d.dispatchEvent(new Event('input', { bubbles: true }));
    d.dispatchEvent(new Event('change', { bubbles: true }));
  });
  s = await snapshot(page);
  check('aggregation: the depth slider switches to folders and changes the node count', s.nodes === 4 && (await page.isChecked('input[name="level"][value="folders"]')), { nodes: s.nodes, ids: await nodeIds(page) });
  await page.check('input[name="level"][value="files"]');

  // tests toggle
  await page.check('#include-tests');
  s = await snapshot(page);
  check('tests toggle: including tests adds the Go external test package as its own node with its two imports, and no cycle',
    s.nodes === 13 && s.edges === 14 && s.summaryCycles === 1 && (await nodeIds(page)).includes('internal/api/api_test'), { nodes: s.nodes, edges: s.edges, cycles: s.summaryCycles });
  await clickNode(page, 'internal/api/api_test');
  const xtest = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#nodes .node')].find((n) => n.getAttribute('data-id') === 'internal/api/api_test');
    return {
      label: el.querySelector('text.label').textContent,
      dash: getComputedStyle(el.querySelector('.box')).strokeDasharray,
      plainDash: getComputedStyle(document.querySelector('#nodes .node:not(.tests) .box')).strokeDasharray,
      title: document.getElementById('detail-title').textContent,
      text: document.getElementById('detail').textContent.replace(/\s+/g, ' '),
      link: (document.querySelector('#detail a') || {}).href,
      lit: [...document.querySelectorAll('#nodes .node.on')].map((n) => n.getAttribute('data-id')).sort(),
      legend: !document.getElementById('legend-tests').hasAttribute('hidden'),
    };
  });
  check('tests toggle: the test package is labelled api_test, drawn with a dashed outline and explained in the legend',
    xtest.label === 'api_test' && xtest.dash !== 'none' && xtest.plainDash === 'none' && xtest.legend, { label: xtest.label, dash: xtest.dash, legend: xtest.legend });
  check('tests toggle: its details name the package, list its file, link to the real folder and show what it imports',
    xtest.title === 'api_test' && /Go external test package in internal\/api\/, 1 file/.test(xtest.text) && /Depends on \(2\)/.test(xtest.text) && /Used by \(0\)/.test(xtest.text) && /internal\/api\/api_test\.go/.test(xtest.text) &&
      xtest.link === 'https://github.com/acme/demo/tree/v1/internal/api' && JSON.stringify(xtest.lit) === JSON.stringify(['internal/api/', 'internal/api/api_test', 'internal/testkit/']),
    { text: xtest.text.slice(0, 160), link: xtest.link, lit: xtest.lit });
  await page.click('#detail .close');
  await page.check('input[name="level"][value="packages"]');
  s = await snapshot(page);
  check('tests toggle: at packages level the test package stays apart from internal/api/', (await nodeIds(page)).includes('internal/api/api_test') && s.summaryCycles === 0, { nodes: s.nodes, cycles: s.summaryCycles });
  await page.check('input[name="level"][value="files"]');
  await page.uncheck('#include-tests');
  s = await snapshot(page);
  check('tests toggle: switching tests off removes the test package again', s.nodes === 12 && s.edges === 12 && !(await nodeIds(page)).includes('internal/api/api_test') && (await page.isHidden('#legend-tests')), { nodes: s.nodes, edges: s.edges });

  // colour by
  const legendFolder = await page.evaluate(() => [...document.querySelectorAll('#legend .name')].map((n) => n.textContent));
  await page.selectOption('#group-by', 'language');
  const legendLang = await page.evaluate(() => [...document.querySelectorAll('#legend .name')].map((n) => n.textContent));
  check('legend: lists the groups, and switches between folders and languages', legendFolder.includes('web/') && JSON.stringify(legendLang) === JSON.stringify(['TypeScript', 'Go', 'Python']), { legendFolder, legendLang });
  await page.selectOption('#group-by', 'folder');

  // cycle highlighting
  s = await snapshot(page);
  const cycleButton = '#cycles button[data-cycle="0"]';
  const cycleText = await page.textContent(cycleButton);
  await page.click(cycleButton);
  const cyc = await page.evaluate(() => ({
    lit: [...document.querySelectorAll('#nodes .node.on')].map((n) => n.getAttribute('data-id')).sort(),
    litEdges: document.querySelectorAll('#edges .edge.on').length,
    litCycleEdges: document.querySelectorAll('#edges .edge.cycle.on').length,
    pressed: document.querySelector('#cycles button[data-cycle="0"]').getAttribute('aria-pressed'),
    example: document.getElementById('cycle-example').textContent,
  }));
  check('cycles: the list names the three files of the known loop', /^3 files/.test(cycleText) && /app\.ts/.test(cycleText) && /events\.ts/.test(cycleText) && /state\.ts/.test(cycleText), cycleText);
  check('cycles: choosing it highlights exactly those three nodes and their three edges',
    JSON.stringify(cyc.lit) === JSON.stringify(['web/src/app.ts', 'web/src/events.ts', 'web/src/state.ts']) && cyc.litEdges === 3 && cyc.litCycleEdges === 1 && cyc.pressed === 'true', cyc);
  check('cycles: the side panel spells out one loop', /app\.ts\s+→\s+state\.ts\s+→\s+events\.ts\s+→\s+app\.ts/.test(cyc.example), cyc.example);
  await page.screenshot({ path: path.join(OUT, 'fixture-cycle.png') });
  await page.click(cycleButton);
  check('cycles: choosing it again clears the highlight', (await page.evaluate(() => document.querySelectorAll('#nodes .node.on').length)) === 0);

  // exports
  const svg = await download(page, '[data-export="svg"][data-how="download"]');
  const svgCheck = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    return { error: !!doc.querySelector('parsererror'), nodes: doc.querySelectorAll('g.node').length, edges: doc.querySelectorAll('path.edge').length, style: (doc.querySelector('style') || {}).textContent || '', vb: doc.documentElement.getAttribute('viewBox') };
  }, svg.text);
  check('export SVG: a standalone file that parses, with every node and edge and its own colours',
    svg.name === 'acme-demo-code.svg' && !svgCheck.error && svgCheck.nodes === 12 && svgCheck.edges === 12 && /stroke:/.test(svgCheck.style) && !/var\(--/.test(svg.text) && !!svgCheck.vb, { name: svg.name, nodes: svgCheck.nodes, edges: svgCheck.edges });
  const mmd = await download(page, '[data-export="mermaid"][data-how="download"]');
  check('export Mermaid: flowchart with 12 nodes, 12 edges, cycle edges dashed',
    mmd.name === 'acme-demo-code.mmd' && mmd.text.startsWith('flowchart LR\n') && (mmd.text.match(/^ {2}n\d+\[/gm) || []).length === 12 && (mmd.text.match(/-->|-\.->/g) || []).length === 12 && (mmd.text.match(/-\.->/g) || []).length === 3, mmd.text.split('\n').slice(0, 3));
  const dot = await download(page, '[data-export="dot"][data-how="download"]');
  check('export DOT: digraph with 12 nodes and 12 edges', dot.name === 'acme-demo-code.dot' && /^digraph "acme\/demo" \{/.test(dot.text) && (dot.text.match(/ -> /g) || []).length === 12 && dot.text.trim().endsWith('}'), dot.text.split('\n')[0]);
  const json = await download(page, '[data-export="json"][data-how="download"]');
  let parsed = null;
  try {
    parsed = JSON.parse(json.text);
  } catch (_) {
    /* reported below */
  }
  check('export JSON: parses, names the source and ref, lists nodes, edges and the cycle',
    !!parsed && parsed.source === 'https://github.com/acme/demo' && parsed.ref === 'v1' && parsed.nodes.length === 12 && parsed.edges.length === 12 && parsed.cycles.length === 1 && parsed.cycles[0].nodes.length === 3, parsed && { nodes: parsed.nodes.length, cycles: parsed.cycles.length });
  // Reading the clipboard back needs a permission prompt that automation cannot answer, so the text handed to
  // the real navigator.clipboard.writeText is recorded on its way through, and the page's own status is checked.
  await page.evaluate(() => {
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__copied = null;
    navigator.clipboard.writeText = (text) => {
      window.__copied = text;
      return real(text);
    };
  });
  await page.click('[data-export="mermaid"][data-how="copy"]');
  await page.waitForFunction(() => /Copied|did not allow/.test(document.getElementById('export-status').textContent), null, { timeout: 5000 }).catch(() => {});
  const copyStatus = await page.textContent('#export-status');
  const copied = await page.evaluate(() => window.__copied);
  check('copy: the Mermaid text is written to the clipboard and the page says so', /^Copied Mermaid/.test(copyStatus) && copied === mmd.text, { copyStatus, same: copied === mmd.text });

  // CI tab
  await page.click('#tab-ci');
  s = await snapshot(page);
  check('CI tab: five jobs, four needs edges and one reusable-workflow call', s.nodes === 5 && s.edges === 5 && s.summaryCycles === 0, s);
  const order = await page.evaluate(() => {
    const x = (id) => [...document.querySelectorAll('#nodes .node')].find((n) => n.getAttribute('data-id').endsWith('#' + id)).getBoundingClientRect().x;
    return ['lint', 'test', 'build', 'release', 'publish'].map(x);
  });
  check('CI tab: jobs read left to right in the order they run', order.every((v, i) => i === 0 || v > order[i - 1]), order);
  await clickNode(page, '.github/workflows/ci.yml#test');
  const job = await page.evaluate(() => ({
    title: document.getElementById('detail-title').textContent,
    text: document.getElementById('detail').textContent,
    steps: [...document.querySelectorAll('#steps li')].map((li) => li.textContent),
    uses: [...document.querySelectorAll('#uses li')].map((li) => li.textContent),
    link: (document.querySelector('#detail a') || {}).href,
  }));
  check('CI tab: job details show the name, runner, steps and actions used',
    job.title === 'Unit tests' && /Runs on\s*ubuntu-latest/.test(job.text) && JSON.stringify(job.steps) === JSON.stringify(['actions/checkout@v4', 'actions/setup-go@v5', 'go test ./...']) && JSON.stringify(job.uses) === JSON.stringify(['actions/checkout@v4', 'actions/setup-go@v5']) && /Waits for \(1\)/.test(job.text) && /Runs before \(1\)/.test(job.text),
    { title: job.title, steps: job.steps, uses: job.uses });
  check('CI tab: link goes to the workflow file', job.link === 'https://github.com/acme/demo/blob/v1/.github/workflows/ci.yml', job.link);
  const fonts = await page.evaluate(() => ({
    job: getComputedStyle(document.querySelector('#nodes .node text.label')).fontFamily,
    path: getComputedStyle(document.querySelector('.panel .kind')).fontFamily,
    devLegendHidden: document.getElementById('legend-dev').hasAttribute('hidden'),
  }));
  check('CI tab: job names are set in the interface font, not monospace', !/mono/i.test(fonts.job) && /system-ui|sans-serif/.test(fonts.job) && fonts.devLegendHidden, fonts.job.slice(0, 60));
  await page.screenshot({ path: path.join(OUT, 'fixture-ci.png') });
  const ciMmd = await download(page, '[data-export="mermaid"][data-how="download"]');
  check('CI tab: exports follow the tab', ciMmd.name === 'acme-demo-ci.mmd' && /Unit tests/.test(ciMmd.text));

  // packages tab
  await page.click('#tab-packages');
  s = await snapshot(page);
  check('packages tab: three manifests and four direct dependencies (the indirect Go one is left out)', s.nodes === 7 && s.edges === 4, s);
  const devMarks = await page.evaluate(() => {
    const dotted = [...document.querySelectorAll('#edges .edge.dev')];
    return {
      dotted: dotted.length,
      dash: dotted.length ? getComputedStyle(dotted[0]).strokeDasharray : 'none',
      plainDash: getComputedStyle(document.querySelector('#edges .edge:not(.dev)')).strokeDasharray,
      hollow: [...document.querySelectorAll('#nodes .node.devonly')].map((n) => n.getAttribute('data-id')).sort(),
      legend: !document.getElementById('legend-dev').hasAttribute('hidden'),
    };
  });
  check('packages tab: development-only dependencies are drawn dotted with a hollow dot, and the legend explains it',
    devMarks.dotted === 2 && devMarks.dash !== 'none' && devMarks.plainDash === 'none' && JSON.stringify(devMarks.hollow) === JSON.stringify(['dep:PyPI:pytest', 'dep:npm:vitest']) && devMarks.legend, devMarks);
  await page.uncheck('#include-dev');
  s = await snapshot(page);
  check('packages tab: hiding development dependencies removes vitest and pytest', s.nodes === 5 && s.edges === 2, { nodes: s.nodes, ids: await nodeIds(page) });
  await page.check('#include-dev');
  await page.check('#include-indirect');
  s = await snapshot(page);
  check('packages tab: indirect Go requirements can be shown', s.nodes === 8 && s.edges === 5, { nodes: s.nodes });
  await page.uncheck('#include-indirect');
  await clickNode(page, 'dep:npm:react');
  const dep = await page.textContent('#detail');
  check('packages tab: a package shows its version and who asks for it', /react/.test(dep) && /\^18\.3\.0/.test(dep) && /Asked for by \(1\)/.test(dep) && /package\.json/.test(dep), dep.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: path.join(OUT, 'fixture-packages.png') });

  // changing the ref
  await page.fill('#ref', 'does-not-exist');
  await page.click('#reload');
  await page.waitForSelector('#error-text', { timeout: 20000 });
  const notFound = await page.textContent('#message');
  check('ref box: a ref that does not exist gives a clear 404 message', /not found, or you are not signed in to an account that can see it/.test(notFound) && /acme\/demo at does-not-exist/.test(notFound), notFound.slice(0, 200));
  check('ref box: the request went to that ref', requests.includes('https://github.com/acme/demo/archive/does-not-exist.zip'), requests.slice(-2));
  check('ref box: the address bar keeps the ref', /ref=does-not-exist/.test(page.url()), page.url());
  await page.fill('#ref', 'forbidden');
  await page.click('#reload');
  await page.waitForFunction(() => /refused/.test(document.getElementById('message').textContent), null, { timeout: 20000 }).catch(() => {});
  check('errors: a 403 says GitHub refused and what to do', /GitHub refused the download/.test(await page.textContent('#message')) && /Sign in to GitHub/.test(await page.textContent('#message')));
  await page.fill('#ref', 'html');
  await page.click('#reload');
  await page.waitForFunction(() => /did not send an archive/.test(document.getElementById('message').textContent), null, { timeout: 20000 }).catch(() => {});
  check('errors: a response that is not a zip is refused instead of being parsed', /GitHub did not send an archive/.test(await page.textContent('#message')));
  await page.fill('#ref', 'bad ref');
  await page.click('#reload');
  check('errors: an impossible ref is caught before any request', /not a valid branch, tag or commit/.test(await page.textContent('#message')) && !requests.some((u) => /bad/.test(u)));
  await page.fill('#ref', 'slow');
  await page.click('#reload');
  await page.waitForSelector('#cancel', { timeout: 10000 });
  const busy = await page.textContent('#message');
  await page.click('#cancel');
  await page.waitForFunction(() => /cancelled/.test(document.getElementById('message').textContent), null, { timeout: 10000 }).catch(() => {});
  check('loading: progress is shown and Cancel stops the download', /Downloading acme\/demo at slow/.test(busy) && /Download cancelled/.test(await page.textContent('#message')), busy.slice(0, 80));
  await page.fill('#ref', 'v1');
  await page.click('#reload');
  await loaded(page);
  await page.waitForFunction(() => document.querySelectorAll('#nodes .node').length === 12, null, { timeout: 20000 }).catch(() => {});
  s = await snapshot(page);
  check('ref box: loading a good ref again brings the graph back', s.nodes === 12 && s.message === null, s);
  await page.close();
  await ctx.unroute('https://github.com/acme/**');
}

/* ------------------------------------------------------------------ 2b. the network path, against a stand-in for GitHub */

/* Route interception answers a request before it reaches the network stack, so it cannot show that the redirect to
   codeload.github.com is followed, that the content security policy lets it through, or that the session cookie is
   attached. This part starts a local HTTPS server, points github.com and codeload.github.com at it inside one
   browser, and lets the extension make its real request. It needs the openssl command for a throwaway certificate. */
async function standInForGitHub(errors) {
  console.log('\n=== The real request path, against a local stand-in for github.com ===');
  const https = require('https');
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repodag-cert-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=github.com', '-addext', 'subjectAltName=DNS:github.com,DNS:codeload.github.com'], { encoding: 'utf8' });
  if (made.error || made.status !== 0) {
    console.log('SKIP openssl is not available, so the stand-in server could not get a certificate');
    return;
  }
  const zip = zipDirectory(FIXTURE, 'demo-v1');
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const cookie = req.headers.cookie || '';
    seen.push({ host, url: req.url, cookie });
    const signedIn = /(^|;\s*)user_session=e2e-session/.test(cookie);
    if (host === 'github.com' && req.url === '/acme/demo/archive/v1.zip') {
      res.writeHead(302, { Location: 'https://codeload.github.com/acme/demo/zip/refs/tags/v1' });
      res.end();
    } else if (host === 'github.com' && req.url === '/acme/private/archive/HEAD.zip') {
      if (signedIn) res.writeHead(302, { Location: 'https://codeload.github.com/acme/private/zip/HEAD?token=T0KEN' });
      else res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(signedIn ? '' : 'Not Found');
    } else if (host === 'github.com' && req.url === '/acme/huge/archive/HEAD.zip') {
      // announces 250 MB and starts sending: the viewer must refuse on the announcement and stop the transfer
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': 250 * 1024 * 1024 });
      res.write(Buffer.alloc(64 * 1024, 0x50));
      req.on('close', () => seen.push({ host, url: 'closed ' + req.url, cookie: '' }));
    } else if (host === 'codeload.github.com' && (req.url === '/acme/demo/zip/refs/tags/v1' || req.url === '/acme/private/zip/HEAD?token=T0KEN')) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': 'attachment; filename=demo-v1.zip' });
      res.end(zip);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'repodag-e2e-net-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      '--host-resolver-rules=MAP github.com 127.0.0.1:' + port + ', MAP codeload.github.com 127.0.0.1:' + port,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    watch(page, errors, true);
    await page.goto('chrome-extension://' + id + '/viewer.html?repo=acme/demo&ref=v1');
    await loaded(page);
    let s = await snapshot(page);
    const hops = seen.map((r) => r.host + r.url);
    check('network: the archive request is redirected to codeload.github.com and followed', JSON.stringify(hops) === JSON.stringify(['github.com/acme/demo/archive/v1.zip', 'codeload.github.com/acme/demo/zip/refs/tags/v1']), hops);
    check('network: the downloaded archive is unpacked and drawn', s.nodes === 12 && s.edges === 12 && s.message === null, { nodes: s.nodes, message: s.message && s.message.slice(0, 120) });

    seen.length = 0;
    await page.goto('chrome-extension://' + id + '/viewer.html?repo=acme/private&ref=HEAD');
    await page.waitForSelector('#error-text', { timeout: 30000 });
    check('network: a private repository without a session is reported as not found or not signed in', /not signed in to an account that can see it/.test(await page.textContent('#message')) && seen.length === 1 && seen[0].cookie === '', seen);

    // the same attributes GitHub gives its session cookie
    await ctx.addCookies([{ name: 'user_session', value: 'e2e-session', domain: 'github.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    seen.length = 0;
    await page.click('button:has-text("Try again")');
    await page.waitForFunction(() => !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 30000 }).catch(() => {});
    s = await snapshot(page);
    check('network: with a GitHub session cookie the request carries it and the private archive loads', s.nodes === 12 && /user_session=e2e-session/.test((seen[0] || {}).cookie || '') && seen.length === 2, seen.map((r) => ({ url: r.host + r.url, cookie: r.cookie })));
    check('network: the session cookie is not passed on to codeload.github.com', seen.length === 2 && seen[1].cookie === '', seen[1]);
    const outside = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('chrome-extension://') && !u.startsWith('https://github.com/') && !u.startsWith('https://codeload.github.com/')) outside.push(u);
    });
    await page.fill('#ref', 'v9');
    await page.click('#reload');
    await page.waitForSelector('#error-text', { timeout: 30000 });
    check('network: no request goes anywhere but github.com and codeload.github.com', outside.length === 0, outside);

    seen.length = 0;
    await page.goto('chrome-extension://' + id + '/viewer.html?repo=acme/huge&ref=HEAD');
    await page.waitForSelector('#error-text', { timeout: 30000 });
    const huge = await page.textContent('#message');
    await page.waitForTimeout(500);
    check('network: an archive announced as over 200 MB is refused before it is downloaded, with a way forward',
      /This archive is too large/.test(huge) && /250 MB/.test(huge) && /Open a folder/.test(huge) && seen.some((r) => r.url === 'closed /acme/huge/archive/HEAD.zip'), { message: huge.slice(0, 120), seen: seen.map((r) => r.url) });
    await page.close();
  } finally {
    await ctx.close();
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
}

/* ------------------------------------------------------------------ 3. local files */

async function localMode(ctx, id, errors) {
  console.log('\n=== Local zip and folder ===');
  const page = await ctx.newPage();
  watch(page, errors);
  const outside = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('chrome-extension://')) outside.push(r.url());
  });
  await page.goto('chrome-extension://' + id + '/viewer.html?local=1');
  await page.waitForSelector('#landing-zip');
  check('local: the landing page offers a zip and a folder and says nothing is uploaded', /Nothing is uploaded/.test(await page.textContent('#message')) && (await page.isVisible('#landing-folder')) && (await page.isHidden('#strip')));

  const zipPath = path.join(OUT, 'demo-local.zip');
  fs.writeFileSync(zipPath, zipDirectory(FIXTURE, 'demo-main'));
  await page.setInputFiles('#zip-input', zipPath);
  await loaded(page);
  let s = await snapshot(page);
  check('local zip: same graph as through GitHub (12 nodes, 12 edges, 1 cycle)', s.nodes === 12 && s.edges === 12 && s.summaryCycles === 1 && s.scanned === 18, s);
  check('local zip: header shows the file name, with no ref box', (await page.textContent('#source-local')) === 'demo-local.zip' && (await page.isHidden('#source-form')));
  await clickNode(page, 'web/src/app.ts');
  check('local zip: details have no GitHub link', (await page.evaluate(() => document.querySelectorAll('#detail a').length)) === 0);
  await page.click('#detail .close');

  // dropping a zip on the page (a synthetic drop: the browser's own drag from the desktop cannot be automated)
  const dropped = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], 'dropped.zip', { type: 'application/zip' });
    const data = new DataTransfer();
    data.items.add(file);
    const stage = document.getElementById('stage');
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    const highlighted = document.getElementById('message').classList.contains('over');
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    return highlighted;
  }, [...zipDirectory(FIXTURE, 'demo-main')]);
  await page.waitForFunction(() => document.getElementById('source-local').textContent === 'dropped.zip' && !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 20000 }).catch(() => {});
  s = await snapshot(page);
  check('local zip: dropping a zip on the page loads it', s.nodes === 12 && s.edges === 12 && (await page.textContent('#source-local')) === 'dropped.zip', { nodes: s.nodes, highlighted: dropped });

  // a real drop from the desktop, driven through the DevTools protocol: first a zip, then a folder
  const cdp = await ctx.newCDPSession(page);
  const dropFromDesktop = async (target) => {
    const stage = await page.locator('#stage').boundingBox();
    const x = Math.round(stage.x + stage.width / 2);
    const y = Math.round(stage.y + stage.height / 2);
    const data = { items: [], files: [target], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
  };
  await page.goto('chrome-extension://' + id + '/viewer.html?local=1');
  await page.waitForSelector('#landing-zip');
  await dropFromDesktop(zipPath);
  await page.waitForFunction(() => document.getElementById('source-local').textContent === 'demo-local.zip' && !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 20000 }).catch(() => {});
  s = await snapshot(page);
  check('local zip: a zip dragged in from the desktop loads', s.nodes === 12 && s.edges === 12 && s.scanned === 18, { nodes: s.nodes, scanned: s.scanned });
  const droppedDir = path.join(OUT, 'dropped-repo');
  fs.rmSync(droppedDir, { recursive: true, force: true });
  fs.cpSync(FIXTURE, droppedDir, { recursive: true });
  fs.mkdirSync(path.join(droppedDir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(droppedDir, 'node_modules', 'left-pad', 'index.ts'), 'export {};\n');
  fs.mkdirSync(path.join(droppedDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(droppedDir, '.git', 'config'), '[core]\n');
  await dropFromDesktop(droppedDir);
  await page.waitForFunction(() => document.getElementById('source-local').textContent === 'dropped-repo' && !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 20000 }).catch(() => {});
  s = await snapshot(page);
  const droppedNotes = await page.textContent('#notes');
  check('local folder: a folder dragged in from the desktop gives the same graph', s.nodes === 12 && s.edges === 12 && s.summaryCycles === 1 && s.scanned === 18 && (await page.textContent('#source-local')) === 'dropped-repo', s);
  check('local folder: a dropped folder is walked without entering node_modules or .git', /18 files read out of 19 in the repository/.test(droppedNotes), droppedNotes.slice(0, 90));
  fs.rmSync(droppedDir, { recursive: true, force: true });

  // a zip with no wrapper folder, a stored entry, a file in an ignored folder, a minified file and an oversized one
  const odd = makeZip([
    { name: 'a.ts', data: "import './b';\nimport './node_modules/x/index';\n", method: 'store' },
    { name: 'b.ts', data: 'export {};\n' },
    { name: 'node_modules/x/index.ts', data: 'export {};\n' },
    { name: 'lib.min.js', data: 'var a=1;' },
    { name: 'huge.ts', data: '// filler\n'.repeat(120000) },
    { name: 'notes.txt', data: 'hello' },
  ]);
  const oddPath = path.join(OUT, 'odd.zip');
  fs.writeFileSync(oddPath, odd);
  await page.setInputFiles('#zip-input', oddPath);
  await page.waitForFunction(() => document.getElementById('source-local').textContent === 'odd.zip' && !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 20000 });
  s = await snapshot(page);
  const notes = await page.textContent('#notes');
  check('local zip: ignored folders, minified files and files over 1 MB are skipped and counted', s.nodes === 2 && s.edges === 1 && s.scanned === 2 && s.skipped === 3 && /1 in ignored folders/.test(notes) && /1 minified/.test(notes) && /1 over 1 MB/.test(notes), { s, notes: notes.slice(0, 260) });
  check('local zip: an import into an ignored folder is reported, not drawn', /1 import point into ignored folders/.test(notes), notes.slice(0, 400));

  // not a zip at all
  const junk = path.join(OUT, 'junk.zip');
  fs.writeFileSync(junk, Buffer.from('this is not a zip archive, just text pretending to be one. '.repeat(4)));
  await page.setInputFiles('#zip-input', junk);
  await page.waitForSelector('#error-text', { timeout: 20000 });
  check('errors: a file that is not a zip is explained', /could not be read/.test(await page.textContent('#message')) && /not a zip archive/.test(await page.textContent('#error-text')), await page.textContent('#error-text'));

  // too large: a sparse 201 MB file is refused before it is read
  const big = path.join(OUT, 'big.zip');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 201 * 1024 * 1024);
  await page.setInputFiles('#zip-input', big);
  await page.waitForFunction(() => /too large/.test(document.getElementById('message').textContent), null, { timeout: 20000 }).catch(() => {});
  check('errors: an archive over 200 MB is refused with a way forward', /This archive is too large/.test(await page.textContent('#message')) && /201 MB/.test(await page.textContent('#message')) && /Open a folder/.test(await page.textContent('#message')), (await page.textContent('#message')).slice(0, 200));
  fs.rmSync(big);

  // a repository with nothing RepoDAG reads
  const plain = path.join(OUT, 'plain.zip');
  fs.writeFileSync(plain, makeZip([{ name: 'docs/readme.md', data: '# hi' }, { name: 'data.csv', data: 'a,b' }]));
  await page.setInputFiles('#zip-input', plain);
  await page.waitForFunction(() => /No source files/.test(document.getElementById('message').textContent), null, { timeout: 20000 }).catch(() => {});
  check('empty states: no supported source files', /No source files in a supported language/.test(await page.textContent('#message')));
  check('empty states: nothing of the previous drawing is left behind', (await page.evaluate(() => document.querySelectorAll('#nodes .node, #edges .edge').length)) === 0);
  await page.click('#tab-ci');
  check('empty states: no workflows', /No GitHub Actions workflows here/.test(await page.textContent('#message')));
  await page.click('#tab-packages');
  check('empty states: no manifests', /No dependency manifests here/.test(await page.textContent('#message')));

  // folder input
  let folderOk = false;
  let folderNote = '';
  try {
    await page.setInputFiles('#folder-input', FIXTURE);
    await page.waitForFunction(() => document.getElementById('source-local').textContent === 'demo-repo' && !document.getElementById('strip').hasAttribute('hidden'), null, { timeout: 20000 });
    await page.click('#tab-code');
    s = await snapshot(page);
    folderOk = s.nodes === 12 && s.edges === 12 && s.summaryCycles === 1 && s.scanned === 18;
    folderNote = JSON.stringify(s);
  } catch (e) {
    folderNote = String(e).split('\n')[0];
  }
  check('local folder: choosing a folder gives the same graph', folderOk, folderNote);
  check('local mode made no network request at all', outside.length === 0, outside);
  await page.close();
}

/* ------------------------------------------------------------------ 4. size limits */

/* 6 areas x 60 modules = 360 folders. Each file imports up to three earlier files, so the graph is acyclic and well connected. */
function syntheticRepo(fileCount, dirCount) {
  const files = [{ name: 'big-main/', data: '' }];
  const dirOf = (i) => 'src/area' + Math.floor((i * 6) / fileCount) + '/mod' + String(i % dirCount).padStart(3, '0');
  for (let i = 0; i < fileCount; i++) {
    const dir = dirOf(i);
    const lines = [];
    for (const back of [1, 7, 31]) {
      const j = i - back * (1 + (i % 3));
      if (j >= 0) lines.push("import '" + path.posix.relative(dir, dirOf(j) + '/f' + j) + "';");
    }
    files.push({ name: 'big-main/' + dir + '/f' + i + '.ts', data: lines.join('\n') + '\nexport const v' + i + ' = ' + i + ';\n' });
  }
  return makeZip(files);
}

async function largeGraphs(ctx, id, errors) {
  console.log('\n=== A 1,500-file repository ===');
  const page = await ctx.newPage();
  watch(page, errors);
  const zipPath = path.join(OUT, 'big.zip');
  fs.writeFileSync(zipPath, syntheticRepo(1500, 60));
  await page.goto('chrome-extension://' + id + '/viewer.html?local=1');
  await page.waitForSelector('#landing-zip');
  const started = Date.now();
  await page.setInputFiles('#zip-input', zipPath);
  await loaded(page);
  const loadMs = Date.now() - started;
  let s = await snapshot(page);
  check('1,500 files: read, scanned and shown grouped by default', s.scanned === 1500 && s.graphShown && s.nodes > 0 && s.nodes <= 600 && loadMs < 30000, { nodes: s.nodes, loadMs });
  check('1,500 files: the default is folders two deep (6 nodes), because even packages would be 360', (await page.isChecked('input[name="level"][value="folders"]')) && s.nodes === 6, { nodes: s.nodes });
  await page.check('input[name="level"][value="files"]');
  s = await snapshot(page);
  check('1,500 files: the files view is not drawn; it explains why and offers grouping', !s.graphShown && /1,500 nodes is too many to read/.test(s.message) && /Show packages/.test(s.message) && s.summaryNodes === 1500, s.message && s.message.slice(0, 200));
  const mmd = await download(page, '[data-export="mermaid"][data-how="download"]');
  check('1,500 files: text exports still carry the whole view', (mmd.text.match(/^ {2}n\d+\[/gm) || []).length === 1500);
  check('1,500 files: the Mermaid export warns that Mermaid stops at 500 edges', /at most 500 edges by default and this view has [\d,]+/.test(await page.textContent('#export-status')), await page.textContent('#export-status'));
  await page.click('[data-export="svg"][data-how="download"]');
  check('1,500 files: SVG export says it needs a drawn view', /this view is not drawn/.test(await page.textContent('#export-status')));
  const drawStart = Date.now();
  await page.click('button:has-text("Draw all 1,500 anyway")');
  await page.waitForFunction(() => document.querySelectorAll('#nodes .node').length === 1500, null, { timeout: 60000 });
  const drawMs = Date.now() - drawStart;
  const box = await page.locator('#graph').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // time twenty wheel steps and a drag, each measured to the next painted frame
  const frameMs = await page.evaluate(async () => {
    const svg = document.getElementById('graph');
    const r = svg.getBoundingClientRect();
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      svg.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 ? 80 : -120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { median: Math.round(times[10]), worst: Math.round(times[19]) };
  });
  check('1,500 nodes drawn on request: drawing finishes, zooming stays responsive', drawMs < 30000 && frameMs.median < 250, { drawMs, frameMs });
  const selectMs = await page.evaluate(async () => {
    const el = document.querySelector('#nodes .node');
    const t = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, clientX: 1, clientY: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, button: 0, clientX: 1, clientY: 1 }));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return Math.round(performance.now() - t);
  });
  check('1,500 nodes drawn on request: selecting a node is quick', selectMs < 500, { selectMs });
  await page.click('#detail .close');
  await page.check('input[name="level"][value="packages"]');
  s = await snapshot(page);
  check('1,500 files: grouping by package draws all 360 folders', s.graphShown && s.nodes === 360, { nodes: s.nodes });
  await page.close();
}

/* ------------------------------------------------------------------ 5. popup */

async function popup(ctx, id, errors) {
  console.log('\n=== Popup ===');
  // Opened as a normal tab, the "current tab" is the popup page itself: not a repository.
  const plain = await ctx.newPage();
  watch(plain, errors);
  await plain.goto('chrome-extension://' + id + '/popup.html');
  await plain.waitForFunction(() => !document.getElementById('off-repo').hidden || !document.getElementById('on-repo').hidden);
  check('popup: on a tab that is not a repository it says so and still offers local files', (await plain.isVisible('#off-repo')) && (await plain.isHidden('#on-repo')) && (await plain.isVisible('#local')) && /not a GitHub repository/.test(await plain.textContent('#off-repo')));
  const [localTab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), plain.click('#local')]);
  await localTab.waitForSelector('#landing-zip');
  check('popup: "Open a zip or folder" opens the viewer in local mode', /viewer\.html\?local=1$/.test(localTab.url()), localTab.url());
  await localTab.close();
  if (!plain.isClosed()) await plain.close();

  // The toolbar click that grants activeTab cannot be automated, so the address of the current tab is supplied
  // by replacing chrome.tabs.query before the popup script runs. Everything after that is the real popup.
  for (const [tabUrl, expectRepo, expectQuery] of [
    ['https://github.com/acme/demo/tree/dev/src', 'acme/demo at dev', '?repo=acme%2Fdemo&ref=dev'],
    ['https://github.com/acme/demo/issues/3', 'acme/demo', '?repo=acme%2Fdemo&ref=HEAD'],
  ]) {
    const pop = await ctx.newPage();
    watch(pop, errors);
    await pop.addInitScript((url) => {
      chrome.tabs.query = async () => [{ id: 1, url }];
    }, tabUrl);
    await pop.goto('chrome-extension://' + id + '/popup.html');
    await pop.waitForFunction(() => !document.getElementById('off-repo').hidden || !document.getElementById('on-repo').hidden);
    const shown = await pop.textContent('#repo');
    const [viewer] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), pop.click('#map')]);
    check('popup: on ' + tabUrl + ' it shows "' + expectRepo + '" and opens the viewer for it', shown === expectRepo && viewer.url().endsWith('/viewer.html' + expectQuery), { shown, url: viewer.url() });
    await viewer.close();
    if (!pop.isClosed()) await pop.close();
  }
  const settings = await ctx.newPage();
  await settings.addInitScript(() => {
    chrome.tabs.query = async () => [{ id: 1, url: 'https://github.com/settings/profile' }];
  });
  await settings.goto('chrome-extension://' + id + '/popup.html');
  await settings.waitForFunction(() => !document.getElementById('off-repo').hidden || !document.getElementById('on-repo').hidden);
  check('popup: GitHub pages that are not repositories are not offered', await settings.isVisible('#off-repo'));
  await settings.close();
}

/* ------------------------------------------------------------------ 6. the extension as a whole */

async function extensionShape(ctx, sw, errors) {
  console.log('\n=== Extension ===');
  const info = await sw.evaluate(() => {
    const m = chrome.runtime.getManifest();
    return { version: m.version, permissions: m.permissions, hosts: m.host_permissions, mv: m.manifest_version };
  });
  check('manifest: MV3 with activeTab and the two GitHub hosts, nothing else', info.mv === 3 && JSON.stringify(info.permissions) === '["activeTab"]' && JSON.stringify(info.hosts) === '["https://github.com/*","https://codeload.github.com/*"]', info);
  check('no page errors or console errors anywhere', errors.length === 0, errors.slice(0, 5));
  void ctx;
}

(async () => {
  const errors = [];
  let ctx;
  try {
    const launched = await launch();
    ctx = launched.ctx;
    check('service worker registered', !!launched.sw, launched.sw && launched.sw.url());
    await realRepository(ctx, launched.id, errors);
    await fixtureThroughGitHubPath(ctx, launched.id, errors);
    await standInForGitHub(errors);
    await localMode(ctx, launched.id, errors);
    await largeGraphs(ctx, launched.id, errors);
    await popup(ctx, launched.id, errors);
    await extensionShape(ctx, launched.sw, errors);
  } catch (e) {
    console.error('HARNESS ERROR', e);
    process.exitCode = 2;
  } finally {
    if (ctx) await ctx.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('Failed: ' + failed.map((f) => f.name).join(' | '));
    process.exitCode = process.exitCode || 1;
  }
})();
