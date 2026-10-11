/* RepoDAG text exports: Mermaid, Graphviz DOT and JSON for a { nodes, edges } graph.
   `cycleEdges` is a Set of "from\u0000to" keys for edges that are part of a cycle; they are drawn dashed. */
(function () {
  'use strict';

  const edgeKey = (e) => e.from + '\u0000' + e.to;

  function edgeText(e) {
    const dev = e.dev ? 'dev' : '';
    if (e.label) return String(e.label) + (dev ? ' (dev)' : '');
    if (e.count > 1) return String(e.count);
    return dev;
  }

  /* Mermaid flowchart. Ids are n0, n1, ... so any path is safe; labels are quoted with Mermaid's entity escapes. */
  function toMermaid(graph, cycleEdges) {
    const esc = (s) =>
      String(s)
        .replace(/&/g, '#amp;')
        .replace(/"/g, '#quot;')
        .replace(/</g, '#lt;')
        .replace(/>/g, '#gt;')
        .replace(/[\r\n]+/g, ' ');
    const idOf = new Map();
    graph.nodes.forEach((n, i) => idOf.set(n.id, 'n' + i));
    const lines = ['flowchart LR'];
    for (const n of graph.nodes) {
      const text = esc(n.label || n.id);
      lines.push('  ' + idOf.get(n.id) + (n.kind === 'dep' ? '(["' + text + '"])' : '["' + text + '"]'));
    }
    for (const e of graph.edges) {
      const a = idOf.get(e.from);
      const b = idOf.get(e.to);
      if (!a || !b) continue;
      const dashed = cycleEdges && cycleEdges.has(edgeKey(e));
      const text = esc(edgeText(e)).replace(/\|/g, '#124;');
      const arrow = dashed ? '-.->' : '-->';
      lines.push('  ' + a + ' ' + arrow + (text ? '|"' + text + '"| ' : ' ') + b);
    }
    return lines.join('\n') + '\n';
  }

  /* Graphviz DOT, left to right. */
  function toDot(graph, cycleEdges, name) {
    const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
    const lines = ['digraph ' + q(name || 'repodag') + ' {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica", fontsize=10];', '  edge [fontname="Helvetica", fontsize=9];'];
    for (const n of graph.nodes) {
      const attrs = ['label=' + q(n.label || n.id)];
      if (n.title && n.title !== n.label) attrs.push('tooltip=' + q(n.title));
      if (n.kind === 'dep') attrs.push('shape=ellipse');
      if (n.kind === 'folder') attrs.push('shape=folder');
      lines.push('  ' + q(n.id) + ' [' + attrs.join(', ') + '];');
    }
    const known = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      if (!known.has(e.from) || !known.has(e.to)) continue;
      const attrs = [];
      const text = edgeText(e);
      if (text) attrs.push('label=' + q(text));
      if (cycleEdges && cycleEdges.has(edgeKey(e))) attrs.push('color=red', 'style=dashed');
      else if (e.dev) attrs.push('style=dotted');
      lines.push('  ' + q(e.from) + ' -> ' + q(e.to) + (attrs.length ? ' [' + attrs.join(', ') + ']' : '') + ';');
    }
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  /* JSON with only plain data: ids, labels, groups, counts, and the cycles found. */
  function toJson(graph, meta, cycles) {
    const out = {
      tool: 'RepoDAG',
      ...(meta || {}),
      nodes: graph.nodes.map((n) => {
        const o = { id: n.id, label: n.label, kind: n.kind, group: n.group };
        if (n.lang) o.language = n.lang;
        if (Array.isArray(n.files) && (n.files.length > 1 || n.files[0] !== n.id)) o.files = n.files;
        if (n.testPackage) {
          o.testPackage = true; // a Go external test package (package x_test), kept apart from the folder it is in
          o.folder = n.dir;
        }
        if (n.versions && n.versions.length) o.versions = n.versions;
        if (typeof n.usedBy === 'number') o.usedBy = n.usedBy;
        return o;
      }),
      edges: graph.edges.map((e) => {
        const o = { from: e.from, to: e.to };
        if (e.count > 1) o.count = e.count;
        if (e.kind) o.kind = e.kind;
        if (e.label) o.version = e.label;
        if (e.typeOnly) o.typeOnly = true;
        return o;
      }),
      cycles: (cycles || []).map((c) => ({ nodes: c.nodes, example: c.example })),
    };
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* Keys of every edge that lies inside a cycle (both ends in the same strongly connected group). */
  function cycleEdgeKeys(graph, cycles) {
    const groupOf = new Map();
    (cycles || []).forEach((c, i) => c.nodes.forEach((id) => groupOf.set(id, i)));
    const keys = new Set();
    for (const e of graph.edges) {
      const g = groupOf.get(e.from);
      if (g !== undefined && g === groupOf.get(e.to)) keys.add(edgeKey(e));
    }
    return keys;
  }

  const api = { toMermaid, toDot, toJson, cycleEdgeKeys, edgeKey };
  globalThis.RepoDagExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
