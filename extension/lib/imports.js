/* RepoDAG import analysis. Takes the text of every source file and returns file-level edges that were resolved
   to something inside the repository. Anything that cannot be pinned to a real file or package is counted, not guessed. */
(function () {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const Lex = inNode ? require('./lex.js') : globalThis.RepoDagLex;
  const Toml = inNode ? require('./toml.js') : globalThis.RepoDagToml;
  const yamlLib = () => (inNode ? require('./js-yaml.min.js') : globalThis.jsyaml);
  const { dirname, basename, extname, join, dirId } = Lex;

  const LANG_BY_EXT = {
    '.go': 'Go',
    '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
    '.py': 'Python',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.scala': 'Scala',
    '.rs': 'Rust',
    '.c': 'C/C++', '.h': 'C/C++', '.cc': 'C/C++', '.cpp': 'C/C++', '.cxx': 'C/C++',
    '.hpp': 'C/C++', '.hh': 'C/C++', '.hxx': 'C/C++', '.inl': 'C/C++', '.ipp': 'C/C++',
  };
  /* Languages where the unit of dependency is the directory, not the file. */
  const PACKAGE_UNIT = new Set(['Go']);
  const JS_LANGS = new Set(['JavaScript', 'TypeScript']);
  const JVM_LANGS = new Set(['Java', 'Kotlin', 'Scala']);
  const MAX_SAMPLES = 200;

  function languageOf(path) {
    return LANG_BY_EXT[extname(path)] || null;
  }

  const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'e2e']);

  function isTestFile(path, lang) {
    const base = basename(path);
    if (lang === 'Go') return base.endsWith('_test.go');
    const segs = path.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (TEST_DIRS.has(s)) return true;
      if (JVM_LANGS.has(lang) && i > 0 && segs[i - 1] === 'src' && /(^test|Test)$/.test(s)) return true;
    }
    if (JS_LANGS.has(lang)) return /\.(test|spec|e2e)(-d)?\.[cm]?[jt]sx?$/.test(base);
    if (lang === 'Python') return /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py';
    if (lang === 'C/C++') return /(_test|_tests|_unittest)\.[a-z]+$/.test(base) || /^test_/.test(base);
    return false;
  }

  /* ------------------------------------------------------------------ Go */

  function goParse(src) {
    const n = src.length;
    let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
    const skip = () => {
      for (;;) {
        while (i < n && /[\s;]/.test(src[i])) i++;
        if (src[i] === '/' && src[i + 1] === '/') {
          const j = src.indexOf('\n', i);
          i = j < 0 ? n : j;
        } else if (src[i] === '/' && src[i + 1] === '*') {
          const j = src.indexOf('*/', i + 2);
          i = j < 0 ? n : j + 2;
        } else {
          return;
        }
      }
    };
    const word = () => {
      const m = /^[A-Za-z_.][\w.]*/.exec(src.slice(i, i + 256));
      if (!m) return '';
      i += m[0].length;
      return m[0];
    };
    const str = () => {
      const q = src[i];
      if (q !== '"' && q !== '`') return null;
      const end = src.indexOf(q, i + 1);
      if (end < 0) return null;
      const v = src.slice(i + 1, end);
      i = end + 1;
      return v;
    };
    const out = { pkg: '', imports: [] };
    skip();
    if (word() !== 'package') return out;
    skip();
    out.pkg = word();
    for (;;) {
      skip();
      const save = i;
      if (word() !== 'import') {
        i = save;
        break;
      }
      skip();
      const spec = () => {
        let alias = '';
        if (src[i] !== '"' && src[i] !== '`') {
          alias = word();
          skip();
        }
        const path = str();
        if (path === null) return false;
        out.imports.push({ path, alias });
        return true;
      };
      if (src[i] === '(') {
        i++;
        for (;;) {
          skip();
          if (src[i] === ')') {
            i++;
            break;
          }
          if (i >= n || !spec()) return out;
        }
      } else if (!spec()) {
        break;
      }
    }
    return out;
  }

  function goModulePath(text) {
    const clean = text.replace(/\/\/[^\n]*/g, '');
    const m = /^\s*module\s+(?:"([^"]+)"|`([^`]+)`|(\S+))/m.exec(clean);
    return m ? m[1] || m[2] || m[3] : null;
  }

  function analyzeGo(ctx) {
    const modules = [];
    for (const [path, text] of ctx.files) {
      if (basename(path) !== 'go.mod') continue;
      const mod = goModulePath(text);
      if (mod) modules.push({ dir: dirname(path), path: mod });
    }
    modules.sort((a, b) => b.path.length - a.path.length);
    const goDirs = new Set();
    for (const [path, info] of ctx.sources) if (info.lang === 'Go') goDirs.add(dirname(path));
    let unreadDirs = null;
    const unreadGoDirs = () => {
      if (!unreadDirs) {
        unreadDirs = new Set();
        for (const p of ctx.allPaths) if (p.endsWith('.go') && !ctx.files.has(p)) unreadDirs.add(dirname(p));
      }
      return unreadDirs;
    };
    if (modules.length === 0 && goDirs.size > 0) {
      ctx.notes.push('Go files were found but no go.mod, so Go imports could not be matched to folders.');
    }
    for (const [path, info] of ctx.sources) {
      if (info.lang !== 'Go') continue;
      const parsed = goParse(ctx.files.get(path));
      info.pkg = parsed.pkg;
      // `package x_test` in a _test.go file is the external test package: a package of its own that sits in the
      // same folder as x and may import x. Treating it as part of x would invent import cycles Go does not allow.
      if (info.test && /_test$/.test(parsed.pkg)) info.xtest = true;
      for (const imp of parsed.imports) {
        const p = imp.path;
        if (p === 'C') {
          ctx.count('Go', 'external', path, p);
          continue;
        }
        const mod = modules.find((m) => p === m.path || p.startsWith(m.path + '/'));
        if (!mod) {
          ctx.count('Go', 'external', path, p);
          continue;
        }
        const dir = join(mod.dir, p.slice(mod.path.length));
        if (dir !== null && goDirs.has(dir)) {
          ctx.count('Go', 'internal', path, p);
          ctx.edge(path, dirId(dir), 'import');
        } else if (dir !== null && unreadGoDirs().has(dir)) {
          ctx.count('Go', 'ignored', path, p);
        } else {
          ctx.count('Go', 'unresolved', path, p);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ JavaScript / TypeScript */

  const TS_FIRST = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  const JS_FIRST = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.d.ts'];
  const TS_FOR_JS = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] };
  const BUILD_DIRS = new Set(['dist', 'lib', 'build', 'out', 'esm', 'cjs', 'es', 'types', 'typings', '_dist', 'output']);
  const NOT_WORKSPACE_DIRS = new Set(['fixtures', '__fixtures__', 'fixture', 'test', 'tests', '__tests__', 'templates', 'template']);

  function globToRegex(glob) {
    let g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === '*') {
        if (g[i + 1] === '*') {
          re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
          i += g[i + 2] === '/' ? 2 : 1;
        } else {
          re += '[^/]*';
        }
      } else if (ch === '?') {
        re += '[^/]';
      } else if (ch === '{') {
        const end = g.indexOf('}', i);
        if (end > i) {
          re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
          i = end;
        } else {
          re += '\\{';
        }
      } else {
        re += escapeRe(ch);
      }
    }
    return new RegExp('^' + re + '$');
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function analyzeJs(ctx) {
    const codeFiles = new Set();
    for (const [path, info] of ctx.sources) if (JS_LANGS.has(info.lang)) codeFiles.add(path);
    if (codeFiles.size === 0) return;

    /* package.json index */
    const pkgByDir = new Map();
    for (const [path, text] of ctx.files) {
      if (basename(path) !== 'package.json') continue;
      try {
        const json = JSON.parse(text);
        if (json && typeof json === 'object') pkgByDir.set(dirname(path), json);
      } catch (_) {
        ctx.notes.push(path + ' is not valid JSON and was ignored.');
      }
    }
    const workspaceRules = []; // { base, include: [regex], exclude: [regex] }
    const addRule = (base, patterns) => {
      if (!Array.isArray(patterns)) return;
      const rule = { base, include: [], exclude: [] };
      for (const pat of patterns) {
        if (typeof pat !== 'string' || !pat) continue;
        if (pat[0] === '!') rule.exclude.push(globToRegex(pat.slice(1)));
        else rule.include.push(globToRegex(pat));
      }
      if (rule.include.length) workspaceRules.push(rule);
    };
    for (const [dir, json] of pkgByDir) {
      const ws = json.workspaces;
      addRule(dir, Array.isArray(ws) ? ws : ws && ws.packages);
    }
    for (const [path, text] of ctx.files) {
      if (basename(path) !== 'pnpm-workspace.yaml') continue;
      try {
        const doc = yamlLib().load(text);
        addRule(dirname(path), doc && doc.packages);
      } catch (_) {
        ctx.notes.push(path + ' could not be parsed and was ignored.');
      }
    }
    const isWorkspaceMember = (dir) => {
      for (const rule of workspaceRules) {
        if (rule.base !== '' && !(dir === rule.base || dir.startsWith(rule.base + '/'))) continue;
        const rel = rule.base === '' ? dir : dir.slice(rule.base.length + 1);
        if (rule.include.some((re) => re.test(rel)) && !rule.exclude.some((re) => re.test(rel))) return true;
      }
      return false;
    };
    const dirsByName = new Map();
    for (const [dir, json] of pkgByDir) {
      if (typeof json.name !== 'string' || !json.name) continue;
      if (!dirsByName.has(json.name)) dirsByName.set(json.name, []);
      dirsByName.get(json.name).push(dir);
    }

    const exists = (p) => codeFiles.has(p);
    const order = (fromTs) => (fromTs ? TS_FIRST : JS_FIRST);
    let sawUnread = false; // set while resolving one import: some candidate exists but was not read
    /* Would this path have resolved if the file had been read? (It sits in an ignored folder, is minified or is too large.) */
    const existsUnread = (p) => {
      if (p === null) return false;
      if (ctx.unread(p)) return true;
      const ext = extname(p);
      if (TS_FOR_JS[ext]) for (const alt of TS_FOR_JS[ext]) if (ctx.unread(p.slice(0, -ext.length) + alt)) return true;
      for (const e of TS_FIRST) if (ctx.unread(p + e) || ctx.unread((p === '' ? '' : p + '/') + 'index' + e)) return true;
      return false;
    };

    /* Node-style probing of a path without a query string. Returns a file path, { asset: true } or null. */
    const probe = (p, fromTs, noPackage, dirOnly) => {
      if (p === null) return null;
      if (dirOnly) {
        if (pkgByDir.has(p)) {
          const viaPkg = packageEntry(p, '', fromTs, true);
          if (viaPkg) return viaPkg;
        }
        const pre = p === '' ? '' : p + '/';
        for (const e of order(fromTs)) if (exists(pre + 'index' + e)) return pre + 'index' + e;
        if (existsUnread(p)) sawUnread = true;
        return null;
      }
      const ext = extname(p);
      // "./x.js" written in TypeScript means x.ts when that exists (the .js is its build output, or not there at all)
      if (TS_FOR_JS[ext] && (fromTs || !exists(p))) {
        const stem = p.slice(0, -ext.length);
        for (const alt of TS_FOR_JS[ext]) if (!alt.includes('.d.') && exists(stem + alt)) return stem + alt;
        if (!exists(p)) for (const alt of TS_FOR_JS[ext]) if (exists(stem + alt)) return stem + alt;
      }
      if (exists(p)) return p;
      if (p !== '' && ctx.allPaths.has(p)) return { asset: true };
      for (const e of order(fromTs)) if (exists(p + e)) return p + e;
      if (!noPackage && pkgByDir.has(p)) {
        const viaPkg = packageEntry(p, '', fromTs, true);
        if (viaPkg) return viaPkg;
      }
      const prefix = p === '' ? '' : p + '/';
      for (const e of order(fromTs)) if (exists(prefix + 'index' + e)) return prefix + 'index' + e;
      if (existsUnread(p)) sawUnread = true;
      return null;
    };

    /* package.json "exports"/"imports" targets: picks the first string under the usual condition names. */
    const pickTarget = (target, depth) => {
      if (typeof target === 'string') return [target];
      if (!target || typeof target !== 'object' || depth > 6) return [];
      if (Array.isArray(target)) return target.flatMap((t) => pickTarget(t, depth + 1));
      const out = [];
      const seen = new Set();
      for (const key of ['source', 'development', 'import', 'module', 'default', 'require', 'node', 'browser', 'types']) {
        if (key in target) {
          seen.add(key);
          out.push(...pickTarget(target[key], depth + 1));
        }
      }
      for (const key of Object.keys(target)) {
        if (!seen.has(key) && key[0] !== '.') out.push(...pickTarget(target[key], depth + 1));
      }
      return out;
    };
    const matchSubpath = (map, key) => {
      // exact key, then the longest "prefix*suffix" pattern
      if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
      if (Object.prototype.hasOwnProperty.call(map, key)) return pickTarget(map[key], 0);
      let best = null;
      for (const pattern of Object.keys(map)) {
        const star = pattern.indexOf('*');
        if (star < 0) continue;
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (key.length >= pre.length + post.length && key.startsWith(pre) && key.endsWith(post)) {
          if (!best || pre.length > best.pre.length) best = { pre, post, pattern };
        }
      }
      if (!best) return [];
      const middle = key.slice(best.pre.length, key.length - best.post.length);
      return pickTarget(map[best.pattern], 0).map((t) => t.split('*').join(middle));
    };

    /* A package.json usually points at build output that is not in the repository. Map it back to the source. */
    const sourceFor = (dir, target, fromTs) => {
      const rel = target.replace(/^\.\//, '');
      const direct = probe(join(dir, rel), fromTs, true);
      if (typeof direct === 'string') return direct;
      const stem = rel.replace(/\.d\.[cm]?ts$/, '').replace(/\.[cm]?[jt]sx?$/, '');
      const segs = stem.split('/');
      const tries = [stem];
      if (segs.length > 1 && BUILD_DIRS.has(segs[0])) {
        const rest = segs.slice(1);
        tries.push(['src', ...rest].join('/'), rest.join('/'));
        if (rest.length > 1 && BUILD_DIRS.has(rest[0])) {
          tries.push(['src', ...rest.slice(1)].join('/'), rest.slice(1).join('/'));
        }
      }
      for (const t of tries) {
        const hit = probe(join(dir, t), fromTs, true);
        if (typeof hit === 'string') return hit;
      }
      return null;
    };

    function packageEntry(dir, subpath, fromTs, strict) {
      const json = pkgByDir.get(dir) || {};
      const targets = [];
      if (subpath === '') {
        if (typeof json.source === 'string') targets.push(json.source);
        if (typeof json.exports === 'string') targets.push(json.exports);
        else if (json.exports && typeof json.exports === 'object') {
          const hasDot = Object.keys(json.exports).some((k) => k[0] === '.');
          targets.push(...(hasDot ? matchSubpath(json.exports, '.') : pickTarget(json.exports, 0)));
        }
        for (const field of ['module', 'main', 'types', 'typings']) if (typeof json[field] === 'string') targets.push(json[field]);
        targets.push('src/index', 'index', 'src/main', 'lib/index');
      } else {
        if (json.exports && typeof json.exports === 'object') targets.push(...matchSubpath(json.exports, './' + subpath));
        targets.push(subpath, 'src/' + subpath);
      }
      for (const t of targets) {
        if (typeof t !== 'string' || !t) continue;
        const hit = sourceFor(dir, t, fromTs);
        if (hit) return hit;
      }
      return strict ? null : dirId(dir);
    }

    /* tsconfig / jsconfig path aliases */
    const configDirs = new Map(); // dir -> [config paths]
    for (const path of ctx.files.keys()) {
      const b = basename(path);
      if (/^(ts|js)config(\.[\w-]+)?\.json$/.test(b)) {
        const d = dirname(path);
        if (!configDirs.has(d)) configDirs.set(d, []);
        configDirs.get(d).push(path);
      }
    }
    const configCache = new Map();
    const loadConfig = (path, depth) => {
      if (configCache.has(path)) return configCache.get(path);
      const result = { baseUrl: null, paths: null, pathsBase: null };
      configCache.set(path, result);
      const text = ctx.files.get(path);
      const json = text ? Lex.parseJsonc(text) : null;
      if (!json || typeof json !== 'object') return result;
      const exts = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
      for (const ext of exts) {
        if (typeof ext !== 'string' || ext[0] !== '.' || depth > 5) continue;
        let target = join(dirname(path), ext);
        if (target !== null && !ctx.files.has(target) && ctx.files.has(target + '.json')) target += '.json';
        if (target !== null && ctx.files.has(target)) {
          const parent = loadConfig(target, depth + 1);
          if (parent.baseUrl !== null) result.baseUrl = parent.baseUrl;
          if (parent.paths) {
            result.paths = parent.paths;
            result.pathsBase = parent.pathsBase;
          }
        }
      }
      const co = json.compilerOptions;
      if (co && typeof co === 'object') {
        if (typeof co.baseUrl === 'string') result.baseUrl = join(dirname(path), co.baseUrl);
        if (co.paths && typeof co.paths === 'object') {
          result.paths = co.paths;
          result.pathsBase = typeof co.baseUrl === 'string' ? join(dirname(path), co.baseUrl) : result.baseUrl !== null ? result.baseUrl : dirname(path);
        }
      }
      return result;
    };
    const aliasCache = new Map(); // dir -> merged config or null
    const aliasesFor = (dir) => {
      if (aliasCache.has(dir)) return aliasCache.get(dir);
      let found = null;
      if (configDirs.has(dir)) {
        const list = configDirs.get(dir).slice().sort((a, b) => basename(a).length - basename(b).length);
        for (const p of list) {
          const cfg = loadConfig(p, 0);
          if (cfg.paths || cfg.baseUrl !== null) {
            found = found || { baseUrl: null, rules: [] };
            if (cfg.baseUrl !== null && found.baseUrl === null) found.baseUrl = cfg.baseUrl;
            if (cfg.paths && cfg.pathsBase !== null) {
              for (const key of Object.keys(cfg.paths)) {
                const targets = cfg.paths[key];
                if (Array.isArray(targets)) found.rules.push({ key, targets: targets.filter((t) => typeof t === 'string'), base: cfg.pathsBase });
              }
            }
          }
        }
      }
      if (!found && dir !== '') found = aliasesFor(dirname(dir));
      aliasCache.set(dir, found);
      return found;
    };
    const viaAlias = (fromDir, spec, fromTs) => {
      const cfg = aliasesFor(fromDir);
      if (!cfg) return null;
      let best = null;
      for (const rule of cfg.rules) {
        const star = rule.key.indexOf('*');
        if (star < 0) {
          if (rule.key === spec) {
            best = { rule, middle: '', len: Infinity };
            break;
          }
          continue;
        }
        const pre = rule.key.slice(0, star);
        const post = rule.key.slice(star + 1);
        if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) {
          if (!best || pre.length > best.len) best = { rule, middle: spec.slice(pre.length, spec.length - post.length), len: pre.length };
        }
      }
      if (best) {
        for (const target of best.rule.targets) {
          const hit = probe(join(best.rule.base, target.split('*').join(best.middle)), fromTs);
          if (hit) return { hit, matched: true };
        }
        // "*" is a catch-all that also covers real packages, so a miss there says nothing.
        return best.rule.key === '*' ? null : { hit: null, matched: true };
      }
      if (cfg.baseUrl !== null) {
        const hit = probe(join(cfg.baseUrl, spec), fromTs, true);
        if (typeof hit === 'string') return { hit, matched: true };
      }
      return null;
    };

    const nearestPackageDir = (dir) => {
      let d = dir;
      for (;;) {
        if (pkgByDir.has(d)) return d;
        if (d === '') return null;
        d = dirname(d);
      }
    };
    const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const declaredSpec = (fromDir, name) => {
      let d = fromDir;
      for (;;) {
        const json = pkgByDir.get(d);
        if (json) {
          for (const f of DEP_FIELDS) {
            if (json[f] && typeof json[f] === 'object' && typeof json[f][name] === 'string') return json[f][name];
          }
        }
        if (d === '') return null;
        d = dirname(d);
      }
    };

    /* Bare specifier that names a package living in this repository. Returns a target, 'ambiguous' or null. */
    const viaWorkspace = (fromFile, spec, fromTs) => {
      const parts = spec.split('/');
      const name = spec[0] === '@' ? parts.slice(0, 2).join('/') : parts[0];
      const dirs = dirsByName.get(name);
      if (!dirs) return null;
      const subpath = spec.slice(name.length + 1);
      const fromDir = dirname(fromFile);
      const own = nearestPackageDir(fromDir);
      let chosen = null;
      const members = dirs.filter(isWorkspaceMember);
      if (members.length === 1) chosen = members[0];
      else if (members.length > 1) return 'ambiguous';
      else if (own !== null && dirs.includes(own)) chosen = own; // a package importing itself by name
      else {
        const plausible = dirs.filter((d) => !d.split('/').some((s) => NOT_WORKSPACE_DIRS.has(s)));
        if (plausible.length !== 1) return plausible.length > 1 ? 'ambiguous' : null;
        const declared = declaredSpec(fromDir, name);
        const local = declared !== null && /^(workspace:|file:|link:|portal:)/.test(declared);
        // Without a workspace definition, accept a local-path dependency, or the repository's own root package.
        if (local || plausible[0] === '') chosen = plausible[0];
        else return null;
      }
      if (subpath) {
        const direct = join(chosen, subpath);
        if (direct !== null && !codeFiles.has(direct) && ctx.allPaths.has(direct)) return { asset: true }; // pkg/package.json, pkg/style.css
      }
      return packageEntry(chosen, subpath, fromTs, false);
    };

    const viaImportsField = (fromFile, spec, fromTs) => {
      const dir = nearestPackageDir(dirname(fromFile));
      if (dir === null) return null;
      const json = pkgByDir.get(dir);
      if (!json.imports || typeof json.imports !== 'object') return null;
      for (const target of matchSubpath(json.imports, spec)) {
        if (typeof target !== 'string' || target[0] !== '.') continue;
        const hit = sourceFor(dir, target, fromTs);
        if (hit) return hit;
      }
      return undefined; // matched nothing usable
    };

    for (const path of codeFiles) {
      const info = ctx.sources.get(path);
      const lang = info.lang;
      const fromTs = lang === 'TypeScript';
      const fromDir = dirname(path);
      let imports;
      try {
        imports = Lex.jsImports(ctx.files.get(path));
      } catch (_) {
        ctx.notes.push(path + ' could not be tokenized and was skipped.');
        continue;
      }
      for (const imp of imports) {
        const spec = imp.spec.replace(/(?!^)[?#].*$/, ''); // drop ?query and #hash suffixes, keep "#alias" specifiers
        if (!spec) continue;
        let hit = null;
        let internal = false;
        sawUnread = false;
        if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
          internal = true;
          hit = probe(join(fromDir, spec), fromTs, false, /(^|\/)\.{1,2}$|\/$/.test(spec));
        } else if (spec[0] === '#') {
          const r = viaImportsField(path, spec, fromTs);
          if (r === null) {
            const a = viaAlias(fromDir, spec, fromTs);
            if (a) {
              internal = true;
              hit = a.hit;
            }
          } else {
            internal = true;
            hit = r || null;
          }
        } else if (spec[0] === '/' || /^[a-z][a-z0-9+.-]*:/i.test(spec)) {
          internal = false; // absolute paths, node:, http:, data:, virtual: and friends
        } else {
          const a = viaAlias(fromDir, spec, fromTs);
          if (a) {
            internal = true;
            hit = a.hit;
          } else {
            const w = viaWorkspace(path, spec, fromTs);
            if (w === 'ambiguous') {
              internal = true;
              hit = null;
            } else if (w) {
              internal = true;
              hit = w;
            }
          }
        }
        if (!internal) {
          ctx.count(lang, 'external', path, imp.spec);
        } else if (hit === null) {
          // an alias or package name can lead into an ignored folder just like a relative path can
          ctx.count(lang, sawUnread ? 'ignored' : 'unresolved', path, imp.spec);
        } else if (typeof hit === 'object') {
          ctx.count(lang, 'asset', path, imp.spec);
        } else {
          ctx.count(lang, 'internal', path, imp.spec);
          ctx.edge(path, hit, imp.typeOnly ? 'type' : 'import');
        }
      }
    }
  }

  /* ------------------------------------------------------------------ Python */

  const PY_STDLIB = new Set(
    ('__future__ abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 ' +
      'calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib ' +
      'contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest ' +
      'email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt ' +
      'getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ' +
      'ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap ' +
      'modulefinder msilib msvcrt multiprocessing netrc nis nntplib ntpath numbers opcode operator optparse os ossaudiodev ' +
      'pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd ' +
      'py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select ' +
      'selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile ' +
      'sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog ' +
      'tabnanny tarfile telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace ' +
      'traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave ' +
      'weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread').split(' ')
  );

  /* Returns [{ level, module, names }] — `names` is null for a plain "import a.b". */
  function pyImports(src) {
    const text = Lex.blankPython(src);
    const out = [];
    const cont = '[^\\n\\\\;]*(?:\\\\\\n[^\\n\\\\;]*)*';
    const fromRe = new RegExp('(?:^|;)[ \\t]*from(?:[ \\t]+|(?=\\.))(\\.*)[ \\t]*([\\w.]*)[ \\t]+import[ \\t]*(\\([^)]*\\)|' + cont + ')', 'gm');
    const importRe = new RegExp('(?:^|;)[ \\t]*import[ \\t]+(' + cont + ')', 'gm');
    let m;
    while ((m = fromRe.exec(text))) {
      const level = m[1].length;
      const module = m[2];
      if (level === 0 && !module) continue;
      const names = m[3]
        .replace(/[()\\]/g, ' ')
        .split(',')
        .map((s) => s.trim().split(/\s+/)[0])
        .filter((s) => s && (s === '*' || /^[A-Za-z_]\w*$/.test(s)));
      if (names.length === 0) continue;
      out.push({ level, module, names });
    }
    while ((m = importRe.exec(text))) {
      for (const part of m[1].replace(/\\\n/g, ' ').replace(/\s*\.\s*/g, '.').split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (/^[A-Za-z_][\w.]*$/.test(name) && !name.endsWith('.')) out.push({ level: 0, module: name, names: null });
      }
    }
    return out;
  }

  function analyzePython(ctx) {
    const pyFiles = new Set();
    for (const [path, info] of ctx.sources) if (info.lang === 'Python') pyFiles.add(path);
    if (pyFiles.size === 0) return;
    const pyDirs = new Set(); // every directory that holds a .py file somewhere below it
    for (const p of pyFiles) {
      let d = dirname(p);
      for (;;) {
        if (pyDirs.has(d)) break;
        pyDirs.add(d);
        if (d === '') break;
        d = dirname(d);
      }
    }
    const isPackageDir = (d) => pyFiles.has(d === '' ? '__init__.py' : d + '/__init__.py');
    const projectDirs = new Set();
    for (const p of ctx.allPaths) {
      const b = basename(p);
      if (b === 'pyproject.toml' || b === 'setup.py' || b === 'setup.cfg') projectDirs.add(dirname(p));
    }
    /* Where a top-level package or module lives, for imports that cross project folders. */
    const topLevelRoots = new Map(); // name -> Set(root dir)
    for (const p of pyFiles) {
      if (basename(p) !== '__init__.py') continue;
      const d = dirname(p);
      if (d === '' || isPackageDir(dirname(d))) continue;
      const name = basename(d);
      if (!topLevelRoots.has(name)) topLevelRoots.set(name, new Set());
      topLevelRoots.get(name).add(dirname(d));
    }

    const moduleAt = (root, dotted) => {
      const rel = dotted.split('.').join('/');
      const base = root === '' ? rel : root + '/' + rel;
      if (pyFiles.has(base + '.py')) return base + '.py';
      if (pyFiles.has(base + '/__init__.py')) return base + '/__init__.py';
      return null;
    };
    const somethingAt = (root, name) => {
      const base = root === '' ? name : root + '/' + name;
      return pyFiles.has(base + '.py') || pyDirs.has(base);
    };
    /* A module that exists in the repository but is not Python source: Cython, a type stub, a C extension. */
    const NOT_PYTHON = ['.pyx', '.pxd', '.pyi', '.so', '.pyd', '.c'];
    const extensionAt = (root, dotted) => {
      const base = (root === '' ? '' : root + '/') + dotted.split('.').join('/');
      return NOT_PYTHON.some((ext) => ctx.allPaths.has(base + ext));
    };
    /* "poetry.core" is the distribution "poetry-core" when a manifest in the repository asks for that: the import
       shares its first name with a local package but belongs to a dependency (a namespace package). */
    const declared = ctx.hints.pythonDependencies;
    const isDeclaredDependency = (dotted) => {
      if (!declared || declared.size === 0) return false;
      const segs = dotted.toLowerCase().split('.');
      for (let k = 2; k <= segs.length; k++) {
        if (declared.has(segs.slice(0, k).join('-').replace(/_/g, '-'))) return true;
      }
      return false;
    };

    const rootsCache = new Map();
    const rootsFor = (dir) => {
      if (rootsCache.has(dir)) return rootsCache.get(dir);
      const roots = [];
      const add = (r) => {
        if (r !== null && !roots.includes(r)) roots.push(r);
      };
      // 1. the folder above the outermost package this file belongs to (or the file's own folder for a loose script)
      let d = dir;
      while (d !== '' && isPackageDir(d)) d = dirname(d);
      add(d);
      // 2. enclosing project folders and their src/
      let a = dir;
      for (;;) {
        if (projectDirs.has(a)) {
          add(a);
          add(a === '' ? 'src' : a + '/src');
        }
        if (a === '') break;
        a = dirname(a);
      }
      // 3. the repository root and src/
      add('');
      add('src');
      const result = { roots };
      rootsCache.set(dir, result);
      return result;
    };

    for (const path of pyFiles) {
      const dir = dirname(path);
      const stmts = pyImports(ctx.files.get(path));
      const { roots } = rootsFor(dir);
      for (const st of stmts) {
        const label = (st.level ? '.'.repeat(st.level) : '') + st.module;
        if (st.level > 0) {
          // relative: one dot is the file's own package, each further dot goes up one folder
          let base = dir;
          let ok = true;
          for (let k = 1; k < st.level; k++) {
            if (base === '') {
              ok = false;
              break;
            }
            base = dirname(base);
          }
          const modDotted = st.module;
          const names = st.names || ['*'];
          for (const name of names) {
            const shown = 'from ' + label + ' import ' + name;
            if (!ok) {
              ctx.count('Python', 'unresolved', path, shown);
              continue;
            }
            // `from .pkg import name`: the submodule pkg/name if there is one, else the name lives in pkg itself
            const sub = name !== '*' ? (modDotted ? modDotted + '.' + name : name) : null;
            let hit = sub ? moduleAt(base, sub) : null;
            const compiled = !hit && sub !== null && extensionAt(base, sub);
            if (!hit && !compiled) hit = modDotted ? moduleAt(base, modDotted) : pyFiles.has((base ? base + '/' : '') + '__init__.py') ? (base ? base + '/' : '') + '__init__.py' : null;
            if (hit) {
              ctx.count('Python', 'internal', path, shown);
              ctx.edge(path, hit, 'import');
            } else {
              const rel = (base ? base + '/' : '') + (modDotted || name).split('.').join('/');
              if (compiled || (modDotted && extensionAt(base, modDotted))) ctx.count('Python', 'asset', path, shown);
              else if (ctx.unread(rel + '.py') || ctx.unread(rel + '/__init__.py')) ctx.count('Python', 'ignored', path, shown);
              else ctx.count('Python', 'unresolved', path, shown);
            }
          }
          continue;
        }
        // absolute
        const top = st.module.split('.')[0];
        const stdlib = PY_STDLIB.has(top);
        // A standard-library name only means a local file for a loose script, whose own folder comes first on sys.path.
        const candidates = stdlib ? (isPackageDir(dir) ? [] : [dir]) : roots.slice();
        if (!stdlib) {
          const elsewhere = topLevelRoots.get(top);
          if (elsewhere && elsewhere.size === 1) {
            const r = [...elsewhere][0];
            if (!candidates.includes(r)) candidates.push(r);
          }
        }
        const names = st.names || [null];
        for (const name of names) {
          const shown = name === null ? 'import ' + st.module : 'from ' + st.module + ' import ' + name;
          let hit = null;
          let known = false;
          let extension = false;
          for (const root of candidates) {
            if (name !== null && name !== '*') {
              hit = moduleAt(root, st.module + '.' + name);
              if (!hit && extensionAt(root, st.module + '.' + name)) {
                extension = true; // `from pkg import _speedups` where pkg/_speedups is compiled, not Python
                break;
              }
            }
            if (!hit) hit = moduleAt(root, st.module);
            if (hit) break;
            if (somethingAt(root, top)) known = true;
            if (extensionAt(root, st.module)) extension = true;
          }
          if (hit) {
            ctx.count('Python', 'internal', path, shown);
            ctx.edge(path, hit, 'import');
          } else if (extension && !stdlib) {
            ctx.count('Python', 'asset', path, shown);
          } else if (known && !stdlib && isDeclaredDependency(name !== null && name !== '*' ? st.module + '.' + name : st.module)) {
            ctx.count('Python', 'external', path, shown);
          } else if (known && !stdlib) {
            ctx.count('Python', 'unresolved', path, shown);
          } else {
            ctx.count('Python', 'external', path, shown);
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ Java, Kotlin, Scala */

  const JVM_BLANK = { nested: true, triple: true, backtick: true };

  function jvmParse(src, lang) {
    const text = Lex.blank(src, lang === 'Java' ? { triple: true } : JVM_BLANK);
    const out = { pkg: '', imports: [], text, declared: jvmDeclared(text, lang) };
    if (lang === 'Scala') {
      // Scala allows chained clauses: "package a" then "package b" means a.b
      const re = /^[ \t]*package[ \t]+([\w.]+)[ \t]*;?[ \t]*$/gm;
      const parts = [];
      let m;
      while ((m = re.exec(text))) parts.push(m[1]);
      out.pkg = parts.join('.');
      const imp = /^[ \t]*import[ \t]+([^\n;]+)/gm;
      while ((m = imp.exec(text))) {
        for (const clause of splitTopLevel(m[1])) {
          const c = clause.trim().replace(/^_root_\./, '');
          const brace = c.indexOf('{');
          if (brace >= 0) {
            const prefix = c.slice(0, brace).replace(/\.\s*$/, '').trim();
            const inner = c.slice(brace + 1, c.lastIndexOf('}') > brace ? c.lastIndexOf('}') : c.length);
            for (const sel of inner.split(',')) {
              const name = sel.trim().split(/\s*=>\s*|\s+as\s+/)[0].trim();
              if (!name || !/^[\w.]+$/.test(prefix)) continue;
              if (name === '_' || name === '*') out.imports.push({ name: prefix, wildcard: true });
              else if (/^\w+$/.test(name) && name !== 'given') out.imports.push({ name: prefix + '.' + name, wildcard: false });
            }
          } else {
            const name = c.split(/\s+as\s+/)[0].trim();
            if (/^[\w.]+\.(_|\*)$/.test(name)) out.imports.push({ name: name.replace(/\.(_|\*)$/, ''), wildcard: true });
            else if (/^[\w.]+$/.test(name) && name.includes('.')) out.imports.push({ name, wildcard: false });
          }
        }
      }
      return out;
    }
    const pm = /^[ \t]*package[ \t]+([\w.]+)/m.exec(text);
    if (pm) out.pkg = pm[1];
    const re = /^[ \t]*import[ \t]+(static[ \t]+)?([\w.]+?)(\.\*)?[ \t]*(?:as[ \t]+\w+[ \t]*)?;?[ \t]*$/gm;
    let m;
    while ((m = re.exec(text))) out.imports.push({ name: m[2], wildcard: !!m[3] });
    return out;
  }

  const JVM_MODIFIERS = '(?:(?:public|private(?:\\[[\\w.]+\\])?|protected(?:\\[[\\w.]+\\])?|internal|abstract|final|sealed|open|data|value|inline|enum|annotation|case|implicit|static|strictfp|non-sealed|expect|actual|external|fun|suspend|operator|infix|tailrec|const|lateinit|override|@[\\w.]+(?:\\([^)\\n]*\\))?)[ \\t]+)*';
  const JVM_TYPE_DECL = new RegExp('^' + JVM_MODIFIERS + '(?:class|interface|object|trait|enum|record|typealias|@interface)[ \\t]+([A-Za-z_]\\w*)', 'gm');
  const KOTLIN_FUN_DECL = new RegExp('^' + JVM_MODIFIERS + 'fun[ \\t]+(?:<[^>\\n]+>[ \\t]*)?(?:[^(=\\n]*?\\.)?([A-Za-z_]\\w*)[ \\t]*\\(', 'gm');
  const KOTLIN_VAL_DECL = new RegExp('^' + JVM_MODIFIERS + '(?:val|var)[ \\t]+(?:<[^>\\n]+>[ \\t]*)?(?:[^=:\\n]*?\\.)?([A-Za-z_]\\w*)[ \\t]*(?=[:=\\n]|by\\b|$)', 'gm');

  /* Names declared at the top level of a file (column 0): types for all three languages, plus functions and
     properties for Kotlin, which can be imported by name. */
  function jvmDeclared(text, lang) {
    const names = new Set();
    let m;
    JVM_TYPE_DECL.lastIndex = 0;
    while ((m = JVM_TYPE_DECL.exec(text))) names.add(m[1]);
    if (lang === 'Kotlin') {
      KOTLIN_FUN_DECL.lastIndex = 0;
      while ((m = KOTLIN_FUN_DECL.exec(text))) names.add(m[1]);
      KOTLIN_VAL_DECL.lastIndex = 0;
      while ((m = KOTLIN_VAL_DECL.exec(text))) names.add(m[1]);
    }
    return names;
  }

  function splitTopLevel(s) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      else if (s[i] === ',' && depth === 0) {
        parts.push(s.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(s.slice(start));
    return parts;
  }

  function analyzeJvm(ctx) {
    const parsed = new Map();
    const packages = new Map(); // package name -> { dirs: Set, byName: Map(simple name -> [paths]) }
    for (const [path, info] of ctx.sources) {
      if (!JVM_LANGS.has(info.lang)) continue;
      const p = jvmParse(ctx.files.get(path), info.lang);
      parsed.set(path, p);
      info.pkg = p.pkg;
      if (!p.pkg) continue;
      if (!packages.has(p.pkg)) packages.set(p.pkg, { dirs: new Set(), byName: new Map() });
      const entry = packages.get(p.pkg);
      entry.dirs.add(dirname(path));
      const simple = basename(path).split('.')[0];
      const names = new Set(p.declared);
      names.add(simple);
      for (const name of names) {
        if (!entry.byName.has(name)) entry.byName.set(name, []);
        entry.byName.get(name).push(path);
      }
    }
    if (parsed.size === 0) return;

    const filesNamed = (pkg, simple, fromTest) => {
      const list = packages.get(pkg).byName.get(simple);
      if (!list) return null;
      if (!fromTest) {
        const main = list.filter((p) => !ctx.sources.get(p).test);
        if (main.length) return main;
      }
      return list;
    };
    const packageDirs = (pkg, fromTest) => {
      const dirs = [...packages.get(pkg).dirs];
      if (fromTest) return dirs;
      // a package split between main and test sources: code outside the tests can only mean the main half
      const main = dirs.filter((d) => {
        for (const list of packages.get(pkg).byName.values()) {
          for (const p of list) if (dirname(p) === d && !ctx.sources.get(p).test) return true;
        }
        return false;
      });
      return main.length ? main : dirs;
    };

    /* Returns { files } | { dirs } | 'external'. */
    const resolve = (name, wildcard, fromTest) => {
      const segs = name.split('.');
      if (packages.has(name)) return { dirs: packageDirs(name, fromTest) };
      for (let k = segs.length - 1; k >= 1; k--) {
        const pkg = segs.slice(0, k).join('.');
        if (!packages.has(pkg)) continue;
        const next = segs[k];
        const files = filesNamed(pkg, next, fromTest);
        if (files) return { files };
        const rest = segs.length - k;
        // pkg.member or pkg.Type.member where nothing in the package declares that name at the top level
        // (generated code, a Scala package object, a nested declaration): the best that can be said is "that package"
        if ((rest === 1 && !wildcard) || /^[A-Z]/.test(next)) {
          const dirs = packageDirs(pkg, fromTest);
          return dirs.length === 1 ? { dirs } : { ambiguous: dirs.length };
        }
        // pkg.lowercase.More looks like a sub-package that is not in this repository
        return 'external';
      }
      return 'external';
    };

    for (const [path, p] of parsed) {
      const info = ctx.sources.get(path);
      const lang = info.lang;
      for (const imp of p.imports) {
        const shown = imp.name + (imp.wildcard ? '.*' : '');
        let r = resolve(imp.name, imp.wildcard, info.test);
        if (r === 'external' && lang === 'Scala' && p.pkg) {
          // Scala resolves imports relative to the enclosing packages too
          const own = p.pkg.split('.');
          for (let k = own.length; k >= 1 && r === 'external'; k--) {
            r = resolve(own.slice(0, k).join('.') + '.' + imp.name, imp.wildcard, info.test);
          }
        }
        if (r === 'external') {
          ctx.count(lang, 'external', path, shown);
          continue;
        }
        if (r.ambiguous) {
          ctx.count(lang, 'unresolved', path, shown + ' (not declared at the top level of any file; the package spans ' + r.ambiguous + ' folders)');
          continue;
        }
        ctx.count(lang, 'internal', path, shown);
        if (r.files) for (const f of r.files) ctx.edge(path, f, 'import');
        else for (const d of r.dirs) ctx.edge(path, dirId(d), 'package');
      }
    }

    /* Types in the same package are used without an import. A capitalised name that matches a neighbouring file,
       is not imported from elsewhere and is not declared in this file is taken as a reference to that neighbour. */
    for (const [path, p] of parsed) {
      if (!p.pkg) continue;
      const entry = packages.get(p.pkg);
      if (entry.byName.size < 2) continue;
      const info = ctx.sources.get(path);
      const own = basename(path).split('.')[0];
      const imported = new Set();
      for (const imp of p.imports) if (!imp.wildcard) imported.add(imp.name.slice(imp.name.lastIndexOf('.') + 1));
      const seen = new Set();
      const re = /(^|[^\w.$])([A-Z][A-Za-z0-9_]*)\b/g;
      let m;
      while ((m = re.exec(p.text))) {
        const name = m[2];
        if (seen.has(name)) continue;
        seen.add(name);
        if (name === own || p.declared.has(name) || imported.has(name) || !entry.byName.has(name)) continue;
        if (new RegExp('\\b(?:class|interface|enum|record|object|trait|typealias|type)\\s+' + name + '\\b').test(p.text)) continue;
        const targets = filesNamed(p.pkg, name, info.test);
        let linked = false;
        for (const f of targets || []) {
          if (f === path) continue;
          ctx.edge(path, f, 'same-package');
          linked = true;
        }
        if (linked) ctx.stats[info.lang].samePackage++;
      }
    }
    for (const p of parsed.values()) {
      delete p.text;
      delete p.declared;
    }
  }

  /* ------------------------------------------------------------------ Rust */

  const RUST_BLANK = { nested: true, rustRaw: true };

  /* Expands a use tree ("a::{b, c::{d, self}}") into flat paths (arrays of segments). */
  function expandUseTree(tree) {
    const out = [];
    const walk = (prefix, s) => {
      s = s.trim();
      if (!s) return;
      const brace = s.indexOf('{');
      if (brace < 0) {
        const path = s.split(/\s+as\s+/)[0].trim();
        const segs = path.split('::').map((x) => x.trim()).filter(Boolean);
        if (segs.every((x) => /^(\*|[A-Za-z_]\w*|r#\w+)$/.test(x))) out.push(prefix.concat(segs));
        return;
      }
      const head = s.slice(0, brace).split('::').map((x) => x.trim()).filter(Boolean);
      let depth = 0;
      let end = -1;
      for (let i = brace; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) return;
      for (const part of splitTopLevel(s.slice(brace + 1, end))) walk(prefix.concat(head), part);
    };
    walk([], tree);
    return out;
  }

  /* Returns { mods: [{ name, path, inline: [names] }], paths: [{ segs, depth, use }] } for one file.
     `depth` is how many inline `mod x { }` blocks enclose the path. */
  function rustParse(src) {
    const text = Lex.blank(src, RUST_BLANK);
    const mods = [];
    const paths = [];
    const inlineStack = []; // { name, braceDepth }
    let braceDepth = 0;
    const tokenRe = /[{}]|#\s*\[\s*path\s*=\s*"[^"]*"\s*\]|\bextern\s+crate\s+([A-Za-z_]\w*)|\b(?:pub(?:\s*\([^)]*\))?\s+)?(mod|use)\b|(?<![\w:$])(\$?(?:crate|self|super|[A-Za-z_]\w*)(?:\s*::\s*[A-Za-z_]\w*)+)/g;
    // #[path = "..."] needs its string contents, which blanking removed; read attributes from the original.
    let pendingPath = null;
    let m;
    while ((m = tokenRe.exec(text))) {
      const tok = m[0];
      if (tok === '{') {
        braceDepth++;
        continue;
      }
      if (tok === '}') {
        braceDepth--;
        while (inlineStack.length && inlineStack[inlineStack.length - 1].braceDepth > braceDepth) inlineStack.pop();
        continue;
      }
      if (tok[0] === '#') {
        const orig = /"([^"]*)"/.exec(src.slice(m.index, m.index + tok.length));
        pendingPath = orig ? orig[1] : null;
        continue;
      }
      if (m[1]) {
        if (m[1] !== 'self') paths.push({ segs: [m[1]], depth: inlineStack.length, use: true });
        continue;
      }
      if (m[2] === 'mod') {
        const rest = /^\s+([A-Za-z_]\w*|r#\w+)\s*([;{])/.exec(text.slice(tokenRe.lastIndex, tokenRe.lastIndex + 200));
        if (rest) {
          const name = rest[1].replace(/^r#/, '');
          tokenRe.lastIndex += rest[0].length;
          if (rest[2] === ';') {
            mods.push({ name, path: pendingPath, inline: inlineStack.map((x) => x.name) });
          } else {
            braceDepth++;
            inlineStack.push({ name, braceDepth });
          }
        }
        pendingPath = null;
        continue;
      }
      if (m[2] === 'use') {
        const end = text.indexOf(';', tokenRe.lastIndex);
        if (end < 0) break;
        const tree = text.slice(tokenRe.lastIndex, end);
        tokenRe.lastIndex = end + 1;
        for (const segs of expandUseTree(tree.replace(/^\s*::/, ''))) paths.push({ segs, depth: inlineStack.length, use: true });
        pendingPath = null;
        continue;
      }
      if (m[3]) {
        paths.push({ segs: m[3].replace(/^\$/, '').split('::').map((x) => x.trim()), depth: inlineStack.length, use: false });
      }
    }
    return { mods, paths };
  }

  function analyzeRust(ctx) {
    const rsFiles = new Set();
    for (const [path, info] of ctx.sources) if (info.lang === 'Rust') rsFiles.add(path);
    if (rsFiles.size === 0) return;

    /* crates */
    const crates = new Map(); // dir -> { dir, name, libRoot, toml }
    for (const [path, text] of ctx.files) {
      if (basename(path) !== 'Cargo.toml') continue;
      let toml;
      try {
        toml = Toml.parse(text);
      } catch (e) {
        ctx.notes.push(path + ' could not be parsed (' + e.message + ').');
        continue;
      }
      crates.set(dirname(path), { dir: dirname(path), toml });
    }
    const workspaceRootOf = (dir) => {
      let d = dir;
      for (;;) {
        const c = crates.get(d);
        if (c && c.toml.workspace && typeof c.toml.workspace === 'object') return c;
        if (d === '') return null;
        d = dirname(d);
      }
    };
    for (const crate of crates.values()) {
      const pkg = crate.toml.package;
      crate.name = pkg && typeof pkg.name === 'string' ? pkg.name : null;
      const lib = crate.toml.lib && typeof crate.toml.lib === 'object' ? crate.toml.lib : {};
      const libPath = join(crate.dir, typeof lib.path === 'string' ? lib.path : 'src/lib.rs');
      crate.libRoot = libPath !== null && rsFiles.has(libPath) ? libPath : null;
      crate.libName = typeof lib.name === 'string' ? lib.name : crate.name ? crate.name.replace(/-/g, '_') : null;
      crate.roots = [];
      const addRoot = (p) => {
        if (p !== null && rsFiles.has(p) && !crate.roots.includes(p)) crate.roots.push(p);
      };
      addRoot(libPath);
      addRoot(join(crate.dir, 'src/main.rs'));
      addRoot(join(crate.dir, 'build.rs'));
      for (const key of ['bin', 'example', 'test', 'bench']) {
        const list = crate.toml[key];
        if (Array.isArray(list)) for (const t of list) if (t && typeof t.path === 'string') addRoot(join(crate.dir, t.path));
      }
    }
    const parsed = new Map();
    for (const p of rsFiles) parsed.set(p, rustParse(ctx.files.get(p)));
    // Conventional target folders: every file directly in src/bin, examples, tests or benches starts its own
    // target, unless a sibling there declares it with `mod name;` (the usual tests/tests.rs + tests/util.rs layout).
    const candidates = [];
    for (const p of rsFiles) {
      const d = dirname(p);
      for (const folder of ['src/bin', 'examples', 'tests', 'benches']) {
        for (const crate of crates.values()) {
          const base = crate.dir === '' ? folder : crate.dir + '/' + folder;
          if (d === base || (dirname(d) === base && basename(p) === 'main.rs')) candidates.push({ crate, path: p });
        }
      }
    }
    const claimed = new Set();
    const declaring = candidates.map((c) => c.path);
    for (const crate of crates.values()) declaring.push(...crate.roots);
    for (const file of declaring) {
      const d = dirname(file);
      for (const mod of parsed.get(file).mods) {
        if (mod.inline.length || mod.path) continue;
        const a = (d ? d + '/' : '') + mod.name + '.rs';
        const b = (d ? d + '/' : '') + mod.name + '/mod.rs';
        if (rsFiles.has(a)) claimed.add(a);
        else if (rsFiles.has(b)) claimed.add(b);
      }
    }
    for (const c of candidates) {
      if (!claimed.has(c.path) && !c.crate.roots.includes(c.path)) c.crate.roots.push(c.path);
    }
    const crateOf = (path) => {
      let d = dirname(path);
      for (;;) {
        if (crates.has(d)) return crates.get(d);
        if (d === '') return null;
        d = dirname(d);
      }
    };
    /* local path dependencies: the name code uses -> the crate it refers to */
    const localDepsCache = new Map();
    const localDeps = (crate) => {
      if (localDepsCache.has(crate.dir)) return localDepsCache.get(crate.dir);
      const out = new Map();
      const take = (table) => {
        if (!table || typeof table !== 'object') return;
        for (const key of Object.keys(table)) {
          let spec = table[key];
          if (spec && typeof spec === 'object' && spec.workspace === true) {
            const ws = workspaceRootOf(crate.dir);
            const shared = ws && ws.toml.workspace.dependencies && ws.toml.workspace.dependencies[key];
            if (shared && typeof shared === 'object' && typeof shared.path === 'string') {
              const target = crates.get(join(ws.dir, shared.path) || '\u0000');
              if (target) out.set(key.replace(/-/g, '_'), target);
            }
            continue;
          }
          if (spec && typeof spec === 'object' && typeof spec.path === 'string') {
            const target = crates.get(join(crate.dir, spec.path) || '\u0000');
            if (target) out.set(key.replace(/-/g, '_'), target);
          }
        }
      };
      const t = crate.toml;
      take(t.dependencies);
      take(t['dev-dependencies']);
      take(t['build-dependencies']);
      if (t.target && typeof t.target === 'object') {
        for (const cfg of Object.values(t.target)) {
          if (cfg && typeof cfg === 'object') {
            take(cfg.dependencies);
            take(cfg['dev-dependencies']);
            take(cfg['build-dependencies']);
          }
        }
      }
      localDepsCache.set(crate.dir, out);
      return out;
    };

    /* module trees */
    const modInfo = new Map(); // file -> { root, parent, childDir }
    const children = new Map(); // file -> Map(name -> file)
    const childDirOf = (file, isRoot) => {
      const b = basename(file);
      if (isRoot || b === 'mod.rs') return dirname(file);
      return join(dirname(file), b.slice(0, -3));
    };
    const orderedCrates = [...crates.values()].sort((a, b) => a.dir.length - b.dir.length);
    const allRoots = [];
    for (const crate of orderedCrates) for (const r of crate.roots) allRoots.push(r);
    // A file that is not listed anywhere but is named like a crate root still starts a tree.
    for (const p of rsFiles) if ((basename(p) === 'lib.rs' || basename(p) === 'main.rs') && !allRoots.includes(p)) allRoots.push(p);
    const rootSet = new Set(allRoots);
    for (const root of allRoots) {
      if (modInfo.has(root)) continue;
      modInfo.set(root, { root, parent: null, childDir: childDirOf(root, true) });
      const queue = [root];
      while (queue.length) {
        const file = queue.shift();
        const info = modInfo.get(file);
        const kids = new Map();
        children.set(file, kids);
        for (const mod of parsed.get(file).mods) {
          let target = null;
          if (mod.path) {
            target = join(dirname(file), mod.path);
          } else {
            const base = [info.childDir, ...mod.inline].filter((x) => x !== '').join('/');
            const a = (base ? base + '/' : '') + mod.name + '.rs';
            const b = (base ? base + '/' : '') + mod.name + '/mod.rs';
            target = rsFiles.has(a) ? a : rsFiles.has(b) ? b : null;
          }
          const shown = 'mod ' + mod.name;
          if (target === null || !rsFiles.has(target)) {
            const base = [info.childDir, ...mod.inline].filter((x) => x !== '').join('/');
            const guess = (base ? base + '/' : '') + mod.name;
            const unread = ctx.unread(target) || ctx.unread(guess + '.rs') || ctx.unread(guess + '/mod.rs');
            ctx.count('Rust', unread ? 'ignored' : 'unresolved', file, shown);
            continue;
          }
          ctx.count('Rust', 'internal', file, shown);
          ctx.edge(file, target, 'mod');
          if (mod.inline.length === 0) kids.set(mod.name, target);
          if (!modInfo.has(target) && !rootSet.has(target)) {
            modInfo.set(target, { root, parent: file, childDir: childDirOf(target, false) });
            queue.push(target);
          }
        }
      }
    }

    const walkDown = (start, segs) => {
      let file = start;
      for (const seg of segs) {
        const kids = children.get(file);
        const next = kids && kids.get(seg);
        if (!next) break;
        file = next;
      }
      return file;
    };

    for (const path of rsFiles) {
      const info = modInfo.get(path);
      const crate = crateOf(path);
      const deps = crate ? localDeps(crate) : new Map();
      const ownKids = children.get(path) || new Map();
      const rootKids = info ? children.get(info.root) || new Map() : new Map();
      const seenTargets = new Set();
      for (const item of parsed.get(path).paths) {
        const segs = item.segs.filter((s) => s !== '*');
        if (segs.length === 0) continue;
        const shown = (item.use ? 'use ' : '') + item.segs.join('::');
        const head = segs[0];
        let start = null;
        let rest = segs.slice(1);
        if (head === 'crate') {
          if (!info) {
            ctx.count('Rust', 'unresolved', path, shown);
            continue;
          }
          start = info.root;
        } else if (head === 'self' || head === 'super') {
          let supers = 0;
          let k = 0;
          if (head === 'self') k = 1;
          while (segs[k] === 'super') {
            supers++;
            k++;
          }
          rest = segs.slice(k);
          let up = supers - item.depth;
          if (item.depth > 0 && up <= 0) continue; // stays inside this file's inline modules
          if (item.depth > 0 && head === 'self') continue;
          if (!info) {
            if (supers > 0) ctx.count('Rust', 'unresolved', path, shown);
            continue;
          }
          start = path;
          let failed = false;
          for (; up > 0; up--) {
            const parent = modInfo.get(start) && modInfo.get(start).parent;
            if (!parent) {
              failed = true;
              break;
            }
            start = parent;
          }
          if (failed) {
            ctx.count('Rust', 'unresolved', path, shown);
            continue;
          }
        } else if (deps.has(head)) {
          const target = deps.get(head);
          if (!target.libRoot) {
            ctx.count('Rust', 'unresolved', path, shown);
            continue;
          }
          start = target.libRoot;
        } else if (crate && crate.libRoot && head === crate.libName && info && info.root !== crate.libRoot) {
          // a binary, example, test or bench of a package using that package's own library by name
          start = crate.libRoot;
        } else if (item.depth === 0 && ownKids.has(head)) {
          start = path;
          rest = segs;
        } else if (item.use && info && path !== info.root && rootKids.has(head) && rsFiles.has(rootKids.get(head))) {
          // 2015-edition style: `use foo::bar` from anywhere means crate::foo::bar
          start = info.root;
          rest = segs;
        } else {
          if (item.use) ctx.count('Rust', 'external', path, shown);
          continue;
        }
        // In `use a::b`, b may be a module. In an expression or a type (`a::b(x)`, `a::B`), the last name is always
        // an item inside the module before it, even when a module of the same name exists (`fn search` next to
        // `mod search`), so it is not followed.
        const walk = rest.filter((s) => s !== 'self');
        const target = walkDown(start, item.use ? walk : walk.slice(0, -1));
        ctx.count('Rust', 'internal', path, shown);
        if (target !== path && !seenTargets.has(target)) {
          seenTargets.add(target);
          ctx.edge(path, target, 'import');
        }
      }
    }
  }

  /* ------------------------------------------------------------------ C / C++ */

  function analyzeC(ctx) {
    const cFiles = new Set();
    for (const [path, info] of ctx.sources) if (info.lang === 'C/C++') cFiles.add(path);
    if (cFiles.size === 0) return;
    const bySuffix = new Map(); // "dir/name.h" suffixes -> [paths]; built lazily per basename
    const byBase = new Map();
    for (const p of cFiles) {
      const b = basename(p);
      if (!byBase.has(b)) byBase.set(b, []);
      byBase.get(b).push(p);
    }
    for (const path of cFiles) {
      const text = Lex.blank(ctx.files.get(path), { keepStrings: true, cppRaw: true });
      const re = /^[ \t]*#[ \t]*(?:include|import)[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/gm;
      let m;
      while ((m = re.exec(text))) {
        if (m[2] !== undefined) {
          // <x.h> is searched on the include path only. A project's own headers are written that way when the build
          // passes -I. or -Iinclude, so those two places are tried; anything else is a system or library header.
          const spec = m[2].trim().replace(/\\/g, '/');
          let hit = null;
          for (const base of ['', 'include', 'src']) {
            const p = join(base, spec);
            if (p !== null && cFiles.has(p)) {
              hit = p;
              break;
            }
          }
          if (hit) {
            ctx.count('C/C++', 'internal', path, '<' + spec + '>');
            if (hit !== path) ctx.edge(path, hit, 'include');
          } else {
            ctx.count('C/C++', 'external', path, '<' + spec + '>');
          }
          continue;
        }
        const spec = m[1].trim().replace(/\\/g, '/');
        let hit = null;
        const rel = join(dirname(path), spec);
        if (rel !== null && cFiles.has(rel)) hit = rel;
        if (!hit) {
          const fromRoot = join('', spec);
          if (fromRoot !== null && cFiles.has(fromRoot)) hit = fromRoot;
        }
        let ambiguous = false;
        if (!hit) {
          const clean = spec.split('/').filter((s) => s !== '.' && s !== '..').join('/');
          const key = clean;
          if (!bySuffix.has(key)) {
            const list = (byBase.get(basename(clean)) || []).filter((p) => p === clean || p.endsWith('/' + clean));
            bySuffix.set(key, list);
          }
          const list = bySuffix.get(key);
          if (list.length === 1) hit = list[0];
          else if (list.length > 1) ambiguous = true;
        }
        if (hit) {
          ctx.count('C/C++', 'internal', path, spec);
          if (hit !== path) ctx.edge(path, hit, 'include');
        } else if (ambiguous) {
          ctx.count('C/C++', 'unresolved', path, spec + ' (several files match)');
        } else if (ctx.unread(rel) || ctx.unread(join('', spec))) {
          ctx.count('C/C++', 'ignored', path, spec);
        } else {
          ctx.count('C/C++', 'external', path, spec);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ driver */

  /* files: Map(path -> text) of everything that was read (sources, manifests, configs).
     allPaths: every path in the repository, read or not (used only for existence checks).
     hints: { pythonDependencies: Set of normalised distribution names the repository's manifests ask for }.
     Returns { sources: Map(path -> { lang, test, pkg?, xtest? }), edges: [{ from, to, kind }], stats, notes }.
     `xtest` marks a Go file of an external test package (package x_test).
     An edge target is a file path, or a directory id ending in "/" when the import names a whole package. */
  function analyze(files, allPaths, hints) {
    const sources = new Map();
    for (const path of files.keys()) {
      const lang = languageOf(path);
      if (lang) sources.set(path, { lang, test: isTestFile(path, lang) });
    }
    const all = new Set(allPaths || []);
    for (const p of files.keys()) all.add(p);
    const stats = {};
    const edgeMap = new Map();
    const ctx = {
      files,
      sources,
      allPaths: all,
      hints: hints || {},
      stats,
      notes: [],
      /* true when the path is in the repository but was not read (ignored folder, minified, or too large) */
      unread(path) {
        return path !== null && all.has(path) && !files.has(path);
      },
      count(lang, outcome, from, spec) {
        const s = stats[lang];
        s.found++;
        s[outcome]++;
        if (outcome === 'unresolved' && s.samples.length < MAX_SAMPLES) s.samples.push({ from, spec });
      },
      edge(from, to, kind) {
        if (from === to) return;
        const key = from + '\u0000' + to;
        const prev = edgeMap.get(key);
        if (!prev) edgeMap.set(key, { from, to, kind });
        else if (prev.kind === 'type' && kind !== 'type') prev.kind = kind;
      },
    };
    for (const info of sources.values()) {
      if (!stats[info.lang]) stats[info.lang] = { files: 0, testFiles: 0, found: 0, internal: 0, external: 0, unresolved: 0, ignored: 0, asset: 0, samePackage: 0, samples: [] };
      stats[info.lang].files++;
      if (info.test) stats[info.lang].testFiles++;
    }
    for (const [path, text] of files) {
      if (text.indexOf('\r') >= 0) files.set(path, text.replace(/\r\n?/g, '\n'));
    }
    const steps = [analyzeGo, analyzeJs, analyzePython, analyzeJvm, analyzeRust, analyzeC];
    for (const step of steps) {
      try {
        step(ctx);
      } catch (e) {
        ctx.notes.push('One language scanner stopped early: ' + (e && e.message ? e.message : String(e)));
      }
    }
    return { sources, edges: [...edgeMap.values()], stats, notes: ctx.notes };
  }

  const api = {
    analyze, languageOf, isTestFile, goParse, goModulePath, pyImports, jvmParse, rustParse, expandUseTree, globToRegex,
    LANG_BY_EXT, PACKAGE_UNIT, JVM_LANGS,
  };
  globalThis.RepoDagImports = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
