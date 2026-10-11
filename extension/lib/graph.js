/* RepoDAG graph algorithms: strongly connected components, cycle listing and a layered left-to-right layout.
   Pure functions on plain data, no DOM. Nothing here recurses, so deep graphs cannot overflow the stack. */
(function () {
  'use strict';

  /* Indexes ids and builds adjacency lists. Edges whose ends are unknown, and self-loops, are dropped. */
  function index(ids, edges) {
    const pos = new Map();
    ids.forEach((id, i) => pos.set(id, i));
    const n = ids.length;
    const out = Array.from({ length: n }, () => []);
    const inn = Array.from({ length: n }, () => []);
    const list = [];
    edges.forEach((e, k) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (a === undefined || b === undefined || a === b) return;
      const idx = list.length;
      list.push({ a, b, k });
      out[a].push(idx);
      inn[b].push(idx);
    });
    return { pos, n, out, inn, list };
  }

  /* Tarjan's algorithm with an explicit stack. Returns { components: [[id, ...]], of: Map(id -> component index) }.
     Components come out in reverse topological order (a component appears before the ones that point to it). */
  function scc(ids, edges) {
    const g = index(ids, edges);
    const n = g.n;
    const idx = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const stack = [];
    const comp = new Int32Array(n).fill(-1);
    const components = [];
    let counter = 0;
    const work = []; // [node, next out-edge position]
    for (let root = 0; root < n; root++) {
      if (idx[root] !== -1) continue;
      work.push(root, 0);
      idx[root] = low[root] = counter++;
      stack.push(root);
      onStack[root] = 1;
      while (work.length) {
        const v = work[work.length - 2];
        const i = work[work.length - 1];
        if (i < g.out[v].length) {
          work[work.length - 1] = i + 1;
          const w = g.list[g.out[v][i]].b;
          if (idx[w] === -1) {
            idx[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = 1;
            work.push(w, 0);
          } else if (onStack[w]) {
            if (idx[w] < low[v]) low[v] = idx[w];
          }
        } else {
          work.length -= 2;
          if (work.length) {
            const parent = work[work.length - 2];
            if (low[v] < low[parent]) low[parent] = low[v];
          }
          if (low[v] === idx[v]) {
            const members = [];
            for (;;) {
              const w = stack.pop();
              onStack[w] = 0;
              comp[w] = components.length;
              members.push(ids[w]);
              if (w === v) break;
            }
            components.push(members);
          }
        }
      }
    }
    const of = new Map();
    ids.forEach((id, i) => of.set(id, comp[i]));
    return { components, of };
  }

  /* Every group of nodes that can reach each other (size > 1), largest first.
     Each has { nodes: [ids], edgeCount, example: [ids] } where `example` is one shortest loop, first id repeated at the end. */
  function findCycles(ids, edges) {
    const { components, of } = scc(ids, edges);
    const out = [];
    const adjacency = new Map();
    for (const e of edges) {
      if (e.from === e.to) continue;
      const c = of.get(e.from);
      if (c === undefined || c !== of.get(e.to) || components[c].length < 2) continue;
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      adjacency.get(e.from).push(e.to);
    }
    for (const members of components) {
      if (members.length < 2) continue;
      const nodes = members.slice().sort();
      let edgeCount = 0;
      for (const id of nodes) edgeCount += (adjacency.get(id) || []).length;
      // shortest loop through the first node, by breadth-first search inside the component
      const start = nodes[0];
      const prev = new Map([[start, null]]);
      const queue = [start];
      let last = null;
      for (let qi = 0; qi < queue.length && last === null; qi++) {
        const v = queue[qi];
        for (const w of adjacency.get(v) || []) {
          if (w === start) {
            last = v;
            break;
          }
          if (!prev.has(w)) {
            prev.set(w, v);
            queue.push(w);
          }
        }
      }
      const example = [];
      for (let v = last; v !== null && v !== undefined; v = prev.get(v)) example.push(v);
      example.reverse();
      example.push(start);
      out.push({ nodes, edgeCount, example });
    }
    out.sort((a, b) => b.nodes.length - a.nodes.length || (a.nodes[0] < b.nodes[0] ? -1 : 1));
    return out;
  }

  /* Chooses the edges to turn around so that what is left has no cycle.
     Only edges inside a strongly connected component can be part of a cycle, so each component is handled alone:
     its nodes are put in a line with the greedy heuristic of Eades, Lin and Smyth (peel off sinks to the right and
     sources to the left; when neither exists, take the node with the most outgoing over incoming edges), and the
     edges that point backwards along that line are the ones reversed. A plain depth-first walk also works but
     reverses many more edges than needed on real code. An acyclic graph gets no reversed edge at all. */
  function backEdges(g, ids) {
    const n = g.n;
    const reversed = new Uint8Array(g.list.length);
    const comps = scc(ids, g.list.map((e) => ({ from: ids[e.a], to: ids[e.b] })));
    const compOf = new Int32Array(n);
    for (let v = 0; v < n; v++) compOf[v] = comps.of.get(ids[v]);
    const members = new Map();
    for (let v = 0; v < n; v++) {
      const c = compOf[v];
      if (comps.components[c].length < 2) continue;
      if (!members.has(c)) members.set(c, []);
      members.get(c).push(v);
    }
    const rank = new Int32Array(n).fill(-1);
    const outLeft = new Int32Array(n);
    const inLeft = new Int32Array(n);
    const gone = new Uint8Array(n);
    for (const [c, nodes] of members) {
      nodes.sort((a, b) => (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0));
      for (const v of nodes) {
        outLeft[v] = 0;
        inLeft[v] = 0;
      }
      for (const v of nodes) {
        for (const ei of g.out[v]) {
          if (compOf[g.list[ei].b] !== c) continue;
          outLeft[v]++;
          inLeft[g.list[ei].b]++;
        }
      }
      const left = [];
      const right = [];
      const queue = [];
      let remaining = nodes.length;
      const take = (v, toRight) => {
        gone[v] = 1;
        remaining--;
        (toRight ? right : left).push(v);
        for (const ei of g.out[v]) {
          const w = g.list[ei].b;
          if (compOf[w] === c && !gone[w] && --inLeft[w] === 0) queue.push(w);
        }
        for (const ei of g.inn[v]) {
          const w = g.list[ei].a;
          if (compOf[w] === c && !gone[w] && --outLeft[w] === 0) queue.push(w);
        }
      };
      while (remaining > 0) {
        while (queue.length) {
          const v = queue.pop();
          if (gone[v]) continue;
          if (outLeft[v] === 0) take(v, true);
          else if (inLeft[v] === 0) take(v, false);
        }
        if (remaining === 0) break;
        let best = -1;
        let bestDelta = -Infinity;
        for (const v of nodes) {
          if (gone[v]) continue;
          const delta = outLeft[v] - inLeft[v];
          if (delta > bestDelta) {
            bestDelta = delta;
            best = v;
          }
        }
        take(best, false);
      }
      let r = 0;
      for (const v of left) rank[v] = r++;
      for (let i = right.length - 1; i >= 0; i--) rank[right[i]] = r++;
      for (const v of nodes) {
        for (const ei of g.out[v]) {
          const w = g.list[ei].b;
          if (compOf[w] === c && rank[v] > rank[w]) reversed[ei] = 1;
        }
      }
    }
    return reversed;
  }

  /* Number of edge crossings between two neighbouring layers, given each edge as [position above, position below]. */
  function countCrossings(pairs, lowerSize) {
    if (pairs.length < 2) return 0;
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const tree = new Int32Array(lowerSize + 1);
    let crossings = 0;
    let seen = 0;
    for (const [, lo] of pairs) {
      // count earlier edges that end strictly below this one
      let sum = 0;
      for (let i = lo + 1; i > 0; i -= i & -i) sum += tree[i];
      crossings += seen - sum;
      for (let i = lo + 1; i <= lowerSize; i += i & -i) tree[i]++;
      seen++;
    }
    return crossings;
  }

  /* Least-squares positions for one column: stay close to `want` (weighted) while keeping every node at least
     `sep[i]` below the one before it. Pool-adjacent-violators, linear time. */
  function placeColumn(want, weight, sep) {
    const n = want.length;
    const offset = new Float64Array(n);
    for (let i = 1; i < n; i++) offset[i] = offset[i - 1] + sep[i - 1];
    const blockSum = [];
    const blockWeight = [];
    const blockCount = [];
    for (let i = 0; i < n; i++) {
      let s = (want[i] - offset[i]) * weight[i];
      let w = weight[i];
      let c = 1;
      while (blockSum.length && blockSum[blockSum.length - 1] / blockWeight[blockWeight.length - 1] > s / w) {
        s += blockSum.pop();
        w += blockWeight.pop();
        c += blockCount.pop();
      }
      blockSum.push(s);
      blockWeight.push(w);
      blockCount.push(c);
    }
    const y = new Float64Array(n);
    let i = 0;
    for (let b = 0; b < blockSum.length; b++) {
      const mean = blockSum[b] / blockWeight[b];
      for (let k = 0; k < blockCount[b]; k++, i++) y[i] = mean + offset[i];
    }
    return y;
  }

  const DEFAULTS = {
    nodeHeight: 26,
    nodeGap: 10, // vertical space between two nodes in a column
    laneGap: 6, // vertical space around an edge that passes through a column
    layerGap: 72, // horizontal space between columns
    minWidth: 48,
    sweeps: 12,
    maxDummies: 30000, // most columns that long edges may cross in total; beyond it the longest are drawn direct
    bundle: true, // long edges that share an end share their pass-through points
  };

  /* nodes: [{ id, width?, height? }], edges: [{ from, to }]. Returns
     { nodes: Map(id -> { x, y, width, height, layer, order, isolated }),
       edges: [{ from, to, reversed, points: [[x, y], ...] } | null]   (same order as the input; null for dropped edges)
       layers: [{ x, width, count }], width, height, crossings, reversedCount, dummyCount, directEdges, isolatedTop,
       isolatedCount }
     Columns run left to right: an edge always leaves a node on its right side and ends in a column further right,
     except edges marked `reversed`, which were turned around to break a cycle and so point right-to-left when drawn. */
  function layout(nodes, edges, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const ids = nodes.map((n) => n.id);
    const g = index(ids, edges);
    const n = g.n;
    const width = nodes.map((nd) => Math.max(o.minWidth, nd.width || 0));
    const height = nodes.map((nd) => nd.height || o.nodeHeight);

    const reversed = backEdges(g, ids);
    // the acyclic graph actually laid out
    const dagOut = Array.from({ length: n }, () => []);
    const dagIn = Array.from({ length: n }, () => []);
    const ends = g.list.map((e, i) => (reversed[i] ? [e.b, e.a] : [e.a, e.b]));
    ends.forEach(([a, b], i) => {
      dagOut[a].push(i);
      dagIn[b].push(i);
    });

    const connected = new Uint8Array(n);
    for (const [a, b] of ends) {
      connected[a] = 1;
      connected[b] = 1;
    }

    /* layers by longest path */
    const layer = new Int32Array(n);
    const indeg = new Int32Array(n);
    for (let v = 0; v < n; v++) indeg[v] = dagIn[v].length;
    const topo = [];
    for (let v = 0; v < n; v++) if (connected[v] && indeg[v] === 0) topo.push(v);
    for (let qi = 0; qi < topo.length; qi++) {
      const v = topo[qi];
      for (const ei of dagOut[v]) {
        const w = ends[ei][1];
        if (layer[v] + 1 > layer[w]) layer[w] = layer[v] + 1;
        if (--indeg[w] === 0) topo.push(w);
      }
    }
    // a node nothing depends on sits right before its nearest dependency instead of far out on the left
    for (let qi = topo.length - 1; qi >= 0; qi--) {
      const v = topo[qi];
      if (dagIn[v].length !== 0 || dagOut[v].length === 0) continue;
      let nearest = Infinity;
      for (const ei of dagOut[v]) nearest = Math.min(nearest, layer[ends[ei][1]]);
      if (nearest - 1 > layer[v]) layer[v] = nearest - 1;
    }
    let layerCount = 0;
    for (let v = 0; v < n; v++) if (connected[v] && layer[v] + 1 > layerCount) layerCount = layer[v] + 1;

    /* Long edges get a pass-through point (a dummy vertex) in every column they cross. Long edges that share an end
       share those points, so twenty files importing one distant utility run as a single trunk that the sources join,
       not as twenty parallel lanes. Each edge is bundled at whichever of its two ends has more long edges: at a
       target that many things reach (a trunk that gathers), or at a source that reaches many things (a trunk that
       fans out). Without this a real import graph is mostly empty lanes and the nodes end up far apart. */
    const vLayer = []; // layer of every vertex, real and dummy
    const vReal = []; // index of the real node, or -1
    for (let v = 0; v < n; v++) {
      vLayer.push(layer[v]);
      vReal.push(v);
    }
    const up = []; // neighbours one column to the left
    const down = []; // neighbours one column to the right
    for (let v = 0; v < n; v++) {
      up.push([]);
      down.push([]);
    }
    const linked = new Set();
    const link = (u, v) => {
      const key = u + ',' + v;
      if (linked.has(key)) return;
      linked.add(key);
      down[u].push(v);
      up[v].push(u);
    };
    const longIn = new Int32Array(n);
    const longOut = new Int32Array(n);
    for (const [a, b] of ends) {
      if (layer[b] - layer[a] > 1) {
        longOut[a]++;
        longIn[b]++;
      }
    }
    const trunk = new Map(); // "t<target>,<layer>" or "s<source>,<layer>" -> dummy vertex
    // Short edges are served first: if a tangled graph would need more pass-through points than `maxDummies`,
    // the longest edges are drawn as one direct curve instead of being threaded through every column.
    const bySpan = ends.map((_, i) => i).sort((p, q) => layer[ends[p][1]] - layer[ends[p][0]] - (layer[ends[q][1]] - layer[ends[q][0]]) || p - q);
    const chains = new Array(ends.length);
    let direct = 0;
    let passes = 0; // columns crossed by all threaded edges together: bounds the size of the drawn paths
    for (const i of bySpan) {
      const [a, b] = ends[i];
      const chain = [a];
      let prev = a;
      const span = layer[b] - layer[a] - 1;
      if (span > 0 && passes + span > o.maxDummies) {
        direct++;
        chains[i] = [a, b];
        continue;
      }
      passes += span;
      // a turned-around edge is drawn red and dashed: it keeps to trunks of its own kind, so that a trunk of
      // ordinary edges is never painted over as if all of it closed a cycle
      const kind = reversed[i] ? 'r' : '';
      const anchor = o.bundle === false ? 'e' + i : kind + (longIn[b] >= longOut[a] ? 't' + b : 's' + a);
      for (let l = layer[a] + 1; l < layer[b]; l++) {
        const key = anchor + ',' + l;
        let d = trunk.get(key);
        if (d === undefined) {
          d = vLayer.length;
          trunk.set(key, d);
          vLayer.push(l);
          vReal.push(-1);
          up.push([]);
          down.push([]);
        }
        link(prev, d);
        chain.push(d);
        prev = d;
      }
      link(prev, b);
      chain.push(b);
      chains[i] = chain;
    }
    const total = vLayer.length;

    const columns = Array.from({ length: layerCount }, () => []);
    for (let v = 0; v < total; v++) if (vReal[v] === -1 || connected[v]) columns[vLayer[v]].push(v);
    const order = new Int32Array(total);
    const setOrder = () => {
      for (const col of columns) col.forEach((v, i) => (order[v] = i));
    };
    // deterministic start: real nodes by id, dummies after the node they hang off
    for (const col of columns) {
      col.sort((a, b) => {
        const ra = vReal[a];
        const rb = vReal[b];
        if (ra >= 0 && rb >= 0) return ids[ra] < ids[rb] ? -1 : ids[ra] > ids[rb] ? 1 : 0;
        return ra >= 0 ? -1 : rb >= 0 ? 1 : a - b;
      });
    }
    setOrder();

    const crossingsTotal = () => {
      let sum = 0;
      for (let l = 0; l + 1 < layerCount; l++) {
        const pairs = [];
        for (const v of columns[l]) for (const w of down[v]) pairs.push([order[v], order[w]]);
        sum += countCrossings(pairs, columns[l + 1].length);
      }
      return sum;
    };

    const key = new Float64Array(total);
    const sweep = (l, neighbours) => {
      const col = columns[l];
      col.forEach((v, i) => {
        const nb = neighbours[v];
        if (nb.length === 0) {
          key[v] = -1;
          return;
        }
        let s = 0;
        for (const w of nb) s += order[w];
        key[v] = s / nb.length;
      });
      // nodes without neighbours on that side keep their slot; the others are sorted into the remaining slots
      const movable = col.filter((v) => key[v] >= 0);
      movable.sort((a, b) => key[a] - key[b] || order[a] - order[b]);
      let mi = 0;
      for (let i = 0; i < col.length; i++) if (key[col[i]] >= 0) col[i] = movable[mi++];
      col.forEach((v, i) => (order[v] = i));
    };

    let best = crossingsTotal();
    let bestColumns = columns.map((c) => c.slice());
    if (best > 0) {
      let stale = 0;
      for (let round = 0; round < o.sweeps && stale < 4; round++) {
        if (round % 2 === 0) for (let l = 1; l < layerCount; l++) sweep(l, up);
        else for (let l = layerCount - 2; l >= 0; l--) sweep(l, down);
        const c = crossingsTotal();
        if (c < best) {
          best = c;
          bestColumns = columns.map((col) => col.slice());
          stale = 0;
          if (c === 0) break;
        } else {
          stale++;
        }
      }
      bestColumns.forEach((col, l) => (columns[l] = col));
      setOrder();
    }

    /* coordinates */
    const layerWidth = columns.map((col) => {
      let w = 0;
      for (const v of col) if (vReal[v] >= 0) w = Math.max(w, width[v]);
      return w || o.minWidth;
    });
    const layerX = [];
    let x = 0;
    for (let l = 0; l < layerCount; l++) {
      layerX.push(x);
      x += layerWidth[l] + o.layerGap;
    }
    const mainWidth = layerCount ? x - o.layerGap : 0;
    const h = (v) => (vReal[v] >= 0 ? height[v] : 2);
    const cy = new Float64Array(total); // centre y
    for (const col of columns) {
      let y = 0;
      col.forEach((v, i) => {
        if (i > 0) y += h(col[i - 1]) / 2 + h(v) / 2 + (vReal[v] >= 0 && vReal[col[i - 1]] >= 0 ? o.nodeGap : o.laneGap);
        cy[v] = y;
      });
    }
    const relax = (l, pick) => {
      const col = columns[l];
      const m = col.length;
      if (m === 0) return;
      const want = new Float64Array(m);
      const weight = new Float64Array(m);
      const sep = new Float64Array(Math.max(0, m - 1));
      for (let i = 0; i < m; i++) {
        const v = col[i];
        const nb = pick(v);
        if (nb.length === 0) {
          want[i] = cy[v];
          weight[i] = 0.05;
        } else {
          let s = 0;
          for (const w of nb) s += cy[w];
          want[i] = s / nb.length;
          // an edge passing through pulls harder, so long edges come out straight
          weight[i] = vReal[v] === -1 ? 4 : 1;
        }
        if (i + 1 < m) {
          const next = col[i + 1];
          sep[i] = h(v) / 2 + h(next) / 2 + (vReal[v] >= 0 && vReal[next] >= 0 ? o.nodeGap : o.laneGap);
        }
      }
      const y = placeColumn(want, weight, sep);
      for (let i = 0; i < m; i++) cy[col[i]] = y[i];
    };
    const both = (v) => up[v].concat(down[v]);
    for (let round = 0; round < 4; round++) {
      for (let l = 1; l < layerCount; l++) relax(l, (v) => up[v]);
      for (let l = layerCount - 2; l >= 0; l--) relax(l, (v) => down[v]);
    }
    for (let round = 0; round < 2; round++) {
      for (let l = 0; l < layerCount; l++) relax(l, both);
    }
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < total; v++) {
      if (vReal[v] >= 0 && !connected[v]) continue;
      minY = Math.min(minY, cy[v] - h(v) / 2);
      maxY = Math.max(maxY, cy[v] + h(v) / 2);
    }
    if (minY === Infinity) {
      minY = 0;
      maxY = 0;
    }

    const placed = new Map();
    for (let v = 0; v < n; v++) {
      if (!connected[v]) continue;
      placed.set(ids[v], {
        x: layerX[layer[v]],
        y: cy[v] - height[v] / 2 - minY,
        width: width[v],
        height: height[v],
        layer: layer[v],
        order: order[v],
        isolated: false,
      });
    }
    let totalHeight = maxY - minY;

    /* nodes without any edge: a tidy block underneath, so they are present but out of the way */
    const loose = [];
    for (let v = 0; v < n; v++) if (!connected[v]) loose.push(v);
    let isolatedTop = null;
    let totalWidth = mainWidth;
    if (loose.length) {
      loose.sort((a, b) => (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0));
      const wrap = Math.max(mainWidth, 900);
      isolatedTop = layerCount ? totalHeight + 56 : 0;
      let lx = 0;
      let ly = isolatedTop;
      let rowHeight = 0;
      let slot = 0;
      for (const v of loose) {
        if (lx > 0 && lx + width[v] > wrap) {
          lx = 0;
          ly += rowHeight + o.nodeGap;
          rowHeight = 0;
        }
        placed.set(ids[v], { x: lx, y: ly, width: width[v], height: height[v], layer: -1, order: slot++, isolated: true });
        lx += width[v] + 14;
        totalWidth = Math.max(totalWidth, lx - 14);
        rowHeight = Math.max(rowHeight, height[v]);
      }
      totalHeight = ly + rowHeight;
    }

    /* edge routes: through the right side of the source, across each column it passes, into the left side of the target */
    const routed = new Array(edges.length).fill(null);
    g.list.forEach((e, i) => {
      const chain = chains[i];
      const a = chain[0];
      const b = chain[chain.length - 1];
      const pts = [[layerX[layer[a]] + width[a], cy[a] - minY]];
      for (let k = 1; k < chain.length - 1; k++) {
        const d = chain[k];
        pts.push([layerX[vLayer[d]], cy[d] - minY], [layerX[vLayer[d]] + layerWidth[vLayer[d]], cy[d] - minY]);
      }
      pts.push([layerX[layer[b]], cy[b] - minY]);
      routed[e.k] = { from: edges[e.k].from, to: edges[e.k].to, reversed: !!reversed[i], points: pts };
    });
    let reversedCount = 0;
    for (let i = 0; i < reversed.length; i++) reversedCount += reversed[i];

    return {
      nodes: placed,
      edges: routed,
      layers: layerX.map((lx, l) => ({ x: lx, width: layerWidth[l], count: columns[l].filter((v) => vReal[v] >= 0).length })),
      width: totalWidth,
      height: totalHeight,
      crossings: best,
      reversedCount,
      dummyCount: total - n,
      directEdges: direct,
      isolatedTop,
      isolatedCount: loose.length,
    };
  }

  /* SVG path data for a routed edge: straight across columns it passes, smooth S-curves between columns. */
  function edgePath(points) {
    const r = (v) => Math.round(v * 10) / 10;
    let d = 'M' + r(points[0][0]) + ',' + r(points[0][1]);
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1];
      const [x2, y2] = points[i];
      if (y1 === y2) {
        d += 'L' + r(x2) + ',' + r(y2);
      } else {
        const bend = (x2 - x1) / 2;
        d += 'C' + r(x1 + bend) + ',' + r(y1) + ' ' + r(x2 - bend) + ',' + r(y2) + ' ' + r(x2) + ',' + r(y2);
      }
    }
    return d;
  }

  const api = { scc, findCycles, layout, edgePath, countCrossings, placeColumn };
  globalThis.RepoDagGraph = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
