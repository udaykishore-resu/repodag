// Graph algorithms: strongly connected components, cycle listing, and the layered layout's invariants.
const test = require('node:test');
const assert = require('node:assert/strict');
const Graph = require('../extension/lib/graph.js');

const E = (pairs) => pairs.map(([from, to]) => ({ from, to }));
const sortComps = (comps) => comps.map((c) => c.slice().sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));

/* Deterministic pseudo-random numbers so failures can be reproduced. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomGraph(n, m, seed, acyclic) {
  const rand = rng(seed);
  const ids = Array.from({ length: n }, (_, i) => 'n' + String(i).padStart(4, '0'));
  const seen = new Set();
  const edges = [];
  while (edges.length < m) {
    let a = Math.floor(rand() * n);
    let b = Math.floor(rand() * n);
    if (a === b) continue;
    if (acyclic && a > b) [a, b] = [b, a];
    const key = a + '>' + b;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: ids[a], to: ids[b] });
  }
  return { ids, edges };
}

/* Checks every promise the layout makes. Returns the layout for further assertions. */
function checkLayout(ids, edges, widths) {
  const nodes = ids.map((id, i) => ({ id, width: widths ? widths[i] : 60 + (id.length % 5) * 20 }));
  const L = Graph.layout(nodes, edges);
  assert.equal(L.nodes.size, ids.length, 'every node is placed');
  assert.equal(L.edges.length, edges.length);
  const withEdges = new Set();
  edges.forEach((e, i) => {
    const r = L.edges[i];
    if (e.from === e.to) {
      assert.equal(r, null, 'self-loops are not routed');
      return;
    }
    withEdges.add(e.from);
    withEdges.add(e.to);
    const a = L.nodes.get(e.from);
    const b = L.nodes.get(e.to);
    if (r.reversed) assert.ok(b.layer < a.layer, 'a reversed edge runs right to left: ' + e.from + ' -> ' + e.to);
    else assert.ok(a.layer < b.layer, 'an edge runs from a lower layer to a higher one: ' + e.from + ' -> ' + e.to);
    const left = r.reversed ? b : a;
    const right = r.reversed ? a : b;
    const first = r.points[0];
    const last = r.points[r.points.length - 1];
    assert.ok(Math.abs(first[0] - (left.x + left.width)) < 1e-6 && first[1] >= left.y - 1e-6 && first[1] <= left.y + left.height + 1e-6, 'route starts on the right side of its left node');
    assert.ok(Math.abs(last[0] - right.x) < 1e-6 && last[1] >= right.y - 1e-6 && last[1] <= right.y + right.height + 1e-6, 'route ends on the left side of its right node');
    for (let k = 1; k < r.points.length; k++) assert.ok(r.points[k][0] >= r.points[k - 1][0], 'routes never turn back');
    if (!L.directEdges) assert.equal(r.points.length, 2 + 2 * (right.layer - left.layer - 1), 'one pass-through per skipped column');
  });
  // no two boxes overlap, anywhere
  const boxes = [...L.nodes.entries()].map(([id, p]) => ({ id, ...p }));
  boxes.sort((p, q) => p.x - q.x);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j].x < boxes[i].x + boxes[i].width; j++) {
      const p = boxes[i];
      const q = boxes[j];
      const apart = p.y + p.height <= q.y + 1e-6 || q.y + q.height <= p.y + 1e-6;
      assert.ok(apart, 'nodes overlap: ' + p.id + ' and ' + q.id);
    }
  }
  // inside a column, nodes keep a visible gap and never share a slot
  const byLayer = new Map();
  for (const b of boxes) {
    if (b.isolated) continue;
    if (!byLayer.has(b.layer)) byLayer.set(b.layer, []);
    byLayer.get(b.layer).push(b);
  }
  for (const col of byLayer.values()) {
    col.sort((p, q) => p.y - q.y);
    for (let i = 1; i < col.length; i++) assert.ok(col[i].y - (col[i - 1].y + col[i - 1].height) >= 5.999, 'gap inside a column');
    assert.equal(new Set(col.map((b) => b.x)).size, 1, 'a column shares one left edge');
  }
  for (const b of boxes) {
    assert.equal(b.isolated, !withEdges.has(b.id));
    assert.ok(b.x >= -1e-6 && b.y >= -1e-6 && b.x + b.width <= L.width + 1e-6 && b.y + b.height <= L.height + 1e-6, 'inside the reported bounds: ' + b.id);
  }
  // a pass-through point never lands inside a node of that column
  edges.forEach((e, i) => {
    const r = L.edges[i];
    if (!r) return;
    for (let k = 1; k < r.points.length - 1; k++) {
      const [x, y] = r.points[k];
      for (const b of boxes) {
        if (b.isolated) continue;
        const inside = x > b.x + 1e-6 && x < b.x + b.width - 1e-6 && y > b.y + 1e-6 && y < b.y + b.height - 1e-6;
        assert.ok(!inside, 'edge ' + e.from + ' -> ' + e.to + ' passes through ' + b.id);
      }
    }
  });
  return L;
}

test('SCC: components of a small graph', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const edges = E([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'e'], ['e', 'd'], ['f', 'g'], ['g', 'g'], ['a', 'zzz-unknown']]);
  const r = Graph.scc(ids, edges);
  assert.deepEqual(sortComps(r.components), [['a', 'b', 'c'], ['d', 'e'], ['f'], ['g']]);
  assert.equal(r.of.get('a'), r.of.get('c'));
  assert.notEqual(r.of.get('a'), r.of.get('d'));
  // reverse topological order: a component is listed before the components that point at it
  assert.ok(r.of.get('d') < r.of.get('a'));
  assert.ok(r.of.get('g') < r.of.get('f'));
});

test('SCC: agrees with a brute-force reachability check on random graphs', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { ids, edges } = randomGraph(14, 20 + (seed % 12), seed, false);
    const reach = new Map(ids.map((id) => [id, new Set([id])]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of edges) {
        for (const set of reach.values()) {
          if (set.has(e.from) && !set.has(e.to)) {
            set.add(e.to);
            changed = true;
          }
        }
      }
    }
    const r = Graph.scc(ids, edges);
    for (const a of ids) {
      for (const b of ids) {
        const mutual = reach.get(a).has(b) && reach.get(b).has(a);
        assert.equal(r.of.get(a) === r.of.get(b), mutual, 'seed ' + seed + ': ' + a + ' ' + b);
      }
    }
  }
});

test('SCC: a 100,000-node chain does not overflow the stack', () => {
  const n = 100000;
  const ids = Array.from({ length: n }, (_, i) => 'v' + i);
  const edges = [];
  for (let i = 0; i + 1 < n; i++) edges.push({ from: ids[i], to: ids[i + 1] });
  assert.equal(Graph.scc(ids, edges).components.length, n);
  edges.push({ from: ids[n - 1], to: ids[0] });
  const closed = Graph.scc(ids, edges);
  assert.equal(closed.components.length, 1);
  assert.equal(closed.components[0].length, n);
});

test('cycles: listed largest first with a real example loop', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'x', 'y', 'solo'];
  const edges = E([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['b', 'a'], ['d', 'e'], ['x', 'y'], ['y', 'x'], ['solo', 'solo']]);
  const cycles = Graph.findCycles(ids, edges);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].nodes, ['a', 'b', 'c', 'd']);
  assert.equal(cycles[0].edgeCount, 5);
  assert.deepEqual(cycles[0].example, ['a', 'b', 'a'], 'the shortest loop through the first node');
  assert.deepEqual(cycles[1].nodes, ['x', 'y']);
  assert.deepEqual(cycles[1].example, ['x', 'y', 'x']);
  for (const c of cycles) {
    for (let i = 0; i + 1 < c.example.length; i++) {
      assert.ok(edges.some((e) => e.from === c.example[i] && e.to === c.example[i + 1]), 'example follows real edges');
    }
  }
  assert.deepEqual(Graph.findCycles(['a', 'b'], E([['a', 'b']])), []);
});

test('layout: a simple chain goes left to right in order', () => {
  const L = checkLayout(['c', 'a', 'b', 'd'], E([['a', 'b'], ['b', 'c'], ['c', 'd']]));
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => L.nodes.get(id).layer), [0, 1, 2, 3]);
  assert.equal(L.reversedCount, 0);
  assert.equal(L.crossings, 0);
  assert.equal(L.layers.length, 4);
  const xs = ['a', 'b', 'c', 'd'].map((id) => L.nodes.get(id).x);
  assert.deepEqual(xs.slice().sort((p, q) => p - q), xs);
});

test('layout: long edges pass through every column between their ends', () => {
  const L = checkLayout(['a', 'b', 'c', 'd'], E([['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd']]));
  const long = L.edges[3];
  assert.equal(long.points.length, 6);
  assert.equal(long.points[1][1], long.points[2][1], 'straight across the column it passes');
});

test('layout: long edges that share an end share their pass-through points', () => {
  // a chain x0 -> x1 -> x2 -> hub, and six files in the first column that all import hub directly
  const sources = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const ids = ['x0', 'x1', 'x2', 'hub', ...sources];
  const edges = E([['x0', 'x1'], ['x1', 'x2'], ['x2', 'hub'], ...sources.map((s) => [s, 'x1']), ...sources.map((s) => [s, 'hub'])]);
  const L = checkLayout(ids, edges);
  assert.equal(L.nodes.get('hub').layer, 3);
  // six edges from column 0 to column 3 cross two columns each: one shared trunk, so two points, not twelve
  assert.equal(L.dummyCount, 2);
  const routes = sources.map((s) => L.edges[edges.findIndex((e) => e.from === s && e.to === 'hub')]);
  for (const r of routes) {
    assert.equal(r.points.length, 6);
    assert.deepEqual(r.points.slice(1), routes[0].points.slice(1), 'after leaving their own node the six edges run together');
  }
  const apart = Graph.layout(ids.map((id) => ({ id, width: 60 })), edges, { bundle: false });
  assert.equal(apart.dummyCount, 12);
  assert.ok(L.height <= apart.height, 'bundling never makes the drawing taller: ' + L.height + ' vs ' + apart.height);

  // the mirror image: one file that imports six distant ones fans out from a single trunk
  const targets = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const fanIds = ['main', 'm1', 'm2', ...targets];
  const fanEdges = E([['main', 'm1'], ['m1', 'm2'], ...targets.map((t) => ['m2', t]), ...targets.map((t) => ['main', t])]);
  const fan = checkLayout(fanIds, fanEdges);
  assert.equal(fan.dummyCount, 2);

  // an edge that was turned around to break a cycle does not share a trunk with ordinary edges
  const loopIds = ['a', 'b', 'c', 'd', 'e'];
  const loopEdges = E([['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd'], ['e', 'd'], ['d', 'a'], ['e', 'b']]);
  const loop = checkLayout(loopIds, loopEdges);
  const back = loop.edges.find((r) => r.reversed);
  assert.ok(back && back.from === 'd' && back.to === 'a');
  const forward = loop.edges.find((r) => r.from === 'a' && r.to === 'd');
  assert.equal(back.points.length, forward.points.length, 'both cross the same columns');
  assert.notDeepEqual(back.points.slice(1, -1), forward.points.slice(1, -1), 'on separate lanes');
});

test('layout: cycles are broken by reversing few edges, and only edges inside a cycle', () => {
  const L = checkLayout(['a', 'b', 'c'], E([['a', 'b'], ['b', 'c'], ['c', 'a']]));
  assert.equal(L.reversedCount, 1);
  const two = checkLayout(['a', 'b'], E([['a', 'b'], ['b', 'a']]));
  assert.equal(two.reversedCount, 1);
  assert.equal(two.edges.filter((e) => e.reversed).length, 1);
  // a graph that is already acyclic never gets a reversed edge
  const { ids, edges } = randomGraph(60, 140, 7, true);
  assert.equal(checkLayout(ids, edges).reversedCount, 0);
  // one edge back into a long chain: exactly that one is turned around, not half the chain
  const chain = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  const chainEdges = E(chain.slice(1).map((id, i) => [chain[i], id]).concat([['c7', 'c0'], ['c7', 'tail'], ['head', 'c0']]));
  const looped = checkLayout([...chain, 'head', 'tail'], chainEdges);
  assert.equal(looped.reversedCount, 1);
  // a hub that everything imports and that imports two things back: the two back edges are the cheap ones to turn
  const hub = E([['a', 'hub'], ['b', 'hub'], ['c', 'hub'], ['d', 'hub'], ['e', 'hub'], ['hub', 'a'], ['hub', 'b']]);
  const hubbed = checkLayout(['a', 'b', 'c', 'd', 'e', 'hub'], hub);
  assert.equal(hubbed.reversedCount, 2);
  assert.deepEqual(hubbed.edges.filter((e) => e.reversed).map((e) => e.from + '>' + e.to).sort(), ['hub>a', 'hub>b']);
  // edges that are not inside any cycle are never reversed
  for (let seed = 1; seed <= 20; seed++) {
    const g = randomGraph(30, 45, seed * 13, false);
    const L = Graph.layout(g.ids.map((id) => ({ id, width: 60 })), g.edges);
    const comps = Graph.scc(g.ids, g.edges);
    L.edges.forEach((r, i) => {
      if (r && r.reversed) assert.equal(comps.of.get(g.edges[i].from), comps.of.get(g.edges[i].to), 'seed ' + seed);
    });
  }
});

test('layout: a node nothing depends on sits next to its dependency, not at the far left', () => {
  const L = checkLayout(['root', 'mid', 'leaf', 'late'], E([['root', 'mid'], ['mid', 'leaf'], ['late', 'leaf']]));
  assert.equal(L.nodes.get('late').layer, 1);
  assert.equal(L.nodes.get('root').layer, 0);
});

test('layout: nodes without edges are set apart below the graph', () => {
  const L = checkLayout(['a', 'b', 'lonely1', 'lonely2'], E([['a', 'b']]));
  assert.equal(L.isolatedCount, 2);
  assert.ok(L.nodes.get('lonely1').isolated);
  assert.ok(L.nodes.get('lonely1').y >= L.isolatedTop);
  assert.ok(L.isolatedTop > L.nodes.get('a').y + L.nodes.get('a').height);
  const onlyLoose = checkLayout(['x', 'y', 'z'], []);
  assert.equal(onlyLoose.isolatedCount, 3);
  assert.equal(onlyLoose.layers.length, 0);
});

test('layout: empty graph, self-loops and edges to unknown nodes are tolerated', () => {
  const empty = Graph.layout([], []);
  assert.equal(empty.nodes.size, 0);
  assert.equal(empty.width, 0);
  const L = Graph.layout([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'a' }, { from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }]);
  assert.equal(L.edges[0], null);
  assert.equal(L.edges[1], null);
  assert.ok(L.edges[2]);
});

test('layout: invariants hold on random acyclic and cyclic graphs', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const n = 8 + (seed * 7) % 60;
    const acyclic = seed % 2 === 0;
    const { ids, edges } = randomGraph(n, Math.floor(n * (1 + (seed % 4) * 0.5)), seed * 31, acyclic);
    const L = checkLayout(ids, edges);
    if (acyclic) assert.equal(L.reversedCount, 0, 'seed ' + seed);
  }
});

test('layout: the sweeps remove crossings that the starting order has', () => {
  // two columns whose natural (alphabetical) order is fully crossed
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5'];
  const edges = E([['a1', 'b5'], ['a2', 'b4'], ['a3', 'b3'], ['a4', 'b2'], ['a5', 'b1']]);
  const L = checkLayout(ids, edges);
  assert.equal(L.crossings, 0);
  // a ladder with rungs needs none either
  const ladder = E([['p1', 'q1'], ['p2', 'q2'], ['p3', 'q3'], ['q1', 'r3'], ['q2', 'r2'], ['q3', 'r1'], ['p1', 'r3']]);
  assert.equal(checkLayout(['p1', 'p2', 'p3', 'q1', 'q2', 'q3', 'r1', 'r2', 'r3'], ladder).crossings, 0);
});

test('countCrossings matches a brute-force count', () => {
  const rand = rng(99);
  for (let round = 0; round < 50; round++) {
    const pairs = Array.from({ length: 12 }, () => [Math.floor(rand() * 6), Math.floor(rand() * 6)]);
    let brute = 0;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) brute++;
      }
    }
    assert.equal(Graph.countCrossings(pairs.map((p) => p.slice()), 6), brute);
  }
});

test('placeColumn keeps order and spacing while staying close to the wanted positions', () => {
  const y = Graph.placeColumn([10, 10, 10], [1, 1, 1], [5, 5]);
  assert.deepEqual([...y], [5, 10, 15]);
  const free = Graph.placeColumn([0, 100, 200], [1, 1, 1], [5, 5]);
  assert.deepEqual([...free], [0, 100, 200]);
  const heavy = Graph.placeColumn([0, 0], [1, 1000], [10]);
  assert.ok(Math.abs(heavy[1]) < 0.02 && Math.abs(heavy[0] + 10) < 0.02, 'the heavier node stays where it wants to be');
});

test('layout: 1,500 nodes and 4,000 edges are laid out quickly and correctly', () => {
  const { ids, edges } = randomGraph(1500, 4000, 2026, true);
  const started = Date.now();
  const L = Graph.layout(ids.map((id) => ({ id, width: 80 })), edges);
  const ms = Date.now() - started;
  assert.ok(ms < 5000, 'layout took ' + ms + ' ms');
  assert.equal(L.directEdges, 0);
  checkLayout(ids, edges);
});

test('layout: a hopelessly tangled graph stays bounded instead of producing millions of route points', () => {
  // uniformly random edges make one giant cycle; real code never looks like this, but nothing should hang
  const { ids, edges } = randomGraph(1500, 4000, 2026, false);
  const started = Date.now();
  const L = Graph.layout(ids.map((id) => ({ id, width: 80 })), edges);
  const ms = Date.now() - started;
  assert.ok(ms < 15000, 'layout took ' + ms + ' ms');
  let points = 0;
  for (const e of L.edges) if (e) points += e.points.length;
  assert.ok(points <= 2 * 30000 + 2 * edges.length, points + ' route points');
  assert.ok(L.directEdges > 0);
  assert.equal(L.nodes.size, 1500);
});

test('layout: a deep chain of 5,000 nodes does not recurse', () => {
  const ids = Array.from({ length: 5000 }, (_, i) => 'k' + String(i).padStart(4, '0'));
  const edges = [];
  for (let i = 0; i + 1 < ids.length; i++) edges.push({ from: ids[i], to: ids[i + 1] });
  const L = Graph.layout(ids.map((id) => ({ id, width: 50 })), edges);
  assert.equal(L.layers.length, 5000);
});

test('edgePath: starts with a move, curves between columns, straight across them', () => {
  const d = Graph.edgePath([[0, 0], [100, 50], [160, 50], [260, 10]]);
  assert.match(d, /^M0,0C50,0 50,50 100,50L160,50C210,50 210,10 260,10$/);
  assert.equal(Graph.edgePath([[0, 5], [80, 5]]), 'M0,5L80,5');
});
