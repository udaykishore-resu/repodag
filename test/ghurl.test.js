// GitHub URL handling used by the popup and the viewer.
const test = require('node:test');
const assert = require('node:assert/strict');
const Url = require('../extension/lib/ghurl.js');

test('repository pages are recognised, with the ref taken from /tree/', () => {
  assert.deepEqual(Url.parseRepoUrl('https://github.com/udaykishore-resu/idem'), { owner: 'udaykishore-resu', repo: 'idem', ref: 'HEAD' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/demo/'), { owner: 'acme', repo: 'demo', ref: 'HEAD' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/demo/tree/v1.2.3'), { owner: 'acme', repo: 'demo', ref: 'v1.2.3' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/demo/tree/main/src/lib?x=1#L3'), { owner: 'acme', repo: 'demo', ref: 'main' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/demo/blob/main/README.md'), { owner: 'acme', repo: 'demo', ref: 'HEAD' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/demo/pull/12/files'), { owner: 'acme', repo: 'demo', ref: 'HEAD' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/demo.git'), { owner: 'acme', repo: 'demo', ref: 'HEAD' });
  assert.deepEqual(Url.parseRepoUrl('https://github.com/acme/.github/tree/release%2F1'), { owner: 'acme', repo: '.github', ref: 'release/1' });
});

test('everything else is not a repository', () => {
  for (const url of [
    'https://github.com/',
    'https://github.com/acme',
    'https://github.com/settings/profile',
    'https://github.com/orgs/acme/people',
    'https://github.com/marketplace/actions',
    'https://github.com/search?q=x',
    'https://gist.github.com/acme/abc',
    'https://github.com.evil.example/acme/demo',
    'http://github.com/acme/demo',
    'https://gitlab.com/acme/demo',
    'chrome://extensions',
    'not a url',
    '',
    undefined,
  ]) {
    assert.equal(Url.parseRepoUrl(url), null, String(url));
  }
});

test('slugs and refs typed by the user are validated', () => {
  assert.deepEqual(Url.parseSlug('acme/demo'), { owner: 'acme', repo: 'demo' });
  assert.deepEqual(Url.parseSlug('  acme/demo.js '), { owner: 'acme', repo: 'demo.js' });
  for (const bad of ['acme', 'acme/', '/demo', 'a/b/c', 'acme/..', 'ac me/demo', 'acme/de mo', '', null]) assert.equal(Url.parseSlug(bad), null, String(bad));
  assert.equal(Url.cleanRef(' main '), 'main');
  assert.equal(Url.cleanRef('feature/x-1'), 'feature/x-1');
  assert.equal(Url.cleanRef('v1.0.0'), 'v1.0.0');
  assert.equal(Url.cleanRef('3f2a9c1'), '3f2a9c1');
  for (const bad of ['', '  ', 'a b', 'a..b', '/a', 'a/', 'a~1', 'a^', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b']) assert.equal(Url.cleanRef(bad), null, bad);
});

test('archive and source links are built with every segment encoded', () => {
  assert.equal(Url.archiveUrl('acme', 'demo', 'HEAD'), 'https://github.com/acme/demo/archive/HEAD.zip');
  assert.equal(Url.archiveUrl('acme', 'demo', 'feature/a#b'), 'https://github.com/acme/demo/archive/feature/a%23b.zip');
  assert.equal(Url.sourceUrl('acme', 'demo', 'main', 'src/a b.ts'), 'https://github.com/acme/demo/blob/main/src/a%20b.ts');
  assert.equal(Url.sourceUrl('acme', 'demo', 'main', 'src/lib/'), 'https://github.com/acme/demo/tree/main/src/lib');
  assert.equal(Url.sourceUrl('acme', 'demo', 'HEAD', './'), 'https://github.com/acme/demo/tree/HEAD');
  assert.equal(Url.viewerQuery('acme', 'demo', 'feature/x'), '?repo=acme%2Fdemo&ref=feature%2Fx');
});
