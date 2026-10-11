/* Where the archive of a real repository comes from when the harness cannot simply let the extension download it.

   Some networks (CI sandboxes, corporate proxies) allow `git clone` from github.com but answer 403 for
   github.com/<owner>/<repo>/archive/<ref>.zip and codeload.github.com. There the same bytes are made locally:
   a shallow clone, then `git archive`, which produces the zip layout GitHub serves (one <repo>-<ref>/ folder). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/* Returns { file, note } or { error }. `slug` is "owner/repo". */
function cloneArchive(slug) {
  const name = slug.split('/')[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repodag-clone-'));
  const clone = spawnSync('git', ['clone', '--quiet', '--depth', '1', 'https://github.com/' + slug, path.join(dir, name)], { encoding: 'utf8', timeout: 120000 });
  if (clone.error || clone.status !== 0) {
    return { error: 'git clone of ' + slug + ' failed: ' + String((clone.error && clone.error.message) || clone.stderr || '').trim().split('\n').pop() };
  }
  const file = path.join(dir, name + '.zip');
  const archive = spawnSync('git', ['-C', path.join(dir, name), 'archive', '--format=zip', '--prefix=' + name + '-HEAD/', 'HEAD', '-o', file], { encoding: 'utf8', timeout: 120000 });
  if (archive.error || archive.status !== 0) return { error: 'git archive failed: ' + String(archive.stderr || '').trim() };
  return { file, note: 'made with git clone + git archive in ' + dir };
}

/* Makes the extension's request for github.com/<slug>/archive/<anything>.zip come back with `file`.
   Returns a function that reports how many requests were answered. */
async function serveArchive(ctx, slug, file) {
  const body = fs.readFileSync(file);
  let count = 0;
  await ctx.route('https://github.com/' + slug + '/archive/**', (route) => {
    count++;
    return route.fulfill({ status: 200, contentType: 'application/zip', body });
  });
  return () => count;
}

module.exports = { cloneArchive, serveArchive };
