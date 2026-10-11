/* RepoDAG viewer page: loads a repository (GitHub archive, local zip or folder), runs the scanners, and draws the
   chosen graph as SVG. All DOM is built with createElement / createElementNS and textContent. */
(function () {
  'use strict';

  const Zip = globalThis.RepoDagZip;
  const Scan = globalThis.RepoDagScan;
  const Views = globalThis.RepoDagViews;
  const Graph = globalThis.RepoDagGraph;
  const Export = globalThis.RepoDagExport;
  const Url = globalThis.RepoDagUrl;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
  const DRAW_LIMIT = 600; // above this a view must be grouped, or drawn on request
  const HARD_LIMIT = 2500; // above this it is never drawn
  const NODE_HEIGHT = 26;
  const LABEL_MAX = 38;
  const PALETTE = 6;

  const $ = (id) => document.getElementById(id);

  /* createElement with attributes and children. Strings become text nodes. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === false || value === null || value === undefined) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function s(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /* SVG elements have no `hidden` property, only the attribute, so always go through the attribute. */
  const hide = (el, hidden) => el.toggleAttribute('hidden', !!hidden);

  const plural = (n, one, many) => n.toLocaleString('en') + ' ' + (n === 1 ? one : many || one + 's');
  const megabytes = (bytes) => (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

  const state = {
    mode: 'local', // 'github' | 'local'
    owner: '',
    repo: '',
    ref: 'HEAD',
    label: '', // what was loaded, for messages and file names
    abort: null,
    scan: null,
    load: null, // { inRepo, scanned, skipped: { folder, minified, size } }
    tab: 'code',
    options: {
      code: { level: 'files', depth: 2, includeTests: false, groupBy: 'folder' },
      packages: { includeDev: true, includeIndirect: false },
    },
    force: false,
    view: null,
    cycles: [],
    cycleKeys: new Set(),
    layout: null,
    drawn: null, // { nodeEl, edgeEl, out, inn, byId, columns, colourOf }
    lit: [], // elements currently carrying .on / .sel
    selected: null,
    activeCycle: -1,
    tabbable: null,
    transform: { k: 1, x: 0, y: 0 },
    hits: [],
    hitIndex: -1,
    autoView: false, // true while the view is the one RepoDAG chose, so a window resize may choose again
  };

  /* ------------------------------------------------------------------ messages */

  function showMessage(parts, options) {
    const box = $('message');
    box.replaceChildren(...parts.filter(Boolean));
    box.className = 'message' + (options && options.drop ? ' drop' : '');
    hide(box, false);
    hide($('graph'), true);
    hide($('zoom'), true);
  }

  function hideMessage() {
    hide($('message'), true);
    hide($('graph'), false);
    hide($('zoom'), false);
  }

  function showLanding(note) {
    setChrome(false);
    showMessage(
      [
        h('h2', { text: 'Open a repository to map it' }),
        note ? h('p', { class: 'error', text: note }) : null,
        h('p', { text: 'Drop a .zip or a folder of a project here, or choose one below. Nothing is uploaded: the files are read in this tab.' }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'primary', id: 'landing-zip', onclick: () => $('zip-input').click() }, 'Choose a zip file'),
          h('button', { type: 'button', id: 'landing-folder', onclick: () => $('folder-input').click() }, 'Choose a folder')
        ),
        h('p', { text: 'To map a repository on GitHub, open its page and click the RepoDAG toolbar icon.' }),
      ],
      { drop: true }
    );
  }

  function showProgress(title, detail) {
    const bar = h('progress', { id: 'progress-bar' });
    const line = h('p', { id: 'progress-text', role: 'status', 'aria-live': 'polite', text: detail || '' });
    showMessage([
      h('h2', { text: title }),
      bar,
      line,
      h('div', { class: 'row' }, h('button', { type: 'button', id: 'cancel', onclick: cancelLoad }, 'Cancel')),
    ]);
    return {
      set(text, done, total) {
        line.textContent = text;
        if (typeof done === 'number' && typeof total === 'number' && total > 0) {
          bar.max = total;
          bar.value = done;
        } else {
          bar.removeAttribute('value');
        }
      },
    };
  }

  function showError(title, what, todo, actions) {
    setChrome(false);
    showMessage([
      h('h2', { text: title }),
      h('p', { class: 'error', id: 'error-text', text: what }),
      todo ? h('p', { text: todo }) : null,
      h('div', { class: 'row' }, actions || []),
    ]);
  }

  function setChrome(loaded) {
    hide($('strip'), !loaded);
    hide($('rail'), !loaded);
    hide($('panel'), !loaded);
    $('work').classList.toggle('solo', !loaded);
  }

  function cancelLoad() {
    if (state.abort) state.abort.abort();
  }

  /* ------------------------------------------------------------------ loading */

  class Cancelled extends Error {}

  function beginLoad() {
    if (state.abort) state.abort.abort();
    state.abort = new AbortController();
    state.scan = null;
    state.view = null;
    clearDrawing();
    return state.abort.signal;
  }

  const retryButton = () => h('button', { type: 'button', class: 'primary', onclick: () => loadGitHub(state.owner, state.repo, state.ref) }, 'Try again');
  const localButtons = () => [
    h('button', { type: 'button', onclick: () => $('zip-input').click() }, 'Open a zip'),
    h('button', { type: 'button', onclick: () => $('folder-input').click() }, 'Open a folder'),
  ];

  async function loadGitHub(owner, repo, ref) {
    const signal = beginLoad();
    state.mode = 'github';
    state.owner = owner;
    state.repo = repo;
    state.ref = ref;
    state.label = owner + '/' + repo;
    document.title = state.label + ' — RepoDAG';
    const link = $('repo-link');
    link.textContent = state.label;
    link.href = 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    $('ref').value = ref;
    hide($('source-form'), false);
    hide($('source-local'), true);
    setChrome(false);
    const where = state.label + ' at ' + ref;
    const progress = showProgress('Downloading ' + where, 'Asking GitHub for the archive');
    let bytes;
    try {
      let res;
      try {
        // no-store: a branch moves, and a "not found" from before signing in must not be answered from the cache
        res = await fetch(Url.archiveUrl(owner, repo, ref), { credentials: 'include', redirect: 'follow', cache: 'no-store', signal });
      } catch (e) {
        if (signal.aborted) throw new Cancelled();
        showError('GitHub could not be reached', 'The download of ' + where + ' did not start.', 'Check your connection, then try again.', [retryButton(), ...localButtons()]);
        return;
      }
      if (!res.ok) {
        if (res.status === 404) {
          showError(
            'Not found',
            where + ' was not found, or you are not signed in to an account that can see it.',
            'Check the repository name and the branch, tag or commit. For a private repository, sign in to GitHub in this browser, then try again.',
            [retryButton(), ...localButtons()]
          );
        } else if (res.status === 401 || res.status === 403) {
          showError('GitHub refused the download', 'GitHub answered ' + res.status + ' for ' + where + '.', 'Sign in to GitHub in this browser, or wait a few minutes if you have made many requests, then try again.', [retryButton(), ...localButtons()]);
        } else if (res.status === 429) {
          showError('Too many requests', 'GitHub is rate-limiting downloads from this browser.', 'Wait a few minutes, then try again.', [retryButton()]);
        } else {
          showError('The download failed', 'GitHub answered ' + res.status + ' for ' + where + '.', 'Try again in a moment. If it keeps failing, download the zip from the repository page and open it here.', [retryButton(), ...localButtons()]);
        }
        return;
      }
      const declared = Number(res.headers.get('content-length')) || 0;
      if (declared > MAX_ARCHIVE_BYTES) {
        if (res.body) res.body.cancel().catch(() => {}); // stop the transfer; none of it is wanted
        tooLarge(megabytes(declared));
        return;
      }
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => {});
          tooLarge('more than ' + megabytes(MAX_ARCHIVE_BYTES));
          return;
        }
        chunks.push(value);
        progress.set(megabytes(received) + (declared ? ' of ' + megabytes(declared) : '') + ' downloaded', declared ? received : undefined, declared || undefined);
      }
      bytes = new Uint8Array(received);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
    } catch (e) {
      if (e instanceof Cancelled || signal.aborted) {
        showError('Download cancelled', 'Nothing was loaded.', '', [retryButton(), ...localButtons()]);
        return;
      }
      showError('The download was interrupted', 'The connection to GitHub dropped while downloading ' + where + '.', 'Try again.', [retryButton(), ...localButtons()]);
      return;
    }
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      showError('GitHub did not send an archive', 'The response for ' + where + ' is not a zip file.', 'Sign in to GitHub in this browser if the repository is private, then try again.', [retryButton(), ...localButtons()]);
      return;
    }
    await loadZipBytes(bytes, signal);
  }

  function tooLarge(size) {
    showError(
      'This archive is too large',
      'The archive is ' + size + '. RepoDAG reads archives up to ' + megabytes(MAX_ARCHIVE_BYTES) + ' so the tab does not run out of memory.',
      'Clone the repository and open only the folder you care about with "Open a folder".',
      localButtons()
    );
  }

  /* Runs `task` over `items` with a few in flight at once. */
  async function pooled(items, limit, task) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        await task(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  async function loadZipBytes(bytes, signal) {
    const progress = showProgress('Reading ' + state.label, 'Opening the archive');
    await nextFrame();
    let zip;
    try {
      zip = Zip.open(bytes);
    } catch (e) {
      showError('This zip could not be read', e && e.message ? e.message : String(e), 'If the file came from a browser download, download it again. Otherwise unpack it and use "Open a folder".', localButtons());
      return;
    }
    const prefix = Zip.commonTopFolder(zip.entries.map((e) => e.name));
    const allPaths = [];
    const wanted = [];
    const skipped = { folder: 0, minified: 0, size: 0 };
    for (const entry of zip.entries) {
      if (entry.isDirectory) continue;
      const path = entry.name.slice(prefix.length);
      if (!path) continue;
      allPaths.push(path);
      const w = Scan.wants(path, entry.size);
      if (w.skipped) skipped[w.skipped]++;
      if (w.read) wanted.push({ entry, path });
    }
    const files = new Map();
    const failed = [];
    let done = 0;
    const decoder = new TextDecoder('utf-8');
    try {
      await pooled(wanted, 12, async ({ entry, path }) => {
        if (signal.aborted) throw new Cancelled();
        try {
          files.set(path, decoder.decode(await Zip.read(zip, entry)));
        } catch (e) {
          failed.push(path + ': ' + (e && e.message ? e.message : e));
        }
        done++;
        if (done % 40 === 0 || done === wanted.length) {
          progress.set('Read ' + done.toLocaleString('en') + ' of ' + plural(wanted.length, 'file'), done, wanted.length);
          await nextFrame();
        }
      });
    } catch (e) {
      if (e instanceof Cancelled) {
        showLanding('Loading was cancelled.');
        return;
      }
      throw e;
    }
    // keep the Map in archive order so results do not depend on which file finished unpacking first
    const ordered = new Map();
    for (const { path } of wanted) if (files.has(path)) ordered.set(path, files.get(path));
    await analyse(ordered, allPaths, skipped, failed, progress);
  }

  async function loadZipFile(file) {
    const signal = beginLoad();
    enterLocal(file.name);
    if (file.size > MAX_ARCHIVE_BYTES) {
      tooLarge(megabytes(file.size));
      return;
    }
    showProgress('Reading ' + file.name, 'Loading the file');
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      showError('This file could not be read', 'The browser could not open ' + file.name + '.', 'Check that the file still exists and try again.', localButtons());
      return;
    }
    await loadZipBytes(new Uint8Array(buffer), signal);
  }

  /* entries: [{ path, file }] with paths relative to the chosen folder */
  async function loadFileEntries(entries, name) {
    const signal = beginLoad();
    enterLocal(name);
    const progress = showProgress('Reading ' + name, 'Listing files');
    await nextFrame();
    const allPaths = [];
    const wanted = [];
    const skipped = { folder: 0, minified: 0, size: 0 };
    for (const { path, file } of entries) {
      if (!path || path.split('/').includes('.git')) continue;
      allPaths.push(path);
      const w = Scan.wants(path, file.size);
      if (w.skipped) skipped[w.skipped]++;
      if (w.read) wanted.push({ path, file });
    }
    const files = new Map();
    const failed = [];
    let done = 0;
    try {
      await pooled(wanted, 8, async ({ path, file }) => {
        if (signal.aborted) throw new Cancelled();
        try {
          files.set(path, await file.text());
        } catch (e) {
          failed.push(path + ': could not be read');
        }
        done++;
        if (done % 40 === 0 || done === wanted.length) {
          progress.set('Read ' + done.toLocaleString('en') + ' of ' + plural(wanted.length, 'file'), done, wanted.length);
          await nextFrame();
        }
      });
    } catch (e) {
      if (e instanceof Cancelled) {
        showLanding('Loading was cancelled.');
        return;
      }
      throw e;
    }
    const ordered = new Map();
    for (const { path } of wanted.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) if (files.has(path)) ordered.set(path, files.get(path));
    await analyse(ordered, allPaths, skipped, failed, progress);
  }

  function enterLocal(name) {
    state.mode = 'local';
    state.owner = '';
    state.repo = '';
    state.label = name;
    document.title = name + ' — RepoDAG';
    hide($('source-form'), true);
    const local = $('source-local');
    local.textContent = name;
    hide(local, false);
    setChrome(false);
  }

  /* Files picked with <input webkitdirectory>: strip the folder's own name from each path. */
  function fromDirectoryInput(fileList) {
    const entries = [];
    let top = '';
    for (const file of fileList) {
      const rel = file.webkitRelativePath || file.name;
      const slash = rel.indexOf('/');
      if (!top && slash > 0) top = rel.slice(0, slash);
      entries.push({ path: slash > 0 ? rel.slice(slash + 1) : rel, file });
    }
    return { entries, name: top || 'folder' };
  }

  /* A dropped folder: walk it, never entering folders the scanners ignore anyway. */
  async function fromDroppedDirectory(root) {
    const entries = [];
    const readAll = (reader) =>
      new Promise((resolve, reject) => {
        const all = [];
        const more = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), more()) : resolve(all)), reject);
        more();
      });
    const walk = async (dir, rel) => {
      for (const child of await readAll(dir.createReader())) {
        const path = rel ? rel + '/' + child.name : child.name;
        if (child.isDirectory) {
          if (child.name === '.git' || Scan.SKIP_DIRS.has(child.name)) continue;
          await walk(child, path);
        } else if (child.isFile) {
          const file = await new Promise((resolve, reject) => child.file(resolve, reject));
          entries.push({ path, file });
        }
      }
    };
    await walk(root, '');
    return { entries, name: root.name };
  }

  async function analyse(files, allPaths, skipped, failed, progress) {
    progress.set('Working out the dependencies of ' + plural(files.size, 'file'));
    await nextFrame();
    let scan;
    try {
      scan = Scan.scan(files, { allPaths });
    } catch (e) {
      showError('The scan stopped', e && e.message ? e.message : String(e), 'This is a bug in RepoDAG. Opening a smaller folder may work in the meantime.', localButtons());
      return;
    }
    state.scan = scan;
    state.load = { inRepo: allPaths.length, scanned: files.size, skipped, failed };
    const suggestion = Views.suggestLevel(scan.code, false, 150);
    state.options.code = { level: suggestion.level, depth: suggestion.depth, includeTests: false, groupBy: 'folder' };
    state.options.packages = { includeDev: true, includeIndirect: false };
    state.force = false;
    const hasCode = scan.code.sources.size > 0;
    const hasCi = scan.ci.jobs.length > 0;
    const hasPackages = scan.packages.manifests.length > 0;
    state.tab = hasCode ? 'code' : hasCi ? 'ci' : hasPackages ? 'packages' : 'code';
    setChrome(true);
    updateTabCounts();
    render();
  }

  /* ------------------------------------------------------------------ views */

  function buildView() {
    const scan = state.scan;
    if (state.tab === 'ci') return Views.ciView(scan.ci);
    if (state.tab === 'packages') return Views.packagesView(scan.packages, state.options.packages);
    return Views.codeView(scan.code, state.options.code);
  }

  function updateTabCounts() {
    const scan = state.scan;
    const counts = { code: scan.code.sources.size, ci: scan.ci.jobs.length, packages: scan.packages.manifests.length };
    const units = { code: ['file', 'files'], ci: ['job', 'jobs'], packages: ['manifest', 'manifests'] };
    for (const tab of ['code', 'ci', 'packages']) {
      const button = $('tab-' + tab);
      let badge = button.querySelector('.count');
      if (!badge) {
        badge = h('span', { class: 'count' });
        button.appendChild(badge);
      }
      badge.textContent = counts[tab].toLocaleString('en');
      badge.title = plural(counts[tab], units[tab][0], units[tab][1]);
    }
  }

  function syncControls() {
    for (const tab of ['code', 'ci', 'packages']) {
      const button = $('tab-' + tab);
      const on = state.tab === tab;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
    $('stage').setAttribute('aria-labelledby', 'tab-' + state.tab);
    // job names are prose, so that tab uses the interface font where the others use monospace for paths
    document.body.classList.toggle('prose', state.tab === 'ci');
    hide($('level-section'), state.tab !== 'code');
    hide($('packages-section'), state.tab !== 'packages');
    const c = state.options.code;
    const s = Views.suggestLevel(state.scan.code, c.includeTests, 150);
    for (const radio of document.querySelectorAll('input[name="level"]')) radio.checked = radio.value === c.level;
    $('level-files-label').textContent = 'Files (' + s.files.toLocaleString('en') + ')';
    $('level-packages-label').textContent = 'Packages (' + s.packages.toLocaleString('en') + ')';
    const depth = $('depth');
    depth.max = String(Math.max(1, s.maxDepth));
    depth.value = String(Math.min(c.depth, Math.max(1, s.maxDepth)));
    $('depth-out').textContent = depth.value;
    $('include-tests').checked = c.includeTests;
    $('group-by').value = c.groupBy;
    $('include-dev').checked = state.options.packages.includeDev;
    $('include-indirect').checked = state.options.packages.includeIndirect;
    const meaning = {
      code: 'An arrow points from a file to what it imports. Every node sits to the left of the things it depends on.',
      ci: 'An arrow points from a job to the jobs that wait for it. Jobs on the left run first.',
      packages: 'An arrow points from a manifest to a package it asks for directly.',
    };
    $('arrow-meaning').textContent = meaning[state.tab];
    $('legend-edge').textContent = state.tab === 'ci' ? 'runs before' : state.tab === 'packages' ? 'asks for' : 'imports';
  }

  function render() {
    syncControls();
    clearFocusState();
    $('search').value = '';
    $('search-count').textContent = '';
    $('export-status').textContent = '';
    state.hits = [];
    const view = buildView();
    state.view = view;
    const ids = view.nodes.map((n) => n.id);
    state.cycles = Graph.findCycles(ids, view.edges);
    state.cycleKeys = Export.cycleEdgeKeys(view, state.cycles);
    renderSummary();
    renderLegend();
    renderCycles();
    renderNotes();
    showDetail(null);
    if (view.nodes.length === 0) {
      clearDrawing();
      showEmpty();
      return;
    }
    if (view.nodes.length > DRAW_LIMIT && !state.force) {
      clearDrawing();
      showTooMany();
      return;
    }
    hideMessage();
    draw();
    firstView();
  }

  /* Nothing is drawn for this view: forget the previous drawing so no stale nodes stay behind the message. */
  function clearDrawing() {
    state.drawn = null;
    state.layout = null;
    state.tabbable = null;
    for (const id of ['bands', 'edges', 'nodes']) $(id).replaceChildren();
  }

  function showEmpty() {
    const scan = state.scan;
    if (state.tab === 'ci') {
      const broken = scan.ci.workflows.filter((w) => w.error).length;
      showMessage([
        h('h2', { text: scan.ci.workflows.length ? 'No jobs could be read' : 'No GitHub Actions workflows here' }),
        h('p', { text: scan.ci.workflows.length ? plural(broken, 'workflow file') + ' could not be parsed. The reasons are listed on the right.' : 'Workflows live in .github/workflows/ as .yml or .yaml files. This repository has none.' }),
      ]);
    } else if (state.tab === 'packages') {
      showMessage([
        h('h2', { text: 'No dependency manifests here' }),
        h('p', { text: 'RepoDAG reads go.mod, package.json, requirements*.txt, pyproject.toml, Cargo.toml, pom.xml, build.gradle, build.gradle.kts and build.sbt. None were found outside the ignored folders.' }),
      ]);
    } else {
      const anySource = scan.code.sources.size > 0;
      showMessage([
        h('h2', { text: anySource ? 'Only test files were found' : 'No source files in a supported language' }),
        h('p', {
          text: anySource
            ? 'Tick "Include tests" on the left to draw them.'
            : 'RepoDAG reads Go, JavaScript, TypeScript, Python, Java, Kotlin, Scala, Rust, C and C++. ' + plural(state.load.inRepo, 'file') + ' were listed and none matched.',
        }),
      ]);
    }
  }

  function showTooMany() {
    const n = state.view.nodes.length;
    const actions = [];
    if (state.tab === 'code') {
      const c = state.options.code;
      const sug = Views.suggestLevel(state.scan.code, c.includeTests, DRAW_LIMIT);
      if (c.level !== 'packages' && sug.packages <= DRAW_LIMIT) {
        actions.push(h('button', { type: 'button', class: 'primary', onclick: () => setCode({ level: 'packages' }) }, 'Show packages (' + sug.packages.toLocaleString('en') + ')'));
      }
      const depth = c.level === 'folders' ? Math.max(1, c.depth - 1) : sug.level === 'folders' ? sug.depth : Math.min(2, sug.maxDepth);
      actions.push(h('button', { type: 'button', class: actions.length ? '' : 'primary', onclick: () => setCode({ level: 'folders', depth }) }, 'Show folders, ' + depth + ' deep'));
    } else if (state.tab === 'packages' && state.options.packages.includeDev) {
      actions.push(h('button', { type: 'button', class: 'primary', onclick: () => setPackages({ includeDev: false }) }, 'Hide development and test dependencies'));
    }
    if (n <= HARD_LIMIT) {
      actions.push(h('button', { type: 'button', onclick: () => { state.force = true; render(); } }, 'Draw all ' + n.toLocaleString('en') + ' anyway'));
    }
    showMessage([
      h('h2', { text: n.toLocaleString('en') + ' nodes is too many to read' }),
      h('p', { text: 'Above ' + DRAW_LIMIT + ' nodes the drawing turns into a grey block and gets slow to move.' + (state.tab === 'code' ? ' Group the files to see the structure.' : '') + (n > HARD_LIMIT ? ' This view is not drawn at all above ' + HARD_LIMIT.toLocaleString('en') + ' nodes.' : '') }),
      h('div', { class: 'row' }, actions),
      h('p', { text: 'The exports on the left still contain the whole view.' }),
    ]);
  }

  function setCode(patch) {
    Object.assign(state.options.code, patch);
    state.force = false;
    render();
  }

  function setPackages(patch) {
    Object.assign(state.options.packages, patch);
    state.force = false;
    render();
  }

  /* ------------------------------------------------------------------ summary, legend, cycles, notes */

  function renderSummary() {
    const view = state.view;
    const load = state.load;
    const skipped = load.skipped.folder + load.skipped.minified + load.skipped.size;
    const item = (value, label, cls, title) => h('div', { class: cls || null, title: title || null }, h('dt', { text: label }), h('dd', { text: value }));
    const langs = state.scan.languages.map((l) => l.lang + ' ' + l.files.toLocaleString('en')).join(', ');
    $('summary').replaceChildren(
      item(view.nodes.length.toLocaleString('en'), view.nodes.length === 1 ? 'node' : 'nodes'),
      item(view.edges.length.toLocaleString('en'), view.edges.length === 1 ? 'edge' : 'edges'),
      item(state.cycles.length.toLocaleString('en'), state.cycles.length === 1 ? 'cycle' : 'cycles', state.cycles.length ? 'warn' : null),
      item(load.scanned.toLocaleString('en'), 'files scanned', null, 'Files that were read, out of ' + load.inRepo.toLocaleString('en') + ' in the repository'),
      item(skipped.toLocaleString('en'), 'skipped', null, load.skipped.folder + ' in ignored folders, ' + load.skipped.minified + ' minified, ' + load.skipped.size + ' over 1 MB'),
      langs ? item(langs, 'files by language') : null
    );
  }

  function colourIndex() {
    const map = new Map();
    state.view.groups.forEach((g, i) => map.set(g.key, i < PALETTE ? i : -1));
    return map;
  }

  function renderLegend() {
    const groups = state.view.groups;
    const items = [];
    const paths = state.tab === 'code' && state.options.code.groupBy === 'folder';
    groups.slice(0, PALETTE).forEach((g, i) => {
      items.push(h('li', null, h('span', { class: 'swatch c' + i }), h('span', { class: 'name' + (paths ? ' path' : ''), text: g.key, title: g.key }), h('span', { class: 'n', text: g.count.toLocaleString('en') })));
    });
    if (groups.length > PALETTE) {
      const rest = groups.slice(PALETTE);
      const total = rest.reduce((sum, g) => sum + g.count, 0);
      items.push(h('li', { title: rest.map((g) => g.key).join(', ') }, h('span', { class: 'swatch cx' }), h('span', { class: 'name', text: plural(rest.length, 'other group') }), h('span', { class: 'n', text: total.toLocaleString('en') })));
    }
    $('legend').replaceChildren(...items);
    hide($('legend-dev'), state.tab !== 'packages');
    hide($('legend-tests'), !(state.tab === 'code' && state.view.nodes.some((n) => n.testPackage)));
  }

  function renderCycles() {
    const list = $('cycles');
    const cycles = state.cycles;
    const kindOf = new Map(state.view.nodes.map((n) => [n.id, n.kind]));
    const nounFor = (ids) => {
      if (state.tab === 'ci') return 'jobs';
      if (state.tab === 'packages') return 'manifests';
      if (ids.every((id) => kindOf.get(id) === 'folder')) return 'folders';
      if (ids.every((id) => kindOf.get(id) === 'file')) return 'files';
      return 'files and folders';
    };
    const noun = nounFor(state.view.nodes.map((n) => n.id));
    if (cycles.length === 0) {
      $('cycles-empty').textContent = state.view.nodes.length ? 'None. Nothing in this view depends on itself.' : '';
      list.replaceChildren();
      return;
    }
    $('cycles-empty').textContent = 'Groups of ' + noun + ' that depend on each other in a loop. Choose one to see it.';
    const labelOf = new Map(state.view.nodes.map((n) => [n.id, n.label]));
    list.replaceChildren(
      ...cycles.slice(0, 200).map((c, i) =>
        h('li', null,
          h('button', { type: 'button', 'aria-pressed': 'false', 'data-cycle': i, onclick: () => toggleCycle(i) },
            h('span', { class: 'size', text: c.nodes.length + ' ' + nounFor(c.nodes) }),
            h('span', { class: 'members', text: c.nodes.map((id) => labelOf.get(id) || id).join(', ') })
          )
        )
      )
    );
  }

  function renderNotes() {
    const scan = state.scan;
    const load = state.load;
    const box = $('notes');
    const parts = [h('h2', { text: 'What was read' })];
    const skippedTotal = load.skipped.folder + load.skipped.minified + load.skipped.size;
    parts.push(
      h('p', {
        text:
          plural(load.scanned, 'file') + ' read out of ' + load.inRepo.toLocaleString('en') + ' in the repository. ' +
          (skippedTotal
            ? plural(skippedTotal, 'file') + ' of a kind RepoDAG reads were skipped: ' + load.skipped.folder + ' in ignored folders (node_modules, vendor, dist, build, target, out, third_party, testdata and similar), ' + load.skipped.minified + ' minified, ' + load.skipped.size + ' over 1 MB.'
            : 'Nothing of a kind RepoDAG reads was skipped.'),
      })
    );
    const stats = scan.code.stats;
    const langs = Object.keys(stats).sort((a, b) => stats[b].files - stats[a].files);
    if (langs.length) {
      const head = h('tr', null, ...[['Language', ''], ['Files', ''], ['Imports', 'Import statements found'], ['Inside', 'Resolved to a file or package in this repository'], ['Outside', 'Standard library, third-party packages and assets'], ['Not found', 'Unresolved: looks internal, but no matching file']].map(([t, tip]) => h('th', { scope: 'col', text: t, title: tip || null })));
      const rows = langs.map((lang) => {
        const st = stats[lang];
        return h('tr', null,
          h('td', { text: lang }),
          h('td', { text: st.files.toLocaleString('en') }),
          h('td', { text: st.found.toLocaleString('en') }),
          h('td', { text: st.internal.toLocaleString('en') }),
          h('td', { text: (st.external + st.asset).toLocaleString('en') }),
          h('td', { class: st.unresolved ? 'bad' : null, text: st.unresolved.toLocaleString('en') })
        );
      });
      parts.push(h('h3', { text: 'Imports by language' }), h('table', { class: 'stats', id: 'stats' }, h('thead', null, head), h('tbody', null, ...rows)));
      parts.push(h('p', { class: 'hint', text: '"Unresolved" imports look like they point inside the repository, but no matching file was found (generated code, an alias RepoDAG does not know, or a parsing gap). They are not drawn.' }));
      const ignored = langs.reduce((sum, l) => sum + stats[l].ignored, 0);
      if (ignored) parts.push(h('p', { class: 'hint', text: plural(ignored, 'import') + ' point into ignored folders and are not drawn.' }));
      const samePackage = langs.reduce((sum, l) => sum + stats[l].samePackage, 0);
      if (samePackage) parts.push(h('p', { class: 'hint', text: plural(samePackage, 'link') + ' between Java, Kotlin or Scala files in the same package were inferred from type names, because those need no import.' }));
      const samples = [];
      for (const lang of langs) for (const smp of stats[lang].samples) samples.push(smp);
      if (samples.length) {
        parts.push(
          h('details', { id: 'unresolved' },
            h('summary', { text: 'Unresolved imports (' + (samples.length >= 200 ? 'first ' : '') + samples.length + ')' }),
            h('ul', { class: 'plain mono' }, ...samples.slice(0, 200).map((smp) => h('li', { text: smp.from + '  →  ' + smp.spec })))
          )
        );
      }
    }
    const notes = [...scan.code.notes, ...scan.ci.notes, ...scan.packages.notes, ...load.failed.map((f) => 'Not read: ' + f)];
    const present = new Set(langs);
    if (present.has('Java') || present.has('Kotlin') || present.has('Scala')) notes.push('Java, Kotlin and Scala: uses of a fully qualified name without an import are not seen.');
    if (present.has('Rust')) notes.push('Rust: modules of one crate may refer to each other freely, so cycles between files of the same crate are normal.');
    if (present.has('JavaScript') || present.has('TypeScript')) notes.push('JavaScript and TypeScript: aliases set up in bundler configuration (Vite, webpack) are not read; tsconfig paths are.');
    if (present.has('C/C++')) notes.push('C and C++: #include <...> is followed only when it names a file by its path from the repository root, include/ or src/. Other angle-bracket includes count as system headers.');
    if (present.has('Python')) notes.push('Python: imports built at run time (importlib, __import__) are not seen.');
    if (notes.length) parts.push(h('h3', { text: 'Notes' }), h('ul', { class: 'plain', id: 'scan-notes' }, ...notes.slice(0, 80).map((n) => h('li', { text: n }))));
    box.replaceChildren(...parts);
  }

  /* ------------------------------------------------------------------ drawing */

  let measureContext = null;
  function textWidth(text, font) {
    if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
    measureContext.font = font;
    return measureContext.measureText(text).width;
  }

  /* Paths keep their tail (the file name matters most); job names keep their start. */
  function shorten(label, keepStart) {
    if (label.length <= LABEL_MAX) return label;
    return keepStart ? label.slice(0, LABEL_MAX - 1) + '…' : '…' + label.slice(label.length - LABEL_MAX + 1);
  }

  function draw() {
    const view = state.view;
    const rootStyle = getComputedStyle(document.documentElement);
    const mono = rootStyle.getPropertyValue('--mono').trim() || 'monospace';
    // job names are prose; file paths and package names are set in monospace
    const prose = state.tab === 'ci';
    const labelFont = '11.5px ' + (prose ? rootStyle.getPropertyValue('--ui').trim() || 'sans-serif' : mono);
    const badgeFont = '10.5px ' + mono;
    const colours = colourIndex();
    const sized = view.nodes.map((n) => {
      const text = shorten(n.label, n.kind === 'job');
      let badge = '';
      if (n.kind === 'folder' && n.fileCount > 0) badge = String(n.fileCount);
      else if (n.kind === 'dep' && n.versions.length === 1) badge = n.versions[0].length > 16 ? n.versions[0].slice(0, 15) + '…' : n.versions[0];
      else if (n.kind === 'dep' && n.versions.length > 1) badge = n.versions.length + ' versions';
      const labelWidth = textWidth(text, (n.kind === 'manifest' ? '700 ' : '') + labelFont);
      const badgeWidth = badge ? textWidth(badge, badgeFont) + 10 : 0;
      const width = Math.ceil(14 + labelWidth + badgeWidth + (n.kind === 'dep' ? 14 : 10));
      return { id: n.id, width, height: NODE_HEIGHT, text, badge };
    });
    const layout = Graph.layout(sized, view.edges, { nodeHeight: NODE_HEIGHT });
    state.layout = layout;

    const svg = $('graph');
    const bands = $('bands');
    const edgesG = $('edges');
    const nodesG = $('nodes');
    const frag = { bands: document.createDocumentFragment(), edges: document.createDocumentFragment(), nodes: document.createDocumentFragment() };

    // one lane per column, with its depth written at the top; edges bend in the gutters between lanes
    const bottom = layout.isolatedTop !== null ? layout.isolatedTop - 34 : layout.height + 14;
    layout.layers.forEach((layer, i) => {
      frag.bands.appendChild(s('rect', { class: 'band', x: layer.x - 12, y: -34, width: layer.width + 24, height: bottom + 34, rx: 6 }));
      const t = s('text', { class: 'depth', x: layer.x + layer.width / 2, y: -17 }, String(i));
      t.appendChild(s('title', null, 'Column ' + i + ': ' + plural(layer.count, 'node')));
      frag.bands.appendChild(t);
    });
    if (layout.isolatedCount) {
      frag.bands.appendChild(s('text', { class: 'loose-title', x: 0, y: layout.isolatedTop - 12 }, 'Not connected to anything in this view (' + layout.isolatedCount.toLocaleString('en') + ')'));
    }

    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const out = new Map();
    const inn = new Map();
    for (const n of view.nodes) {
      out.set(n.id, []);
      inn.set(n.id, []);
    }
    const edgeEl = new Array(view.edges.length).fill(null);
    const onTop = document.createDocumentFragment();
    const verb = state.tab === 'ci' ? ' runs before ' : state.tab === 'packages' ? ' asks for ' : ' imports ';
    view.edges.forEach((e, i) => {
      const route = layout.edges[i];
      if (!route) return;
      out.get(e.from).push(i);
      inn.get(e.to).push(i);
      const pts = route.points;
      if (route.reversed) {
        // keep a turned-around edge apart from a normal edge between the same two nodes
        pts[0] = [pts[0][0], pts[0][1] + 7];
        pts[pts.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1] + 7];
      }
      const weight = e.count >= 10 ? ' w4' : e.count >= 4 ? ' w3' : e.count >= 2 ? ' w2' : '';
      const path = s('path', { class: 'edge' + (route.reversed ? ' cycle' : '') + (e.dev ? ' dev' : '') + weight, d: Graph.edgePath(pts) });
      const fromLabel = byId.get(e.from).label;
      const toLabel = byId.get(e.to).label;
      let title = fromLabel + verb + toLabel;
      if (e.count > 1) title += ' (' + e.count + ' imports)';
      if (e.label) title += ' (' + e.label + ')';
      if (e.dev) title += ', for development, build or tests only';
      if (route.reversed) title += '. This edge closes a cycle, so it is drawn against the flow.';
      path.appendChild(s('title', null, title));
      edgeEl[i] = path;
      (route.reversed ? onTop : frag.edges).appendChild(path);
    });
    frag.edges.appendChild(onTop); // the red dashed edges are drawn last, so nothing covers them

    const nodeEl = new Map();
    const columns = new Map();
    sized.forEach((sz, i) => {
      const n = view.nodes[i];
      const p = layout.nodes.get(n.id);
      const depends = out.get(n.id).length;
      const used = inn.get(n.id).length;
      // a package that nothing asks for outside development and tests
      const devOnly = n.kind === 'dep' && used > 0 && inn.get(n.id).every((k) => view.edges[k].dev);
      const g = s('g', { class: 'node ' + n.kind + (devOnly ? ' devonly' : '') + (n.testPackage ? ' tests' : ''), transform: 'translate(' + p.x + ',' + p.y + ')', tabindex: '-1', role: 'button', 'data-id': n.id });
      g.setAttribute('aria-label', n.title + '. ' + (state.tab === 'ci' ? 'Runs before ' + depends + ', waits for ' + used : 'Depends on ' + depends + ', used by ' + used) + '.');
      const radius = n.kind === 'dep' ? NODE_HEIGHT / 2 : 3;
      g.appendChild(s('rect', { class: 'ring', x: -4, y: -4, width: p.width + 8, height: p.height + 8, rx: radius + 3 }));
      g.appendChild(s('rect', { class: 'box', x: 0, y: 0, width: p.width, height: p.height, rx: radius }));
      const ci = colours.get(n.group);
      if (n.kind === 'dep') g.appendChild(s('circle', { class: 'tab ' + (ci >= 0 ? 'c' + ci : 'cx'), cx: 10, cy: p.height / 2, r: 3.5 }));
      else g.appendChild(s('rect', { class: 'tab ' + (ci >= 0 ? 'c' + ci : 'cx'), x: 1.5, y: 1.5, width: 5, height: p.height - 3, rx: 1.5 }));
      g.appendChild(s('text', { class: 'label', x: n.kind === 'dep' ? 19 : 13, y: p.height / 2 }, sz.text));
      if (sz.badge) g.appendChild(s('text', { class: 'badge', x: p.width - (n.kind === 'dep' ? 10 : 7), y: p.height / 2 }, sz.badge));
      g.appendChild(s('title', null, n.title + (n.kind === 'folder' && n.fileCount ? ' — ' + plural(n.fileCount, 'file') : '') + (n.kind === 'dep' && n.versions.length ? ' — ' + n.versions.join(', ') : '') + (devOnly ? ' — development, build or tests only' : '')));
      nodeEl.set(n.id, g);
      frag.nodes.appendChild(g);
      if (!columns.has(p.layer)) columns.set(p.layer, []);
      columns.get(p.layer).push(n.id);
    });
    for (const [layer, list] of columns) {
      list.sort((a, b) => {
        const pa = layout.nodes.get(a);
        const pb = layout.nodes.get(b);
        return layer === -1 ? pa.y - pb.y || pa.x - pb.x : pa.y - pb.y;
      });
    }

    bands.replaceChildren(frag.bands);
    edgesG.replaceChildren(frag.edges);
    nodesG.replaceChildren(frag.nodes);
    svg.setAttribute('aria-label', (state.tab === 'ci' ? 'CI pipeline' : state.tab === 'packages' ? 'Third-party packages' : 'Code imports') + ' graph, ' + plural(view.nodes.length, 'node') + ', ' + plural(view.edges.length, 'edge'));
    state.drawn = { nodeEl, edgeEl, out, inn, byId, columns };
    state.lit = [];
    state.tabbable = null;
    const first = (columns.get(0) || columns.get(-1) || [])[0];
    if (first) setTabbable(first);
  }

  function setTabbable(id) {
    const d = state.drawn;
    if (state.tabbable && d.nodeEl.get(state.tabbable)) d.nodeEl.get(state.tabbable).setAttribute('tabindex', '-1');
    state.tabbable = id;
    d.nodeEl.get(id).setAttribute('tabindex', '0');
  }

  /* ------------------------------------------------------------------ pan and zoom */

  function applyTransform(byUser) {
    if (byUser !== false) state.autoView = false;
    const t = state.transform;
    $('viewport').setAttribute('transform', 'translate(' + t.x.toFixed(2) + ',' + t.y.toFixed(2) + ') scale(' + t.k.toFixed(4) + ')');
  }

  function fitBox(x0, y0, x1, y1, maxScale) {
    const svg = $('graph');
    const w = svg.clientWidth || 800;
    const hgt = svg.clientHeight || 600;
    const pad = 36;
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    const k = Math.max(0.02, Math.min((w - pad * 2) / bw, (hgt - pad * 2) / bh, maxScale));
    state.transform = { k, x: (w - bw * k) / 2 - x0 * k, y: (hgt - bh * k) / 2 - y0 * k };
    applyTransform(false);
  }

  function fit() {
    if (!state.layout) return;
    fitBox(-12, -34, state.layout.width + 12, state.layout.height + 14, 1.25);
  }

  /* The opening view: the whole graph when its labels stay legible, otherwise the left end at a readable size.
     "Fit" always shows everything. */
  function firstView() {
    fit();
    state.autoView = true;
    const READABLE = 0.72; // 11.5 px labels stay above 8 px
    const note = $('zoom-note');
    if (state.transform.k >= READABLE) {
      hide(note, true);
      return;
    }
    const svg = $('graph');
    const hgt = svg.clientHeight || 600;
    const L = state.layout;
    const tall = (L.height + 48) * READABLE;
    state.transform = { k: READABLE, x: 30, y: tall + 40 <= hgt ? (hgt - tall) / 2 + 34 * READABLE : 34 * READABLE + 24 };
    applyTransform(false);
    hide(note, false);
  }

  function zoomAt(cx, cy, factor) {
    const t = state.transform;
    const k = Math.max(0.02, Math.min(6, t.k * factor));
    const f = k / t.k;
    state.transform = { k, x: cx - (cx - t.x) * f, y: cy - (cy - t.y) * f };
    applyTransform();
  }

  function zoomCentre(factor) {
    const svg = $('graph');
    zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, factor);
  }

  /* Pans just enough to bring a node into view. */
  function reveal(id) {
    const p = state.layout.nodes.get(id);
    if (!p) return;
    const svg = $('graph');
    const t = state.transform;
    const w = svg.clientWidth;
    const hgt = svg.clientHeight;
    const left = p.x * t.k + t.x;
    const top = p.y * t.k + t.y;
    const right = left + p.width * t.k;
    const bottom = top + p.height * t.k;
    const margin = 40;
    let dx = 0;
    let dy = 0;
    if (left < margin) dx = margin - left;
    else if (right > w - margin) dx = w - margin - right;
    if (top < margin) dy = margin - top;
    else if (bottom > hgt - margin) dy = hgt - margin - bottom;
    if (dx || dy) {
      state.transform = { k: t.k, x: t.x + dx, y: t.y + dy };
      applyTransform();
    }
  }

  function wirePanZoom() {
    const svg = $('graph');
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const node = e.target.closest ? e.target.closest('.node') : null;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: state.transform.x, ty: state.transform.y, moved: false, node: node ? node.getAttribute('data-id') : null };
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        svg.classList.add('dragging');
        try {
          svg.setPointerCapture(e.pointerId);
        } catch (_) {
          /* the pointer is already gone */
        }
      }
      state.transform = { k: state.transform.k, x: drag.tx + dx, y: drag.ty + dy };
      applyTransform();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      svg.classList.remove('dragging');
      if (d.moved || e.type === 'pointercancel') return;
      if (d.node) {
        select(d.node);
        const el = state.drawn && state.drawn.nodeEl.get(d.node);
        if (el) el.focus({ preventScroll: true });
      } else {
        clearFocus();
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const unit = e.deltaMode === 1 ? 16 : 1;
        if (e.shiftKey && !e.ctrlKey) {
          // Shift + wheel slides sideways, which is the direction these graphs are long in
          state.transform = { k: state.transform.k, x: state.transform.x - (e.deltaY || e.deltaX) * unit, y: state.transform.y };
          applyTransform();
          return;
        }
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016)));
      },
      { passive: false }
    );
    $('zoom-in').addEventListener('click', () => zoomCentre(1.3));
    $('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.3));
    $('zoom-fit').addEventListener('click', () => {
      fit();
      hide($('zoom-note'), true);
    });

    svg.addEventListener('keydown', (e) => {
      const node = e.target.closest ? e.target.closest('.node') : null;
      if (e.key === '+' || e.key === '=') {
        zoomCentre(1.3);
      } else if (e.key === '-' || e.key === '_') {
        zoomCentre(1 / 1.3);
      } else if (e.key === '0') {
        fit();
      } else if (e.key === 'Escape') {
        clearFocus();
      } else if (node && (e.key === 'Enter' || e.key === ' ')) {
        select(node.getAttribute('data-id'));
      } else if (node && e.key.startsWith('Arrow')) {
        moveFocus(node.getAttribute('data-id'), e.key);
      } else {
        return;
      }
      e.preventDefault();
    });
    svg.addEventListener('focusin', (e) => {
      const node = e.target.closest ? e.target.closest('.node') : null;
      if (node && state.drawn) {
        setTabbable(node.getAttribute('data-id'));
        reveal(node.getAttribute('data-id'));
      }
    });
  }

  /* Arrow keys: up and down within a column, left and right to the nearest node in the next column. */
  function moveFocus(id, key) {
    const d = state.drawn;
    const p = state.layout.nodes.get(id);
    if (!d || !p) return;
    const column = d.columns.get(p.layer) || [];
    const at = column.indexOf(id);
    let target = null;
    if (key === 'ArrowDown') target = column[at + 1];
    else if (key === 'ArrowUp') target = column[at - 1];
    else if (p.layer >= 0) {
      const step = key === 'ArrowRight' ? 1 : -1;
      for (let layer = p.layer + step; layer >= 0 && layer < state.layout.layers.length && !target; layer += step) {
        const other = d.columns.get(layer);
        if (!other || !other.length) continue;
        let best = Infinity;
        for (const cand of other) {
          const q = state.layout.nodes.get(cand);
          const dist = Math.abs(q.y - p.y);
          if (dist < best) {
            best = dist;
            target = cand;
          }
        }
      }
    }
    if (target) d.nodeEl.get(target).focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ selection and highlighting */

  function clearFocusState() {
    for (const el of state.lit) el.classList.remove('on', 'sel');
    state.lit = [];
    state.selected = null;
    state.activeCycle = -1;
    $('graph').classList.remove('has-focus');
    for (const b of document.querySelectorAll('#cycles button[aria-pressed="true"]')) b.setAttribute('aria-pressed', 'false');
  }

  function clearFocus() {
    clearFocusState();
    showDetail(null);
  }

  function light(el, cls) {
    if (!el) return;
    el.classList.add(cls || 'on');
    state.lit.push(el);
  }

  function select(id) {
    const d = state.drawn;
    if (!d || !d.nodeEl.has(id)) return;
    if (state.selected === id) {
      clearFocus();
      return;
    }
    clearFocusState();
    state.selected = id;
    const el = d.nodeEl.get(id);
    light(el, 'on');
    light(el, 'sel');
    for (const i of d.out.get(id)) {
      light(d.edgeEl[i]);
      light(d.nodeEl.get(state.view.edges[i].to));
    }
    for (const i of d.inn.get(id)) {
      light(d.edgeEl[i]);
      light(d.nodeEl.get(state.view.edges[i].from));
    }
    $('graph').classList.add('has-focus');
    setTabbable(id);
    showDetail({ node: d.byId.get(id) });
  }

  function toggleCycle(index) {
    const d = state.drawn;
    if (state.activeCycle === index) {
      clearFocus();
      return;
    }
    clearFocusState();
    const cycle = state.cycles[index];
    state.activeCycle = index;
    const button = document.querySelector('#cycles button[data-cycle="' + index + '"]');
    if (button) button.setAttribute('aria-pressed', 'true');
    showDetail({ cycle });
    if (!d) return;
    const members = new Set(cycle.nodes);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of cycle.nodes) {
      light(d.nodeEl.get(id));
      const p = state.layout.nodes.get(id);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.width);
      y1 = Math.max(y1, p.y + p.height);
    }
    state.view.edges.forEach((e, i) => {
      if (members.has(e.from) && members.has(e.to)) light(d.edgeEl[i]);
    });
    $('graph').classList.add('has-focus');
    fitBox(x0 - 30, y0 - 30, x1 + 30, y1 + 30, 1.25);
  }

  /* ------------------------------------------------------------------ details panel */

  function jumpButton(id, extra) {
    const node = state.drawn ? state.drawn.byId.get(id) : null;
    const label = node ? node.label : id;
    return h('li', null,
      h('button', { type: 'button', title: node ? node.title : id, onclick: () => goTo(id) }, label),
      extra ? h('span', { class: 'extra', text: extra }) : null
    );
  }

  function goTo(id) {
    const d = state.drawn;
    if (!d || !d.nodeEl.has(id)) return;
    if (state.selected !== id) select(id);
    reveal(id);
    d.nodeEl.get(id).focus({ preventScroll: true });
  }

  function edgeExtra(e) {
    const bits = [];
    if (e.label) bits.push(e.label);
    if (e.count > 1) bits.push('×' + e.count);
    if (e.kind === 'dev') bits.push('dev');
    else if (e.kind === 'build') bits.push('build');
    else if (e.kind === 'peer') bits.push('peer');
    else if (e.kind === 'optional') bits.push('optional');
    else if (e.kind === 'indirect') bits.push('indirect');
    else if (e.kind === 'calls') bits.push('calls');
    else if (e.kind === 'workflow_run') bits.push('workflow_run');
    if (e.local) bits.push('in this repo');
    if (e.typeOnly) bits.push('types only');
    if (state.cycleKeys.has(Export.edgeKey(e))) bits.push('in a cycle');
    return bits.join(', ');
  }

  function neighbourList(title, indexes, pick) {
    if (!indexes.length) return [h('h3', { text: title + ' (0)' }), h('p', { class: 'hint', text: 'Nothing in this view.' })];
    const sorted = indexes.slice().sort((a, b) => {
      const la = state.drawn.byId.get(pick(state.view.edges[a])).label;
      const lb = state.drawn.byId.get(pick(state.view.edges[b])).label;
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    const shown = sorted.slice(0, 300);
    const parts = [h('h3', { text: title + ' (' + indexes.length + ')' }), h('ul', { class: 'links' }, ...shown.map((i) => jumpButton(pick(state.view.edges[i]), edgeExtra(state.view.edges[i]))))];
    if (sorted.length > shown.length) parts.push(h('p', { class: 'hint', text: 'Showing the first ' + shown.length + '. The JSON export has all of them.' }));
    return parts;
  }

  function githubLink(path, text) {
    if (state.mode !== 'github') return null;
    return h('p', null, h('a', { href: Url.sourceUrl(state.owner, state.repo, state.ref, path), target: '_blank', rel: 'noopener noreferrer', text: text || 'Open on GitHub' }));
  }

  function showDetail(what) {
    const box = $('detail');
    if (!what) {
      hide(box, true);
      box.replaceChildren();
      return;
    }
    const parts = [h('button', { type: 'button', class: 'close', onclick: clearFocus }, 'Close')];
    if (what.cycle) {
      const c = what.cycle;
      const labelOf = (id) => (state.view.nodes.find((n) => n.id === id) || { label: id }).label;
      parts.push(
        h('h2', { class: 'title', text: 'Cycle of ' + c.nodes.length }),
        h('p', { class: 'kind', text: plural(c.edgeCount, 'edge') + ' inside the loop. Breaking any edge on a loop removes that loop; the red dashed edges are the ones RepoDAG turned around to draw it.' }),
        h('h3', { text: 'One loop through it' }),
        h('p', { class: 'path', id: 'cycle-example', text: c.example.map(labelOf).join('  →  ') }),
        h('h3', { text: 'Members (' + c.nodes.length + ')' }),
        h('ul', { class: 'links' }, ...c.nodes.slice(0, 300).map((id) => jumpButton(id)))
      );
      box.replaceChildren(...parts);
      hide(box, false);
      return;
    }
    const n = what.node;
    const d = state.drawn;
    const outIdx = d.out.get(n.id);
    const inIdx = d.inn.get(n.id);
    const facts = [];
    const fact = (k, v) => {
      if (v !== null && v !== undefined && v !== '') facts.push(h('dt', { text: k }), h('dd', { text: String(v) }));
    };
    if (state.tab === 'ci') {
      const job = n.job;
      parts.push(h('h2', { class: 'title', id: 'detail-title', text: job.name }), h('p', { class: 'kind', text: 'Job "' + job.key + '" in ' + job.workflow }));
      parts.push(githubLink(job.workflow, 'Open the workflow on GitHub'));
      fact('Workflow', n.group);
      fact('Runs on', job.runsOn || (job.calls ? 'set by the called workflow' : 'not stated'));
      fact('Calls', job.calls);
      fact('Only if', job.condition);
      fact('Environment', job.environment);
      fact('Matrix', job.matrix ? 'yes, runs once per combination' : '');
      parts.push(h('dl', { class: 'facts' }, ...facts));
      if (job.steps.length) parts.push(h('h3', { text: 'Steps (' + job.steps.length + ')' }), h('ol', { class: 'plain', id: 'steps' }, ...job.steps.map((st) => h('li', { text: st.label }))));
      if (job.uses.length) parts.push(h('h3', { text: 'Actions used (' + job.uses.length + ')' }), h('ul', { class: 'plain mono', id: 'uses' }, ...job.uses.map((u) => h('li', { text: u }))));
      parts.push(...neighbourList('Waits for', inIdx, (e) => e.from), ...neighbourList('Runs before', outIdx, (e) => e.to));
    } else if (state.tab === 'packages') {
      parts.push(h('h2', { class: 'title', id: 'detail-title', text: n.kind === 'manifest' ? n.path : n.name }));
      if (n.kind === 'manifest') {
        parts.push(h('p', { class: 'kind', text: n.group + ' manifest' + (n.name ? ' for ' + n.name : '') }), githubLink(n.path));
        parts.push(...neighbourList('Asks for', outIdx, (e) => e.to), ...neighbourList('Used by', inIdx, (e) => e.from));
      } else {
        parts.push(h('p', { class: 'kind', text: n.group + ' package' }));
        fact('Versions asked for', n.versions.length ? n.versions.join(', ') : 'not stated');
        parts.push(h('dl', { class: 'facts' }, ...facts));
        parts.push(...neighbourList('Asked for by', inIdx, (e) => e.from));
      }
    } else {
      if (n.testPackage) {
        // a Go external test package: named after its package clause, linked to the folder its files are in
        const where = n.dir === './' ? 'the top level folder' : n.dir;
        parts.push(h('h2', { class: 'title', id: 'detail-title', text: n.label }));
        parts.push(
          h('p', {
            class: 'kind',
            text: n.merged
              ? 'External test packages of ' + plural(n.packages.length, 'Go package') + ' under ' + where + ' (' + n.packages.join(', ') + '), ' + plural(n.fileCount, 'file')
              : 'Go external test package in ' + where + ', ' + plural(n.fileCount, 'file'),
          }),
          h('p', { class: 'hint', text: 'Test files that say "package ' + (n.merged ? 'x' : n.packages[0].replace(/_test$/, '')) + '_test" form a package of their own. It may import the package it tests, and nothing can import it, so it is drawn apart and is never part of a cycle.' }),
          githubLink(n.dir, 'Open the folder on GitHub')
        );
      } else {
        parts.push(h('h2', { class: 'title', id: 'detail-title', text: n.id === './' ? '(top level of the repository)' : n.id }));
        const kind = n.kind === 'folder' ? 'Folder with ' + plural(n.fileCount, 'file') + (n.languages.length ? ', ' + n.languages.join(' and ') : '') : n.lang + ' file';
        parts.push(h('p', { class: 'kind', text: kind }), githubLink(n.id));
      }
      fact('Group', n.group);
      parts.push(h('dl', { class: 'facts' }, ...facts));
      parts.push(...neighbourList('Depends on', outIdx, (e) => e.to), ...neighbourList('Used by', inIdx, (e) => e.from));
      if (n.kind === 'folder' && n.files.length) {
        parts.push(
          h('details', { open: n.files.length <= 12 },
            h('summary', { text: 'Files in this node (' + n.files.length + ')' }),
            h('ul', { class: 'plain mono' }, ...n.files.slice(0, 400).map((f) => h('li', { text: f })))
          )
        );
      }
    }
    box.replaceChildren(...parts.filter(Boolean));
    hide(box, false);
    $('panel').scrollTop = 0;
  }

  /* ------------------------------------------------------------------ search */

  let searchTimer = 0;
  function runSearch() {
    const d = state.drawn;
    const q = $('search').value.trim().toLowerCase();
    const svg = $('graph');
    state.hits = [];
    state.hitIndex = -1;
    if (!d) {
      $('search-count').textContent = q ? 'Nothing is drawn to search in.' : '';
      return;
    }
    for (const [id, el] of d.nodeEl) {
      const n = d.byId.get(id);
      const hit = q !== '' && (id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q) || (n.name || '').toLowerCase().includes(q));
      el.classList.toggle('hit', hit);
      if (hit) state.hits.push(id);
    }
    svg.classList.toggle('has-search', q !== '');
    if (q === '') $('search-count').textContent = '';
    else if (state.hits.length === 0) $('search-count').textContent = 'No node matches "' + $('search').value.trim() + '".';
    else $('search-count').textContent = state.hits.length.toLocaleString('en') + ' of ' + d.nodeEl.size.toLocaleString('en') + ' match. Press Enter to step through them.';
    state.hits.sort((a, b) => {
      const pa = state.layout.nodes.get(a);
      const pb = state.layout.nodes.get(b);
      return pa.x - pb.x || pa.y - pb.y;
    });
  }

  function nextHit() {
    if (!state.hits.length) return;
    state.hitIndex = (state.hitIndex + 1) % state.hits.length;
    const id = state.hits[state.hitIndex];
    const p = state.layout.nodes.get(id);
    const svg = $('graph');
    const k = Math.max(state.transform.k, 0.8);
    state.transform = { k, x: svg.clientWidth / 2 - (p.x + p.width / 2) * k, y: svg.clientHeight / 2 - (p.y + p.height / 2) * k };
    applyTransform();
    if (state.selected !== id) select(id);
    $('search-count').textContent = 'Match ' + (state.hitIndex + 1) + ' of ' + state.hits.length + ': ' + state.drawn.byId.get(id).label;
  }

  /* ------------------------------------------------------------------ exports */

  function fileStem() {
    const base = (state.mode === 'github' ? state.owner + '-' + state.repo : state.label.replace(/\.zip$/i, '')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repodag';
    return base + '-' + state.tab;
  }

  function exportText(kind) {
    const view = state.view;
    if (kind === 'mermaid') return Export.toMermaid(view, state.cycleKeys);
    if (kind === 'dot') return Export.toDot(view, state.cycleKeys, state.label);
    if (kind === 'json') {
      const meta = { source: state.mode === 'github' ? 'https://github.com/' + state.owner + '/' + state.repo : state.label, view: state.tab };
      if (state.mode === 'github') meta.ref = state.ref;
      if (state.tab === 'code') meta.options = Object.assign({}, state.options.code);
      if (state.tab === 'packages') meta.options = Object.assign({}, state.options.packages);
      return Export.toJson(view, meta, state.cycles);
    }
    return standaloneSvg();
  }

  /* A copy of the drawing that stands on its own: whole graph in view, colours written out, no page styles needed. */
  function standaloneSvg() {
    const L = state.layout;
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    const pad = 24;
    const x0 = -pad - 12;
    const y0 = -pad - 34;
    const width = Math.ceil(L.width + 24 + pad * 2);
    const height = Math.ceil(L.height + 48 + pad * 2);
    const svg = s('svg', { xmlns: SVG_NS, width, height, viewBox: x0 + ' ' + y0 + ' ' + width + ' ' + height });
    svg.appendChild(s('title', null, 'RepoDAG: ' + state.label + ' (' + state.tab + ')'));
    const labelFamily = state.tab === 'ci' ? 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif' : 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    const rules = [
      'text{font-family:' + labelFamily + ';font-size:11.5px;fill:' + v('--ink') + ';dominant-baseline:central}',
      '.depth,.loose-title{font-family:system-ui,sans-serif;font-size:11px;fill:' + v('--soft') + '}.depth{text-anchor:middle}',
      '.band{fill:' + v('--band') + '}',
      '.edge{fill:none;stroke:' + v('--edge') + ';stroke-width:1.1;marker-end:url(#x-head)}',
      '.edge.w2{stroke-width:1.6}.edge.w3{stroke-width:2.2}.edge.w4{stroke-width:3}',
      '.edge.cycle{stroke:' + v('--cycle') + ';stroke-width:1.5;stroke-dasharray:6 4;marker-end:none;marker-start:url(#x-head-cycle)}',
      '.box{fill:' + v('--node') + ';stroke:' + v('--node-line') + ';stroke-width:1}.folder .box{stroke-width:1.6}.manifest .label{font-weight:700}',
      '.ring{display:none}.badge{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;text-anchor:end;fill:' + v('--soft') + '}',
      '.edge.dev{stroke-dasharray:1.5 3.5;stroke-linecap:round}',
      '.tests .box{stroke-dasharray:4 2.5}',
      ...[0, 1, 2, 3, 4, 5].map((i) => '.c' + i + '{fill:' + v('--g' + i) + '}'),
      '.cx{fill:' + v('--g-other') + '}',
      ...[0, 1, 2, 3, 4, 5].map((i) => '.devonly .c' + i + '{fill:' + v('--node') + ';stroke:' + v('--g' + i) + ';stroke-width:1.6}'),
      '.devonly .cx{fill:' + v('--node') + ';stroke:' + v('--g-other') + ';stroke-width:1.6}',
    ];
    svg.appendChild(s('style', null, rules.join('\n')));
    const defs = s('defs');
    const marker = (id, fill) => {
      const m = s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
      m.appendChild(s('path', { d: 'M0,1 L10,5 L0,9 Z', fill }));
      return m;
    };
    defs.appendChild(marker('x-head', v('--soft')));
    defs.appendChild(marker('x-head-cycle', v('--cycle')));
    svg.appendChild(defs);
    svg.appendChild(s('rect', { x: x0, y: y0, width, height, fill: v('--canvas') }));
    for (const id of ['bands', 'edges', 'nodes']) {
      const copy = $(id).cloneNode(true);
      copy.removeAttribute('id');
      for (const el of copy.querySelectorAll('.node')) {
        el.setAttribute('class', el.getAttribute('class').replace(/\b(on|sel|hit)\b/g, '').replace(/\s+/g, ' ').trim());
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
        el.removeAttribute('data-id');
      }
      for (const el of copy.querySelectorAll('.edge')) el.setAttribute('class', el.getAttribute('class').replace(/\bon\b/g, '').replace(/\s+/g, ' ').trim());
      svg.appendChild(copy);
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg) + '\n';
  }

  function runExport(kind, how) {
    const status = $('export-status');
    if (!state.view || state.view.nodes.length === 0) {
      status.textContent = 'There is nothing in this view to export.';
      return;
    }
    if (kind === 'svg' && !state.drawn) {
      status.textContent = 'The SVG is a copy of the drawing, and this view is not drawn. Group it first, or export Mermaid, DOT or JSON.';
      return;
    }
    const names = { svg: 'SVG', mermaid: 'Mermaid', dot: 'DOT', json: 'JSON' };
    const text = exportText(kind);
    // Mermaid stops at 500 edges unless told otherwise; say so now, not when the diagram fails to render
    const edges = state.view.edges.length;
    const caveat = kind === 'mermaid' && edges > 500 ? ' Mermaid draws at most 500 edges by default and this view has ' + edges.toLocaleString('en') + ': group the view, or raise maxEdges where you render it.' : '';
    if (how === 'copy') {
      navigator.clipboard.writeText(text).then(
        () => {
          status.textContent = 'Copied ' + names[kind] + ' (' + text.length.toLocaleString('en') + ' characters).' + caveat;
        },
        () => {
          status.textContent = 'The browser did not allow copying. Use Download instead.';
        }
      );
      return;
    }
    const ext = { svg: 'svg', mermaid: 'mmd', dot: 'dot', json: 'json' }[kind];
    const type = { svg: 'image/svg+xml', mermaid: 'text/plain', dot: 'text/vnd.graphviz', json: 'application/json' }[kind];
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = h('a', { href: url, download: fileStem() + '.' + ext });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    // the page cannot see whether the browser kept the file (Chrome asks before a site saves several in a row)
    status.textContent = 'Download started: ' + fileStem() + '.' + ext + '.' + caveat;
  }

  /* ------------------------------------------------------------------ wiring */

  function wire() {
    wirePanZoom();

    const tabs = ['code', 'ci', 'packages'];
    for (const tab of tabs) {
      $('tab-' + tab).addEventListener('click', () => {
        if (state.tab === tab || !state.scan) return;
        state.tab = tab;
        state.force = false;
        render();
      });
    }
    document.querySelector('.tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(tabs.indexOf(state.tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      $('tab-' + next).click();
      $('tab-' + next).focus();
      e.preventDefault();
    });

    for (const radio of document.querySelectorAll('input[name="level"]')) {
      radio.addEventListener('change', () => {
        if (radio.checked) setCode({ level: radio.value, depth: Number($('depth').value) });
      });
    }
    $('depth').addEventListener('input', () => {
      $('depth-out').textContent = $('depth').value;
    });
    $('depth').addEventListener('change', () => setCode({ level: 'folders', depth: Number($('depth').value) }));
    $('include-tests').addEventListener('change', () => setCode({ includeTests: $('include-tests').checked }));
    $('group-by').addEventListener('change', () => setCode({ groupBy: $('group-by').value }));
    $('include-dev').addEventListener('change', () => setPackages({ includeDev: $('include-dev').checked }));
    $('include-indirect').addEventListener('change', () => setPackages({ includeIndirect: $('include-indirect').checked }));

    $('search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 120);
    });
    $('search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer);
        if (state.hitIndex < 0) runSearch();
        nextHit();
        e.preventDefault();
      }
    });
    $('search-next').addEventListener('click', () => {
      clearTimeout(searchTimer);
      if (state.hitIndex < 0) runSearch();
      nextHit();
    });

    for (const button of document.querySelectorAll('[data-export]')) {
      button.addEventListener('click', () => runExport(button.getAttribute('data-export'), button.getAttribute('data-how')));
    }

    $('source-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const ref = Url.cleanRef($('ref').value);
      if (!ref) {
        showError('That is not a valid branch, tag or commit', 'A ref cannot be empty or contain spaces, "..", "~", "^", ":" or "\\".', 'Correct it in the box at the top and press Load.', []);
        return;
      }
      history.replaceState(null, '', Url.viewerQuery(state.owner, state.repo, ref));
      loadGitHub(state.owner, state.repo, ref);
    });

    $('open-zip').addEventListener('click', () => $('zip-input').click());
    $('open-folder').addEventListener('click', () => $('folder-input').click());
    $('zip-input').addEventListener('change', () => {
      const file = $('zip-input').files[0];
      $('zip-input').value = '';
      if (file) guard(loadZipFile(file));
    });
    $('folder-input').addEventListener('change', () => {
      const picked = fromDirectoryInput($('folder-input').files);
      $('folder-input').value = '';
      if (picked.entries.length) guard(loadFileEntries(picked.entries, picked.name));
    });

    const stage = $('stage');
    const over = (on) => $('message').classList.toggle('over', on);
    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      over(true);
    });
    stage.addEventListener('dragleave', () => over(false));
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      over(false);
      guard(handleDrop(e.dataTransfer));
    });
    window.addEventListener('resize', () => {
      if (state.drawn && state.autoView) firstView();
    });
  }

  async function handleDrop(data) {
    const items = data && data.items ? [...data.items].filter((i) => i.kind === 'file') : [];
    const first = items[0];
    const entry = first && first.webkitGetAsEntry ? first.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      enterLocal(entry.name);
      showProgress('Reading ' + entry.name, 'Listing files');
      const picked = await fromDroppedDirectory(entry);
      await loadFileEntries(picked.entries, picked.name);
      return;
    }
    const file = data && data.files ? data.files[0] : null;
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      showLanding('"' + file.name + '" is not a .zip file. Drop a zip or a folder.');
      return;
    }
    await loadZipFile(file);
  }

  function guard(promise) {
    promise.catch((e) => {
      showError('Something went wrong', e && e.message ? e.message : String(e), 'Try again. If it keeps happening, please report it with the repository you tried.', localButtons());
    });
  }

  function start() {
    wire();
    const params = new URLSearchParams(location.search);
    const slug = Url.parseSlug(params.get('repo'));
    if (slug) {
      const ref = Url.cleanRef(params.get('ref') || 'HEAD') || 'HEAD';
      guard(loadGitHub(slug.owner, slug.repo, ref));
    } else if (params.get('repo')) {
      showLanding('"' + params.get('repo') + '" is not an owner/repository name.');
    } else {
      showLanding('');
    }
  }

  start();
})();
