/* RepoDAG scanner entry point. Decides which files are worth reading, then builds the raw material for the three
   graphs (code imports, CI pipeline, third-party packages) from a Map of path -> text. */
(function () {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const Lex = inNode ? require('./lex.js') : globalThis.RepoDagLex;
  const Imports = inNode ? require('./imports.js') : globalThis.RepoDagImports;
  const Manifests = inNode ? require('./manifests.js') : globalThis.RepoDagManifests;
  const Workflows = inNode ? require('./workflows.js') : globalThis.RepoDagWorkflows;

  const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'out', '.git', '__pycache__', '.venv', 'venv', 'third_party', 'testdata']);
  const MAX_FILE_BYTES = 1024 * 1024;

  /* What a path is to the scanners: 'source', 'manifest', 'workflow', 'config', or null for everything else. */
  function roleOf(path) {
    if (Imports.languageOf(path)) return 'source';
    if (Manifests.manifestKind(path)) return 'manifest';
    if (Workflows.isWorkflowPath(path)) return 'workflow';
    const b = Lex.basename(path);
    if (b === 'pnpm-workspace.yaml' || b === 'settings.gradle' || b === 'settings.gradle.kts') return 'config';
    if (/^(ts|js)config(\.[\w-]+)?\.json$/.test(b)) return 'config';
    if (b === 'libs.versions.toml' && Lex.basename(Lex.dirname(path)) === 'gradle') return 'config';
    return null;
  }

  function inSkippedDir(path) {
    const segs = path.split('/');
    for (let i = 0; i < segs.length - 1; i++) if (SKIP_DIRS.has(segs[i])) return true;
    return false;
  }

  function isMinified(path) {
    return /[.-]min\.(js|mjs|cjs)$/i.test(path);
  }

  /* Should this file be read? Returns { read, role, skipped } where `skipped` names the reason a file the scanners
     would otherwise use was left out: 'folder', 'minified' or 'size'. Files of no interest have role null. */
  function wants(path, size) {
    const role = roleOf(path);
    if (!role) return { read: false, role: null, skipped: null };
    if (inSkippedDir(path)) return { read: false, role, skipped: 'folder' };
    if (isMinified(path)) return { read: false, role, skipped: 'minified' };
    if (typeof size === 'number' && size > MAX_FILE_BYTES) return { read: false, role, skipped: 'size' };
    return { read: true, role, skipped: null };
  }

  /* files: Map(path -> text). options.allPaths: every file path in the repository (for existence checks only). */
  function scan(files, options) {
    const opts = options || {};
    const packages = Manifests.analyze(files);
    // what the manifests ask for tells the import scanner which look-alike names belong to a dependency
    const pythonDependencies = new Set();
    for (const dep of packages.deps) if (dep.ecosystem === 'PyPI' && !dep.local) pythonDependencies.add(dep.name);
    const code = Imports.analyze(files, opts.allPaths, { pythonDependencies });
    const ci = Workflows.analyze(files);
    const languages = Object.keys(code.stats)
      .map((lang) => ({ lang, files: code.stats[lang].files }))
      .sort((a, b) => b.files - a.files || (a.lang < b.lang ? -1 : 1));
    return { code, ci, packages, languages };
  }

  const api = { scan, wants, roleOf, inSkippedDir, isMinified, SKIP_DIRS, MAX_FILE_BYTES };
  globalThis.RepoDagScan = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
