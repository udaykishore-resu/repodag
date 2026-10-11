// Import parsing and resolution for every supported language, on small in-memory repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const Imports = require('../extension/lib/imports.js');

function run(tree, allPaths) {
  const files = new Map(Object.entries(tree));
  const result = Imports.analyze(files, allPaths || []);
  result.list = result.edges.map((e) => e.from + ' -> ' + e.to).sort();
  result.kindOf = (from, to) => (result.edges.find((e) => e.from === from && e.to === to) || {}).kind;
  result.has = (from, to) => result.edges.some((e) => e.from === from && e.to === to);
  return result;
}

/* ------------------------------------------------------------------ Go */

test('Go: parses single imports, blocks, aliases, blank and dot imports, raw strings', () => {
  const p = Imports.goParse(`// Package demo does things.
//go:build linux

/* block comment with import "fake" */
package demo

import "fmt"
import alias "example.com/mod/a"
import (
	"os" // trailing
	_ "example.com/mod/b"
	. "example.com/mod/c"
	x \`example.com/mod/d\`

	/* in between */
	"example.com/mod/e"; "example.com/mod/f"
)

import ()

var s = "import \\"nope\\""
func main() { fmt.Println(\`import "also-nope"\`) }
import "too/late"
`);
  assert.equal(p.pkg, 'demo');
  assert.deepEqual(p.imports.map((i) => i.path), [
    'fmt', 'example.com/mod/a', 'os', 'example.com/mod/b', 'example.com/mod/c', 'example.com/mod/d', 'example.com/mod/e', 'example.com/mod/f',
  ]);
  assert.deepEqual(p.imports.map((i) => i.alias), ['', 'alias', '', '_', '.', 'x', '', '']);
});

test('Go: module path is read from go.mod, quoted or not', () => {
  assert.equal(Imports.goModulePath('module example.com/x // comment\n\ngo 1.22\n'), 'example.com/x');
  assert.equal(Imports.goModulePath('// header\nmodule "example.com/quoted"\n'), 'example.com/quoted');
  assert.equal(Imports.goModulePath('go 1.22\n'), null);
});

test('Go: imports resolve to package folders across several modules', () => {
  const r = run({
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'main.go': 'package main\nimport (\n "fmt"\n "example.com/app/store"\n "example.com/app/internal/log"\n "example.com/app/missing"\n "example.com/other/thing"\n)\n',
    'store/store.go': 'package store\nimport "example.com/app/internal/log"\n',
    'store/store_test.go': 'package store_test\nimport (\n "testing"\n "example.com/app/store"\n "example.com/app/tools/gen"\n)\n',
    'internal/log/log.go': 'package log\n',
    'tools/go.mod': 'module example.com/app/tools\n',
    'tools/gen/gen.go': 'package gen\nimport "example.com/app/store"\nimport "C"\n',
    'api/go.mod': 'module example.com/api\n',
    'api/client.go': 'package api\nimport "example.com/app/store"\n',
  });
  assert.deepEqual(r.list, [
    'api/client.go -> store/',
    'main.go -> internal/log/',
    'main.go -> store/',
    'store/store.go -> internal/log/',
    'store/store_test.go -> store/',
    'store/store_test.go -> tools/gen/',
    'tools/gen/gen.go -> store/',
  ]);
  assert.equal(r.sources.get('store/store_test.go').test, true);
  assert.equal(r.sources.get('store/store.go').test, false);
  const s = r.stats.Go;
  assert.equal(s.files, 6);
  assert.equal(s.internal, 7);
  assert.equal(s.unresolved, 1); // example.com/app/missing
  assert.equal(s.samples[0].spec, 'example.com/app/missing');
  assert.equal(s.external, 4); // fmt, example.com/other/thing, testing, C
});

test('Go: an import into an ignored folder is reported as ignored, not unresolved', () => {
  const r = run(
    { 'go.mod': 'module m\n', 'a.go': 'package a\nimport "m/testdata/fixtures"\nimport "m/gone"\n' },
    ['go.mod', 'a.go', 'testdata/fixtures/f.go']
  );
  assert.equal(r.stats.Go.ignored, 1);
  assert.equal(r.stats.Go.unresolved, 1);
  assert.deepEqual(r.list, []);
});

test('Go: without a go.mod nothing is guessed', () => {
  const r = run({ 'a/a.go': 'package a\nimport "b"\n', 'b/b.go': 'package b\n' });
  assert.deepEqual(r.list, []);
  assert.match(r.notes.join(' '), /no go\.mod/);
});

/* ------------------------------------------------------------------ JavaScript / TypeScript */

test('JS/TS: relative specifiers probe extensions, index files and TypeScript .js specifiers', () => {
  const r = run({
    'src/main.ts': [
      "import a from './a';", // a.ts
      "import b from './b.js';", // b.ts written the ESM way
      "import c from './c';", // c/index.tsx
      "import d from './d.jsx';", // d.tsx
      "import e from '../lib/e.mjs';", // e.mts
      "import f from './real.js';", // a real .js file with no .ts twin
      "import g from './missing';",
      "import h from './styles.css';",
      "import i from './worker?worker';",
      "import j from '.';", // src/index.ts
      "import k from 'react';",
      "import l from 'node:fs';",
    ].join('\n'),
    'src/a.ts': '',
    'src/b.ts': '',
    'src/c/index.tsx': '',
    'src/d.tsx': '',
    'lib/e.mts': '',
    'src/real.js': '',
    'src/worker.ts': '',
    'src/index.ts': "export * from './a';",
  }, ['src/styles.css']);
  assert.deepEqual(r.list, [
    'src/index.ts -> src/a.ts',
    'src/main.ts -> lib/e.mts',
    'src/main.ts -> src/a.ts',
    'src/main.ts -> src/b.ts',
    'src/main.ts -> src/c/index.tsx',
    'src/main.ts -> src/d.tsx',
    'src/main.ts -> src/index.ts',
    'src/main.ts -> src/real.js',
    'src/main.ts -> src/worker.ts',
  ]);
  const s = r.stats.TypeScript;
  assert.equal(s.unresolved, 1);
  assert.equal(s.samples[0].spec, './missing');
  assert.equal(s.asset, 1);
  assert.equal(s.external, 2);
});

test('JS/TS: a .js specifier from TypeScript prefers the .ts source next to its build output', () => {
  const tree = { 'a.ts': "import './x.js';", 'b.js': "import './x.js';", 'x.ts': '', 'x.js': '' };
  const r = run(tree);
  assert.deepEqual(r.list, ['a.ts -> x.ts', 'b.js -> x.js']);
});

test('JS/TS: JavaScript files prefer .js, TypeScript files prefer .ts when both exist', () => {
  const r = run({ 'a.js': "require('./util')", 'b.ts': "import './util'", 'util.js': '', 'util.ts': '' });
  assert.deepEqual(r.list, ['a.js -> util.js', 'b.ts -> util.ts']);
});

test('JS/TS: type-only imports are marked, and a value import wins when both exist', () => {
  const r = run({
    'a.ts': "import type { T } from './t';\nimport type { U } from './u';\nimport { u } from './u';",
    't.ts': '',
    'u.ts': '',
  });
  assert.equal(r.kindOf('a.ts', 't.ts'), 'type');
  assert.equal(r.kindOf('a.ts', 'u.ts'), 'import');
});

test('JS/TS: workspace packages resolve by name through package.json, mapping build output back to source', () => {
  const r = run({
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: './dist/index.js', exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' }, './utils/*': './dist/utils/*.js' } }),
    'packages/core/src/index.ts': "export * from './utils/math';",
    'packages/core/src/utils/math.ts': '',
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', dependencies: { '@acme/core': 'workspace:*', lodash: '^4' } }),
    'packages/ui/src/button.tsx': "import { x } from '@acme/core';\nimport { add } from '@acme/core/utils/math';\nimport _ from 'lodash';\nimport self from '@acme/ui/src/theme';\nimport cfg from '@acme/core/package.json';",
    'packages/ui/src/theme.ts': '',
    'packages/nodist/package.json': JSON.stringify({ name: 'nodist', main: 'dist/bundle.js' }),
    'packages/nodist/build.mjs': '',
    'apps/web/package.json': JSON.stringify({ name: 'web' }),
    'apps/web/main.ts': "import 'nodist';\nimport '@acme/core';",
    // a fixture that happens to be called like a real dependency must not attract imports
    'packages/ui/test/fixtures/lodash/package.json': JSON.stringify({ name: 'lodash' }),
    'packages/ui/test/fixtures/lodash/index.js': '',
  }, ['packages/core/package.json']);
  assert.deepEqual(r.list, [
    'apps/web/main.ts -> packages/core/src/index.ts',
    'apps/web/main.ts -> packages/nodist/', // no entry file in the repository: the package folder
    'packages/core/src/index.ts -> packages/core/src/utils/math.ts',
    'packages/ui/src/button.tsx -> packages/core/src/index.ts',
    'packages/ui/src/button.tsx -> packages/core/src/utils/math.ts',
    'packages/ui/src/button.tsx -> packages/ui/src/theme.ts',
  ]);
  assert.equal(r.stats.TypeScript.external, 1); // lodash
});

test('JS/TS: pnpm-workspace.yaml defines workspaces too, with exclusions', () => {
  const r = run({
    'pnpm-workspace.yaml': "packages:\n  - 'libs/**'\n  - '!libs/legacy/**'\n",
    'libs/a/package.json': '{"name":"lib-a"}',
    'libs/a/index.ts': '',
    'libs/legacy/b/package.json': '{"name":"lib-b"}',
    'libs/legacy/b/index.ts': '',
    'app/main.ts': "import 'lib-a';\nimport 'lib-b';",
  });
  assert.deepEqual(r.list, ['app/main.ts -> libs/a/index.ts']);
});

test('JS/TS: without a workspace definition only local-path dependencies and the root package count', () => {
  const r = run({
    'package.json': '{"name":"mylib","main":"lib/index.js"}',
    'lib/index.js': '',
    'examples/basic/package.json': '{"name":"example","dependencies":{"mylib":"^1.0.0","sibling":"file:../sibling","other":"^2"}}',
    'examples/basic/main.js': "require('mylib'); require('sibling'); require('other');",
    'examples/sibling/package.json': '{"name":"sibling"}',
    'examples/sibling/index.js': '',
    'examples/other/package.json': '{"name":"other"}',
    'examples/other/index.js': '',
  });
  assert.deepEqual(r.list, ['examples/basic/main.js -> examples/sibling/index.js', 'examples/basic/main.js -> lib/index.js']);
});

test('JS/TS: tsconfig paths, baseUrl and extends', () => {
  const r = run({
    'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@shared/*": ["./shared/src/*"] } } }',
    'app/tsconfig.json': '{ // comment\n "extends": "../tsconfig.base.json",\n "compilerOptions": { "paths": { "@/*": ["./src/*"], "config": ["./src/config.ts"], }, }, }',
    'app/src/main.ts': "import '@/lib/x';\nimport 'config';\nimport '@/nope';\nimport 'react';",
    'app/src/lib/x.ts': "import '@shared/y';",
    'app/src/config.ts': '',
    'shared/src/y.ts': '',
    'shared/tsconfig.json': '{ "extends": "../tsconfig.base" }',
    'shared/src/z.ts': "import '@shared/y';",
    // baseUrl alone makes bare specifiers resolve from that folder; paths are then relative to it
    'web/jsconfig.json': '{ "compilerOptions": { "baseUrl": "src", "paths": { "~/*": ["*"] } } }',
    'web/src/pages/home.js': "import 'components/nav';\nimport '~/components/nav';\nimport 'lodash';",
    'web/src/components/nav.js': '',
  });
  // app/tsconfig.json redefines "paths", which replaces the inherited map (as TypeScript does), so @shared/* is unknown there
  assert.deepEqual(r.list, [
    'app/src/main.ts -> app/src/config.ts',
    'app/src/main.ts -> app/src/lib/x.ts',
    'shared/src/z.ts -> shared/src/y.ts',
    'web/src/pages/home.js -> web/src/components/nav.js',
  ]);
  assert.equal(r.stats.TypeScript.unresolved, 1); // '@/nope' matched an alias but no file
  assert.equal(r.stats.TypeScript.external, 2); // react, and @shared/y seen from app/
  assert.equal(r.stats.JavaScript.external, 1); // lodash
});

test('JS/TS: package.json "imports" (#aliases)', () => {
  const r = run({
    'package.json': '{"name":"p","imports":{"#utils/*":"./src/utils/*.js","#config":{"default":"./dist/config.js"}}}',
    'src/a.ts': "import '#utils/str';\nimport '#config';\nimport '#unknown';",
    'src/utils/str.ts': '',
    'src/config.ts': '',
  });
  assert.deepEqual(r.list, ['src/a.ts -> src/config.ts', 'src/a.ts -> src/utils/str.ts']);
});

test('JS/TS: an import into an ignored folder is reported as ignored', () => {
  const r = run({ 'src/a.ts': "import '../vendor/lib';\nimport './gone';" }, ['vendor/lib.ts']);
  assert.equal(r.stats.TypeScript.ignored, 1);
  assert.equal(r.stats.TypeScript.unresolved, 1);
});

test('JS/TS: an alias or a package name that leads into an ignored folder is ignored too, not "not found"', () => {
  // trpc: `@trpc/server/vendor/is-plain-object` is packages/server/src/vendor/is-plain-object.ts, and "vendor" is skipped
  const r = run({
    'package.json': '{"name":"root","workspaces":["packages/*"]}',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"~/*":["./app/*"]}}}',
    'packages/server/package.json': '{"name":"@acme/server","exports":{"./vendor/*":"./dist/vendor/*.js"}}',
    'packages/server/src/index.ts': '',
    'packages/client/package.json': '{"name":"@acme/client"}',
    'packages/client/src/a.ts': "import '@acme/server/vendor/is-plain-object';\nimport '~/vendor/thing';\nimport '~/nowhere';\n",
  }, ['packages/server/src/vendor/is-plain-object.ts', 'app/vendor/thing.ts']);
  assert.equal(r.stats.TypeScript.ignored, 1, 'the alias into app/vendor');
  assert.equal(r.stats.TypeScript.unresolved, 1);
  assert.deepEqual(r.stats.TypeScript.samples.map((x) => x.spec), ['~/nowhere']);
  // a workspace package is still a known place: the import is drawn to the package as a whole
  assert.deepEqual(r.list, ['packages/client/src/a.ts -> packages/server/']);
});

test('test files are recognised per language', () => {
  const t = (p) => Imports.isTestFile(p, Imports.languageOf(p));
  assert.equal(t('pkg/a_test.go'), true);
  assert.equal(t('test/helper.go'), false, 'Go goes by file name only');
  assert.equal(t('src/a.test.ts'), true);
  assert.equal(t('src/a.spec.jsx'), true);
  assert.equal(t('src/__tests__/a.ts'), true);
  assert.equal(t('src/latest.ts'), false);
  assert.equal(t('tests/test_x.py'), true);
  assert.equal(t('pkg/conftest.py'), true);
  assert.equal(t('pkg/x_test.py'), true);
  assert.equal(t('pkg/contest.py'), false);
  assert.equal(t('lib/src/test/java/a/B.java'), true);
  assert.equal(t('lib/src/commonTest/kotlin/a/B.kt'), true);
  assert.equal(t('lib/src/main/java/a/Contest.java'), false);
  assert.equal(t('db/db_test.cc'), true);
  assert.equal(t('crates/a/tests/it.rs'), true);
  assert.equal(t('crates/a/src/lib.rs'), false);
});

/* ------------------------------------------------------------------ Python */

test('Python: statement forms', () => {
  const src = `
"""Docstring.

    import fake_in_docstring
"""
import os, sys
import a.b.c as abc, d
from x.y import (
    one,
    two as deux,  # comment
)
from . import sibling
from .mod import thing
from ..pkg.sub import *
from ... import top
import multi \\
    .line
s = "import fake_in_string"
def f():
    import lazy.inner
    from .late import x; import after_semicolon
if True: pass
# import fake_in_comment
important = 1
from_ = 2
`;
  const got = Imports.pyImports(src).map((s) => '.'.repeat(s.level) + s.module + (s.names ? ' :: ' + s.names.join(',') : ''));
  assert.deepEqual(got.sort(), [
    '. :: sibling',
    '... :: top',
    '..pkg.sub :: *',
    '.late :: x',
    '.mod :: thing',
    'a.b.c',
    'after_semicolon',
    'd',
    'lazy.inner',
    'multi.line',
    'os',
    'sys',
    'x.y :: one,two',
  ].sort());
});

test('Python: relative imports resolve inside the package tree', () => {
  const r = run({
    'src/app/__init__.py': 'from .core import run\nfrom . import util\n',
    'src/app/core.py': 'from .util import helper\nfrom .models import User\nfrom . import models\nfrom .. import outside\nfrom .missing import x\n',
    'src/app/util.py': '',
    'src/app/models/__init__.py': 'from .user import User\n',
    'src/app/models/user.py': 'from ..util import helper\nfrom ... import nothing\nfrom .. import core\n',
  });
  assert.deepEqual(r.list, [
    'src/app/__init__.py -> src/app/core.py',
    'src/app/__init__.py -> src/app/util.py',
    'src/app/core.py -> src/app/models/__init__.py',
    'src/app/core.py -> src/app/util.py',
    'src/app/models/__init__.py -> src/app/models/user.py',
    'src/app/models/user.py -> src/app/core.py',
    'src/app/models/user.py -> src/app/util.py',
  ]);
  assert.equal(r.stats.Python.unresolved, 3); // .missing, "from .. import outside", "from ... import nothing"
});

test('Python: "from pkg import name" prefers the submodule, then the package, then pkg.py', () => {
  const r = run({
    'pkg/__init__.py': '',
    'pkg/name.py': '',
    'pkg/sub/__init__.py': '',
    'single.py': '',
    'main.py': 'from pkg import name\nfrom pkg import other_attr\nfrom pkg import sub\nfrom single import thing\nimport pkg.name\nimport pkg\nimport requests\nfrom pkg.nope import x\n',
  });
  assert.deepEqual(r.list, [
    'main.py -> pkg/__init__.py',
    'main.py -> pkg/name.py',
    'main.py -> pkg/sub/__init__.py',
    'main.py -> single.py',
  ]);
  assert.equal(r.stats.Python.external, 1);
  assert.equal(r.stats.Python.unresolved, 1); // pkg.nope: pkg is ours, nope is not there
});

test('Python: absolute imports resolve against src/, the package root and project folders', () => {
  const r = run({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'src/demo/__init__.py': '',
    'src/demo/cli.py': 'import demo.core\nfrom demo import core\nimport json\n',
    'src/demo/core.py': '',
    'tests/test_cli.py': 'from demo.cli import main\nimport helpers\n',
    'tests/helpers.py': '',
    'services/api/pyproject.toml': '[project]\nname = "api"\n',
    'services/api/api/__init__.py': '',
    'services/api/api/routes.py': 'from api import db\nfrom demo.core import thing\n',
    'services/api/api/db.py': '',
    'scripts/run.py': 'import sibling_script\nimport demo\n',
    'scripts/sibling_script.py': '',
  }, ['pyproject.toml', 'services/api/pyproject.toml']);
  assert.deepEqual(r.list, [
    'scripts/run.py -> scripts/sibling_script.py',
    'scripts/run.py -> src/demo/__init__.py',
    'services/api/api/routes.py -> services/api/api/db.py',
    'services/api/api/routes.py -> src/demo/core.py',
    'src/demo/cli.py -> src/demo/core.py',
    'tests/test_cli.py -> src/demo/cli.py',
    'tests/test_cli.py -> tests/helpers.py',
  ]);
});

test('Python: a standard-library name is not mistaken for a local file elsewhere in the repository', () => {
  const r = run({
    'logging.py': '',
    'src/pkg/__init__.py': '',
    'src/pkg/a.py': 'import logging\nimport json\n',
    'src/json/__init__.py': '',
  });
  assert.deepEqual(r.list, []);
  assert.equal(r.stats.Python.external, 2);
});

test('Python: a namespace package that a manifest declares as a dependency is outside, not "not found"', () => {
  // poetry: src/poetry/ is in the repository, poetry.core comes from the distribution poetry-core
  const tree = {
    'src/poetry/factory.py': 'from poetry.core.packages.dependency import Dependency\nimport poetry.core\nfrom poetry import core\nfrom poetry.missing import thing\nfrom poetry.utils import helpers\n',
    'src/poetry/utils/helpers.py': '',
  };
  const without = run(tree);
  assert.equal(without.stats.Python.unresolved, 4, 'nothing says poetry.core is a dependency, so it is reported');
  const withHint = Imports.analyze(new Map(Object.entries(tree)), [], { pythonDependencies: new Set(['poetry-core', 'requests']) });
  assert.equal(withHint.stats.Python.unresolved, 1);
  assert.deepEqual(withHint.stats.Python.samples.map((x) => x.spec), ['from poetry.missing import thing']);
  assert.equal(withHint.stats.Python.external, 3);
  assert.deepEqual(withHint.edges.map((e) => e.from + ' -> ' + e.to), ['src/poetry/factory.py -> src/poetry/utils/helpers.py']);
});

test('Python: an import of a Cython or C extension module in the repository is counted apart, not as "not found"', () => {
  // yarl: yarl/_quoting_c.pyx
  const r = run({
    'yarl/__init__.py': '',
    'yarl/_quoting.py': 'from ._quoting_c import _Quoter\nfrom . import _speedups\nfrom ._absent import x\n',
    'tests/test_quoting.py': 'from yarl._quoting_c import _Quoter\nimport yarl._speedups\nfrom yarl import _speedups\nfrom yarl._absent import y\nfrom yarl import version\n',
  }, ['yarl/_quoting_c.pyx', 'yarl/_speedups.c']);
  assert.equal(r.stats.Python.asset, 5);
  assert.equal(r.stats.Python.unresolved, 2);
  assert.deepEqual(r.list, ['tests/test_quoting.py -> yarl/__init__.py'], 'only `from yarl import version` is a name in the package itself');
});

/* ------------------------------------------------------------------ Java, Kotlin, Scala */

test('Java: named, static, nested and wildcard imports', () => {
  const r = run({
    'src/main/java/com/acme/app/Main.java': `package com.acme.app;
import com.acme.model.User;
import com.acme.model.Order.Line;
import static com.acme.util.Strings.isBlank;
import static com.acme.util.Strings.*;
import com.acme.model.*;
import com.acme.generated.Thing;
import com.acme.unknown.sub.Other;
import java.util.List;
/* import com.acme.fake.Commented; */
class Main { String s = """
import com.acme.fake.InTextBlock;
"""; }
`,
    'src/main/java/com/acme/model/User.java': 'package com.acme.model;\npublic class User {}\n',
    'src/main/java/com/acme/model/Order.java': 'package com.acme.model;\npublic class Order { static class Line {} }\n',
    'src/main/java/com/acme/util/Strings.java': 'package com.acme.util;\npublic final class Strings {}\n',
    'src/main/java/com/acme/generated/Marker.java': 'package com.acme.generated;\ninterface Marker {}\n',
    'src/main/java/com/acme/fake/Commented.java': 'package com.acme.fake;\nclass Commented {}\n',
    'src/main/java/com/acme/fake/InTextBlock.java': 'package com.acme.fake;\nclass InTextBlock {}\n',
  });
  assert.deepEqual(r.list, [
    'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/generated/', // Thing is not declared in any file there
    'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/model/', // wildcard
    'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/model/Order.java',
    'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/model/User.java',
    'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/util/Strings.java',
  ]);
  assert.equal(r.stats.Java.external, 2); // java.util.List and com.acme.unknown.sub.Other
});

test('Java: classes in the same package are linked without an import', () => {
  const r = run({
    'a/Service.java': 'package a;\nimport b.Helper;\nclass Service { Repo repo; Helper h; a.Other o; String s = "Unused"; /* Hidden */ Inner i; static class Inner {} }\n',
    'a/Repo.java': 'package a;\ninterface Repo {}\n',
    'a/Helper.java': 'package a;\nclass Helper {}\n', // shadowed by the explicit import of b.Helper
    'a/Other.java': 'package a;\nclass Other {}\n', // only used fully qualified: not detected
    'a/Unused.java': 'package a;\nclass Unused {}\n',
    'a/Hidden.java': 'package a;\nclass Hidden {}\n',
    'a/Inner.java': 'package a;\nclass Inner {}\n', // Service declares its own Inner
    'b/Helper.java': 'package b;\npublic class Helper {}\n',
  });
  assert.deepEqual(r.list, ['a/Service.java -> a/Repo.java', 'a/Service.java -> b/Helper.java']);
  assert.equal(r.kindOf('a/Service.java', 'a/Repo.java'), 'same-package');
  assert.equal(r.stats.Java.samePackage, 1);
});

test('Kotlin: imports of classes, top-level functions and extension properties', () => {
  const r = run({
    'app/src/main/kotlin/com/acme/App.kt': `package com.acme
import com.acme.core.Engine
import com.acme.core.Engine as E
import com.acme.core.start
import com.acme.core.isReady
import com.acme.core.Config
import com.acme.core.*
import kotlinx.coroutines.flow.Flow
fun main() { val raw = """
import com.acme.fake.Nope
""" }
`,
    'core/src/main/kotlin/com/acme/core/Engine.kt': 'package com.acme.core\nclass Engine\n',
    'core/src/main/kotlin/com/acme/core/Functions.kt': 'package com.acme.core\n\ninternal const val LIMIT = 3\n\npublic fun <T> Engine.start(x: T) {}\n\nval Class<*>.isReady: Boolean\n  get() = true\n\ndata class Config(val a: Int)\n',
    'core/src/main/kotlin/com/acme/fake/Nope.kt': 'package com.acme.fake\nclass Nope\n',
  });
  assert.deepEqual(r.list, [
    'app/src/main/kotlin/com/acme/App.kt -> core/src/main/kotlin/com/acme/core/',
    'app/src/main/kotlin/com/acme/App.kt -> core/src/main/kotlin/com/acme/core/Engine.kt',
    'app/src/main/kotlin/com/acme/App.kt -> core/src/main/kotlin/com/acme/core/Functions.kt',
    'core/src/main/kotlin/com/acme/core/Functions.kt -> core/src/main/kotlin/com/acme/core/Engine.kt',
  ]);
  assert.equal(r.stats.Kotlin.external, 1);
});

test('JVM: a name that no file declares in a package spread over several folders is reported, not guessed', () => {
  const r = run({
    'a/src/main/kotlin/p/A.kt': 'package p\nclass A\n',
    'b/src/main/kotlin/p/B.kt': 'package p\nclass B\n',
    'c/src/main/kotlin/q/C.kt': 'package q\nimport p.generatedThing\nimport p.A\n',
  });
  assert.deepEqual(r.list, ['c/src/main/kotlin/q/C.kt -> a/src/main/kotlin/p/A.kt']);
  assert.equal(r.stats.Kotlin.unresolved, 1);
  assert.match(r.stats.Kotlin.samples[0].spec, /spans 2 folders/);
});

test('JVM: code outside the tests does not point at test-only copies of a class', () => {
  const r = run({
    'src/main/java/p/Thing.java': 'package p;\npublic class Thing {}\n',
    'src/test/java/p/Thing.java': 'package p;\npublic class Thing {}\n',
    'src/main/java/q/User.java': 'package q;\nimport p.Thing;\nclass User {}\n',
    'src/test/java/q/UserTest.java': 'package q;\nimport p.Thing;\nclass UserTest { User u; }\n',
  });
  assert.deepEqual(r.list, [
    'src/main/java/q/User.java -> src/main/java/p/Thing.java',
    'src/test/java/q/UserTest.java -> src/main/java/p/Thing.java',
    'src/test/java/q/UserTest.java -> src/main/java/q/User.java',
    'src/test/java/q/UserTest.java -> src/test/java/p/Thing.java',
  ]);
});

test('Scala: selectors, renames, wildcards, chained packages and relative imports', () => {
  const p = Imports.jvmParse('package com.acme\npackage app\n\nimport com.acme.model.{User, Order => O, _}\nimport com.acme.util._, scala.collection.mutable\nimport model.Account\nimport _root_.com.acme.util.Text\nimport com.acme.model.given\n', 'Scala');
  assert.equal(p.pkg, 'com.acme.app');
  assert.deepEqual(p.imports.map((i) => i.name + (i.wildcard ? '.*' : '')), [
    'com.acme.model.User', 'com.acme.model.Order', 'com.acme.model.*', 'com.acme.util.*', 'scala.collection.mutable', 'model.Account', 'com.acme.util.Text', 'com.acme.model.given',
  ]);
  const r = run({
    'src/main/scala/com/acme/app/Main.scala': 'package com.acme\npackage app\n\nimport com.acme.model.{User, Order => O}\nimport com.acme.util._\nimport model.Account\nimport scala.collection.mutable\nobject Main\n',
    'src/main/scala/com/acme/model/Models.scala': 'package com.acme.model\n\ncase class User(name: String)\nfinal case class Order(id: Int)\nprivate[acme] sealed trait Account\n',
    'src/main/scala/com/acme/util/Text.scala': 'package com.acme.util\nobject Text\n',
  });
  assert.deepEqual(r.list, [
    'src/main/scala/com/acme/app/Main.scala -> src/main/scala/com/acme/model/Models.scala',
    'src/main/scala/com/acme/app/Main.scala -> src/main/scala/com/acme/util/',
  ]);
  assert.equal(r.stats.Scala.external, 1);
});

/* ------------------------------------------------------------------ Rust */

test('Rust: use trees expand to flat paths', () => {
  const paths = Imports.expandUseTree('crate::{a::{self, B}, c::*, d as e}').map((p) => p.join('::'));
  assert.deepEqual(paths, ['crate::a::self', 'crate::a::B', 'crate::c::*', 'crate::d']);
});

test('Rust: mod declarations, use paths, super, inline modules and #[path]', () => {
  const r = run({
    'Cargo.toml': '[package]\nname = "demo"\n',
    'src/lib.rs': 'pub mod store;\nmod util;\n#[path = "os/linux.rs"]\nmod platform;\nmod missing;\npub use store::Store;\nuse std::fmt;\n',
    'src/store.rs': 'mod memory;\npub mod disk;\nuse crate::util::helper;\nuse self::memory::Mem;\nuse serde::Serialize;\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use super::super::util;\n    use crate::platform;\n}\n',
    'src/store/memory.rs': 'use super::disk::Disk;\nuse super::super::util::{self, helper};\nfn f() { let s = "use crate::fake;"; crate::platform::init(); }\n// use crate::commented;\n',
    'src/store/disk/mod.rs': 'use crate::Store;\n',
    'src/util.rs': '',
    'src/os/linux.rs': '',
    'src/main.rs': 'use demo_unknown::x;\nmod cli;\n',
    'src/cli.rs': 'use crate::helper_in_main;\n',
  });
  assert.deepEqual(r.list, [
    'src/lib.rs -> src/os/linux.rs',
    'src/lib.rs -> src/store.rs',
    'src/lib.rs -> src/util.rs',
    'src/main.rs -> src/cli.rs',
    'src/cli.rs -> src/main.rs', // crate:: in a file of the binary means the binary's root
    'src/store.rs -> src/os/linux.rs',
    'src/store.rs -> src/store/disk/mod.rs',
    'src/store.rs -> src/store/memory.rs',
    'src/store.rs -> src/util.rs',
    'src/store/disk/mod.rs -> src/lib.rs',
    'src/store/memory.rs -> src/os/linux.rs',
    'src/store/memory.rs -> src/store/disk/mod.rs',
    'src/store/memory.rs -> src/util.rs',
  ].sort());
  assert.equal(r.kindOf('src/lib.rs', 'src/store.rs'), 'mod');
  assert.equal(r.stats.Rust.unresolved, 1); // mod missing;
});

test('Rust: the last name of an expression path is an item, not a module of the same name', () => {
  // ripgrep has `fn search` in main.rs next to `mod search;`: `crate::search(args)` calls the function
  const r = run({
    'Cargo.toml': '[package]\nname = "demo"\n',
    'src/main.rs': 'mod search;\nmod index;\nmod flags;\nfn search() {}\nfn main() { let p = flags::parse(); }\n',
    'src/search.rs': 'pub struct Worker;\n',
    'src/index.rs': 'fn run() { crate::search(); }\nfn other() -> crate::search::Worker { todo!() }\n',
    'src/flags/mod.rs': 'mod parse;\npub use self::parse::parse;\n',
    'src/flags/parse.rs': 'pub fn parse() {}\n',
    'src/uses.rs': '',
  });
  assert.ok(r.has('src/index.rs', 'src/main.rs'), 'crate::search() is the function in the crate root');
  assert.ok(r.has('src/index.rs', 'src/search.rs'), 'crate::search::Worker is in the module');
  // flags::parse() is whatever flags/mod.rs exports under that name, so the edge stops at flags/mod.rs
  assert.deepEqual(r.list.filter((e) => e.startsWith('src/main.rs -> ')), ['src/main.rs -> src/flags/mod.rs', 'src/main.rs -> src/index.rs', 'src/main.rs -> src/search.rs']);
  // with `use`, the last name may be a module
  const u = run({
    'Cargo.toml': '[package]\nname = "demo"\n',
    'src/lib.rs': 'mod a;\nmod b;\n',
    'src/a.rs': 'use crate::b;\n',
    'src/b.rs': '',
  });
  assert.ok(u.has('src/a.rs', 'src/b.rs'));
});

test('Rust: path dependencies between workspace crates, renamed and inherited', () => {
  const r = run({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nshared-types = { path = "crates/shared-types" }\n',
    'crates/app/Cargo.toml': '[package]\nname = "app"\n[dependencies]\nengine = { path = "../engine" }\nshared-types.workspace = true\nrenamed = { path = "../engine", package = "engine" }\nserde = "1"\n',
    'crates/app/src/main.rs': 'use engine::run::start;\nuse shared_types::Id;\nuse serde::Serialize;\nfn main() { renamed::run::start(); }\nextern crate engine as e;\n',
    'crates/engine/Cargo.toml': '[package]\nname = "engine"\n',
    'crates/engine/src/lib.rs': 'pub mod run;\n',
    'crates/engine/src/run.rs': '',
    'crates/shared-types/Cargo.toml': '[package]\nname = "shared-types"\n',
    'crates/shared-types/src/lib.rs': '',
  });
  assert.deepEqual(r.list, [
    'crates/app/src/main.rs -> crates/engine/src/lib.rs',
    'crates/app/src/main.rs -> crates/engine/src/run.rs',
    'crates/app/src/main.rs -> crates/shared-types/src/lib.rs',
    'crates/engine/src/lib.rs -> crates/engine/src/run.rs',
  ]);
  assert.equal(r.stats.Rust.external, 1); // serde
});

test('Rust: integration tests that share modules through tests/tests.rs resolve crate:: to that root', () => {
  const r = run({
    'Cargo.toml': '[package]\nname = "demo"\n',
    'src/lib.rs': 'pub mod x;\n',
    'src/x.rs': '',
    'src/main.rs': 'fn main() { demo::x::run(); }\n',
    'tests/tests.rs': 'mod util;\nmod feature;\n',
    'tests/util.rs': 'pub struct Dir;\n',
    'tests/feature.rs': 'use crate::util::Dir;\n',
    'tests/standalone.rs': 'use demo::x::Thing;\nmod helper;\n',
    'tests/helper.rs': 'use crate::helper_fn;\n',
    'examples/a.rs': 'fn main() {}\n',
    'examples/b.rs': 'fn main() {}\n',
  });
  assert.deepEqual(r.list, [
    'src/lib.rs -> src/x.rs',
    'src/main.rs -> src/x.rs', // the binary uses its own package's library by name
    'tests/feature.rs -> tests/util.rs',
    'tests/helper.rs -> tests/standalone.rs',
    'tests/standalone.rs -> src/x.rs',
    'tests/standalone.rs -> tests/helper.rs',
    'tests/tests.rs -> tests/feature.rs',
    'tests/tests.rs -> tests/util.rs',
  ]);
});

/* ------------------------------------------------------------------ C / C++ */

test('C/C++: quoted includes resolve next to the file, from the root, then by a unique path suffix', () => {
  const r = run({
    'src/main.cc': '#include "util.h"\n#include "db/store.h"\n#  include "leveldb/db.h"\n#include "dup.h"\n#include <vector>\n#include "nowhere.h"\n// #include "commented.h"\nconst char* s = "#include \\"string.h\\"";\n/*\n#include "block.h"\n*/\n',
    'src/util.h': '',
    'db/store.h': '#include "store_impl.h"\n',
    'db/store_impl.h': '',
    'include/leveldb/db.h': '',
    'a/dup.h': '',
    'b/dup.h': '',
    'commented.h': '',
    'block.h': '',
    'string.h': '',
  });
  assert.deepEqual(r.list, [
    'db/store.h -> db/store_impl.h',
    'src/main.cc -> db/store.h',
    'src/main.cc -> include/leveldb/db.h',
    'src/main.cc -> src/util.h',
  ]);
  const s = r.stats['C/C++'];
  assert.equal(s.unresolved, 1); // dup.h matches two files
  assert.match(s.samples[0].spec, /several files match/);
  assert.equal(s.external, 2); // nowhere.h and <vector>
  assert.equal(s.found, 7);
});

test('C/C++: <angle> includes are followed only when they name a repository file by its path on the include path', () => {
  // hiredis examples write #include <hiredis.h> and <adapters/ae.h> and build with -I.
  const r = run({
    'examples/example.c': '#include <stdio.h>\n#include <hiredis.h>\n#include <adapters/ae.h>\n#include <leveldb/db.h>\n#include <util.h>\n#include <string.h>\n',
    'hiredis.h': '',
    'adapters/ae.h': '#include <ae.h>\n#include "../hiredis.h"\n',
    'include/leveldb/db.h': '',
    'deep/inside/util.h': '',
    'compat/string.h': '',
  });
  assert.deepEqual(r.list, [
    'adapters/ae.h -> hiredis.h',
    'examples/example.c -> adapters/ae.h',
    'examples/example.c -> hiredis.h',
    'examples/example.c -> include/leveldb/db.h',
  ]);
  // <util.h> and <string.h> exist somewhere in the repository, but not where an include path would find them:
  // they are system headers as far as anyone can tell, so nothing is drawn and nothing is reported missing
  const s = r.stats['C/C++'];
  assert.equal(s.internal, 4);
  assert.equal(s.external, 4);
  assert.equal(s.unresolved, 0);
});

/* ------------------------------------------------------------------ general */

test('Windows line endings do not change the result', () => {
  const unix = run({ 'go.mod': 'module m\n', 'a/a.go': 'package a\nimport (\n "m/b"\n)\n', 'b/b.go': 'package b\n', 'x.py': 'from . import y\n', 'y.py': '', '__init__.py': '' });
  const win = run({ 'go.mod': 'module m\r\n', 'a/a.go': 'package a\r\nimport (\r\n "m/b"\r\n)\r\n', 'b/b.go': 'package b\r\n', 'x.py': 'from . import y\r\n', 'y.py': '', '__init__.py': '' });
  assert.deepEqual(win.list, unix.list);
  assert.equal(unix.list.length, 2);
});

test('edges never point at a file outside the scanned set and never loop on themselves', () => {
  const r = run({
    'a.ts': "import './a';\nimport './b';",
    'b.ts': "import './a';",
    'c.py': 'import c\n',
  });
  for (const e of r.edges) {
    assert.notEqual(e.from, e.to);
    assert.ok(r.sources.has(e.from));
    assert.ok(e.to.endsWith('/') || r.sources.has(e.to));
  }
  assert.deepEqual(r.list, ['a.ts -> b.ts', 'b.ts -> a.ts']);
});
