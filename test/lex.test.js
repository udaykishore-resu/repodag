// Lexing helpers: comment/string blanking, the JS/TS import scanner, JSON-with-comments and the TOML reader.
const test = require('node:test');
const assert = require('node:assert/strict');
const Lex = require('../extension/lib/lex.js');
const Toml = require('../extension/lib/toml.js');

const specs = (src) => Lex.jsImports(src).map((i) => i.spec);

test('paths: join normalises and refuses to climb above the root', () => {
  assert.equal(Lex.join('a/b', '../c/./d'), 'a/c/d');
  assert.equal(Lex.join('', './x'), 'x');
  assert.equal(Lex.join('a', '..'), '');
  assert.equal(Lex.join('a', '../..'), null);
  assert.equal(Lex.dirname('a/b/c.go'), 'a/b');
  assert.equal(Lex.dirname('c.go'), '');
  assert.equal(Lex.extname('a/b.test.TS'), '.ts');
  assert.equal(Lex.extname('a/.gitignore'), '');
  assert.equal(Lex.dirId(''), './');
  assert.equal(Lex.dirId('a/b'), 'a/b/');
});

test('blank keeps length and line breaks, removes comments and string contents', () => {
  const src = 'a = "x // not a comment"; // real\n/* block\n import x */ b = \'c\';\n';
  const out = Lex.blank(src, {});
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!out.includes('not a comment'));
  assert.ok(!out.includes('real'));
  assert.ok(!out.includes('import x'));
  assert.ok(out.includes('a = "'));
  assert.ok(out.includes('b = \''));
});

test('blank handles nested comments, raw strings, text blocks, char literals and lifetimes', () => {
  assert.equal(Lex.blank('a /* x /* y */ z */ b', { nested: true }).replace(/\s+/g, ' '), 'a b');
  assert.equal(Lex.blank('a /* x /* y */ z */ b', {}).replace(/\s+/g, ' '), 'a z */ b');
  const rust = 'let s = r#"use crate::fake; "quoted" "#; fn f<\'a>(x: &\'a str) { let c = \'"\'; use crate::real; }';
  const r = Lex.blank(rust, { nested: true, rustRaw: true });
  assert.ok(!r.includes('fake'));
  assert.ok(r.includes('use crate::real'));
  assert.ok(r.includes("<'a>"));
  const java = 'String s = """\n  import a.b.Fake;\n  """; char q = \'"\'; import x.Real;';
  const j = Lex.blank(java, { triple: true });
  assert.ok(!j.includes('Fake'));
  assert.ok(j.includes('import x.Real'));
  const go = 'var s = `import "fake"` // c\nvar t = 1';
  assert.ok(!Lex.blank(go, { backtick: true }).includes('fake'));
  const cpp = 'auto s = R"x(#include "fake.h")x"; /* c */ #include "real.h"';
  const c = Lex.blank(cpp, { keepStrings: true, cppRaw: true });
  assert.ok(c.includes('#include "real.h"'));
  assert.ok(c.includes('fake.h'), 'keepStrings leaves raw string contents alone');
  const groovy = "url 'https://example.org/x' // c\nimplementation 'g:a:1'";
  const g = Lex.blank(groovy, { keepStrings: true, single: true });
  assert.ok(g.includes("'https://example.org/x'"));
  assert.ok(g.includes("implementation 'g:a:1'"));
});

test('blankPython removes comments, strings and docstrings but keeps code', () => {
  const src = 'import a  # import fake1\ns = "import fake2"\n"""\nimport fake3\n"""\nx = r\'\\\'\'; import b\n';
  const out = Lex.blankPython(src);
  assert.equal(out.length, src.length);
  assert.ok(!/fake/.test(out));
  assert.ok(out.includes('import a'));
  assert.ok(out.includes('import b'));
});

test('JS: every import form is found', () => {
  const src = `
    import a from './a';
    import * as b from "./b";
    import { c1, c2 as c3 } from './c';
    import d, { d1 } from './d';
    import e, * as e2 from './e';
    import './side-effect';
    import type { T } from './types';
    import type U from './u';
    import { type V, w } from './v';
    export * from './re1';
    export * as ns from './re2';
    export { x, y as z } from './re3';
    export type { K } from './re4';
    const f = require('./f');
    const g = await import('./g');
    const h = import(\`./h\`);
    import json from './data.json' with { type: 'json' };
    import i = require('./i');
  `;
  assert.deepEqual(specs(src), [
    './a', './b', './c', './d', './e', './side-effect', './types', './u', './v',
    './re1', './re2', './re3', './re4', './f', './g', './h', './data.json', './i',
  ]);
  const byspec = new Map(Lex.jsImports(src).map((i) => [i.spec, i]));
  assert.equal(byspec.get('./types').typeOnly, true);
  assert.equal(byspec.get('./u').typeOnly, true);
  assert.equal(byspec.get('./v').typeOnly, false);
  assert.equal(byspec.get('./re4').typeOnly, true);
  assert.equal(byspec.get('./f').kind, 'require');
  assert.equal(byspec.get('./g').kind, 'dynamic');
  assert.equal(byspec.get('./re1').kind, 'export');
});

test('JS: multi-line imports and odd binding names', () => {
  const src = `import {
    a,
    b as c, // trailing comment with from './nope'
    default as d,
  } from './multi'
  import from from './from'
  import type from './type-as-name'
  import {} from './empty'
  import def, {
    x,
  } from "./mixed"`;
  assert.deepEqual(specs(src), ['./multi', './from', './type-as-name', './empty', './mixed']);
});

test('JS: things that only look like imports are ignored', () => {
  const src = `
    // import a from './comment-line';
    /* import b from './comment-block';
       require('./comment-require') */
    const s1 = "import c from './string-double'";
    const s2 = 'require("./string-single")';
    const t = \`
      import d from './template'
      \${ok ? require('./inside-template-expression') : ''}
      import('./template-dynamic')
    \`;
    const re = /import e from '.\\/regex'/;
    const glob = 'src/**/*.ts'; /* this must not start a comment */ import real from './real';
    obj.import('./method');
    obj.require('./method2');
    const o = { import: 1, export: 2, require: 3 };
    export const from = './not-a-reexport';
    export default function () {}
    import.meta.url;
    require(variable);
    require('./a' + b);
    import(pathVariable);
    const x = a / b / require('./after-division');
  `;
  assert.deepEqual(specs(src), ['./inside-template-expression', './real', './after-division']);
});

test('JS: JSX text and apostrophes do not derail the scanner', () => {
  const src = `import React from 'react';
    export const A = () => <p>Don't import this from 'nowhere'</p>;
    const B = () => <div title="x">a / b</div>;
    import { helper } from './helper';
    const C = () => <code>import x from './jsx-text'</code>;
    const last = require('./last');`;
  assert.deepEqual(specs(src), ['react', './helper', './last']);
});

test('JS: TypeScript module augmentation counts as a reference', () => {
  const src = "import type {} from '../..'\ndeclare module '../..' { interface X {} }\ndeclare module '*.md' { const s: string }\ndeclare module 'pkg' {}\n";
  const found = Lex.jsImports(src);
  assert.deepEqual(found.map((i) => i.spec), ['../..', '../..', 'pkg']);
  assert.equal(found[1].kind, 'augment');
});

test('JS: an unterminated string or template does not swallow later lines', () => {
  const src = "const s = 'broken\nimport a from './a';\nconst r = x / 2; // /\nimport b from './b';\n";
  assert.deepEqual(specs(src), ['./a', './b']);
});

test('parseJsonc reads tsconfig-style JSON', () => {
  const cfg = Lex.parseJsonc(`{
    // comment
    "compilerOptions": {
      "baseUrl": ".", /* inline */
      "paths": { "@/*": ["src/*"], "url": ["http://x//y"], },
    },
  }`);
  assert.deepEqual(cfg.compilerOptions.paths, { '@/*': ['src/*'], url: ['http://x//y'] });
  assert.equal(Lex.parseJsonc('{ nope'), null);
});

test('TOML: tables, dotted keys, arrays, inline tables and strings', () => {
  const t = Toml.parse(`
# comment
[package]
name = "demo"   # trailing
version = '0.1.0'
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio.workspace = true
local = { path = "../local", version = "0.2" }
"quoted-key" = "1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[[bin]]
name = "a"
path = "src/a.rs"

[[bin]]
name = "b"

[project]
dependencies = [
  "requests>=2",   # comment inside an array
  'flask',
]
multi = """
line one
line "two" \\
   continued"""
n = 1_000
f = 1.5e3
b = false
d = 2026-10-10
when = 2026-10-10 12:30:00
nested = { a = { b = 1 }, c = [1, 2,] }
`);
  assert.equal(t.package.name, 'demo');
  assert.equal(t.package.version, '0.1.0');
  assert.deepEqual(t.dependencies.serde, { version: '1.0', features: ['derive'] });
  assert.equal(t.dependencies.tokio.workspace, true);
  assert.equal(t.dependencies['quoted-key'], '1');
  assert.equal(t.target['cfg(unix)'].dependencies.libc, '0.2');
  assert.equal(t.bin.length, 2);
  assert.equal(t.bin[0].path, 'src/a.rs');
  assert.deepEqual(t.project.dependencies, ['requests>=2', 'flask']);
  assert.equal(t.project.multi, 'line one\nline "two" continued');
  assert.equal(t.project.n, 1000);
  assert.equal(t.project.f, 1500);
  assert.equal(t.project.b, false);
  assert.equal(t.project.d, '2026-10-10');
  assert.equal(t.project.when, '2026-10-10 12:30:00');
  assert.deepEqual(t.project.nested, { a: { b: 1 }, c: [1, 2] });
});

test('TOML: errors carry a line number, and __proto__ is just a key', () => {
  assert.throws(() => Toml.parse('a = 1\nb = \n'), /TOML line 2/);
  assert.throws(() => Toml.parse('[a\n'), /TOML line 1/);
  const t = Toml.parse('[__proto__]\npolluted = true\n');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(t, '__proto__'), true);
});
