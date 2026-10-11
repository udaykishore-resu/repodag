// Views: aggregation levels, the tests toggle, labels and groups for the code graph.
const test = require('node:test');
const assert = require('node:assert/strict');
const Imports = require('../extension/lib/imports.js');
const Views = require('../extension/lib/views.js');
const Scan = require('../extension/lib/scan.js');
const Graph = require('../extension/lib/graph.js');

function code() {
  return Imports.analyze(new Map(Object.entries({
    'go.mod': 'module m\n',
    'cmd/app/main.go': 'package main\nimport (\n "m/internal/store"\n "m/internal/log"\n)\n',
    'cmd/app/flags.go': 'package main\nimport "m/internal/log"\n',
    'internal/store/store.go': 'package store\nimport "m/internal/log"\n',
    'internal/store/cache.go': 'package store\nimport "m/internal/log"\n',
    'internal/store/store_test.go': 'package store_test\nimport (\n "m/internal/store"\n "m/internal/testutil"\n)\n',
    'internal/log/log.go': 'package log\n',
    'internal/testutil/util.go': 'package testutil\nimport "m/internal/store"\n',
    'web/src/app.ts': "import './api/client';\nimport './api/types';\nimport './util';",
    'web/src/util.ts': '',
    'web/src/api/client.ts': "import './types';\nimport '../util';",
    'web/src/api/types.ts': '',
    'web/src/api/client.test.ts': "import './client';",
    'web/src/lonely.ts': '',
  })), []);
}
const edgeList = (v) => v.edges.map((e) => e.from + ' -> ' + e.to + (e.count > 1 ? ' x' + e.count : '')).sort();
const ids = (v) => v.nodes.map((n) => n.id).sort();

test('files level: Go is shown per package, other languages per file; tests are left out by default', () => {
  const v = Views.codeView(code(), { level: 'files' });
  assert.deepEqual(ids(v), [
    'cmd/app/', 'internal/log/', 'internal/store/', 'internal/testutil/',
    'web/src/api/client.ts', 'web/src/api/types.ts', 'web/src/app.ts', 'web/src/lonely.ts', 'web/src/util.ts',
  ]);
  assert.deepEqual(edgeList(v), [
    'cmd/app/ -> internal/log/ x2',
    'cmd/app/ -> internal/store/',
    'internal/store/ -> internal/log/ x2',
    'internal/testutil/ -> internal/store/',
    'web/src/api/client.ts -> web/src/api/types.ts',
    'web/src/api/client.ts -> web/src/util.ts',
    'web/src/app.ts -> web/src/api/client.ts',
    'web/src/app.ts -> web/src/api/types.ts',
    'web/src/app.ts -> web/src/util.ts',
  ]);
  const store = v.nodes.find((n) => n.id === 'internal/store/');
  assert.equal(store.kind, 'folder');
  assert.deepEqual(store.files, ['internal/store/cache.go', 'internal/store/store.go']);
  assert.equal(store.lang, 'Go');
  assert.equal(v.nodes.find((n) => n.id === 'web/src/app.ts').kind, 'file');
});

test('the tests toggle adds test files and their edges; a Go external test package is a node of its own', () => {
  const v = Views.codeView(code(), { level: 'files', includeTests: true });
  assert.ok(ids(v).includes('web/src/api/client.test.ts'));
  assert.ok(edgeList(v).includes('web/src/api/client.test.ts -> web/src/api/client.ts'));
  // store_test.go says `package store_test`: not part of package store
  assert.ok(ids(v).includes('internal/store/store_test'));
  assert.ok(edgeList(v).includes('internal/store/store_test -> internal/store/'));
  assert.ok(edgeList(v).includes('internal/store/store_test -> internal/testutil/'));
  assert.ok(!edgeList(v).includes('internal/store/ -> internal/testutil/'));
  assert.deepEqual(v.nodes.find((n) => n.id === 'internal/store/').files, ['internal/store/cache.go', 'internal/store/store.go']);
  const t = v.nodes.find((n) => n.id === 'internal/store/store_test');
  assert.deepEqual([t.kind, t.testPackage, t.dir, t.label, t.files.join(), t.group], ['folder', true, 'internal/store/', 'store_test', 'internal/store/store_test.go', 'internal/']);
  assert.match(t.title, /^store_test — Go external test package in internal\/store\/$/);
  // testutil imports store and store_test imports testutil: legal Go, and no cycle
  assert.equal(Graph.findCycles(ids(v), v.edges).length, 0);
});

/* The shape that used to be reported as a cycle: package a, its external test package a_test importing b, and b
   importing a. `go build` and `go vet` accept it, because a_test is not a. */
function externalTestRepo() {
  return Imports.analyze(new Map(Object.entries({
    'go.mod': 'module example.com/m\n',
    'a/a.go': 'package a\n',
    'a/a_internal_test.go': 'package a\nimport "testing"\n',
    'a/a_test.go': 'package a_test\nimport (\n "testing"\n "example.com/m/a"\n "example.com/m/b"\n)\n',
    'b/b.go': 'package b\nimport "example.com/m/a"\n',
    'root.go': 'package m\n',
    'root_test.go': 'package m_test\nimport (\n "example.com/m"\n "example.com/m/b"\n)\n',
    'deep/x/x.go': 'package x\n',
    'deep/x/x_test.go': 'package x_test\nimport "example.com/m/deep/y"\n',
    'deep/y/y.go': 'package y\nimport "example.com/m/deep/x"\n',
    'deep/y/y_test.go': 'package y_test\nimport "example.com/m/deep/x"\n',
  })), []);
}

test('Go: an external test package never puts its folder on a cycle, at files and packages level', () => {
  for (const level of ['files', 'packages']) {
    const v = Views.codeView(externalTestRepo(), { level, includeTests: true });
    assert.deepEqual(ids(v), ['./', './m_test', 'a/', 'a/a_test', 'b/', 'deep/x/', 'deep/x/x_test', 'deep/y/', 'deep/y/y_test'], level);
    assert.deepEqual(edgeList(v), [
      './m_test -> ./',
      './m_test -> b/',
      'a/a_test -> a/',
      'a/a_test -> b/',
      'b/ -> a/',
      'deep/x/x_test -> deep/y/',
      'deep/y/ -> deep/x/',
      'deep/y/y_test -> deep/x/',
    ], level);
    assert.equal(Graph.findCycles(ids(v), v.edges).length, 0, level + ': Go has no import cycles');
    // nothing can import an external test package
    const tests = new Set(v.nodes.filter((n) => n.testPackage).map((n) => n.id));
    assert.equal(tests.size, 4);
    assert.ok(v.edges.every((e) => !tests.has(e.to)));
    assert.equal(v.nodes.find((n) => n.id === './m_test').label, 'm_test');
    assert.equal(v.nodes.find((n) => n.id === './m_test').group, '(top level)');
  }
});

test('Go: a test file in the package itself (package a in a_test.go) stays part of that package', () => {
  const v = Views.codeView(externalTestRepo(), { level: 'files', includeTests: true });
  assert.deepEqual(v.nodes.find((n) => n.id === 'a/').files, ['a/a.go', 'a/a_internal_test.go']);
  assert.deepEqual(v.nodes.find((n) => n.id === 'a/a_test').files, ['a/a_test.go']);
  const code = externalTestRepo();
  assert.equal(code.sources.get('a/a_internal_test.go').xtest, undefined);
  assert.equal(code.sources.get('a/a_test.go').xtest, true);
  assert.equal(code.sources.get('a/a.go').xtest, undefined);
});

test('Go: external test packages disappear with the tests, and stay apart when folders are merged', () => {
  const off = Views.codeView(externalTestRepo(), { level: 'packages' });
  assert.deepEqual(ids(off), ['./', 'a/', 'b/', 'deep/x/', 'deep/y/']);
  assert.deepEqual(edgeList(off), ['b/ -> a/', 'deep/y/ -> deep/x/']);
  // one folder deep: deep/x and deep/y become deep/, and their two test packages become one node beside it
  const one = Views.codeView(externalTestRepo(), { level: 'folders', depth: 1, includeTests: true });
  assert.deepEqual(ids(one), ['./', './m_test', 'a/', 'a/a_test', 'b/', 'deep/', 'deep/(external tests)']);
  assert.deepEqual(edgeList(one), [
    './m_test -> ./',
    './m_test -> b/',
    'a/a_test -> a/',
    'a/a_test -> b/',
    'b/ -> a/',
    'deep/(external tests) -> deep/ x2',
  ]);
  const merged = one.nodes.find((n) => n.id === 'deep/(external tests)');
  assert.deepEqual([merged.label, merged.dir, merged.merged, merged.packages.join(), merged.fileCount], ['deep/ external tests', 'deep/', true, 'x_test,y_test', 2]);
  assert.match(merged.title, /^Go external test packages under deep\/ \(x_test, y_test\)$/);
  assert.equal(Graph.findCycles(ids(one), one.edges).length, 0);
  // two deep, nothing is cut, so every test package keeps its own name
  const two = Views.codeView(externalTestRepo(), { level: 'folders', depth: 2, includeTests: true });
  assert.ok(ids(two).includes('deep/x/x_test') && ids(two).includes('deep/y/y_test'));
});

test('packages level: every folder is one node, counts add up, self-edges vanish', () => {
  const v = Views.codeView(code(), { level: 'packages' });
  assert.deepEqual(ids(v), ['cmd/app/', 'internal/log/', 'internal/store/', 'internal/testutil/', 'web/src/', 'web/src/api/']);
  assert.deepEqual(edgeList(v), [
    'cmd/app/ -> internal/log/ x2',
    'cmd/app/ -> internal/store/',
    'internal/store/ -> internal/log/ x2',
    'internal/testutil/ -> internal/store/',
    'web/src/ -> web/src/api/ x2',
    'web/src/api/ -> web/src/',
  ]);
  assert.ok(v.edges.every((e) => e.from !== e.to));
});

test('folders level: depth cuts paths, shallower folders stay whole', () => {
  const d1 = Views.codeView(code(), { level: 'folders', depth: 1 });
  assert.deepEqual(ids(d1), ['cmd/', 'internal/', 'web/']);
  assert.deepEqual(edgeList(d1), ['cmd/ -> internal/ x3']);
  const d2 = Views.codeView(code(), { level: 'folders', depth: 2 });
  assert.deepEqual(ids(d2), ['cmd/app/', 'internal/log/', 'internal/store/', 'internal/testutil/', 'web/src/']);
  const d9 = Views.codeView(code(), { level: 'folders', depth: 9 });
  assert.deepEqual(ids(d9), ids(Views.codeView(code(), { level: 'packages' })));
  assert.equal(Views.cutDir('a/b/c/', 2), 'a/b/');
  assert.equal(Views.cutDir('a/', 2), 'a/');
  assert.equal(Views.cutDir('./', 2), './');
});

test('files at the top level of the repository get a root node', () => {
  const c = Imports.analyze(new Map(Object.entries({ 'main.py': 'import util\n', 'util.py': '', 'pkg/__init__.py': '', 'pkg/a.py': 'import util\n' })), []);
  const v = Views.codeView(c, { level: 'packages' });
  assert.deepEqual(ids(v), ['./', 'pkg/']);
  assert.equal(v.nodes.find((n) => n.id === './').label, '(top level)');
  assert.deepEqual(edgeList(v), ['pkg/ -> ./']);
});

test('labels are the shortest unique tail of the path', () => {
  const labels = Views.shortLabels(['a/x/index.ts', 'a/y/index.ts', 'b/y/index.ts', 'a/main.ts', 'pkg/store/', 'other/store/', 'solo/']);
  assert.equal(labels.get('a/x/index.ts'), 'x/index.ts');
  assert.equal(labels.get('a/y/index.ts'), 'a/y/index.ts');
  assert.equal(labels.get('b/y/index.ts'), 'b/y/index.ts');
  assert.equal(labels.get('a/main.ts'), 'main.ts');
  assert.equal(labels.get('pkg/store/'), 'pkg/store/');
  assert.equal(labels.get('solo/'), 'solo/');
});

test('groups: by leading folder, as deep as needed, or by language', () => {
  const v = Views.codeView(code(), { level: 'files' });
  assert.deepEqual(v.groups.map((g) => g.key + ':' + g.count), ['web/:5', 'internal/:3', 'cmd/:1']);
  const byLang = Views.codeView(code(), { level: 'files', groupBy: 'language' });
  assert.deepEqual(byLang.groups.map((g) => g.key + ':' + g.count), ['TypeScript:5', 'Go:4']);
  // everything under one folder: go one level deeper so the colours still say something
  const g = Views.folderGroups(['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts', 'src/c/w.ts', 'src/main.ts']);
  assert.equal(g.get('src/a/x.ts'), 'src/a/');
  assert.equal(g.get('src/main.ts'), 'src/');
  // a monorepo with forty small example folders: one level deeper would leave most nodes without a colour of their own
  const mono = [];
  for (let i = 0; i < 40; i++) mono.push('examples/app' + i + '/src/index.ts', 'examples/app' + i + '/src/util.ts');
  for (let i = 0; i < 6; i++) for (let k = 0; k < 4; k++) mono.push('packages/pkg' + i + '/src/f' + k + '.ts');
  mono.push('www/src/a.ts', 'www/src/b.ts', 'scripts/x.ts');
  const m = Views.folderGroups(mono);
  assert.deepEqual([...new Set(m.values())].sort(), ['examples/', 'packages/', 'scripts/', 'www/']);
});

test('suggestLevel: small repositories start at files, large ones grouped', () => {
  const small = Views.suggestLevel(code(), false);
  assert.equal(small.level, 'files');
  assert.equal(small.files, 9);
  assert.equal(small.packages, 6);
  const many = new Map();
  for (let d = 0; d < 20; d++) for (let f = 0; f < 10; f++) many.set('src/mod' + d + '/f' + f + '.ts', '');
  assert.equal(Views.suggestLevel(Imports.analyze(many, []), false).level, 'packages');
  const huge = new Map();
  for (let a = 0; a < 4; a++) for (let b = 0; b < 60; b++) huge.set('src/area' + a + '/mod' + b + '/f.ts', '');
  const s = Views.suggestLevel(Imports.analyze(huge, []), false);
  assert.equal(s.level, 'folders');
  assert.equal(s.depth, 2);
});

test('wants: which files are read, and why the others are skipped', () => {
  const w = Scan.wants;
  assert.deepEqual(w('src/a.ts', 10), { read: true, role: 'source', skipped: null });
  assert.equal(w('go.mod', 10).role, 'manifest');
  assert.equal(w('.github/workflows/ci.yml', 10).role, 'workflow');
  assert.equal(w('tsconfig.json', 10).role, 'config');
  assert.equal(w('tsconfig.app.json', 10).role, 'config');
  assert.equal(w('pnpm-workspace.yaml', 10).role, 'config');
  assert.equal(w('gradle/libs.versions.toml', 10).role, 'config');
  assert.deepEqual(w('README.md', 10), { read: false, role: null, skipped: null });
  assert.deepEqual(w('logo.png', 10), { read: false, role: null, skipped: null });
  for (const dir of ['node_modules', 'vendor', 'dist', 'build', 'target', 'out', '.git', '__pycache__', '.venv', 'venv', 'third_party', 'testdata']) {
    assert.deepEqual(w('a/' + dir + '/x.go', 10), { read: false, role: 'source', skipped: 'folder' }, dir);
  }
  assert.equal(w('build.gradle', 10).read, true, 'a file called build.* is not the build folder');
  assert.equal(w('src/builder/x.ts', 10).read, true);
  assert.deepEqual(w('lib/jquery.min.js', 10), { read: false, role: 'source', skipped: 'minified' });
  assert.deepEqual(w('lib/app-min.js', 10), { read: false, role: 'source', skipped: 'minified' });
  assert.equal(w('lib/admin.js', 10).read, true);
  assert.deepEqual(w('src/big.ts', Scan.MAX_FILE_BYTES + 1), { read: false, role: 'source', skipped: 'size' });
  assert.equal(w('src/big.ts', Scan.MAX_FILE_BYTES).read, true);
});

test('scan: one call returns all three raw graphs and the language list', () => {
  const r = Scan.scan(new Map(Object.entries({
    'go.mod': 'module m\nrequire github.com/a/b v1.0.0\n',
    'main.go': 'package main\nimport "m/x"\n',
    'x/x.go': 'package x\n',
    'tool.py': 'import os\n',
    '.github/workflows/ci.yml': 'on: push\njobs:\n  a: {runs-on: x}\n  b: {runs-on: x, needs: a}\n',
  })), { allPaths: ['README.md'] });
  assert.deepEqual(r.languages, [{ lang: 'Go', files: 2 }, { lang: 'Python', files: 1 }]);
  assert.equal(r.code.edges.length, 1);
  assert.equal(r.ci.jobs.length, 2);
  assert.equal(r.ci.edges.length, 1);
  assert.equal(r.packages.deps.length, 1);
});

test('scan: dependencies named in the manifests tell the import scanner what is outside', () => {
  const tree = {
    'pyproject.toml': '[project]\nname = "poetry"\ndependencies = ["poetry-core (>=2.0)", "requests"]\n',
    'src/poetry/__init__.py': '',
    'src/poetry/factory.py': 'from poetry.core.packages import Package\nfrom poetry.gone import x\n',
  };
  const r = Scan.scan(new Map(Object.entries(tree)), {});
  assert.equal(r.code.stats.Python.external, 1);
  assert.equal(r.code.stats.Python.unresolved, 1);
});
