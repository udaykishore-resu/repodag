/* RepoDAG views: turn raw scan results into plain { nodes, edges } graphs for each tab.
   Every graph uses the same shape so layout, drawing and export do not care which tab they serve:
     node: { id, label, title, kind, group, ... }      edge: { from, to, count, ... } */
(function () {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const Lex = inNode ? require('./lex.js') : globalThis.RepoDagLex;
  const Imports = inNode ? require('./imports.js') : globalThis.RepoDagImports;
  const { dirname, dirId } = Lex;

  /* "a/b/c/" cut to its first `depth` folders. "./" is the repository root. */
  function cutDir(id, depth) {
    if (id === './') return id;
    const segs = id.slice(0, -1).split('/');
    return segs.length <= depth ? id : segs.slice(0, depth).join('/') + '/';
  }

  /* Shortest trailing part of each id that is still unique among the nodes ("store/redis.go" rather than the full path). */
  function shortLabels(ids) {
    const parts = new Map();
    const take = new Map();
    for (const id of ids) {
      const isDir = id.endsWith('/');
      const segs = (isDir ? id.slice(0, -1) : id).split('/');
      parts.set(id, { segs, isDir });
      take.set(id, 1);
    }
    const labelOf = (id) => {
      const { segs, isDir } = parts.get(id);
      const n = Math.min(take.get(id), segs.length);
      return segs.slice(segs.length - n).join('/') + (isDir ? '/' : '');
    };
    for (let round = 0; round < 12; round++) {
      const seen = new Map();
      for (const id of ids) {
        const l = labelOf(id);
        if (!seen.has(l)) seen.set(l, []);
        seen.get(l).push(id);
      }
      let changed = false;
      for (const list of seen.values()) {
        if (list.length < 2) continue;
        for (const id of list) {
          if (take.get(id) < parts.get(id).segs.length) {
            take.set(id, take.get(id) + 1);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const out = new Map();
    for (const id of ids) out.set(id, labelOf(id));
    return out;
  }

  /* Groups nodes by leading folders. Returns Map(id -> group key).
     Top-level folders are the names people know, so that is the default. When one of them holds most of the nodes
     the colours say little, and the split goes as deep as it takes for no folder to hold more than 60%. But only
     `palette` groups get a colour of their own: if the deeper split would leave most nodes in "other" (a monorepo
     with dozens of small packages), the top level is kept after all. */
  function folderGroups(ids, palette) {
    const colours = palette || 6;
    const dirsOf = (id) => {
      if (id === './') return [];
      const segs = (id.endsWith('/') ? id.slice(0, -1) : id).split('/');
      return id.endsWith('/') ? segs : segs.slice(0, -1);
    };
    const keyAt = (id, depth) => {
      const d = dirsOf(id);
      if (d.length === 0) return '(top level)';
      return d.slice(0, depth).join('/') + '/';
    };
    const n = ids.length || 1;
    let best = 1;
    for (let depth = 1; depth <= 4; depth++) {
      const counts = new Map();
      for (const id of ids) {
        const k = keyAt(id, depth);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const sizes = [...counts.values()].sort((a, b) => b - a);
      if (sizes[0] / n > 0.6) continue; // one folder still dominates: look deeper
      const coloured = sizes.slice(0, colours).reduce((sum, size) => sum + size, 0);
      if (coloured / n >= 0.5) best = depth;
      break;
    }
    const out = new Map();
    for (const id of ids) out.set(id, keyAt(id, best));
    return out;
  }

  function summariseGroups(nodes) {
    const counts = new Map();
    for (const n of nodes) counts.set(n.group, (counts.get(n.group) || 0) + 1);
    return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  }

  /* ---------- code imports ---------- */

  /* Which node a file belongs to at each level, and what an edge target becomes.
     A Go external test package (`package x_test` in the folder of x) is always a unit of its own, never merged
     with the code it tests: it is a different package, it may import x, and nothing can import it. Its id is the
     folder id plus the package name ("memstore/memstore_test"), which no file or folder id can equal. When
     folders are cut to a depth and one folder holds several such packages, they share one unit
     ("internal/(external tests)"). `meta` describes these units: { testPackage, dir, packages, merged }. */
  function unitMapper(code, level, depth) {
    const meta = new Map();
    const testUnit = new Map(); // path -> unit id
    const perFolder = new Map(); // folder id -> Map(package unit id -> { dir, pkg, paths })
    for (const [path, info] of code.sources) {
      if (!info.xtest) continue;
      const dir = dirId(dirname(path));
      const folder = level === 'folders' ? cutDir(dir, depth) : dir;
      if (!perFolder.has(folder)) perFolder.set(folder, new Map());
      const own = dir + info.pkg;
      const units = perFolder.get(folder);
      if (!units.has(own)) units.set(own, { dir, pkg: info.pkg, paths: [] });
      units.get(own).paths.push(path);
    }
    for (const [folder, units] of perFolder) {
      const list = [...units.entries()];
      const single = list.length === 1 && list[0][1].dir === folder;
      const id = single ? list[0][0] : folder + '(external tests)';
      meta.set(id, { testPackage: true, dir: folder, packages: list.map(([, u]) => u.pkg).sort(), merged: !single });
      for (const [, u] of list) for (const path of u.paths) testUnit.set(path, id);
    }
    const ofFile = (path) => {
      if (testUnit.has(path)) return testUnit.get(path);
      const info = code.sources.get(path);
      const dir = dirId(dirname(path));
      if (level === 'packages') return dir;
      if (level === 'folders') return cutDir(dir, depth);
      return info && Imports.PACKAGE_UNIT.has(info.lang) ? dir : path;
    };
    const ofTarget = (to) => {
      if (to.endsWith('/')) return level === 'folders' ? cutDir(to, depth) : to;
      return ofFile(to);
    };
    return { ofFile, ofTarget, meta };
  }

  /* options: { level: 'files' | 'folders' | 'packages', depth, includeTests, groupBy: 'folder' | 'language' } */
  function codeView(code, options) {
    const o = Object.assign({ level: 'files', depth: 2, includeTests: false, groupBy: 'folder' }, options || {});
    const { ofFile, ofTarget, meta } = unitMapper(code, o.level, o.depth);
    const nodes = new Map();
    const node = (id) => {
      let n = nodes.get(id);
      if (!n) {
        const m = meta.get(id);
        n = { id, kind: m || id.endsWith('/') ? 'folder' : 'file', files: [], langs: new Map() };
        if (m) Object.assign(n, { testPackage: true, dir: m.dir, packages: m.packages, merged: m.merged });
        nodes.set(id, n);
      }
      return n;
    };
    for (const [path, info] of code.sources) {
      if (info.test && !o.includeTests) continue;
      const n = node(ofFile(path));
      n.files.push(path);
      n.langs.set(info.lang, (n.langs.get(info.lang) || 0) + 1);
    }
    const edges = new Map();
    for (const e of code.edges) {
      const src = code.sources.get(e.from);
      if (!src || (src.test && !o.includeTests)) continue;
      const from = ofFile(e.from);
      const to = ofTarget(e.to);
      if (from === to) continue; // inside one node after aggregation
      const target = node(to);
      if (!e.to.endsWith('/')) {
        // a file that is only present because something that is shown imports it (a test helper, for example)
        const tinfo = code.sources.get(e.to);
        if (tinfo && tinfo.test && !o.includeTests && !target.files.includes(e.to)) {
          target.files.push(e.to);
          target.langs.set(tinfo.lang, (target.langs.get(tinfo.lang) || 0) + 1);
        }
      }
      const key = from + '\u0000' + to;
      let agg = edges.get(key);
      if (!agg) {
        agg = { from, to, count: 0, typeOnly: true };
        edges.set(key, agg);
      }
      agg.count++;
      if (e.kind !== 'type') agg.typeOnly = false;
    }
    const list = [...nodes.values()];
    // a shared test unit is named after its folder, and every test unit is coloured like its folder
    const placeOf = (n) => (n.testPackage ? n.dir : n.id);
    const labels = shortLabels([...new Set(list.map((n) => (n.merged ? n.dir : n.id)))]);
    const groups = o.groupBy === 'language' ? null : folderGroups([...new Set(list.map(placeOf))]);
    const folderLabel = (id) => (id === './' ? '(top level)' : labels.get(id));
    for (const n of list) {
      n.files.sort();
      let lang = '';
      let most = 0;
      for (const [l, c] of n.langs) {
        if (c > most) {
          most = c;
          lang = l;
        }
      }
      n.lang = lang || 'folder';
      n.languages = [...n.langs.keys()].sort();
      delete n.langs;
      n.fileCount = n.files.length;
      if (n.merged) {
        n.label = n.dir === './' ? 'external tests (top level)' : folderLabel(n.dir) + ' external tests';
        n.title = 'Go external test packages under ' + (n.dir === './' ? 'the top level' : n.dir) + ' (' + n.packages.join(', ') + ')';
      } else if (n.testPackage) {
        n.label = labels.get(n.id);
        n.title = n.packages[0] + ' — Go external test package in ' + (n.dir === './' ? 'the top level folder' : n.dir);
      } else {
        n.label = folderLabel(n.id);
        n.title = n.id === './' ? 'Files at the top level of the repository' : n.id;
      }
      n.group = groups ? groups.get(placeOf(n)) : n.lang;
    }
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const edgeList = [...edges.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    return { nodes: list, edges: edgeList, groups: summariseGroups(list), level: o.level, depth: o.depth };
  }

  /* How many nodes each level would draw, and a sensible default. Large repositories start grouped. */
  function suggestLevel(code, includeTests, limit) {
    const max = limit || 150;
    const count = (level, depth) => {
      const { ofFile } = unitMapper(code, level, depth);
      const seen = new Set();
      for (const [path, info] of code.sources) {
        if (info.test && !includeTests) continue;
        seen.add(ofFile(path));
      }
      return seen.size;
    };
    const files = count('files', 0);
    const packages = count('packages', 0);
    let maxDepth = 1;
    for (const path of code.sources.keys()) maxDepth = Math.max(maxDepth, path.split('/').length - 1);
    maxDepth = Math.min(maxDepth, 8);
    const result = { files, packages, maxDepth, level: 'files', depth: Math.min(2, maxDepth) };
    if (files > max) {
      result.level = 'packages';
      if (packages > max) {
        result.level = 'folders';
        result.depth = 1;
        for (let d = Math.min(4, maxDepth); d >= 1; d--) {
          if (count('folders', d) <= max) {
            result.depth = d;
            break;
          }
        }
      }
    }
    return result;
  }

  /* ---------- CI pipeline ---------- */

  function ciView(ci) {
    const wfName = new Map(ci.workflows.map((w) => [w.path, w.name]));
    // two workflow files can share a display name; keep their groups apart
    const nameCount = new Map();
    for (const w of ci.workflows) nameCount.set(w.name, (nameCount.get(w.name) || 0) + 1);
    const groupOf = (path) => (nameCount.get(wfName.get(path)) > 1 ? wfName.get(path) + ' (' + path.split('/').pop() + ')' : wfName.get(path));
    const nodes = ci.jobs.map((job) => ({
      id: job.id,
      kind: 'job',
      label: job.name,
      title: job.name + ' — job "' + job.key + '" in ' + job.workflow,
      group: groupOf(job.workflow),
      job,
    }));
    const seen = new Set();
    const edges = [];
    for (const e of ci.edges) {
      const key = e.from + '\u0000' + e.to;
      if (seen.has(key) || e.from === e.to) continue;
      seen.add(key);
      edges.push({ from: e.from, to: e.to, count: 1, kind: e.kind });
    }
    return { nodes, edges, groups: summariseGroups(nodes) };
  }

  /* ---------- third-party packages ---------- */

  /* options: { includeDev, includeIndirect } */
  function packagesView(pk, options) {
    const o = Object.assign({ includeDev: true, includeIndirect: false }, options || {});
    const nodes = new Map();
    const manifestLabels = shortLabels(pk.manifests.map((m) => m.path));
    for (const m of pk.manifests) {
      nodes.set(m.path, {
        id: m.path,
        kind: 'manifest',
        label: manifestLabels.get(m.path),
        title: m.path + (m.name ? ' (' + m.name + ')' : ''),
        group: m.ecosystem,
        name: m.name,
        path: m.path,
      });
    }
    const edges = [];
    let hiddenDev = 0;
    let hiddenIndirect = 0;
    for (const d of pk.deps) {
      const devLike = d.kind === 'dev' || d.kind === 'build';
      if (d.kind === 'indirect' && !o.includeIndirect) {
        hiddenIndirect++;
        continue;
      }
      if (devLike && !o.includeDev) {
        hiddenDev++;
        continue;
      }
      let to;
      if (d.local) {
        to = d.local;
      } else {
        to = 'dep:' + d.ecosystem + ':' + d.name;
        let n = nodes.get(to);
        if (!n) {
          n = { id: to, kind: 'dep', label: d.name, title: d.name + ' (' + d.ecosystem + ')', group: d.ecosystem, name: d.name, usedBy: 0, versions: [] };
          nodes.set(to, n);
        }
        n.usedBy++;
        for (const v of d.versions) if (!n.versions.includes(v)) n.versions.push(v);
      }
      if (to === d.from) continue;
      edges.push({ from: d.from, to, count: 1, kind: d.kind, dev: devLike, local: !!d.local, label: d.versions.join(' | '), note: d.note || null });
    }
    // Maven coordinates are long: show the artifact when that is unambiguous
    const artifactCount = new Map();
    for (const n of nodes.values()) {
      if (n.kind === 'dep' && n.group === 'Maven' && n.name.includes(':')) {
        const a = n.name.slice(n.name.lastIndexOf(':') + 1);
        artifactCount.set(a, (artifactCount.get(a) || 0) + 1);
      }
    }
    for (const n of nodes.values()) {
      if (n.kind === 'dep' && n.group === 'Maven' && n.name.includes(':')) {
        const a = n.name.slice(n.name.lastIndexOf(':') + 1);
        if (artifactCount.get(a) === 1) n.label = a;
      }
    }
    const list = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { nodes: list, edges, groups: summariseGroups(list), hiddenDev, hiddenIndirect };
  }

  const api = { codeView, suggestLevel, ciView, packagesView, shortLabels, folderGroups, cutDir };
  globalThis.RepoDagViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
