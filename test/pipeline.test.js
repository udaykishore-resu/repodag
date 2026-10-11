// The whole pipeline on a repository whose graph was written out by hand: test/fixtures/polyglot is zipped the way
// GitHub does it, read back through the zip reader, scanned, turned into views, laid out and exported.
// Every expected edge below was derived by reading the fixture, not by copying the scanner's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zipDirectory } = require('./helpers/make-zip.js');
const Zip = require('../extension/lib/zip.js');
const Scan = require('../extension/lib/scan.js');
const Views = require('../extension/lib/views.js');
const Graph = require('../extension/lib/graph.js');
const Export = require('../extension/lib/export.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'polyglot');

/* What the viewer does with a downloaded archive, without the page around it. */
async function load() {
  const zip = Zip.open(zipDirectory(FIXTURE, 'polyglot-main'));
  const prefix = Zip.commonTopFolder(zip.entries.map((e) => e.name));
  const files = new Map();
  const allPaths = [];
  const skipped = { folder: 0, minified: 0, size: 0 };
  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    const rel = entry.name.slice(prefix.length);
    allPaths.push(rel);
    const w = Scan.wants(rel, entry.size);
    if (w.skipped) skipped[w.skipped]++;
    if (w.read) files.set(rel, await Zip.readText(zip, entry));
  }
  return { prefix, files, allPaths, skipped, scan: Scan.scan(files, { allPaths }) };
}

const pairs = (edges) => edges.map((e) => e.from + ' -> ' + e.to).sort();
const J = 'jvm/src/main/';

test('archive: the wrapper folder is stripped and only useful files are unpacked', async () => {
  const r = await load();
  assert.equal(r.prefix, 'polyglot-main/');
  assert.equal(r.allPaths.length, 39);
  assert.equal(r.files.size, 36, '26 sources, 6 manifests, 3 workflows and the tsconfig');
  assert.deepEqual(r.skipped, { folder: 1, minified: 1, size: 0 }, 'vendor/lib/lib.go and web/src/legacy.min.js');
  assert.ok(!r.files.has('README.md') && !r.files.has('vendor/lib/lib.go') && !r.files.has('web/src/legacy.min.js'));
  assert.deepEqual(r.scan.languages, [
    { lang: 'Go', files: 5 }, { lang: 'Python', files: 5 }, { lang: 'TypeScript', files: 5 },
    { lang: 'C/C++', files: 3 }, { lang: 'Java', files: 3 }, { lang: 'Rust', files: 3 },
    { lang: 'Kotlin', files: 1 }, { lang: 'Scala', files: 1 },
  ]);
});

test('code imports: every edge of the fixture, and nothing else', async () => {
  const { scan } = await load();
  assert.deepEqual(pairs(scan.code.edges), [
    // Go: a file points at the package folder it imports; two modules, one import across them
    'cmd/app/main.go -> internal/core/',
    'cmd/app/main.go -> tools/gen/',
    'internal/core/core_test.go -> internal/testutil/',
    'tools/gen/gen.go -> internal/core/',
    // TypeScript: "./app.js" is app.ts, "@/util/fmt" comes from tsconfig paths, app and state import each other
    'web/src/app.ts -> web/src/state.ts',
    'web/src/main.ts -> web/src/app.ts',
    'web/src/main.ts -> web/src/types.ts',
    'web/src/main.ts -> web/src/util/fmt.ts',
    'web/src/state.ts -> web/src/app.ts',
    // Python: relative imports, a parenthesised name list, an absolute import resolved under py/src
    'py/src/poly/cli.py -> py/src/poly/core.py',
    'py/src/poly/cli.py -> py/src/poly/util/helpers.py',
    'py/src/poly/core.py -> py/src/poly/util/helpers.py',
    // Java, Kotlin, Scala: imports by package and class, Helper used without an import, a Scala wildcard
    J + 'java/com/poly/App.java -> ' + J + 'java/com/poly/Helper.java',
    J + 'java/com/poly/App.java -> ' + J + 'java/com/poly/model/User.java',
    J + 'java/com/poly/Helper.java -> ' + J + 'java/com/poly/model/User.java',
    J + 'kotlin/com/poly/Ext.kt -> ' + J + 'java/com/poly/model/User.java',
    J + 'scala/com/poly/Calc.scala -> ' + J + 'java/com/poly/model/',
    // Rust: mod declarations and crate:: paths
    'rust/src/engine.rs -> rust/src/util.rs',
    'rust/src/main.rs -> rust/src/engine.rs',
    'rust/src/main.rs -> rust/src/util.rs',
    // C: quoted includes; <stdio.h> is outside
    'c/main.c -> c/util.h',
    'c/util.c -> c/util.h',
  ].sort());
  const kind = (from, to) => scan.code.edges.find((e) => e.from === from && e.to === to).kind;
  assert.equal(kind('web/src/main.ts', 'web/src/types.ts'), 'type');
  assert.equal(kind(J + 'java/com/poly/App.java', J + 'java/com/poly/Helper.java'), 'same-package');
  assert.equal(kind('rust/src/main.rs', 'rust/src/engine.rs'), 'mod');

  const s = scan.code.stats;
  const row = (lang) => [s[lang].found, s[lang].internal, s[lang].external, s[lang].unresolved, s[lang].ignored];
  assert.deepEqual(row('Go'), [9, 4, 4, 0, 1], 'fmt, uuid and testing twice are outside; vendor/lib is in an ignored folder');
  assert.deepEqual(row('TypeScript'), [6, 5, 1, 0, 0], 'react is outside; the commented and quoted imports are not counted');
  assert.deepEqual(row('Python'), [6, 4, 2, 0, 0], 'os and requests are outside; the docstring is not code');
  assert.deepEqual(row('Java'), [3, 2, 1, 0, 0]);
  assert.equal(s.Java.samePackage, 1);
  assert.deepEqual(row('Kotlin'), [1, 1, 0, 0, 0]);
  assert.deepEqual(row('Scala'), [1, 1, 0, 0, 0]);
  assert.deepEqual(row('Rust'), [5, 4, 1, 0, 0], 'serde is outside');
  assert.deepEqual(row('C/C++'), [3, 2, 1, 0, 0]);
});

test('code imports: views at each level', async () => {
  const { scan } = await load();
  const files = Views.codeView(scan.code, { level: 'files' });
  // Go is drawn per package (4), the model package also appears as a folder because Scala imports all of it
  assert.equal(files.nodes.length, 4 + 5 + 5 + 5 + 1 + 3 + 3);
  assert.equal(files.edges.length, 21, 'all 22 edges but the one from the Go test file');
  let cycles = Graph.findCycles(files.nodes.map((n) => n.id), files.edges);
  assert.deepEqual(cycles.map((c) => c.nodes), [['web/src/app.ts', 'web/src/state.ts']]);

  const withTests = Views.codeView(scan.code, { level: 'files', includeTests: true });
  assert.equal(withTests.edges.length, 22);
  assert.ok(withTests.edges.some((e) => e.from === 'internal/core/' && e.to === 'internal/testutil/'));

  const packages = Views.codeView(scan.code, { level: 'packages' });
  assert.equal(packages.nodes.length, 14);
  assert.deepEqual(packages.edges.map((e) => e.from + ' -> ' + e.to + ' x' + e.count).sort(), [
    'cmd/app/ -> internal/core/ x1',
    'cmd/app/ -> tools/gen/ x1',
    'tools/gen/ -> internal/core/ x1',
    'web/src/ -> web/src/util/ x1',
    'py/src/poly/ -> py/src/poly/util/ x2',
    J + 'java/com/poly/ -> ' + J + 'java/com/poly/model/ x2',
    J + 'kotlin/com/poly/ -> ' + J + 'java/com/poly/model/ x1',
    J + 'scala/com/poly/ -> ' + J + 'java/com/poly/model/ x1',
  ].sort());
  cycles = Graph.findCycles(packages.nodes.map((n) => n.id), packages.edges);
  assert.equal(cycles.length, 0, 'the app/state loop is inside one folder now');

  const top = Views.codeView(scan.code, { level: 'folders', depth: 1 });
  assert.deepEqual(top.nodes.map((n) => n.id), ['c/', 'cmd/', 'internal/', 'jvm/', 'py/', 'rust/', 'tools/', 'web/']);
  assert.deepEqual(pairs(top.edges), ['cmd/ -> internal/', 'cmd/ -> tools/', 'tools/ -> internal/']);
});

test('CI pipeline: jobs, needs, a reusable-workflow call and a workflow_run trigger', async () => {
  const { scan } = await load();
  const view = Views.ciView(scan.ci);
  const W = '.github/workflows/';
  assert.deepEqual(view.nodes.map((n) => n.id + ' "' + n.label + '"').sort(), [
    W + 'ci.yml#build "build"', W + 'ci.yml#lint "lint"', W + 'ci.yml#test "Unit tests"',
    W + 'nightly.yml#checks "checks"', W + 'nightly.yml#report "report"', W + 'release.yml#publish "publish"',
  ]);
  assert.deepEqual(view.edges.map((e) => e.from.split('#')[1] + ' -> ' + e.to.split('#')[1] + ' (' + e.kind + ')').sort(), [
    'build -> publish (workflow_run)',
    'checks -> lint (calls)',
    'checks -> report (needs)',
    'lint -> build (needs)',
    'lint -> test (needs)',
    'test -> build (needs)',
  ]);
  const testJob = scan.ci.jobs.find((j) => j.key === 'test');
  assert.equal(testJob.runsOn, 'ubuntu-latest');
  assert.deepEqual(testJob.steps.map((s) => s.label), ['actions/checkout@v4', 'actions/setup-go@v5', 'go test ./...']);
  assert.deepEqual(testJob.uses, ['actions/checkout@v4', 'actions/setup-go@v5']);
  assert.equal(scan.ci.jobs.find((j) => j.key === 'publish').environment, 'production');
  assert.deepEqual(view.groups.map((g) => g.key + ':' + g.count), ['CI:3', 'Nightly:2', 'Release:1']);
});

test('third-party packages: one node per manifest, direct dependencies, dev marked, indirect left out', async () => {
  const { scan } = await load();
  const view = Views.packagesView(scan.packages, { includeDev: true, includeIndirect: false });
  assert.deepEqual(view.nodes.filter((n) => n.kind === 'manifest').map((n) => n.id), ['go.mod', 'jvm/pom.xml', 'py/pyproject.toml', 'rust/Cargo.toml', 'tools/go.mod', 'web/package.json']);
  assert.deepEqual(view.edges.map((e) => e.from + ' -> ' + e.to + (e.label ? ' ' + e.label : '') + (e.dev ? ' [dev]' : '') + (e.local ? ' [local]' : '')).sort(), [
    'go.mod -> dep:Go:github.com/google/uuid v1.6.0',
    'jvm/pom.xml -> dep:Maven:com.google.guava:guava 33.0.0-jre',
    'jvm/pom.xml -> dep:Maven:junit:junit 4.13.2 [dev]',
    'py/pyproject.toml -> dep:PyPI:pytest >=8 [dev]',
    'py/pyproject.toml -> dep:PyPI:requests >=2.31',
    'rust/Cargo.toml -> dep:Cargo:serde 1',
    'rust/Cargo.toml -> dep:Cargo:tempfile 3 [dev]',
    'tools/go.mod -> go.mod v0.0.0 [local]',
    'web/package.json -> dep:npm:react ^18.3.0',
    'web/package.json -> dep:npm:vitest ^2.0.0 [dev]',
  ]);
  assert.equal(view.hiddenIndirect, 1, 'golang.org/x/sys is an indirect requirement');
  const lean = Views.packagesView(scan.packages, { includeDev: false, includeIndirect: false });
  assert.equal(lean.nodes.length, 6 + 5);
  assert.equal(lean.edges.length, 6);
  assert.equal(lean.hiddenDev, 4);
  const all = Views.packagesView(scan.packages, { includeDev: true, includeIndirect: true });
  assert.ok(all.nodes.some((n) => n.id === 'dep:Go:golang.org/x/sys'));
});

test('layout and exports of every view hold together', async (t) => {
  const { scan } = await load();
  const views = {
    code: Views.codeView(scan.code, { level: 'files', includeTests: true }),
    ci: Views.ciView(scan.ci),
    packages: Views.packagesView(scan.packages, {}),
  };
  const haveDot = !spawnSync('dot', ['-V']).error;
  if (!haveDot) t.diagnostic('Graphviz is not installed: DOT output was not run through dot');
  for (const [name, view] of Object.entries(views)) {
    const L = Graph.layout(view.nodes.map((n) => ({ id: n.id, width: 40 + n.label.length * 7 })), view.edges);
    assert.equal(L.nodes.size, view.nodes.length, name);
    view.edges.forEach((e, i) => {
      const a = L.nodes.get(e.from);
      const b = L.nodes.get(e.to);
      if (L.edges[i].reversed) assert.ok(a.layer > b.layer, name + ': a reversed edge points back');
      else assert.ok(a.layer < b.layer, name + ': ' + e.from + ' must sit left of ' + e.to);
    });
    assert.equal(L.reversedCount, name === 'code' ? 1 : 0, name + ': only the app/state loop needs an edge turned');
    const cycles = Graph.findCycles(view.nodes.map((n) => n.id), view.edges);
    const keys = Export.cycleEdgeKeys(view, cycles);
    const mermaid = Export.toMermaid(view, keys);
    assert.equal((mermaid.match(/-->|-\.->/g) || []).length, view.edges.length, name);
    const dot = Export.toDot(view, keys, 'polyglot');
    assert.equal((dot.match(/ -> /g) || []).length, view.edges.length, name);
    if (haveDot) {
      const run = spawnSync('dot', ['-Tsvg'], { input: dot, encoding: 'utf8' });
      assert.equal(run.status, 0, name + ': ' + run.stderr);
    }
    const json = JSON.parse(Export.toJson(view, { view: name }, cycles));
    assert.equal(json.nodes.length, view.nodes.length);
    assert.equal(json.edges.length, view.edges.length);
  }
  // in the CI view, jobs run left to right in the order the workflow gives
  const ci = Graph.layout(views.ci.nodes.map((n) => ({ id: n.id, width: 80 })), views.ci.edges);
  const layerOf = (key) => ci.nodes.get([...ci.nodes.keys()].find((id) => id.endsWith('#' + key))).layer;
  assert.ok(layerOf('checks') < layerOf('lint') && layerOf('lint') < layerOf('test') && layerOf('test') < layerOf('build') && layerOf('build') < layerOf('publish'));
});
