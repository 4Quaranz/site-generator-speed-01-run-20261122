// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site 1.0.0's build(), byte for byte, on every input:
// same front matter, template dialect, Markdown subset, slug rule and report.
// Written from the reference README and code as the specification.
//
// Speed comes from fusing passes instead of changing answers:
//   - Markdown is lexed and rendered in one sweep over the body (no token
//     list, no per-line regexes, no per-character escaping).
//   - Inline runs of plain text are escaped in one native replace.
//   - slugify() has an ASCII fast path plus a cache (titles, tags and
//     headings repeat a lot across a site).
//   - Front matter is parsed from the head of the source only; the body is
//     never split into lines.
//   - Templates are compiled once per case to plain JS functions (a
//     `new Function` per template) instead of walked as a node tree on
//     every page; scope lookup, truthiness and value formatting keep the
//     reference semantics exactly.
//   - Link targets are resolved through a per-build memo.
//
// No clock, environment, randomness or file is read: the output is a
// function of the input alone, so two runs agree byte for byte.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ text

/** The HTML escape table, in this order: & < > " ' . */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Slugs already computed, keyed by the exact input text. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (/[^\x00-\x7F]/.test(text)) {
    // Non-ASCII: the reference algorithm, verbatim in effect.
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    // ASCII: NFKD is the identity and there are no combining marks, so the
    // same walk runs on code units directly.
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The Unicode spaces in JavaScript's \s beyond the ASCII ones. */
const UNICODE_WS = new Set([0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

/** Whether code unit `code` is whitespace by JavaScript's \s. */
function isWsCode(code) {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 || (code > 127 && UNICODE_WS.has(code));
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare value. */
function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Only the head of `text` is scanned line by
 * line; the body is one slice, never split.
 */
function parseFrontMatter(text) {
  if (text === '---') return { error: 'the front matter is not closed' };
  if (!text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line: a line that is exactly "---". The "\n" ending
  // the opening line is at index 3, so the search starts there.
  let closeAt = -1;
  let bodyAt = -1;
  let at = text.indexOf('\n---', 3);
  while (at !== -1) {
    const after = at + 4;
    if (after === text.length || text[after] === '\n') {
      closeAt = at;
      bodyAt = after === text.length ? text.length : after + 1;
      break;
    }
    at = text.indexOf('\n---', after);
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Walk the lines between the fences (line 2 is the first of them).
  let lineNo = 2;
  let p = 4;
  const end = closeAt;
  while (p <= end) {
    let e = text.indexOf('\n', p);
    if (e === -1 || e > end) e = end;
    const line = text.slice(p, e);
    const blank = /^[ \t]*$/.test(line);
    if (!blank && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineNo++;
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ------------------------------------------------------------------ Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with its spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence opening line's language, or null when the line opens no fence. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after. */
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  let i = d;
  if (i >= line.length || (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9)) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let b = line.length;
  while (b > i && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === i) return null;
  return { depth: d, text: line.slice(i, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs after. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether `line` continues a list item: two or more spaces, then non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !/\s/.test(line[i]);
}

/** An ordered list marker's start number and content, or null. */
function orderedOf(line) {
  let d = 0;
  while (d < 9 && d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let i = 0;
  const n = s.length;
  let run = 0;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      if (j > run) out += escapeHtml(s.slice(run, j));
      out += escapeHtml(s[j + 1]);
      i = j + 2;
      run = i;
      continue;
    }
    if (c === '\\') {
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > run) out += escapeHtml(s.slice(run, j));
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        run = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > run) out += escapeHtml(s.slice(run, j));
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
          run = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > run) out += escapeHtml(s.slice(run, j));
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
        run = i;
      } else i = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        if (j > run) out += escapeHtml(s.slice(run, j));
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = m2 + 1;
        run = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (j > run) out += escapeHtml(s.slice(run, j));
    out += ESCAPES[c];
    i = j + 1;
    run = i;
  }
  if (n > run) out += escapeHtml(s.slice(run, n));
  return out;
}

/**
 * `src` rendered in one sweep: its HTML (each block on its own lines, a
 * "\n" after the last), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let p = 0;
  // One reused holder for the current line, so scanning never allocates.
  const la = { line: '', next: 0 };
  const lineAt = (pos) => {
    let e = src.indexOf('\n', pos);
    if (e === -1) e = n;
    la.line = src.slice(pos, e);
    la.next = e + 1;
  };
  while (p < n) {
    lineAt(p);
    let line = la.line;
    let next = la.next;
    if (isBlank(line)) {
      p = next;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const body = [];
      p = next;
      while (p < n) {
        lineAt(p);
        const l2 = la.line;
        const nx2 = la.next;
        if (fenceClose(l2)) {
          p = nx2;
          break;
        }
        body.push(l2);
        p = nx2;
      }
      const cls = fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`;
      let code = '';
      for (const l of body) code += `${escapeHtml(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      p = next;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      p = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // Blockquote: lines opening on ">".
      const qlines = [];
      while (true) {
        let l = line.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        qlines.push(l);
        p = next;
        if (p >= n) break;
        lineAt(p);
        line = la.line;
        next = la.next;
        if (line.charCodeAt(0) !== 62) break;
      }
      const inner = qlines.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = line.startsWith('- ') || line.startsWith('* ');
    const ordered = bullet ? null : orderedOf(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      while (true) {
        if (isOrdered) {
          const m = orderedOf(line);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            p = next;
          } else if (isContinued(line)) {
            items[items.length - 1].push(trimLine(line));
            p = next;
          } else break;
        } else {
          if (line.startsWith('- ') || line.startsWith('* ')) {
            items.push([trimLine(line.slice(2))]);
            p = next;
          } else if (isContinued(line)) {
            items[items.length - 1].push(trimLine(line));
            p = next;
          } else break;
        }
        if (p >= n) break;
        lineAt(p);
        line = la.line;
        next = la.next;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    p = next;
    while (p < n) {
      lineAt(p);
      line = la.line;
      next = la.next;
      if (endsParagraph(line)) break;
      body.push(trimLine(line));
      p = next;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const pathLit = (path, u) => `P[${u.pi(path)}]`;

/** JS source for `nodes` rendered in scope variable `sv`; `u` seeds unique temp names and path indexes. */
function genNodes(nodes, sv, u) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') code += `o+=${JSON.stringify(n.text)};`;
    else if (n.kind === 'var') code += `o+=C.e(C.tx(C.lk(${sv},${pathLit(n.path, u)})));`;
    else if (n.kind === 'raw') code += `o+=C.tx(C.lk(${sv},${pathLit(n.path, u)}));`;
    else if (n.kind === 'if') {
      code += `if(C.tr(C.lk(${sv},${pathLit(n.path, u)}))!==${n.not}){${genNodes(n.then, sv, u)}`;
      if (n.else !== null) code += `}else{${genNodes(n.else, sv, u)}}`;
      else code += '}';
    } else if (n.kind === 'for') {
      const a = `_a${u.n++}`;
      const k = `_i${u.n++}`;
      const s = `_s${u.n++}`;
      code += `var ${a}=C.lk(${sv},${pathLit(n.path, u)});if(Array.isArray(${a})){for(var ${k}=0;${k}<${a}.length;${k}++){var ${s}={vars:{${JSON.stringify(n.name)}:${a}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${a}.length-1,length:${a}.length}},parent:${sv}};${genNodes(n.body, s, u)}}}`;
    } else if (n.kind === 'include') {
      const t = `_t${u.n++}`;
      code += `var ${t}=C.tp.get(${JSON.stringify(n.name)});if(${t}!==undefined&&D<${INCLUDE_DEPTH})o+=${t}.f(${sv},C,D+1,${t}.p);`;
    }
  }
  return code;
}

/**
 * A template's parsed tree compiled to a render record { f, p }: f is a
 * function (S, C, D, P) => string and p its table of paths, so rendering
 * never allocates a path array.
 */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const paths = [];
  const pathIndex = new Map();
  const u = {
    n: 0,
    pi(path) {
      const key = path.join('');
      let idx = pathIndex.get(key);
      if (idx === undefined) {
        idx = paths.length;
        paths.push(path);
        pathIndex.set(key, idx);
      }
      return idx;
    },
  };
  const f = new Function('S', 'C', 'D', 'P', `var o="";${genNodes(nodes, 'S', u)}return o;`);
  return { f, p: paths };
}

// ------------------------------------------------------------------ the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  // Nothing is carried from one case to the next: each case is answered alone.
  slugCache.clear();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const ctx = { lk: lookup, tx: textOf, tr: truthy, e: escapeHtml, tp: templates };

  // 1. The sources, in code-unit order of their paths; a source that is
  // not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft. The checks run in order; the first that fails is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCache = new Map();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        if (rel === '') path = null;
        else {
          const key = `${dir}\0${rel}`;
          path = resolveCache.get(key);
          if (path === undefined) {
            path = resolvePath(dir, rel);
            resolveCache.set(key, path);
          }
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  // A page as its layout reads it (its card's fields inlined, no spread).
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One top scope per case; each render only swaps its own fields in.
  const topVars = { site, tags: allTags, recent, page: null, posts: null, pager: null, tag: null };
  const topScope = { vars: topVars, parent: null };
  const render = (name) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    return t.f(topScope, ctx, 0, t.p);
  };
  const output = {};
  for (const s of kept) {
    topVars.page = pageOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    topVars.page = null;
    topVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    topVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    topVars.posts = null;
    topVars.pager = null;
    topVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  topVars.tag = null;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
