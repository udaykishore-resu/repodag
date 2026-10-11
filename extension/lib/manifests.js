/* RepoDAG manifest readers: direct third-party dependencies declared in go.mod, package.json, requirements*.txt,
   pyproject.toml, Cargo.toml, pom.xml, build.gradle(.kts) and build.sbt. */
(function () {
  'use strict';

  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const Lex = inNode ? require('./lex.js') : globalThis.RepoDagLex;
  const Toml = inNode ? require('./toml.js') : globalThis.RepoDagToml;
  const { dirname, basename, join } = Lex;

  /* Which reader handles a path, or null. */
  function manifestKind(path) {
    const b = basename(path);
    if (b === 'go.mod') return 'gomod';
    if (b === 'package.json') return 'npm';
    if (b === 'pyproject.toml') return 'pyproject';
    if (b === 'Cargo.toml') return 'cargo';
    if (b === 'pom.xml') return 'pom';
    if (b === 'build.gradle' || b === 'build.gradle.kts') return 'gradle';
    if (b === 'build.sbt') return 'sbt';
    if (/^requirements[\w.-]*\.txt$/i.test(b)) return 'requirements';
    if (/\.txt$/i.test(b) && basename(dirname(path)).toLowerCase() === 'requirements') return 'requirements';
    return null;
  }

  const ECOSYSTEM = { gomod: 'Go', npm: 'npm', pyproject: 'PyPI', requirements: 'PyPI', cargo: 'Cargo', pom: 'Maven', gradle: 'Maven', sbt: 'Maven' };
  const DEV_WORDS = /(^|[^a-z])(dev|develop|development|test|tests|testing|lint|linting|docs?|typing|types|bench|benchmark|ci|check|style|format|coverage|qa)([^a-z]|$)/i;

  /* ---------- go.mod ---------- */

  function parseGoMod(text) {
    const out = { name: null, deps: [], replaces: new Map() };
    let block = null;
    for (const rawLine of text.split('\n')) {
      const commentAt = rawLine.indexOf('//');
      const comment = commentAt >= 0 ? rawLine.slice(commentAt + 2).trim() : '';
      const line = (commentAt >= 0 ? rawLine.slice(0, commentAt) : rawLine).trim();
      if (!line) continue;
      if (block) {
        if (line === ')') {
          block = null;
          continue;
        }
        handle(block, line, comment);
        continue;
      }
      const m = /^(\w+)\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[2] === '(') block = m[1];
      else handle(m[1], m[2], comment);
    }
    function handle(directive, rest, comment) {
      const words = rest.split(/\s+/).map((w) => w.replace(/^["`]|["`]$/g, ''));
      if (directive === 'module') out.name = words[0] || null;
      else if (directive === 'require' && words.length >= 2) {
        out.deps.push({ name: words[0], version: words[1], kind: /(^|\s|;)indirect\b/.test(comment) ? 'indirect' : 'runtime' });
      } else if (directive === 'replace') {
        const arrow = words.indexOf('=>');
        if (arrow > 0 && words[arrow + 1]) out.replaces.set(words[0], words.slice(arrow + 1).join(' '));
      }
    }
    for (const dep of out.deps) {
      if (out.replaces.has(dep.name)) dep.replacedBy = out.replaces.get(dep.name);
    }
    return out;
  }

  /* ---------- package.json ---------- */

  function parsePackageJson(text) {
    const json = JSON.parse(text);
    const out = { name: typeof json.name === 'string' ? json.name : null, deps: [], hasWorkspaces: !!json.workspaces };
    const take = (field, kind) => {
      const table = json[field];
      if (!table || typeof table !== 'object' || Array.isArray(table)) return;
      for (const name of Object.keys(table)) {
        if (typeof table[name] === 'string') out.deps.push({ name, version: table[name], kind });
      }
    };
    take('dependencies', 'runtime');
    take('devDependencies', 'dev');
    take('peerDependencies', 'peer');
    take('optionalDependencies', 'optional');
    return out;
  }

  /* ---------- Python requirement strings ---------- */

  function normalizePyName(name) {
    return name.toLowerCase().replace(/[-_.]+/g, '-');
  }

  /* One PEP 508 requirement ("requests[socks]>=2.0 ; python_version < '3.9'"). Returns { name, version } or null. */
  function parseRequirement(line) {
    let s = line.trim();
    if (!s) return null;
    const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s);
    if (/^(git\+|hg\+|svn\+|bzr\+|https?:|file:)/i.test(s)) {
      return egg ? { name: normalizePyName(egg[1]), version: 'from URL' } : null;
    }
    s = s.split(/\s+#/)[0].trim(); // trailing comment
    const marker = s.indexOf(';');
    if (marker >= 0) s = s.slice(0, marker).trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
    if (!m) return null;
    let version = m[3].trim();
    if (version[0] === '@') return { name: normalizePyName(m[1]), version: 'from URL' };
    if (version && !/^[(<>=!~]/.test(version)) return null;
    version = version.replace(/^\(|\)$/g, '').replace(/\s+/g, '');
    return { name: normalizePyName(m[1]), version };
  }

  function parseRequirementsTxt(text, path) {
    const out = { name: null, deps: [] };
    const hint = basename(path).replace(/^requirements/i, '').replace(/\.txt$/i, '');
    const dev = DEV_WORDS.test(hint);
    const joined = text.replace(/\\\n/g, ' ');
    for (const raw of joined.split('\n')) {
      let line = raw.trim();
      if (!line || line[0] === '#') continue;
      if (line[0] === '-') {
        const e = /^(?:-e|--editable)\s+(.+)$/.exec(line);
        if (!e) continue; // -r, -c, --index-url and other options
        line = e[1];
      }
      line = line.replace(/\s--hash=\S+/g, '');
      const req = parseRequirement(line);
      if (req) out.deps.push({ name: req.name, version: req.version, kind: dev ? 'dev' : 'runtime' });
    }
    return out;
  }

  /* ---------- pyproject.toml ---------- */

  function parsePyproject(text) {
    const toml = Toml.parse(text);
    const out = { name: null, deps: [] };
    const addReq = (str, kind, group) => {
      if (typeof str !== 'string') return;
      const req = parseRequirement(str);
      if (req) out.deps.push({ name: req.name, version: req.version, kind, group });
    };
    const project = toml.project;
    if (project && typeof project === 'object') {
      if (typeof project.name === 'string') out.name = normalizePyName(project.name);
      if (Array.isArray(project.dependencies)) for (const d of project.dependencies) addReq(d, 'runtime');
      const opt = project['optional-dependencies'];
      if (opt && typeof opt === 'object') {
        for (const group of Object.keys(opt)) {
          if (Array.isArray(opt[group])) for (const d of opt[group]) addReq(d, DEV_WORDS.test(group) ? 'dev' : 'optional', group);
        }
      }
    }
    const groups = toml['dependency-groups'];
    if (groups && typeof groups === 'object') {
      for (const group of Object.keys(groups)) {
        if (Array.isArray(groups[group])) for (const d of groups[group]) addReq(d, 'dev', group);
      }
    }
    const build = toml['build-system'];
    if (build && Array.isArray(build.requires)) for (const d of build.requires) addReq(d, 'build');
    const tool = toml.tool && typeof toml.tool === 'object' ? toml.tool : {};
    const poetry = tool.poetry;
    if (poetry && typeof poetry === 'object') {
      if (!out.name && typeof poetry.name === 'string') out.name = normalizePyName(poetry.name);
      const takePoetry = (table, kind, group) => {
        if (!table || typeof table !== 'object') return;
        for (const name of Object.keys(table)) {
          if (name.toLowerCase() === 'python') continue;
          const spec = Array.isArray(table[name]) ? table[name][0] : table[name];
          let version = '';
          let k = kind;
          if (typeof spec === 'string') version = spec;
          else if (spec && typeof spec === 'object') {
            version = typeof spec.version === 'string' ? spec.version : spec.git ? 'git' : spec.path ? 'path' : spec.url ? 'from URL' : '';
            if (spec.optional === true && kind === 'runtime') k = 'optional';
          }
          out.deps.push({ name: normalizePyName(name), version, kind: k, group });
        }
      };
      takePoetry(poetry.dependencies, 'runtime');
      takePoetry(poetry['dev-dependencies'], 'dev', 'dev');
      if (poetry.group && typeof poetry.group === 'object') {
        for (const g of Object.keys(poetry.group)) takePoetry(poetry.group[g] && poetry.group[g].dependencies, 'dev', g);
      }
    }
    if (tool.uv && Array.isArray(tool.uv['dev-dependencies'])) for (const d of tool.uv['dev-dependencies']) addReq(d, 'dev', 'dev');
    if (tool.pdm && tool.pdm['dev-dependencies'] && typeof tool.pdm['dev-dependencies'] === 'object') {
      const pdm = tool.pdm['dev-dependencies'];
      for (const g of Object.keys(pdm)) if (Array.isArray(pdm[g])) for (const d of pdm[g]) addReq(d, 'dev', g);
    }
    return out;
  }

  /* ---------- Cargo.toml ---------- */

  function parseCargo(text) {
    const toml = Toml.parse(text);
    const out = { name: toml.package && typeof toml.package.name === 'string' ? toml.package.name : null, deps: [], workspaceDeps: null };
    const ws = toml.workspace && typeof toml.workspace === 'object' ? toml.workspace : null;
    if (ws && ws.dependencies && typeof ws.dependencies === 'object') out.workspaceDeps = ws.dependencies;
    const take = (table, kind) => {
      if (!table || typeof table !== 'object') return;
      for (const key of Object.keys(table)) {
        const spec = table[key];
        const dep = { name: key, version: '', kind };
        if (typeof spec === 'string') dep.version = spec;
        else if (spec && typeof spec === 'object') {
          if (typeof spec.package === 'string') dep.name = spec.package;
          if (spec.workspace === true) dep.fromWorkspace = key;
          if (typeof spec.path === 'string') dep.path = spec.path;
          dep.version = typeof spec.version === 'string' ? spec.version : spec.git ? 'git' : spec.path ? 'path' : '';
          if (spec.optional === true && kind === 'runtime') dep.kind = 'optional';
        }
        out.deps.push(dep);
      }
    };
    take(toml.dependencies, 'runtime');
    take(toml['dev-dependencies'], 'dev');
    take(toml['build-dependencies'], 'build');
    if (toml.target && typeof toml.target === 'object') {
      for (const cfg of Object.values(toml.target)) {
        if (!cfg || typeof cfg !== 'object') continue;
        take(cfg.dependencies, 'runtime');
        take(cfg['dev-dependencies'], 'dev');
        take(cfg['build-dependencies'], 'build');
      }
    }
    return out;
  }

  /* ---------- pom.xml ---------- */

  /* A very small XML reader: elements, text, no attributes kept. Enough for Maven POMs. */
  function parseXml(text) {
    const root = { name: '#root', children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w.:-]+)\s*>|<([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.text += m[1];
      else if (m[2]) {
        // closing tag: unwind to the matching element (tolerates sloppy nesting)
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === m[2]) {
            stack.length = k;
            break;
          }
        }
      } else if (m[3]) {
        const el = { name: m[3].replace(/^.*:/, ''), children: [], text: '' };
        top.children.push(el);
        if (!m[5]) stack.push(el);
      } else if (m[6]) {
        top.text += m[6];
      }
    }
    return root;
  }

  const xmlChild = (el, name) => (el ? el.children.find((c) => c.name === name) : undefined);
  const xmlChildren = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
  const xmlText = (el, name) => {
    const c = xmlChild(el, name);
    return c ? decodeEntities(c.text.trim()) : '';
  };
  function decodeEntities(s) {
    return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e]);
  }

  function parsePom(text) {
    const doc = parseXml(text);
    const project = xmlChild(doc, 'project');
    const out = { name: null, deps: [] };
    if (!project) return out;
    const parent = xmlChild(project, 'parent');
    const groupId = xmlText(project, 'groupId') || xmlText(parent, 'groupId');
    const artifactId = xmlText(project, 'artifactId');
    const version = xmlText(project, 'version') || xmlText(parent, 'version');
    if (artifactId) out.name = (groupId ? groupId + ':' : '') + artifactId;
    const props = new Map([
      ['project.version', version],
      ['project.groupId', groupId],
      ['project.artifactId', artifactId],
      ['pom.version', version],
      ['pom.groupId', groupId],
      ['project.parent.version', xmlText(parent, 'version')],
      ['project.parent.groupId', xmlText(parent, 'groupId')],
    ]);
    const properties = xmlChild(project, 'properties');
    if (properties) for (const p of properties.children) props.set(p.name, decodeEntities(p.text.trim()));
    const subst = (s) => {
      let cur = s;
      for (let round = 0; round < 5 && cur.indexOf('${') >= 0; round++) {
        cur = cur.replace(/\$\{([^}]+)\}/g, (all, key) => (props.has(key) && props.get(key) ? props.get(key) : all));
      }
      return cur;
    };
    const managed = new Map();
    const dm = xmlChild(xmlChild(project, 'dependencyManagement'), 'dependencies');
    for (const d of xmlChildren(dm, 'dependency')) {
      managed.set(subst(xmlText(d, 'groupId')) + ':' + subst(xmlText(d, 'artifactId')), subst(xmlText(d, 'version')));
    }
    const take = (deps) => {
      for (const d of xmlChildren(deps, 'dependency')) {
        const g = subst(xmlText(d, 'groupId'));
        const a = subst(xmlText(d, 'artifactId'));
        if (!a) continue;
        const name = g + ':' + a;
        const scope = xmlText(d, 'scope');
        const kind = scope === 'test' ? 'dev' : xmlText(d, 'optional') === 'true' ? 'optional' : 'runtime';
        const v = subst(xmlText(d, 'version')) || managed.get(name) || '';
        out.deps.push({ name, version: v, kind, scope: scope || undefined });
      }
    };
    take(xmlChild(project, 'dependencies'));
    for (const profile of xmlChildren(xmlChild(project, 'profiles'), 'profile')) take(xmlChild(profile, 'dependencies'));
    return out;
  }

  /* ---------- Gradle ---------- */

  const GRADLE_CONFIG = /^(api|implementation|compile|runtime|compileOnly|compileOnlyApi|runtimeOnly|kapt|ksp|annotationProcessor|classpath|coreLibraryDesugaring|detektPlugins|lintChecks|\w*(Implementation|Api|CompileOnly|RuntimeOnly|Compile|Runtime|Kapt|Ksp|AnnotationProcessor))$/;
  const gradleDev = (config) => /^(test|androidTest|integrationTest|functionalTest)|Test[A-Z]/.test(config);

  function catalogKey(alias) {
    return alias.replace(/[._-]+/g, '.').toLowerCase();
  }

  /* gradle/libs.versions.toml -> { libraries: Map(key -> { name, version }), bundles: Map(key -> [keys]) } */
  function parseVersionCatalog(text) {
    const toml = Toml.parse(text);
    const versions = toml.versions && typeof toml.versions === 'object' ? toml.versions : {};
    const versionOf = (v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        if (typeof v.ref === 'string') {
          const r = versions[v.ref];
          return typeof r === 'string' ? r : r && typeof r === 'object' ? r.require || r.strictly || r.prefer || '' : '';
        }
        return v.require || v.strictly || v.prefer || '';
      }
      return '';
    };
    const libraries = new Map();
    const libs = toml.libraries && typeof toml.libraries === 'object' ? toml.libraries : {};
    for (const alias of Object.keys(libs)) {
      const spec = libs[alias];
      let name = null;
      let version = '';
      if (typeof spec === 'string') {
        const parts = spec.split(':');
        if (parts.length >= 2) {
          name = parts[0] + ':' + parts[1];
          version = parts[2] || '';
        }
      } else if (spec && typeof spec === 'object') {
        if (typeof spec.module === 'string') name = spec.module;
        else if (typeof spec.group === 'string' && typeof spec.name === 'string') name = spec.group + ':' + spec.name;
        version = versionOf(spec.version);
      }
      if (name) libraries.set(catalogKey(alias), { name, version });
    }
    const bundles = new Map();
    const b = toml.bundles && typeof toml.bundles === 'object' ? toml.bundles : {};
    for (const alias of Object.keys(b)) if (Array.isArray(b[alias])) bundles.set(catalogKey(alias), b[alias].map(catalogKey));
    return { libraries, bundles };
  }

  /* The { } blocks of a Gradle script with the name in front of each: "commonTest", "dependencies",
     "commonTest.dependencies", "getting" (after `val jvmTest by getting`, the name is taken from the val). */
  function gradleBlocks(text) {
    const bare = Lex.blank(text, { single: true, triple: true }); // strings emptied, so "${x}" does not count as a block
    const blocks = [];
    const open = [];
    for (let i = 0; i < bare.length; i++) {
      const ch = bare[i];
      if (ch === '{') {
        const before = bare.slice(Math.max(0, i - 160), i);
        const delegated = /(\w+)\s+by\s+\w+(?:\s*\([^(){}]*\))?\s*$/.exec(before);
        const plain = /([\w.]+)\s*(?:\(([^(){}]*)\))?\s*$/.exec(before);
        let name = delegated ? delegated[1] : plain ? plain[1] : '';
        // named("jvmTest") { ... }, getByName("commonTest") { ... }: the name is the string argument
        if (!delegated && plain && plain[2] !== undefined && /^(named|getByName|maybeCreate|create|register)$/.test(plain[1].split('.').pop())) {
          const from = i - before.length + plain.index;
          const arg = /["']([\w.-]+)["']/.exec(text.slice(from, i));
          if (arg) name = arg[1];
        }
        open.push({ start: i, end: bare.length, name });
      } else if (ch === '}' && open.length) {
        const b = open.pop();
        b.end = i;
        blocks.push(b);
      }
    }
    blocks.push(...open);
    return blocks;
  }

  const TEST_SOURCE_SET = /(^|\.)(test|\w+Test|androidTest\w*|test[A-Z]\w*)(\.|$)/;

  function parseGradle(text, catalog) {
    const src = Lex.blank(text, { keepStrings: true, single: true, triple: true });
    const out = { name: null, deps: [], projects: [] };
    const blocks = gradleBlocks(text);
    // Kotlin Multiplatform and similar: `implementation(...)` inside commonTest { } is a test dependency
    const inTestBlock = (at) => blocks.some((b) => b.start < at && at < b.end && TEST_SOURCE_SET.test(b.name));
    let at = 0; // offset of the declaration being read
    const devHere = (config) => gradleDev(config) || inTestBlock(at);
    const add = (config, name, version) => {
      out.deps.push({ name, version: version || '', kind: devHere(config) ? 'dev' : config === 'classpath' ? 'build' : 'runtime', config });
    };
    let m;
    // implementation "g:a:v", api("g:a:v"), testImplementation(platform("g:a:v"))
    const strRe = /(^|[\s{(;])([A-Za-z]\w*)[ \t]*\(?[ \t]*(?:(?:enforcedPlatform|platform|testFixtures)[ \t]*\([ \t]*)?(["'])([^"'\s:]+):([^"'\s:]+)(?::([^"'\s:@]*))?(?:[:@][^"']*)?\3/g;
    while ((m = strRe.exec(src))) {
      at = m.index;
      if (!GRADLE_CONFIG.test(m[2])) continue;
      add(m[2], m[4] + ':' + m[5], m[6]);
    }
    // implementation group: 'g', name: 'a', version: 'v'
    const mapRe = /(^|[\s{(;])([A-Za-z]\w*)[ \t]*\(?[ \t]*group[ \t]*[:=][ \t]*["']([^"']+)["'][ \t]*,[ \t]*name[ \t]*[:=][ \t]*["']([^"']+)["'](?:[ \t]*,[ \t]*version[ \t]*[:=][ \t]*["']([^"']+)["'])?/g;
    while ((m = mapRe.exec(src))) {
      at = m.index;
      if (GRADLE_CONFIG.test(m[2])) add(m[2], m[3] + ':' + m[4], m[5]);
    }
    // implementation(kotlin("stdlib"))
    const kotlinRe = /(^|[\s{(;])([A-Za-z]\w*)[ \t]*\(?[ \t]*kotlin[ \t]*\([ \t]*["']([\w.-]+)["'](?:[ \t]*,[ \t]*["']([^"']+)["'])?[ \t]*\)/g;
    while ((m = kotlinRe.exec(src))) {
      at = m.index;
      if (GRADLE_CONFIG.test(m[2])) add(m[2], 'org.jetbrains.kotlin:kotlin-' + m[3], m[4]);
    }
    // implementation project(":core"), api(project(path: ":core")), implementation(projects.core.util)
    const projRe = /(^|[\s{(;])([A-Za-z]\w*)[ \t]*\(?[ \t]*(?:testFixtures[ \t]*\([ \t]*)?project[ \t]*\([ \t]*(?:path[ \t]*[:=][ \t]*)?["'](:[^"']*)["']/g;
    while ((m = projRe.exec(src))) {
      at = m.index;
      if (GRADLE_CONFIG.test(m[2])) out.projects.push({ config: m[2], project: m[3], dev: devHere(m[2]) });
    }
    const accessorRe = /(^|[\s{(;])([A-Za-z]\w*)[ \t]*\(?[ \t]*(?:testFixtures[ \t]*\([ \t]*)?projects((?:\.\w+)+)/g;
    while ((m = accessorRe.exec(src))) {
      at = m.index;
      if (GRADLE_CONFIG.test(m[2])) out.projects.push({ config: m[2], accessor: m[3].slice(1), dev: devHere(m[2]) });
    }
    // implementation(libs.foo.bar), implementation libs.bundles.x
    const libsRe = /(^|[\s{(;])([A-Za-z]\w*)[ \t]*\(?[ \t]*(?:(?:enforcedPlatform|platform|testFixtures)[ \t]*\([ \t]*)?libs((?:\.\w+)+)/g;
    while ((m = libsRe.exec(src))) {
      at = m.index;
      if (!GRADLE_CONFIG.test(m[2])) continue;
      const alias = m[3].slice(1).replace(/\.(get|asProvider)$/, '');
      const key = catalogKey(alias);
      if (key.startsWith('plugins.') || key.startsWith('versions.')) continue;
      if (key.startsWith('bundles.')) {
        const members = catalog && catalog.bundles.get(key.slice('bundles.'.length));
        if (members) {
          for (const member of members) {
            const lib = catalog.libraries.get(member);
            if (lib) add(m[2], lib.name, lib.version);
          }
          continue;
        }
      }
      const lib = catalog && catalog.libraries.get(key);
      if (lib) add(m[2], lib.name, lib.version);
      else add(m[2], 'libs.' + alias, '');
    }
    return out;
  }

  /* ---------- build.sbt ---------- */

  function parseSbt(text) {
    const src = Lex.blank(text, { keepStrings: true, nested: true });
    const out = { name: null, deps: [] };
    const vals = new Map();
    let m;
    const valRe = /\bval[ \t]+(\w+)[ \t]*(?::[ \t]*String[ \t]*)?=[ \t]*"([^"\n]*)"/g;
    while ((m = valRe.exec(src))) vals.set(m[1], m[2]);
    const nameRe = /(?:^|[\s(,])name[ \t]*:=[ \t]*"([^"\n]+)"/.exec(src);
    if (nameRe) out.name = nameRe[1];
    const depRe = /"([^"\n]+)"[ \t\n]*(%%%?|%)[ \t\n]*"([^"\n]+)"[ \t\n]*%[ \t\n]*(?:"([^"\n]+)"|([A-Za-z_][\w.]*))((?:[ \t\n]*%[ \t\n]*(?:"[^"\n]+"|[A-Za-z_][\w.]*))*)/g;
    while ((m = depRe.exec(src))) {
      let version = m[4];
      if (version === undefined) version = vals.has(m[5]) ? vals.get(m[5]) : m[5];
      const tail = m[6] || '';
      const dev = /%[ \t\n]*(?:"(?:test|it)[^"]*"|Test\b|IntegrationTest\b|It\b)/.test(tail);
      const kind = dev ? 'dev' : /%[ \t\n]*(?:"provided"|Provided\b)/.test(tail) ? 'optional' : 'runtime';
      out.deps.push({ name: m[1] + ':' + m[3], version, kind, crossBuilt: m[2] !== '%' });
    }
    return out;
  }

  /* ---------- driver ---------- */

  /* files: Map(path -> text). Returns
     { manifests: [{ path, kind, ecosystem, name }],
       deps: [{ from, ecosystem, name, versions: [..], kind, local: manifestPath | null, note }],
       notes: [string] } */
  function analyze(files) {
    const notes = [];
    const manifests = [];
    const parsed = new Map();
    const catalogs = new Map(); // dir that holds gradle/ -> catalog
    for (const [path, text] of files) {
      if (/(^|\/)gradle\/[\w.-]+\.versions\.toml$/.test(path) && basename(path) === 'libs.versions.toml') {
        try {
          catalogs.set(dirname(dirname(path)), parseVersionCatalog(text));
        } catch (e) {
          notes.push(path + ' could not be parsed (' + e.message + ').');
        }
      }
    }
    const catalogFor = (dir) => {
      let d = dir;
      for (;;) {
        if (catalogs.has(d)) return catalogs.get(d);
        if (d === '') return null;
        d = dirname(d);
      }
    };
    for (const [path, text] of files) {
      const kind = manifestKind(path);
      if (!kind) continue;
      let p;
      try {
        if (kind === 'gomod') p = parseGoMod(text);
        else if (kind === 'npm') p = parsePackageJson(text);
        else if (kind === 'requirements') p = parseRequirementsTxt(text, path);
        else if (kind === 'pyproject') p = parsePyproject(text);
        else if (kind === 'cargo') p = parseCargo(text);
        else if (kind === 'pom') p = parsePom(text);
        else if (kind === 'gradle') p = parseGradle(text, catalogFor(dirname(path)));
        else p = parseSbt(text);
      } catch (e) {
        notes.push(path + ' could not be parsed (' + (e && e.message ? e.message : e) + ').');
        continue;
      }
      parsed.set(path, p);
      manifests.push({ path, kind, ecosystem: ECOSYSTEM[kind], name: p.name || null });
    }

    /* names declared inside the repository, per ecosystem */
    const declared = new Map(); // ecosystem + '\0' + name -> [manifest paths]
    for (const mf of manifests) {
      if (!mf.name) continue;
      const key = mf.ecosystem + '\u0000' + mf.name;
      if (!declared.has(key)) declared.set(key, []);
      declared.get(key).push(mf.path);
    }
    const npmWorkspaces = manifests.some((mf) => mf.kind === 'npm' && parsed.get(mf.path).hasWorkspaces) || [...files.keys()].some((p) => basename(p) === 'pnpm-workspace.yaml');
    const localByName = (mf, name, hint) => {
      const list = (declared.get(mf.ecosystem + '\u0000' + name) || []).filter((p) => p !== mf.path);
      if (list.length === 0) return null;
      if (mf.kind === 'npm') {
        const localSpec = /^(workspace:|file:|link:|portal:)/.test(hint || '');
        if (!localSpec && !npmWorkspaces && !list.includes('package.json')) return null;
      }
      if (list.length === 1) return list[0];
      // several manifests declare this name: prefer the closest one
      const dir = dirname(mf.path);
      let best = null;
      let bestScore = -1;
      for (const p of list) {
        const a = dir.split('/');
        const b = dirname(p).split('/');
        let k = 0;
        while (k < a.length && k < b.length && a[k] === b[k]) k++;
        if (k > bestScore) {
          bestScore = k;
          best = p;
        }
      }
      return best;
    };
    const findUp = (dir, names) => {
      let d = dir;
      for (;;) {
        for (const n of names) if (files.has(d === '' ? n : d + '/' + n)) return d;
        if (d === '') return null;
        d = dirname(d);
      }
    };
    const gradleFileIn = (dir) => {
      for (const n of ['build.gradle.kts', 'build.gradle']) {
        const p = dir === '' ? n : dir + '/' + n;
        if (parsed.has(p)) return p;
      }
      return null;
    };

    const merged = new Map();
    const push = (mf, dep, local, note) => {
      const key = mf.path + '\u0000' + (local ? 'local:' + local : mf.ecosystem + ':' + dep.name);
      let e = merged.get(key);
      if (!e) {
        e = { from: mf.path, ecosystem: mf.ecosystem, name: dep.name, versions: [], kind: dep.kind, local: local || null, note: note || null };
        merged.set(key, e);
      } else if (rank(dep.kind) < rank(e.kind)) {
        e.kind = dep.kind; // listed twice: the stronger reason wins (runtime over dev)
      }
      if (dep.version && !e.versions.includes(dep.version)) e.versions.push(dep.version);
    };
    const rank = (kind) => ['runtime', 'peer', 'optional', 'build', 'dev', 'indirect'].indexOf(kind);

    for (const mf of manifests) {
      const p = parsed.get(mf.path);
      const dir = dirname(mf.path);
      for (const dep of p.deps) {
        let local = null;
        let note = null;
        if (mf.kind === 'cargo') {
          let path = dep.path;
          if (dep.fromWorkspace) {
            const wsDir = (function up(d) {
              for (;;) {
                const cand = parsed.get(d === '' ? 'Cargo.toml' : d + '/Cargo.toml');
                if (cand && cand.workspaceDeps) return d;
                if (d === '') return null;
                d = dirname(d);
              }
            })(dir);
            const shared = wsDir !== null ? parsed.get(wsDir === '' ? 'Cargo.toml' : wsDir + '/Cargo.toml').workspaceDeps[dep.fromWorkspace] : null;
            if (typeof shared === 'string') dep.version = shared;
            else if (shared && typeof shared === 'object') {
              if (typeof shared.package === 'string') dep.name = shared.package;
              dep.version = typeof shared.version === 'string' ? shared.version : shared.git ? 'git' : shared.path ? 'path' : '';
              if (typeof shared.path === 'string') path = join(wsDir, shared.path);
            }
          } else if (path) {
            path = join(dir, path);
          }
          if (path !== undefined && path !== null) {
            const target = path === '' ? 'Cargo.toml' : path + '/Cargo.toml';
            if (parsed.has(target) && target !== mf.path) local = target;
          }
        } else if (mf.kind === 'gomod') {
          local = localByName(mf, dep.name);
          if (dep.replacedBy) note = 'replaced by ' + dep.replacedBy;
        } else {
          local = localByName(mf, dep.name, dep.version);
        }
        push(mf, dep, local, note);
      }
      if (mf.kind === 'gradle') {
        const rootDir = findUp(dir, ['settings.gradle.kts', 'settings.gradle']);
        for (const pr of p.projects) {
          let rel = null;
          if (pr.project) rel = pr.project.replace(/^:/, '').split(':').join('/');
          else rel = pr.accessor.split('.').map((s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join('/');
          const base = rootDir === null ? '' : rootDir;
          let target = gradleFileIn(join(base, rel) || '');
          if (!target && pr.accessor) target = gradleFileIn(join(base, pr.accessor.split('.').join('/')) || '');
          const dep = { name: pr.project || 'projects.' + pr.accessor, version: '', kind: pr.dev ? 'dev' : 'runtime' };
          if (target && target !== mf.path) push(mf, dep, target, null);
          else if (!target) notes.push(mf.path + ': project dependency ' + dep.name + ' could not be matched to a build file.');
        }
      }
    }
    return { manifests, deps: [...merged.values()], notes };
  }

  const api = {
    analyze, manifestKind, parseGoMod, parsePackageJson, parseRequirement, parseRequirementsTxt, parsePyproject, parseCargo,
    parsePom, parseXml, parseGradle, parseVersionCatalog, parseSbt, normalizePyName, ECOSYSTEM,
  };
  globalThis.RepoDagManifests = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
