/* RepoDAG TOML reader. Covers what Cargo.toml, pyproject.toml and Gradle version catalogs use:
   tables, arrays of tables, dotted and quoted keys, strings (basic, literal, multi-line), numbers, booleans,
   dates (kept as strings), arrays and inline tables. Throws an Error with a line number on anything else. */
(function () {
  'use strict';

  function parse(text) {
    const src = text.replace(/\r\n?/g, '\n');
    const n = src.length;
    let i = 0;
    const root = {};
    let table = root;

    const fail = (msg) => {
      const line = src.slice(0, i).split('\n').length;
      throw new Error('TOML line ' + line + ': ' + msg);
    };
    const skipSpace = () => {
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    };
    const skipComment = () => {
      if (src[i] === '#') while (i < n && src[i] !== '\n') i++;
    };
    const skipBlank = () => {
      // whitespace, newlines and comments (used between statements and inside arrays)
      for (;;) {
        while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
        if (src[i] === '#') skipComment();
        else break;
      }
    };
    const endOfLine = () => {
      skipSpace();
      skipComment();
      if (i < n && src[i] !== '\n') fail('unexpected text after a value');
    };

    const readBasicString = () => {
      // at the opening quote
      if (src.startsWith('"""', i)) {
        i += 3;
        if (src[i] === '\n') i++;
        let out = '';
        while (i < n) {
          if (src.startsWith('"""', i)) {
            // up to two extra quotes belong to the string
            let extra = 0;
            while (extra < 2 && src[i + 3 + extra] === '"') extra++;
            out += '"'.repeat(extra);
            i += 3 + extra;
            return out;
          }
          if (src[i] === '\\') {
            if (src[i + 1] === '\n' || /^\\[ \t]*\n/.test(src.slice(i, i + 40))) {
              i++;
              while (i < n && /\s/.test(src[i])) i++;
              continue;
            }
            out += readEscape();
            continue;
          }
          out += src[i++];
        }
        fail('multi-line string is not closed');
      }
      i++;
      let out = '';
      while (i < n) {
        const ch = src[i];
        if (ch === '"') {
          i++;
          return out;
        }
        if (ch === '\n') fail('string is not closed');
        if (ch === '\\') {
          out += readEscape();
          continue;
        }
        out += ch;
        i++;
      }
      fail('string is not closed');
      return '';
    };
    const readEscape = () => {
      // at the backslash
      const e = src[i + 1];
      i += 2;
      switch (e) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'e': return '\u001b';
        case '"': return '"';
        case '\\': return '\\';
        case 'u':
        case 'U': {
          const len = e === 'u' ? 4 : 8;
          const hex = src.slice(i, i + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('bad unicode escape');
          i += len;
          return String.fromCodePoint(parseInt(hex, 16));
        }
        default:
          fail('unknown escape \\' + e);
          return '';
      }
    };
    const readLiteralString = () => {
      if (src.startsWith("'''", i)) {
        i += 3;
        if (src[i] === '\n') i++;
        let end = src.indexOf("'''", i);
        if (end < 0) fail('multi-line string is not closed');
        while (src[end + 3] === "'") end++;
        const out = src.slice(i, end);
        i = end + 3;
        return out;
      }
      const end = src.indexOf("'", i + 1);
      const nl = src.indexOf('\n', i + 1);
      if (end < 0 || (nl >= 0 && nl < end)) fail('string is not closed');
      const out = src.slice(i + 1, end);
      i = end + 1;
      return out;
    };

    const readKeyPart = () => {
      skipSpace();
      if (src[i] === '"') return readBasicString();
      if (src[i] === "'") return readLiteralString();
      const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200));
      if (!m) fail('expected a key');
      i += m[0].length;
      return m[0];
    };
    const readKey = () => {
      const parts = [readKeyPart()];
      skipSpace();
      while (src[i] === '.') {
        i++;
        parts.push(readKeyPart());
        skipSpace();
      }
      return parts;
    };

    const descend = (from, parts, forHeader) => {
      let t = from;
      for (const part of parts) {
        let next = Object.prototype.hasOwnProperty.call(t, part) ? t[part] : undefined;
        if (next === undefined) {
          next = {};
          setOwn(t, part, next);
        } else if (Array.isArray(next)) {
          if (!forHeader || next.length === 0 || typeof next[next.length - 1] !== 'object') fail('key "' + part + '" is not a table');
          next = next[next.length - 1];
        } else if (typeof next !== 'object' || next === null) {
          fail('key "' + part + '" is already a value');
        }
        t = next;
      }
      return t;
    };

    const readValue = () => {
      skipSpace();
      const ch = src[i];
      if (ch === '"') return readBasicString();
      if (ch === "'") return readLiteralString();
      if (ch === '[') {
        i++;
        const arr = [];
        for (;;) {
          skipBlank();
          if (src[i] === ']') {
            i++;
            return arr;
          }
          arr.push(readValue());
          skipBlank();
          if (src[i] === ',') {
            i++;
            continue;
          }
          if (src[i] === ']') {
            i++;
            return arr;
          }
          fail('expected , or ] in array');
        }
      }
      if (ch === '{') {
        i++;
        const obj = {};
        skipBlank();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        for (;;) {
          skipBlank();
          const parts = readKey();
          if (src[i] !== '=') fail('expected = in inline table');
          i++;
          const target = descend(obj, parts.slice(0, -1), false);
          setOwn(target, parts[parts.length - 1], readValue());
          skipBlank();
          if (src[i] === ',') {
            i++;
            skipBlank();
            if (src[i] === '}') {
              i++;
              return obj;
            }
            continue;
          }
          if (src[i] === '}') {
            i++;
            return obj;
          }
          fail('expected , or } in inline table');
        }
      }
      const m = /^[^\s,\]}#]+(?: [0-9][^\s,\]}#]*)?/.exec(src.slice(i, i + 80));
      if (!m) fail('expected a value');
      const raw = m[0];
      i += raw.length;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      if (/^[+-]?(inf|nan)$/.test(raw)) return raw.endsWith('nan') ? NaN : raw[0] === '-' ? -Infinity : Infinity;
      if (/^[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+)$/.test(raw)) return Number(raw.replace(/_/g, '').replace(/^\+/, ''));
      if (/^[+-]?[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9_]+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
      if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw; // dates and times stay strings
      fail('unrecognised value ' + raw);
      return null;
    };

    while (i < n) {
      skipBlank();
      if (i >= n) break;
      if (src[i] === '[') {
        const isArray = src[i + 1] === '[';
        i += isArray ? 2 : 1;
        const parts = readKey();
        if (isArray) {
          if (!src.startsWith(']]', i)) fail('expected ]]');
          i += 2;
          const parent = descend(root, parts.slice(0, -1), true);
          const last = parts[parts.length - 1];
          let arr = Object.prototype.hasOwnProperty.call(parent, last) ? parent[last] : undefined;
          if (arr === undefined) {
            arr = [];
            setOwn(parent, last, arr);
          }
          if (!Array.isArray(arr)) fail('key "' + last + '" is not an array of tables');
          table = {};
          arr.push(table);
        } else {
          if (src[i] !== ']') fail('expected ]');
          i++;
          table = descend(root, parts, true);
        }
        endOfLine();
        continue;
      }
      const parts = readKey();
      if (src[i] !== '=') fail('expected = after key');
      i++;
      const target = descend(table, parts.slice(0, -1), false);
      setOwn(target, parts[parts.length - 1], readValue());
      endOfLine();
    }
    return root;
  }

  // Assign without ever touching Object.prototype ("__proto__" as a key stays plain data).
  function setOwn(obj, key, value) {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  }

  const api = { parse };
  globalThis.RepoDagToml = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
