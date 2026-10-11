/* Minimal zip writer for tests and the e2e harness. Not part of the extension.
   makeZip([{ name, data, method: 'store' | 'deflate', descriptor: bool, encrypted: bool }], { comment }) -> Buffer */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files, options) {
  const opts = options || {};
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '', 'utf8');
    const isDir = f.name.endsWith('/');
    const deflate = !isDir && f.method !== 'store';
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    let flags = 0x0800; // UTF-8 names
    if (f.descriptor) flags |= 0x0008;
    if (f.encrypted) flags |= 0x0001;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    // With a data descriptor the local header carries zeros and the real values follow the data.
    local.writeUInt32LE(f.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(f.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(f.descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localExtra = f.localExtra ? Buffer.from(f.localExtra) : Buffer.alloc(0);
    local.writeUInt16LE(localExtra.length, 28);
    const parts = [local, name, localExtra, body];
    if (f.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    const localBuf = Buffer.concat(parts);
    locals.push(localBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(isDir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localBuf.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment || '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

/* Zips a directory tree the way GitHub does: everything under one top-level folder. */
function zipDirectory(dir, topFolder) {
  const files = [];
  const prefix = topFolder ? topFolder.replace(/\/?$/, '/') : '';
  if (prefix) files.push({ name: prefix, data: '' });
  (function walk(rel) {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        files.push({ name: prefix + childRel + '/', data: '' });
        walk(childRel);
      } else if (e.isFile()) {
        files.push({ name: prefix + childRel, data: fs.readFileSync(path.join(dir, childRel)) });
      }
    }
  })('');
  return makeZip(files);
}

module.exports = { makeZip, zipDirectory, crc32 };
