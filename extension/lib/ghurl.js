/* RepoDAG GitHub URL helpers: recognise a repository page, build the archive URL and links back to files. */
(function () {
  'use strict';

  /* First path segments on github.com that are site pages, not account names. */
  const RESERVED = new Set([
    'about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories', 'dashboard',
    'enterprise', 'events', 'explore', 'features', 'gist', 'issues', 'join', 'login', 'logout', 'marketplace', 'mobile', 'new',
    'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'search', 'security', 'sessions', 'settings',
    'signup', 'site', 'sponsors', 'stars', 'team', 'topics', 'trending', 'users', 'watching', 'solutions', 'resources', 'premium-support',
  ]);
  const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const REPO = /^[A-Za-z0-9._-]{1,100}$/;

  /* Returns { owner, repo, ref } for a github.com repository page, else null.
     ref is the path segment after /tree/ when there is one, otherwise 'HEAD'. */
  function parseRepoUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/, '');
    if (RESERVED.has(owner.toLowerCase()) || !NAME.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
    let ref = 'HEAD';
    if (segs[2] === 'tree' && segs[3]) {
      try {
        ref = decodeURIComponent(segs[3]);
      } catch (_) {
        ref = segs[3];
      }
    }
    return { owner, repo, ref };
  }

  /* "owner/repo" as typed or passed in a query string. */
  function parseSlug(slug) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(slug || '').trim());
    if (!m || !NAME.test(m[1]) || !REPO.test(m[2]) || m[2] === '.' || m[2] === '..') return null;
    return { owner: m[1], repo: m[2] };
  }

  function cleanRef(ref) {
    const r = String(ref || '').trim();
    // git ref names: no spaces, control characters or the few characters git forbids
    if (!r || r.length > 250 || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(r) || r.includes('..') || r.startsWith('/') || r.endsWith('/')) return null;
    return r;
  }

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  function archiveUrl(owner, repo, ref) {
    return 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/archive/' + encodePath(ref) + '.zip';
  }

  /* Link to a file (blob) or folder (tree) on GitHub. `path` may end in "/" for folders; "./" is the repository root. */
  function sourceUrl(owner, repo, ref, path) {
    const base = 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    if (path === './' || path === '') return base + '/tree/' + encodePath(ref);
    const isDir = path.endsWith('/');
    const clean = isDir ? path.slice(0, -1) : path;
    return base + (isDir ? '/tree/' : '/blob/') + encodePath(ref) + '/' + encodePath(clean);
  }

  function viewerQuery(owner, repo, ref) {
    return '?repo=' + encodeURIComponent(owner + '/' + repo) + '&ref=' + encodeURIComponent(ref);
  }

  const api = { parseRepoUrl, parseSlug, cleanRef, archiveUrl, sourceUrl, viewerQuery };
  globalThis.RepoDagUrl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
