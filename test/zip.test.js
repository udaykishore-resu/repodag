// Zip reader: central directory parsing, stored and deflated entries, data descriptors, and the rejected formats.
const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('../extension/lib/zip.js');
const { makeZip } = require('./helpers/make-zip.js');

const text = (bytes) => new TextDecoder().decode(bytes);
const big = 'package main\n' + '// filler line that compresses well\n'.repeat(4000);

test('reads stored and deflated entries', async () => {
  const buf = makeZip([
    { name: 'repo-main/', data: '' },
    { name: 'repo-main/stored.txt', data: 'stored body', method: 'store' },
    { name: 'repo-main/src/deflated.go', data: big, method: 'deflate' },
    { name: 'repo-main/empty.txt', data: '', method: 'deflate' },
    { name: 'repo-main/ünïcode/файл.py', data: 'import os\n', method: 'deflate' },
  ]);
  const zip = Zip.open(buf);
  assert.equal(zip.entries.length, 5);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('repo-main/').isDirectory, true);
  assert.equal(byName.get('repo-main/stored.txt').method, 0);
  assert.equal(byName.get('repo-main/src/deflated.go').method, 8);
  assert.ok(byName.get('repo-main/src/deflated.go').compressedSize < big.length / 10);
  assert.equal(text(await Zip.read(zip, byName.get('repo-main/stored.txt'))), 'stored body');
  assert.equal(await Zip.readText(zip, byName.get('repo-main/src/deflated.go')), big);
  assert.equal(await Zip.readText(zip, byName.get('repo-main/empty.txt')), '');
  assert.equal(await Zip.readText(zip, byName.get('repo-main/ünïcode/файл.py')), 'import os\n');
});

test('accepts an ArrayBuffer and a Uint8Array view with an offset', async () => {
  const buf = makeZip([{ name: 'a.txt', data: 'hello' }]);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  assert.equal(await Zip.readText(Zip.open(ab), Zip.open(ab).entries[0]), 'hello');
  const padded = new Uint8Array(buf.length + 7);
  padded.set(buf, 7);
  const zip = Zip.open(padded.subarray(7));
  assert.equal(await Zip.readText(zip, zip.entries[0]), 'hello');
});

test('data descriptor entries are read using central-directory sizes', async () => {
  const buf = makeZip([
    { name: 'x/one.js', data: 'export const one = 1;\n'.repeat(50), method: 'deflate', descriptor: true },
    { name: 'x/two.js', data: 'two', method: 'store', descriptor: true },
  ]);
  const zip = Zip.open(buf);
  // The local header really does carry zero sizes.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(view.getUint32(zip.entries[0].localOffset + 18, true), 0);
  assert.equal(await Zip.readText(zip, zip.entries[0]), 'export const one = 1;\n'.repeat(50));
  assert.equal(await Zip.readText(zip, zip.entries[1]), 'two');
});

test('local header extra field of a different length than the central one is skipped', async () => {
  const buf = makeZip([{ name: 'a.txt', data: 'payload', method: 'store', localExtra: [0x55, 0x54, 0x05, 0x00, 1, 2, 3, 4, 5] }]);
  const zip = Zip.open(buf);
  assert.equal(await Zip.readText(zip, zip.entries[0]), 'payload');
});

test('finds the end record behind an archive comment', async () => {
  const buf = makeZip([{ name: 'a.txt', data: 'hi' }], { comment: 'c0ffee'.repeat(20) });
  const zip = Zip.open(buf);
  assert.equal(await Zip.readText(zip, zip.entries[0]), 'hi');
});

test('rejects zip64 with a clear message', () => {
  const buf = makeZip([{ name: 'a.txt', data: 'hi' }], { zip64: true });
  assert.throws(() => Zip.open(buf), (e) => e instanceof Zip.ZipError && /zip64/.test(e.message) && /not supported/.test(e.message));
});

test('rejects encrypted archives with a clear message', () => {
  const buf = makeZip([{ name: 'secret.txt', data: 'hi', encrypted: true }]);
  assert.throws(() => Zip.open(buf), (e) => e instanceof Zip.ZipError && /password-protected/.test(e.message) && /secret\.txt/.test(e.message));
});

test('rejects data that is not a zip', () => {
  assert.throws(() => Zip.open(new Uint8Array(10)), /too small/);
  assert.throws(() => Zip.open(new TextEncoder().encode('<!doctype html><html><body>Not found</body></html>')), /not a zip archive/);
});

test('a corrupted entry fails its checksum instead of returning wrong text', async () => {
  const buf = makeZip([{ name: 'a.txt', data: 'hello world', method: 'store' }]);
  const zip = Zip.open(buf);
  buf[zip.entries[0].localOffset + 30 + 'a.txt'.length] ^= 0xff;
  await assert.rejects(() => Zip.read(zip, zip.entries[0]), /checksum/);
});

test('an entry that inflates past its stated size is stopped', async () => {
  const buf = makeZip([{ name: 'bomb.txt', data: 'A'.repeat(200000), method: 'deflate' }]);
  const zip = Zip.open(buf);
  const lying = Object.assign({}, zip.entries[0], { size: 1000 });
  await assert.rejects(() => Zip.read(zip, lying), /more than its stated size/);
});

test('unsupported compression methods are named', async () => {
  const buf = makeZip([{ name: 'a.txt', data: 'hello', method: 'store' }]);
  const zip = Zip.open(buf);
  await assert.rejects(() => Zip.read(zip, Object.assign({}, zip.entries[0], { method: 12 })), /compression method 12/);
});

test('commonTopFolder finds the single wrapper folder and nothing else', () => {
  assert.equal(Zip.commonTopFolder(['repo-main/', 'repo-main/a.go', 'repo-main/b/c.go']), 'repo-main/');
  assert.equal(Zip.commonTopFolder(['repo-main/a.go', 'repo-main/b/c.go']), 'repo-main/');
  assert.equal(Zip.commonTopFolder(['a.go', 'b/c.go']), '');
  assert.equal(Zip.commonTopFolder(['x/a.go', 'y/c.go']), '');
  assert.equal(Zip.commonTopFolder(['x/']), '');
  assert.equal(Zip.commonTopFolder([]), '');
});

test('crc32 matches the reference value', () => {
  assert.equal(Zip.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
