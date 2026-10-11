// Limits the Chrome Web Store enforces at upload time, and the promises the README and privacy policy make
// about what the extension's code does and does not do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Zip = require('../extension/lib/zip.js');

const repo = path.join(__dirname, '..');
const root = path.join(repo, 'extension');
const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function walk(dir, skip) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, skip));
    else out.push(full);
  }
  return out;
}

const ownScripts = walk(root, []).filter((f) => f.endsWith('.js') && !f.endsWith('js-yaml.min.js'));
const pages = walk(root, []).filter((f) => f.endsWith('.html'));

test('manifest fits Chrome Web Store limits', () => {
  assert.equal(m.manifest_version, 3);
  assert.ok(m.description.length <= 132, 'description is ' + m.description.length + ' chars, limit is 132');
  assert.ok(m.name.length <= 75, 'name is ' + m.name.length + ' chars, limit is 75');
  assert.ok(m.short_name.length <= 12, 'short_name is ' + m.short_name.length + ' chars, limit is 12');
  assert.match(m.version, /^\d+(\.\d+){0,3}$/);
  assert.equal(m.version, JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, 'manifest and package.json versions differ');
});

test('every file the manifest points at exists', () => {
  const files = [m.background.service_worker, m.action.default_popup, ...Object.values(m.icons)];
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), 'missing ' + f);
});

test('permissions are exactly activeTab plus the two GitHub hosts', () => {
  assert.deepEqual(m.permissions, ['activeTab']);
  assert.deepEqual(m.host_permissions, ['https://github.com/*', 'https://codeload.github.com/*']);
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.optional_permissions, undefined);
  assert.equal(m.optional_host_permissions, undefined);
  assert.equal(m.web_accessible_resources, undefined);
  assert.equal(m.externally_connectable, undefined);
});

test('the content security policy allows scripts from the package only and connections to GitHub only', () => {
  const csp = m.content_security_policy.extension_pages;
  const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').slice(name.length + 1);
  assert.equal(directive('default-src'), "'none'");
  assert.equal(directive('script-src'), "'self'");
  assert.equal(directive('connect-src'), 'https://github.com https://codeload.github.com');
  assert.ok(!/unsafe-eval|wasm-unsafe-eval|https?:\/\/(?!github\.com|codeload\.github\.com)/.test(csp), csp);
});

test('icons are PNGs of the stated sizes', () => {
  for (const [size, file] of Object.entries(m.icons)) {
    const png = pngInfo(path.join(root, file));
    assert.equal(png.width, Number(size), file);
    assert.equal(png.height, Number(size), file);
  }
});

test('own code never builds markup from strings or evaluates text as code', () => {
  const banned = [
    [/\binnerHTML\b/, 'innerHTML'],
    [/\bouterHTML\b/, 'outerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\.write(ln)?\b/, 'document.write'],
    [/\beval\s*\(/, 'eval('],
    [/\bnew\s+Function\b/, 'new Function'],
    [/\bcreateContextualFragment\b/, 'createContextualFragment'],
    [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'setTimeout with a string'],
    [/\bimportScripts\s*\(\s*['"`]https?:/, 'remote importScripts'],
  ];
  for (const file of ownScripts) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [re, name] of banned) assert.ok(!re.test(text), path.relative(repo, file) + ' uses ' + name);
  }
  assert.ok(ownScripts.length >= 14, 'expected to check every script, found ' + ownScripts.length);
});

test('the bundled js-yaml is 4.1.0, ships its licence, and does not evaluate code either', () => {
  const text = read('lib/js-yaml.min.js');
  assert.match(text, /^\/\*! js-yaml 4\.1\.0 https:\/\/github\.com\/nodeca\/js-yaml @license MIT \*\//);
  assert.ok(!/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(text));
  assert.match(read('lib/js-yaml.LICENSE'), /Vitaly Puzrin/);
  const others = walk(path.join(root, 'lib'), []).filter((f) => /\.min\.js$/.test(f));
  assert.equal(others.length, 1, 'js-yaml is the only third-party file');
});

test('pages load only packaged scripts and styles: no inline script, no event attributes, no remote URL', () => {
  assert.ok(pages.length >= 2);
  for (const file of pages) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repo, file);
    for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || []) {
      assert.match(tag, /^<script src="[^":]+"><\/script>$/, rel + ' has an inline or remote script: ' + tag.slice(0, 80));
      const src = /src="([^"]+)"/.exec(tag)[1];
      assert.ok(fs.existsSync(path.join(path.dirname(file), src)), rel + ' loads a missing script ' + src);
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(html), rel + ' has an inline event handler attribute');
    assert.ok(!/javascript:/i.test(html), rel + ' has a javascript: URL');
    for (const url of html.match(/(?:src|href)="([^"]+)"/g) || []) {
      assert.ok(!/="(https?:)?\/\//.test(url), rel + ' references a remote resource: ' + url);
    }
  }
  const css = read('viewer.css');
  assert.ok(!/@import|url\(\s*['"]?(https?:)?\/\//.test(css), 'viewer.css loads something remote');
  assert.ok(!/@font-face/.test(css + read('popup.html')), 'no web fonts');
});

test('the only network request in the code is the archive download', () => {
  let fetches = 0;
  for (const file of ownScripts) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repo, file);
    fetches += (text.match(/\bfetch\s*\(/g) || []).length;
    assert.ok(!/XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|\.src\s*=\s*['"`]https?:/.test(text), rel + ' has another way to reach the network');
  }
  assert.equal(fetches, 1);
  const viewer = read('viewer.js');
  assert.match(viewer, /fetch\(Url\.archiveUrl\(owner, repo, ref\), \{ credentials: 'include'/);
  assert.match(read('lib/ghurl.js'), /'https:\/\/github\.com\/' \+ encodeURIComponent\(owner\) \+ '\/' \+ encodeURIComponent\(repo\) \+ '\/archive\/'/);
});

test('nothing is stored: no storage, cookie or IndexedDB use', () => {
  for (const file of ownScripts) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/chrome\.storage|localStorage|sessionStorage|indexedDB|document\.cookie|chrome\.cookies/.test(text), path.relative(repo, file) + ' stores something');
  }
});

test('shared logic files work in a page and in Node', () => {
  const libs = walk(path.join(root, 'lib'), []).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'));
  assert.ok(libs.length >= 10);
  for (const file of libs) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repo, file);
    assert.match(text, /^\/\*[\s\S]*?\*\/\n\(function \(\) \{\n {2}'use strict';/, rel + ' is not wrapped in an IIFE');
    assert.match(text, /globalThis\.RepoDag[A-Z]\w* = api;/, rel + ' does not attach to globalThis.RepoDag…');
    assert.match(text, /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = api;/, rel + ' does not export for Node');
    const mod = require(file);
    assert.equal(typeof mod, 'object');
    const name = /globalThis\.(RepoDag[A-Z]\w*) = api;/.exec(text)[1];
    assert.equal(globalThis[name], mod, rel + ' global and export differ');
  }
});

test('the viewer loads every library before the code that needs it', () => {
  const html = read('viewer.html');
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((x) => x[1]);
  const before = (a, b) => assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), a + ' must load before ' + b);
  before('lib/js-yaml.min.js', 'lib/imports.js');
  before('lib/lex.js', 'lib/imports.js');
  before('lib/toml.js', 'lib/imports.js');
  before('lib/toml.js', 'lib/manifests.js');
  for (const dep of ['lib/imports.js', 'lib/manifests.js', 'lib/workflows.js']) before(dep, 'lib/scan.js');
  before('lib/imports.js', 'lib/views.js');
  for (const dep of ['lib/zip.js', 'lib/scan.js', 'lib/views.js', 'lib/graph.js', 'lib/export.js', 'lib/ghurl.js']) before(dep, 'viewer.js');
  assert.equal(order[order.length - 1], 'viewer.js');
});

/* ---------- repository hygiene ---------- */

test('authorship: MIT, Udaykishore Resu, 2026', () => {
  const licence = fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8');
  assert.match(licence, /^MIT License\n\nCopyright \(c\) 2026 Udaykishore Resu\n/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.author, 'Udaykishore Resu');
  assert.equal(pkg.license, 'MIT');
});

/* ---------- store assets ---------- */

function pngInfo(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file + ' is not a PNG');
  assert.equal(b.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25], hasTransparencyChunk: b.includes(Buffer.from('tRNS', 'latin1')) };
}

test('store screenshots are 1280x800, 24-bit, without alpha', () => {
  for (const name of ['repodag-screenshot-1.png', 'repodag-screenshot-2.png']) {
    const png = pngInfo(path.join(repo, 'store', name));
    assert.deepEqual([png.width, png.height], [1280, 800], name);
    assert.equal(png.bitDepth, 8, name);
    assert.equal(png.colorType, 2, name + ' must be RGB without an alpha channel (colour type 2), got ' + png.colorType);
    assert.equal(png.hasTransparencyChunk, false, name);
  }
});

test('promo tile is 440x280 without alpha, store icon is 128x128', () => {
  const promo = pngInfo(path.join(repo, 'store', 'repodag-promo-440x280.png'));
  assert.deepEqual([promo.width, promo.height, promo.colorType], [440, 280, 2]);
  const icon = pngInfo(path.join(repo, 'store', 'repodag-store-icon-128.png'));
  assert.deepEqual([icon.width, icon.height], [128, 128]);
  // the art must sit inside the centre 96x96: the source SVG draws nothing outside x,y 16..112
  const svg = fs.readFileSync(path.join(repo, 'store', 'icon.svg'), 'utf8');
  for (const rect of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
    const [x, y, w, h] = rect.slice(1).map(Number);
    assert.ok(x >= 16 && y >= 16 && x + w <= 112 && y + h <= 112, 'icon art leaves the centre 96x96: ' + rect[0]);
  }
});

test('store listing: every field is present and the description is plain prose', () => {
  const listing = fs.readFileSync(path.join(repo, 'store', 'LISTING.md'), 'utf8');
  for (const heading of ['## Store listing tab', '### Description', '## Privacy tab', '**Single purpose**', '**Permission justifications**', '**Remote code:**', '**Data usage:**', '**Privacy policy URL:**', '## Distribution tab', '## Test instructions tab']) {
    assert.ok(listing.includes(heading), 'LISTING.md lacks ' + heading);
  }
  const description = /### Description\s+```\n([\s\S]*?)\n```/.exec(listing);
  assert.ok(description, 'description block not found');
  const text = description[1];
  assert.ok(text.length > 400 && text.length < 16000, 'description length ' + text.length);
  for (const line of text.split('\n')) {
    assert.ok(!/^\s*([-*•]|\d+[.)])\s/.test(line), 'the description has a list item: ' + line);
    assert.ok((line.match(/,/g) || []).length <= 4, 'this sentence reads like a keyword list: ' + line);
  }
  // A previous listing was rejected for "excessive keywords": the description names no languages, package
  // registries or diagram tools at all, and mentions GitHub only as often as it has to.
  const names = /\b(JavaScript|TypeScript|Python|Java|Kotlin|Scala|Rust|Golang|C\+\+|npm|PyPI|pip|Maven|Gradle|Cargo|sbt|Mermaid|Graphviz|DOT|YAML|React|Node)\b/;
  assert.ok(!names.test(text), 'the description names a language or tool: ' + (names.exec(text) || [])[0]);
  assert.ok(!/\bGo\b(?! to)/.test(text), 'the description names Go');
  assert.ok((text.match(/GitHub/g) || []).length <= 5, 'GitHub is mentioned too often');
  for (const perm of ['`activeTab`', 'github.com', 'codeload.github.com']) assert.ok(listing.includes(perm), 'no justification for ' + perm);
  for (const asset of ['repodag-store-icon-128.png', 'repodag-screenshot-1.png', 'repodag-screenshot-2.png', 'repodag-promo-440x280.png']) {
    assert.ok(listing.includes(asset) && fs.existsSync(path.join(repo, 'store', asset)), asset);
  }
});

test('README covers what a reader needs', () => {
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  for (const part of ['**Topics:**', '## Repo layout', '## How it works', '## Install (unpacked)', '## Develop', '## Limits', '## Privacy', '## Skills demonstrated', '## License']) {
    assert.ok(readme.includes(part), 'README lacks ' + part);
  }
  assert.match(readme, /private repositor/i, 'README must say private repositories are untested');
});

test('npm run package builds a zip with manifest.json at the top level', (t) => {
  if (spawnSync('zip', ['-v']).error) {
    t.skip('the zip command is not installed');
    return;
  }
  const run = spawnSync('bash', [path.join(repo, 'scripts', 'package.sh')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = path.join(repo, 'dist', 'repodag-' + m.version + '.zip');
  assert.ok(fs.existsSync(out), 'no ' + out);
  const zip = Zip.open(fs.readFileSync(out));
  const names = zip.entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'), 'manifest.json is not at the top level');
  for (const needed of ['viewer.html', 'viewer.js', 'viewer.css', 'popup.html', 'popup.js', 'background.js', 'lib/js-yaml.min.js', 'lib/js-yaml.LICENSE', 'lib/scan.js', 'lib/graph.js', 'lib/zip.js', 'icons/icon128.png']) {
    assert.ok(names.includes(needed), 'the package lacks ' + needed);
  }
  assert.ok(!names.some((n) => /(^|\/)\.|node_modules|test\/|e2e\/|store\//.test(n)), 'the package contains files that do not belong');
});
