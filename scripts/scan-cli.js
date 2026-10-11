#!/usr/bin/env node
/* Runs the same scanner the extension uses over a folder or a .zip and prints the numbers.
   Usage: node scripts/scan-cli.js <folder-or-zip> [--tests] [--unresolved] [--edges] [--pkg-edges] */
const fs = require('node:fs');
const path = require('node:path');
const lib = path.join(__dirname, '..', 'extension', 'lib');
const Zip = require(path.join(lib, 'zip.js'));
const Scan = require(path.join(lib, 'scan.js'));
const Views = require(path.join(lib, 'views.js'));
const Graph = require(path.join(lib, 'graph.js'));

async function load(target) {
  const files = new Map();
  const allPaths = [];
  const skipped = { folder: 0, minified: 0, size: 0 };
  const consider = (rel, size) => {
    allPaths.push(rel);
    const w = Scan.wants(rel, size);
    if (w.skipped) skipped[w.skipped]++;
    return w.read;
  };
  if (fs.statSync(target).isDirectory()) {
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? rel + '/' + e.name : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '.git') walk(full, childRel);
        } else if (e.isFile()) {
          if (consider(childRel, fs.statSync(full).size)) files.set(childRel, fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(target, '');
  } else {
    const zip = Zip.open(fs.readFileSync(target));
    const prefix = Zip.commonTopFolder(zip.entries.map((e) => e.name));
    for (const entry of zip.entries) {
      if (entry.isDirectory) continue;
      const rel = entry.name.slice(prefix.length);
      if (consider(rel, entry.size)) files.set(rel, await Zip.readText(zip, entry));
    }
  }
  return { files, allPaths, skipped };
}

(async () => {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: node scripts/scan-cli.js <folder-or-zip> [--tests] [--unresolved] [--edges] [--pkg-edges]');
    process.exit(2);
  }
  const includeTests = args.includes('--tests');
  const started = Date.now();
  const { files, allPaths, skipped } = await load(target);
  const result = Scan.scan(files, { allPaths });
  const suggestion = Views.suggestLevel(result.code, includeTests);
  const summary = { target, filesInRepo: allPaths.length, filesScanned: files.size, filesSkipped: skipped, languages: result.languages, imports: {}, code: {}, ci: {}, packages: {} };
  for (const [lang, s] of Object.entries(result.code.stats)) {
    summary.imports[lang] = { files: s.files, testFiles: s.testFiles, found: s.found, internal: s.internal, external: s.external, unresolved: s.unresolved, ignored: s.ignored, asset: s.asset, samePackage: s.samePackage };
  }
  for (const level of ['files', 'packages']) {
    const view = Views.codeView(result.code, { level, includeTests });
    const cycles = Graph.findCycles(view.nodes.map((n) => n.id), view.edges);
    summary.code[level] = { nodes: view.nodes.length, edges: view.edges.length, cycles: cycles.length, largestCycle: cycles[0] ? cycles[0].nodes.length : 0 };
  }
  summary.code.suggested = suggestion;
  const ci = Views.ciView(result.ci);
  summary.ci = { workflows: result.ci.workflows.length, jobs: ci.nodes.length, edges: ci.edges.length };
  const pk = Views.packagesView(result.packages, { includeDev: true, includeIndirect: false });
  summary.packages = { manifests: result.packages.manifests.length, nodes: pk.nodes.length, edges: pk.edges.length, hiddenIndirect: pk.hiddenIndirect };
  summary.notes = [...result.code.notes, ...result.ci.notes, ...result.packages.notes];
  summary.ms = Date.now() - started;
  console.log(JSON.stringify(summary, null, 2));
  if (args.includes('--unresolved')) {
    for (const [lang, s] of Object.entries(result.code.stats)) {
      for (const u of s.samples) console.log('UNRESOLVED\t' + lang + '\t' + u.from + '\t' + u.spec);
    }
  }
  if (args.includes('--pkg-edges')) {
    const view = Views.codeView(result.code, { level: 'packages', includeTests });
    for (const e of view.edges) console.log('PKGEDGE\t' + e.from + '\t' + e.to + '\t' + e.count);
  }
  if (args.includes('--edges')) {
    for (const e of result.code.edges) console.log('EDGE\t' + e.from + '\t' + e.to + '\t' + e.kind);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
