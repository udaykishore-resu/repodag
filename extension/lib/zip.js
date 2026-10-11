/* RepoDAG zip reader. Reads the central directory of a zip held in memory and inflates single entries on demand.
   Supports stored (0) and deflate (8) entries. Zip64 and encrypted archives are rejected with a clear error.
   Works in a browser page and in Node 18+ (both ship DecompressionStream). */
(function () {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64_LOCATOR = 0x07064b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;

  class ZipError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ZipError';
    }
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new ZipError('Expected an ArrayBuffer or Uint8Array.');
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* Returns { bytes, entries } where each entry is
     { name, isDirectory, method, flags, crc, compressedSize, size, localOffset }. */
  function open(data) {
    const bytes = toBytes(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;
    if (len < 22) throw new ZipError('This file is too small to be a zip archive.');

    // The end-of-central-directory record sits at the very end, followed only by an optional comment (max 65535 bytes).
    let eocd = -1;
    const stop = Math.max(0, len - 22 - 0xffff);
    for (let i = len - 22; i >= stop; i--) {
      if (view.getUint32(i, true) === SIG_EOCD && i + 22 + view.getUint16(i + 20, true) <= len) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('This file is not a zip archive (no end-of-central-directory record found).');

    const diskNumber = view.getUint16(eocd + 4, true);
    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const hasLocator = eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR;
    if (hasLocator || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError('This archive uses the zip64 format (more than 65,535 files or over 4 GB), which is not supported.');
    }
    if (diskNumber !== 0) throw new ZipError('Multi-part zip archives are not supported.');
    if (cdOffset + cdSize > eocd) throw new ZipError('The zip central directory is damaged (it runs past the end of the file).');

    const decoder = new TextDecoder('utf-8');
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > len || view.getUint32(p, true) !== SIG_CENTRAL) {
        throw new ZipError('The zip central directory is damaged (entry ' + (i + 1) + ' of ' + count + ').');
      }
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compressedSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      if (p + 46 + nameLen > len) throw new ZipError('The zip central directory is damaged (a file name runs past the end).');
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (flags & 0x0001) {
        throw new ZipError('This archive is password-protected ("' + name + '" is encrypted). Unpack it first and open the folder instead.');
      }
      if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new ZipError('This archive uses the zip64 format ("' + name + '" is over 4 GB), which is not supported.');
      }
      entries.push({
        name,
        isDirectory: name.endsWith('/'),
        method,
        flags,
        crc,
        compressedSize,
        size,
        localOffset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { bytes, entries };
  }

  async function inflateRaw(compressed, expectedSize) {
    if (typeof DecompressionStream !== 'function') {
      throw new ZipError('This browser cannot unpack deflate data (DecompressionStream is missing).');
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const out = new Uint8Array(expectedSize);
    let filled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // The central directory states the size. An entry that inflates past it is damaged or hostile: stop early.
      if (filled + value.length > expectedSize) {
        await reader.cancel().catch(() => {});
        throw new ZipError('inflates to more than its stated size');
      }
      out.set(value, filled);
      filled += value.length;
    }
    if (filled !== expectedSize) throw new ZipError('inflates to ' + filled + ' bytes, expected ' + expectedSize);
    return out;
  }

  /* Returns the entry's bytes. Sizes and CRC come from the central directory, so entries written with a
     data descriptor (local header sizes of zero) are read correctly. */
  async function read(zip, entry, options) {
    const bytes = zip.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.localOffset;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== SIG_LOCAL) {
      throw new ZipError('"' + entry.name + '" has a damaged local header.');
    }
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.length) throw new ZipError('"' + entry.name + '" runs past the end of the archive.');
    const raw = bytes.subarray(start, end);
    let out;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new ZipError('"' + entry.name + '" is stored but its sizes disagree.');
      out = raw;
    } else if (entry.method === 8) {
      try {
        out = await inflateRaw(raw, entry.size);
      } catch (e) {
        if (e instanceof ZipError) throw new ZipError('"' + entry.name + '" ' + e.message + '.');
        throw new ZipError('"' + entry.name + '" could not be unpacked (the compressed data is damaged).');
      }
    } else {
      throw new ZipError('"' + entry.name + '" uses compression method ' + entry.method + ', which is not supported (only stored and deflate are).');
    }
    if (!options || options.verify !== false) {
      if (crc32(out) !== entry.crc) throw new ZipError('"' + entry.name + '" failed its checksum (the archive is damaged).');
    }
    return out;
  }

  async function readText(zip, entry, options) {
    const data = await read(zip, entry, options);
    return new TextDecoder('utf-8').decode(data);
  }

  /* GitHub archives wrap everything in one folder named <repo>-<ref>/. Returns that prefix ("name/"),
     or "" when the entries do not share a single top-level folder. */
  function commonTopFolder(names) {
    let prefix = null;
    let files = 0;
    for (const name of names) {
      const slash = name.indexOf('/');
      if (slash < 0) return ''; // an entry at the top level
      if (slash === name.length - 1 && name.indexOf('/') === name.lastIndexOf('/')) {
        // the top-level directory entry itself
        if (prefix === null) prefix = name;
        else if (prefix !== name) return '';
        continue;
      }
      const top = name.slice(0, slash + 1);
      if (prefix === null) prefix = top;
      else if (prefix !== top) return '';
      files++;
    }
    return files > 0 && prefix ? prefix : '';
  }

  const api = { open, read, readText, commonTopFolder, crc32, ZipError };
  globalThis.RepoDagZip = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
