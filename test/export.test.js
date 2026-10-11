// Exports: Mermaid, Graphviz DOT and JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const Export = require('../extension/lib/export.js');
const Graph = require('../extension/lib/graph.js');

const graph = {
  nodes: [
    { id: 'src/a.ts', label: 'a.ts', kind: 'file', group: 'src/', lang: 'TypeScript', files: ['src/a.ts'] },
    { id: 'src/b "quoted" [x].ts', label: 'b "quoted" [x].ts', kind: 'file', group: 'src/' },
    { id: 'pkg/', label: 'pkg/', kind: 'folder', group: 'pkg/', files: ['pkg/x.go', 'pkg/y.go'] },
    { id: 'dep:npm:left-pad', label: 'left-pad', kind: 'dep', group: 'npm', usedBy: 1, versions: ['^1.3.0'] },
    { id: 'weird\\path|pipe<>&', label: 'weird\\path|pipe<>&\nnewline', kind: 'file', group: 'x' },
  ],
  edges: [
    { from: 'src/a.ts', to: 'src/b "quoted" [x].ts', count: 1 },
    { from: 'src/b "quoted" [x].ts', to: 'src/a.ts', count: 1 },
    { from: 'src/a.ts', to: 'pkg/', count: 3 },
    { from: 'src/a.ts', to: 'dep:npm:left-pad', count: 1, label: '^1.3.0 | "x"', kind: 'runtime' },
    { from: 'pkg/', to: 'weird\\path|pipe<>&', count: 1, typeOnly: true },
    { from: 'src/a.ts', to: 'not-a-node', count: 1 },
  ],
};
const cycles = Graph.findCycles(graph.nodes.map((n) => n.id), graph.edges);
const cycleEdges = Export.cycleEdgeKeys(graph, cycles);

test('cycle edges are the ones inside a strongly connected group', () => {
  assert.equal(cycles.length, 1);
  assert.equal(cycleEdges.size, 2);
  assert.ok(cycleEdges.has(Export.edgeKey(graph.edges[0])));
  assert.ok(!cycleEdges.has(Export.edgeKey(graph.edges[2])));
});

test('Mermaid: a flowchart whose every line is a node or an edge between declared nodes', () => {
  const text = Export.toMermaid(graph, cycleEdges);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines[0], 'flowchart LR');
  const declared = new Set();
  let edges = 0;
  let dashed = 0;
  for (const line of lines.slice(1)) {
    const node = /^ {2}(n\d+)(\["[^"\n]*"\]|\(\["[^"\n]*"\]\))$/.exec(line);
    if (node) {
      declared.add(node[1]);
      continue;
    }
    const edge = /^ {2}(n\d+) (-->|-\.->)(\|"[^"|\n]*"\|)? (n\d+)$/.exec(line);
    assert.ok(edge, 'unexpected line: ' + line);
    assert.ok(declared.has(edge[1]) && declared.has(edge[4]), 'edge uses undeclared node: ' + line);
    edges++;
    if (edge[2] === '-.->') dashed++;
  }
  assert.equal(declared.size, 5);
  assert.equal(edges, 5, 'the edge to an unknown node is dropped');
  assert.equal(dashed, 2);
  assert.ok(text.includes('n1["b #quot;quoted#quot; [x].ts"]'));
  assert.ok(text.includes('|"3"|'));
  assert.ok(text.includes('(["left-pad"])'));
  assert.ok(!/\n\s*\n/.test(text));
});

test('DOT: balanced, quoted, and accepted by Graphviz when it is installed', (t) => {
  const text = Export.toDot(graph, cycleEdges, 'acme/demo');
  assert.ok(text.startsWith('digraph "acme/demo" {\n  rankdir=LR;'));
  assert.ok(text.trimEnd().endsWith('}'));
  // every quote is either escaped or balanced on its line
  for (const line of text.split('\n')) {
    const unescaped = line.replace(/\\\\/g, '').replace(/\\"/g, '');
    assert.equal((unescaped.match(/"/g) || []).length % 2, 0, line);
  }
  assert.ok(text.includes('"src/a.ts" -> "pkg/" [label="3"];'));
  assert.ok(text.includes('color=red, style=dashed'));
  assert.ok(text.includes('"src/b \\"quoted\\" [x].ts"'));
  assert.ok(text.includes('"weird\\\\path|pipe<>&"'));
  assert.ok(!text.includes('not-a-node'));
  const dot = spawnSync('dot', ['-Tplain'], { input: text, encoding: 'utf8' });
  if (dot.error) {
    t.diagnostic('Graphviz is not installed; skipped the real parse');
    return;
  }
  assert.equal(dot.status, 0, dot.stderr);
  assert.equal(dot.stdout.split('\n').filter((l) => l.startsWith('node ')).length, 5);
  assert.equal(dot.stdout.split('\n').filter((l) => l.startsWith('edge ')).length, 5);
});

test('JSON: parses back, carries metadata and cycles, and nothing but plain data', () => {
  const text = Export.toJson(graph, { repository: 'acme/demo', ref: 'main', view: 'code' }, cycles);
  const data = JSON.parse(text);
  assert.equal(data.tool, 'RepoDAG');
  assert.equal(data.repository, 'acme/demo');
  assert.equal(data.nodes.length, 5);
  assert.equal(data.edges.length, 6);
  assert.deepEqual(data.nodes[2], { id: 'pkg/', label: 'pkg/', kind: 'folder', group: 'pkg/', files: ['pkg/x.go', 'pkg/y.go'] });
  assert.deepEqual(data.nodes[0], { id: 'src/a.ts', label: 'a.ts', kind: 'file', group: 'src/', language: 'TypeScript' });
  assert.deepEqual(data.edges[2], { from: 'src/a.ts', to: 'pkg/', count: 3 });
  assert.equal(data.edges[3].version, '^1.3.0 | "x"');
  assert.equal(data.edges[4].typeOnly, true);
  assert.equal(data.cycles.length, 1);
  assert.deepEqual(data.cycles[0].nodes, ['src/a.ts', 'src/b "quoted" [x].ts']);
});

test('an empty graph still exports valid documents', () => {
  const empty = { nodes: [], edges: [] };
  assert.equal(Export.toMermaid(empty), 'flowchart LR\n');
  assert.match(Export.toDot(empty), /^digraph "repodag" \{[\s\S]*\}\n$/);
  assert.deepEqual(JSON.parse(Export.toJson(empty)).nodes, []);
});

test('development-only dependencies are marked in the text exports', () => {
  const g = {
    nodes: [
      { id: 'package.json', label: 'package.json', kind: 'manifest', group: 'npm' },
      { id: 'dep:npm:react', label: 'react', kind: 'dep', group: 'npm', versions: ['^18'] },
      { id: 'dep:npm:vitest', label: 'vitest', kind: 'dep', group: 'npm', versions: ['^2'] },
      { id: 'dep:npm:tool', label: 'tool', kind: 'dep', group: 'npm', versions: [] },
    ],
    edges: [
      { from: 'package.json', to: 'dep:npm:react', count: 1, kind: 'runtime', dev: false, label: '^18' },
      { from: 'package.json', to: 'dep:npm:vitest', count: 1, kind: 'dev', dev: true, label: '^2' },
      { from: 'package.json', to: 'dep:npm:tool', count: 1, kind: 'dev', dev: true, label: '' },
    ],
  };
  const dot = Export.toDot(g, new Set(), 'demo');
  assert.match(dot, /"package\.json" -> "dep:npm:vitest" \[label="\^2 \(dev\)", style=dotted\];/);
  assert.match(dot, /"package\.json" -> "dep:npm:react" \[label="\^18"\];/);
  const mmd = Export.toMermaid(g, new Set());
  assert.ok(mmd.includes('n0 -->|"^2 (dev)"| n2'));
  assert.ok(mmd.includes('n0 -->|"dev"| n3'));
  assert.ok(mmd.includes('n0 -->|"^18"| n1'));
  assert.equal(JSON.parse(Export.toJson(g, {}, [])).edges[1].kind, 'dev');
});

