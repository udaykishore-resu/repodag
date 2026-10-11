/* RepoDAG lexing helpers: path utilities, a comment/string blanker for C-like languages and Python,
   and a small JavaScript/TypeScript tokenizer that is just good enough to find import specifiers. */
(function () {
  'use strict';

  /* ---------- paths (always forward slashes, no leading slash, '' is the repo root) ---------- */

  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  function basename(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }

  function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i).toLowerCase();
  }

  /* Joins and normalises. Returns null when the path climbs above the repo root. */
  function join(base, rel) {
    const parts = base ? base.split('/') : [];
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    return parts.join('/');
  }

  /* Directory id used for package and folder nodes: "a/b/" and "./" for the repo root. */
  function dirId(dir) {
    return dir ? dir + '/' : './';
  }

  /* ---------- blanking ---------- */

  function spaces(text) {
    return text.replace(/[^\n]/g, ' ');
  }

  /* Returns `src` with comments (and, unless keepStrings, string and char literal contents) replaced by spaces.
     Length and line breaks are preserved, so offsets and line-anchored regexes keep working.
     cfg: { nested, triple, backtick, single, rustRaw, cppRaw, keepStrings } */
  function blank(src, cfg) {
    const c = cfg || {};
    const n = src.length;
    const out = [];
    let keepFrom = 0;
    let i = 0;
    const cut = (from, to) => {
      // blank [from, to)
      if (from > keepFrom) out.push(src.slice(keepFrom, from));
      out.push(spaces(src.slice(from, to)));
      keepFrom = to;
    };
    // Blanks the body of a string literal, keeping its delimiters so "..." still looks like an (empty) string.
    const blankString = (bodyStart, bodyEnd) => {
      if (!c.keepStrings && bodyEnd > bodyStart) cut(bodyStart, bodyEnd);
    };
    while (i < n) {
      const ch = src.charCodeAt(i);
      // line comment
      if (ch === 47 /* / */ && src.charCodeAt(i + 1) === 47) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        cut(i, j);
        i = j;
        continue;
      }
      // block comment
      if (ch === 47 && src.charCodeAt(i + 1) === 42 /* * */) {
        let j = i + 2;
        let depth = 1;
        while (j < n && depth > 0) {
          if (src.charCodeAt(j) === 42 && src.charCodeAt(j + 1) === 47) {
            depth--;
            j += 2;
          } else if (c.nested && src.charCodeAt(j) === 47 && src.charCodeAt(j + 1) === 42) {
            depth++;
            j += 2;
          } else {
            j++;
          }
        }
        cut(i, j);
        i = j;
        continue;
      }
      // Rust raw strings: r"..", r#".."#, br#".."#
      if (c.rustRaw && (ch === 114 /* r */ || (ch === 98 /* b */ && src.charCodeAt(i + 1) === 114))) {
        const prev = i > 0 ? src.charCodeAt(i - 1) : 32;
        if (!isIdentCode(prev)) {
          let j = i + (ch === 98 ? 2 : 1);
          let hashes = 0;
          while (src.charCodeAt(j) === 35 /* # */) {
            hashes++;
            j++;
          }
          if (src.charCodeAt(j) === 34 /* " */) {
            const close = '"' + '#'.repeat(hashes);
            let end = src.indexOf(close, j + 1);
            if (end < 0) end = n;
            const bodyEnd = end;
            blankString(j + 1, bodyEnd);
            i = Math.min(n, bodyEnd + close.length);
            continue;
          }
        }
      }
      // C++ raw strings: R"delim( ... )delim"
      if (c.cppRaw && ch === 82 /* R */ && src.charCodeAt(i + 1) === 34) {
        const open = src.indexOf('(', i + 2);
        if (open > 0 && open - (i + 2) <= 16 && !/[\s\\)"]/.test(src.slice(i + 2, open))) {
          const close = ')' + src.slice(i + 2, open) + '"';
          let end = src.indexOf(close, open + 1);
          if (end < 0) end = n;
          blankString(open + 1, end);
          i = Math.min(n, end + close.length);
          continue;
        }
      }
      // triple-quoted strings (Java text blocks, Kotlin and Scala raw strings)
      if (c.triple && ch === 34 && src.charCodeAt(i + 1) === 34 && src.charCodeAt(i + 2) === 34) {
        let end = src.indexOf('"""', i + 3);
        if (end < 0) end = n;
        // a run of more than three closing quotes belongs to the string except for the last three
        while (src.charCodeAt(end + 3) === 34) end++;
        blankString(i + 3, end);
        i = Math.min(n, end + 3);
        continue;
      }
      // ordinary string (and '...' strings in languages that have them, such as Groovy)
      if (ch === 34 || (c.single && ch === 39)) {
        let j = i + 1;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (d === 92 /* \ */) {
            j += 2;
            continue;
          }
          if (d === ch || d === 10) break;
          j++;
        }
        blankString(i + 1, Math.min(j, n));
        i = Math.min(n, j + 1);
        continue;
      }
      // backtick strings (Go raw strings, Kotlin quoted identifiers)
      if (c.backtick && ch === 96) {
        let end = src.indexOf('`', i + 1);
        if (end < 0) end = n;
        blankString(i + 1, end);
        i = Math.min(n, end + 1);
        continue;
      }
      // char literal, or a Rust lifetime / Scala symbol that only looks like one
      if (ch === 39 /* ' */) {
        let j = i + 1;
        if (src.charCodeAt(j) === 92) {
          // escaped char: '\n', '\'', '\u{1F600}', '\x41'
          j += 2;
          while (j < n && j - i < 12 && src.charCodeAt(j) !== 39 && src.charCodeAt(j) !== 10) j++;
          if (src.charCodeAt(j) === 39) {
            blankString(i + 1, j);
            i = j + 1;
            continue;
          }
        } else if (j < n && src.charCodeAt(j) !== 10) {
          // one code point (possibly a surrogate pair) then the closing quote
          const cp = src.codePointAt(j);
          const k = j + (cp > 0xffff ? 2 : 1);
          if (src.charCodeAt(k) === 39) {
            blankString(i + 1, k);
            i = k + 1;
            continue;
          }
        }
        i++; // lifetime, symbol or apostrophe: leave it
        continue;
      }
      i++;
    }
    if (keepFrom < n) out.push(src.slice(keepFrom));
    return out.join('');
  }

  function isIdentCode(code) {
    return (
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 127
    );
  }

  /* Python: blanks comments and the contents of every string literal, including triple-quoted ones. */
  function blankPython(src) {
    const n = src.length;
    const out = [];
    let keepFrom = 0;
    let i = 0;
    const cut = (from, to) => {
      if (to <= from) return;
      if (from > keepFrom) out.push(src.slice(keepFrom, from));
      out.push(spaces(src.slice(from, to)));
      keepFrom = to;
    };
    while (i < n) {
      const ch = src.charCodeAt(i);
      if (ch === 35 /* # */) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        cut(i, j);
        i = j;
        continue;
      }
      if (ch === 34 || ch === 39) {
        const q = src[i];
        if (src[i + 1] === q && src[i + 2] === q) {
          const close = q + q + q;
          let j = i + 3;
          let end = -1;
          while (j < n) {
            const d = src.charCodeAt(j);
            if (d === 92) {
              j += 2;
              continue;
            }
            if (d === ch && src.startsWith(close, j)) {
              end = j;
              break;
            }
            j++;
          }
          if (end < 0) end = n;
          cut(i + 3, end);
          i = Math.min(n, end + 3);
          continue;
        }
        let j = i + 1;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (d === 92) {
            j += 2;
            continue;
          }
          if (d === ch || d === 10) break;
          j++;
        }
        cut(i + 1, Math.min(j, n));
        i = Math.min(n, j + 1);
        continue;
      }
      i++;
    }
    if (keepFrom < n) out.push(src.slice(keepFrom));
    return out.join('');
  }

  /* ---------- JavaScript / TypeScript tokenizer ---------- */

  const REGEX_AFTER_WORD = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
  ]);

  /* Calls onToken({ t, v, nl }) for every token. t is 'id', 'str', 'tmpl', 'num', 'p' (one punctuation char) or 're'.
     `nl` is true when the token is the first on its line. Template literals without ${} come out as 'str' with tmpl: true.
     Strings and regular expressions never span lines, so a misread (JSX text, for example) heals at the next line break. */
  function jsTokens(src, onToken) {
    const n = src.length;
    let i = 0;
    let prevT = '';
    let prevV = '';
    let newline = true;
    const braces = []; // '{' for a block, 't' for a ${ inside a template literal
    const emit = (t, v, extra) => {
      const tok = { t, v, nl: newline };
      if (extra) Object.assign(tok, extra);
      newline = false;
      prevT = t;
      prevV = v;
      return onToken(tok);
    };
    const readTemplate = (from) => {
      // `from` is just after a backtick or after the } that closes a ${...}. Returns the index to resume at.
      let j = from;
      let simple = true;
      const start = from;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92) {
          j += 2;
          continue;
        }
        if (d === 96) {
          emit(simple && templateStart === start ? 'str' : 'tmpl', src.slice(start, j), { tmpl: true });
          return j + 1;
        }
        if (d === 36 && src.charCodeAt(j + 1) === 123) {
          simple = false;
          emit('tmpl', '', { tmpl: true });
          braces.push('t');
          prevT = 'p';
          prevV = '{';
          return j + 2;
        }
        j++;
      }
      return n;
    };
    let templateStart = -1;
    while (i < n) {
      const ch = src.charCodeAt(i);
      if (ch === 10) {
        newline = true;
        i++;
        continue;
      }
      if (ch === 32 || ch === 9 || ch === 13 || ch === 0xfeff || ch === 0xa0) {
        i++;
        continue;
      }
      if (ch === 47) {
        const next = src.charCodeAt(i + 1);
        if (next === 47) {
          const j = src.indexOf('\n', i);
          i = j < 0 ? n : j;
          continue;
        }
        if (next === 42) {
          const j = src.indexOf('*/', i + 2);
          const end = j < 0 ? n : j + 2;
          if (src.slice(i, end).indexOf('\n') >= 0) newline = true;
          i = end;
          continue;
        }
        const regexAllowed =
          prevT === '' ||
          (prevT === 'p' && prevV !== ')' && prevV !== ']' && prevV !== '}') ||
          (prevT === 'id' && REGEX_AFTER_WORD.has(prevV));
        if (regexAllowed) {
          let j = i + 1;
          let inClass = false;
          let closed = false;
          while (j < n) {
            const d = src.charCodeAt(j);
            if (d === 10) break;
            if (d === 92) {
              j += 2;
              continue;
            }
            if (d === 91) inClass = true;
            else if (d === 93) inClass = false;
            else if (d === 47 && !inClass) {
              closed = true;
              break;
            }
            j++;
          }
          if (closed) {
            j++;
            while (j < n && isIdentCode(src.charCodeAt(j))) j++;
            emit('re', '');
            i = j;
            continue;
          }
        }
        emit('p', '/');
        i++;
        continue;
      }
      if (ch === 34 || ch === 39) {
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (d === 92) {
            j += 2;
            continue;
          }
          if (d === ch) {
            closed = true;
            break;
          }
          if (d === 10) break;
          j++;
        }
        if (emit('str', closed ? src.slice(i + 1, j) : '', closed ? null : { broken: true }) === false) return;
        i = closed ? j + 1 : j;
        continue;
      }
      if (ch === 96) {
        templateStart = i + 1;
        i = readTemplate(i + 1);
        continue;
      }
      if (isIdentCode(ch) && !(ch >= 48 && ch <= 57)) {
        let j = i + 1;
        while (j < n && isIdentCode(src.charCodeAt(j))) j++;
        if (emit('id', src.slice(i, j)) === false) return;
        i = j;
        continue;
      }
      if (ch >= 48 && ch <= 57) {
        let j = i + 1;
        while (j < n && (isIdentCode(src.charCodeAt(j)) || src.charCodeAt(j) === 46)) j++;
        emit('num', '');
        i = j;
        continue;
      }
      if (ch === 123) {
        braces.push('{');
      } else if (ch === 125) {
        const top = braces.pop();
        if (top === 't') {
          templateStart = -1;
          i = readTemplate(i + 1);
          continue;
        }
      }
      if (emit('p', src[i]) === false) return;
      i++;
    }
  }

  /* Returns [{ spec, kind, typeOnly }] where kind is 'import', 'export', 'require' or 'dynamic'. */
  function jsImports(src) {
    const toks = [];
    jsTokens(src, (tok) => {
      toks.push(tok);
    });
    const found = [];
    const n = toks.length;
    const isP = (k, v) => k < n && toks[k].t === 'p' && toks[k].v === v;
    const isId = (k, v) => k < n && toks[k].t === 'id' && (v === undefined || toks[k].v === v);
    const isStr = (k) => k < n && toks[k].t === 'str' && !toks[k].broken;
    const statementStart = (k) => k === 0 || toks[k].nl || isP(k - 1, ';') || isP(k - 1, '}') || isP(k - 1, '{');
    // Skips a { ... } block of import/export names. Returns the index after the closing brace, or -1.
    const skipNames = (k) => {
      if (!isP(k, '{')) return -1;
      let j = k + 1;
      for (; j < n; j++) {
        const tk = toks[j];
        if (tk.t === 'p' && tk.v === '}') return j + 1;
        if (tk.t === 'id' || tk.t === 'str' || (tk.t === 'p' && tk.v === ',')) continue;
        return -1;
      }
      return -1;
    };
    for (let k = 0; k < n; k++) {
      const tok = toks[k];
      if (tok.t !== 'id') continue;
      const afterDot = k > 0 && isP(k - 1, '.');
      if (tok.v === 'import' && !afterDot) {
        if (isP(k + 1, '(')) {
          if (isStr(k + 2) && (isP(k + 3, ')') || isP(k + 3, ','))) found.push({ spec: toks[k + 2].v, kind: 'dynamic', typeOnly: false });
          continue;
        }
        if (isP(k + 1, '.')) continue; // import.meta
        if (!statementStart(k)) continue;
        if (isStr(k + 1)) {
          found.push({ spec: toks[k + 1].v, kind: 'import', typeOnly: false });
          continue;
        }
        let j = k + 1;
        let typeOnly = false;
        if ((isId(j, 'type') || isId(j, 'typeof')) && (isP(j + 1, '{') || isP(j + 1, '*') || (isId(j + 1) && !(toks[j + 1].v === 'from' && isStr(j + 2))))) {
          typeOnly = true;
          j++;
        }
        let ok = false;
        for (let guard = 0; guard < 4; guard++) {
          if (isId(j) && toks[j].v !== 'from') {
            j++;
          } else if (isId(j, 'from') && !isStr(j + 1)) {
            j++; // a default binding that happens to be called "from"
          } else if (isP(j, '*') && isId(j + 1, 'as') && isId(j + 2)) {
            j += 3;
          } else if (isP(j, '{')) {
            j = skipNames(j);
            if (j < 0) break;
          } else {
            break;
          }
          if (isP(j, ',')) {
            j++;
            continue;
          }
          ok = true;
          break;
        }
        if (ok && j > 0 && isId(j, 'from') && isStr(j + 1)) {
          found.push({ spec: toks[j + 1].v, kind: 'import', typeOnly });
        }
        continue;
      }
      if (tok.v === 'export' && !afterDot && statementStart(k)) {
        let j = k + 1;
        let typeOnly = false;
        if (isId(j, 'type') && (isP(j + 1, '{') || isP(j + 1, '*'))) {
          typeOnly = true;
          j++;
        }
        if (isP(j, '*')) {
          j++;
          if (isId(j, 'as') && (isId(j + 1) || isStr(j + 1))) j += 2;
        } else if (isP(j, '{')) {
          j = skipNames(j);
          if (j < 0) continue;
        } else {
          continue;
        }
        if (isId(j, 'from') && isStr(j + 1)) found.push({ spec: toks[j + 1].v, kind: 'export', typeOnly });
        continue;
      }
      // TypeScript module augmentation: declare module './x' { ... } refers to that module just like an import
      if (tok.v === 'declare' && isId(k + 1, 'module') && isStr(k + 2) && isP(k + 3, '{') && statementStart(k) && !toks[k + 2].v.includes('*')) {
        found.push({ spec: toks[k + 2].v, kind: 'augment', typeOnly: true });
        continue;
      }
      if (tok.v === 'require' && !afterDot && isP(k + 1, '(') && isStr(k + 2) && (isP(k + 3, ')') || isP(k + 3, ','))) {
        found.push({ spec: toks[k + 2].v, kind: 'require', typeOnly: false });
      }
    }
    return found;
  }

  /* Strips // and block comments and trailing commas from JSON-with-comments (tsconfig.json) and parses it.
     Returns null when it still does not parse. */
  function parseJsonc(text) {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
      } else if (ch === '/' && text[i + 1] === '/') {
        const j = text.indexOf('\n', i);
        i = j < 0 ? n : j;
      } else if (ch === '/' && text[i + 1] === '*') {
        const j = text.indexOf('*/', i + 2);
        i = j < 0 ? n : j + 2;
      } else {
        out += ch;
        i++;
      }
    }
    out = out.replace(/^\uFEFF/, '');
    // trailing commas: a comma followed only by whitespace and a closing bracket (strings were copied verbatim above,
    // so check we are not inside one by re-walking)
    let cleaned = '';
    i = 0;
    while (i < out.length) {
      const ch = out[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
        cleaned += out.slice(i, j + 1);
        i = j + 1;
      } else if (ch === ',') {
        let j = i + 1;
        while (j < out.length && /\s/.test(out[j])) j++;
        if (out[j] === '}' || out[j] === ']') {
          i++;
        } else {
          cleaned += ch;
          i++;
        }
      } else {
        cleaned += ch;
        i++;
      }
    }
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      return null;
    }
  }

  const api = { dirname, basename, extname, join, dirId, blank, blankPython, jsTokens, jsImports, parseJsonc };
  globalThis.RepoDagLex = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
