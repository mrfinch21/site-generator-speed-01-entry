// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// run(input) returns exactly makefun-site 1.0.0's build(input) for every input:
// the same output tree, byte for byte. Same pipeline, same rules, same messages;
// only the machinery is faster: run-sliced inline Markdown, memoised slugs,
// an index-based front-matter scan, and a scope-stack template interpreter
// that renders into an array instead of concatenating strings node by node.
// No imports, no network, no clock, no randomness. Pure JS, Node 22.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped (same table as makefun-site). */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESC[text[i]];
    if (e !== undefined) {
      if (i > start) out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  if (start === 0) return text;
  if (start < text.length) out += text.slice(start);
  return out;
}

/** Escape the slice s[from, to) into the output array `out`. */
function escapeInto(s, from, to, out) {
  let start = from;
  for (let i = from; i < to; i++) {
    const e = ESC[s[i]];
    if (e !== undefined) {
      if (i > start) out.push(s.slice(start, i));
      out.push(e);
      start = i + 1;
    }
  }
  if (to > start) out.push(s.slice(start, to));
}

/** Per-run memo of slugify results (reset at every run: nothing is shared between cases). */
let slugMemo;

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = slugMemo.get(text);
  if (hit !== undefined) return hit;
  // ASCII text is unchanged by NFKD and holds no combining marks: skip both.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugMemo.set(text, slug);
  return slug;
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
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    // Every whitespace the generator can emit is <= 32 (space, tab, newline);
    // 0xa0 is the only non-ASCII whitespace its word tables could ever hold.
    const c = text.charCodeAt(i);
    if (c <= 32 || c === 0xa0) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The body is one slice of the
 * text; only the front matter's lines are ever visited.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing line first: a missing close refuses the source whatever
  // the lines between hold.
  let closeStart = -1;
  let closeEnd = -1;
  let p = firstEnd === text.length ? text.length : firstEnd + 1;
  while (p <= text.length) {
    const e = text.indexOf('\n', p);
    const lend = e === -1 ? text.length : e;
    if (lend - p === 3 && text[p] === '-' && text[p + 1] === '-' && text[p + 2] === '-') {
      closeStart = p;
      closeEnd = lend;
      break;
    }
    if (e === -1) break;
    p = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2;
  p = firstEnd === text.length ? text.length : firstEnd + 1;
  while (p < closeStart) {
    const e = text.indexOf('\n', p);
    const lend = e === -1 ? closeStart : Math.min(e, closeStart);
    const line = text.slice(p, lend);
    if (!isBlank(line) && line[0] !== '#') {
      // /^([a-z_]+):(?: (.*))?$/
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || line[j] !== ':') return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === line.length) raw = '';
      else if (line[j + 1] === ' ') raw = line.slice(j + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c !== 32 && c !== 9) break;
        rEnd--;
      }
      raw = raw.slice(0, rEnd);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineNo++;
    p = e === -1 ? text.length : e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether the rest of `line` from `i` is spaces and tabs only. */
function onlySpaceTab(line, i) {
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  return onlySpaceTab(line, i) ? line.slice(3, i) : null;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaceTab(line, 3);
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.charCodeAt(0) !== 45 && line.charCodeAt(0) !== 42) return false;
  const m = line.charCodeAt(0) === 45 ? '---' : '***';
  return line.startsWith(m) && onlySpaceTab(line, 3);
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && n < 10) {
    const c = line.charCodeAt(n);
    if (c < 48 || c > 57) break;
    n++;
  }
  if (n === 0 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { num: Number(line.slice(0, n)), rest: line.slice(n + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  if (n < 2) return false;
  if (n >= line.length) return false;
  const c = line.charCodeAt(n);
  return c !== 32 && c !== 9;
}

/** Line kinds, computed once per body so no line is classified twice. */
const K_OTHER = 0;
const K_BLANK = 1;
const K_FENCE = 2;
const K_HEADING = 3;
const K_HR = 4;
const K_QUOTE = 5;
const K_BULLET = 6;
const K_ORDERED = 7;

function classifyLines(lines) {
  const kinds = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) { kinds[i] = K_BLANK; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) { kinds[i] = isBlank(line) ? K_BLANK : K_OTHER; continue; }
    if (c0 === 96) { kinds[i] = fenceOpen(line) !== null ? K_FENCE : K_OTHER; continue; }
    if (c0 === 35) { kinds[i] = headingOf(line) !== null ? K_HEADING : K_OTHER; continue; }
    if (c0 === 45) {
      if (isHr(line)) kinds[i] = K_HR;
      else if (line.charCodeAt(1) === 32) kinds[i] = K_BULLET;
      else kinds[i] = K_OTHER;
      continue;
    }
    if (c0 === 42) {
      if (isHr(line)) kinds[i] = K_HR;
      else if (line.charCodeAt(1) === 32) kinds[i] = K_BULLET;
      else kinds[i] = K_OTHER;
      continue;
    }
    if (c0 === 62) { kinds[i] = K_QUOTE; continue; }
    if (c0 >= 48 && c0 <= 57) { kinds[i] = orderedOf(line) !== null ? K_ORDERED : K_OTHER; continue; }
    kinds[i] = K_OTHER;
  }
  return kinds;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where s holds `what` outside a backslash escape, or -1 (within [from, to)). */
function findUnescaped(s, what, from, to) {
  const last = to - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1 (within [from, to)). */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < to && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * The slice s[from, to) rendered inline into `out`. `env.link(target)` is a
 * link's href. No substring is ever built except a link's target: the inline
 * renderer works on ranges of the one string, jumping from one interesting
 * character to the next with one native scan instead of walking every char.
 */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

function inlineInto(s, from, to, env, out) {
  let start = from;
  INLINE_SPECIAL.lastIndex = from;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null && m.index < to) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < to && ESCAPABLE.has(s[i + 1])) {
        if (i > start) out.push(s.slice(start, i));
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        INLINE_SPECIAL.lastIndex = i + 2;
        start = i + 2;
        continue;
      }
      INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (c === 96) { // backtick: a code span closed by the next backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < to && j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>');
        escapeInto(s, i + 1, j, out);
        out.push('</code>');
        INLINE_SPECIAL.lastIndex = j + 1;
        start = j + 1;
        continue;
      }
      INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (c === 42) { // *
      if (i + 1 < to && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, to);
        if (j !== -1 && j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>');
          inlineInto(s, i + 2, j, env, out);
          out.push('</strong>');
          INLINE_SPECIAL.lastIndex = j + 2;
          start = j + 2;
        } else {
          if (i > start) out.push(s.slice(start, i));
          out.push('**');
          INLINE_SPECIAL.lastIndex = i + 2;
          start = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, to);
      if (j !== -1 && j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>');
        inlineInto(s, i + 1, j, env, out);
        out.push('</em>');
        INLINE_SPECIAL.lastIndex = j + 1;
        start = j + 1;
      } else {
        if (i > start) out.push(s.slice(start, i));
        out.push('*');
        INLINE_SPECIAL.lastIndex = i + 1;
        start = i + 1;
      }
      continue;
    }
    if (c === 91) { // [
      const k = findUnescaped(s, ']', i + 1, to);
      if (k !== -1 && k + 1 < to && s[k + 1] === '(') {
        const m2 = s.indexOf(')', k + 2);
        const target = m2 !== -1 && m2 < to ? s.slice(k + 2, m2) : '';
        if (target !== '' && !/\s/.test(target)) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<a href="');
          out.push(escapeHtml(env.link(target)));
          out.push('">');
          inlineInto(s, i + 1, k, env, out);
          out.push('</a>');
          INLINE_SPECIAL.lastIndex = m2 + 1;
          start = m2 + 1;
          continue;
        }
      }
      if (i > start) out.push(s.slice(start, i));
      out.push('[');
      INLINE_SPECIAL.lastIndex = i + 1;
      start = i + 1;
      continue;
    }
    // & < > " '
    if (i > start) out.push(s.slice(start, i));
    out.push(ESC[s[i]]);
    INLINE_SPECIAL.lastIndex = i + 1;
    start = i + 1;
  }
  if (to > start) out.push(s.slice(start, to));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). Blocks are written straight into one output
 * array; only the first paragraph and level 2/3 headings take a detour through
 * a temporary array, because their HTML is also kept as a string.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const kinds = classifyLines(lines);
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const kind = kinds[i];
    const line = lines[i];
    if (kind === K_BLANK) { i++; continue; }
    if (kind === K_FENCE) {
      const fence = fenceOpen(line);
      const body = [];
      i++;
      // A body ends at a fence CLOSE (``` with no language); a ```lang line
      // inside is body content, so this check is not the kind.
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre><code');
      if (fence !== '') out.push(` class="language-${escapeHtml(fence)}"`);
      out.push('>');
      for (const l of body) {
        out.push(escapeHtml(l));
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === K_HEADING) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      if (heading.depth === 2 || heading.depth === 3) {
        const tmp = [];
        inlineInto(heading.text, 0, heading.text.length, env, tmp);
        const html = tmp.join('');
        toc.push({ level: heading.depth, id, html });
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      } else {
        out.push(`<h${heading.depth} id="${id}">`);
        inlineInto(heading.text, 0, heading.text.length, env, out);
        out.push(`</h${heading.depth}>\n`);
      }
      i++;
      continue;
    }
    if (kind === K_HR) { out.push('<hr>\n'); i++; continue; }
    if (kind === K_QUOTE) { // >
      const body = [];
      while (i < n && kinds[i] === K_QUOTE) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') inner.push(t);
      }
      if (inner.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = inner.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === K_BULLET || kind === K_ORDERED) {
      const isOrdered = kind === K_ORDERED;
      const items = [];
      while (i < n) {
        const k = kinds[i];
        if (isOrdered ? k === K_ORDERED : k === K_BULLET) {
          const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
          items.push([trimLine(isOrdered ? m.rest : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = isOrdered ? orderedOf(line).num : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const item of items) {
        const text = item.join('\n');
        out.push('<li>');
        inlineInto(text, 0, text.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n) {
      const k = kinds[i];
      if (k === K_BLANK || k === K_FENCE || k === K_HEADING || k === K_HR) break;
      body.push(trimLine(lines[i++]));
    }
    const text = body.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineInto(text, 0, text.length, env, tmp);
      excerpt = tmp.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` from `i` holds only spaces or tabs. */
function spacesOnly(s, i, end) {
  for (; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
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
    const standalone = spacesOnly(src, lineStart, open) && spacesOnly(src, end, lineEnd);
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
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

/**
 * `nodes` rendered into `out`, in the scope stack. `ctx` holds the parsed
 * templates and the per-case cache of templates whose output never varies.
 */
function renderNodes(nodes, scopes, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scopes, node.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scopes, node.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scopes, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scopes, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scopes, node.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          scopes.push({ [node.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } });
          renderNodes(node.body, scopes, ctx, depth, out);
          scopes.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          const c = ctx.constCache.get(node.name);
          if (c !== undefined && depth + c.depth < INCLUDE_DEPTH) out.push(c.text);
          else renderNodes(t, scopes, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/**
 * Which templates render the same string wherever they are included: a
 * template whose every free read is one of the build's globals (site, tags,
 * recent) and whose includes are constant too, with no for anywhere binding a
 * global's name. `depth` is the deepest include chain below the template, so
 * the cached string is only used where the whole chain still renders.
 */
function constantTemplates(templates) {
  const GLOBALS = new Set(['site', 'tags', 'recent']);
  const bound = new Set();
  const freeOf = new Map();
  const collect = (nodes, boundHere, free) => {
    for (const node of nodes) {
      if (node.kind === 'var' || node.kind === 'raw') {
        if (!boundHere.has(node.path[0])) free.add(node.path[0]);
      } else if (node.kind === 'if') {
        if (!boundHere.has(node.path[0])) free.add(node.path[0]);
        collect(node.then, boundHere, free);
        if (node.else !== null) collect(node.else, boundHere, free);
      } else if (node.kind === 'for') {
        if (!boundHere.has(node.path[0])) free.add(node.path[0]);
        bound.add(node.name);
        bound.add('loop');
        const inner = new Set(boundHere);
        inner.add(node.name);
        inner.add('loop');
        collect(node.body, inner, free);
      }
    }
  };
  for (const [name, nodes] of templates) {
    const free = new Set();
    collect(nodes, new Set(), free);
    freeOf.set(name, free);
  }
  if ([...bound].some((b) => GLOBALS.has(b))) return new Map();
  const depthOf = new Map();
  const visiting = new Set();
  const depth = (name) => {
    if (depthOf.has(name)) return depthOf.get(name);
    if (visiting.has(name)) return Infinity;
    const nodes = templates.get(name);
    if (nodes === undefined) return 0;
    visiting.add(name);
    let d = 0;
    for (const node of nodes) {
      if (node.kind === 'include') d = Math.max(d, 1 + depth(node.name));
      else if (node.kind === 'for') d = Math.max(d, depthNodes(node.body));
      else if (node.kind === 'if') d = Math.max(d, depthNodes(node.then), node.else === null ? 0 : depthNodes(node.else));
    }
    visiting.delete(name);
    depthOf.set(name, d);
    return d;
  };
  const depthNodes = (nodes) => {
    let d = 0;
    for (const node of nodes) {
      if (node.kind === 'include') d = Math.max(d, 1 + depth(node.name));
      else if (node.kind === 'for') d = Math.max(d, depthNodes(node.body));
      else if (node.kind === 'if') d = Math.max(d, depthNodes(node.then), node.else === null ? 0 : depthNodes(node.else));
    }
    return d;
  };
  const isConst = (name, seen) => {
    if (seen.has(name)) return false;
    const free = freeOf.get(name);
    if (free === undefined) return false;
    for (const f of free) if (!GLOBALS.has(f)) return false;
    seen.add(name);
    const nodes = templates.get(name);
    const walk = (ns) => {
      for (const node of ns) {
        if (node.kind === 'include') {
          if (!templates.has(node.name) || !isConst(node.name, seen)) return false;
        } else if (node.kind === 'for') {
          if (!walk(node.body)) return false;
        } else if (node.kind === 'if') {
          if (!walk(node.then)) return false;
          if (node.else !== null && !walk(node.else)) return false;
        }
      }
      return true;
    };
    const ok = walk(nodes);
    seen.delete(name);
    return ok;
  };
  const out = new Map();
  for (const name of templates.keys()) {
    if (isConst(name, new Set()) && depth(name) <= INCLUDE_DEPTH) out.set(name, depth(name));
  }
  return out;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  slugMemo = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const constDepths = constantTemplates(templates);
  const ctx = { templates, constCache: new Map() };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter; a refused source is reported and dropped,
  // and so is a draft.
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
  sources = kept;

  // 3. Each page's output directory and url.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        const ck = `${dir}|${rel}`;
        if (resolveCache.has(ck)) path = resolveCache.get(ck);
        else {
          path = rel === '' ? null : resolvePath(dir, rel);
          resolveCache.set(ck, path);
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${spath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages.
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
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const renderInto = (name, vars, out) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return false;
    const scopes = [{ site, tags: allTags, recent, ...vars }];
    renderNodes(nodes, scopes, ctx, 0, out);
    return true;
  };
  // Render each constant template once, against the globals alone.
  for (const [name, d] of constDepths) {
    const nodes = templates.get(name);
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent }], ctx, 0, out);
    ctx.constCache.set(name, { text: out.join(''), depth: d });
  }
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const s of sources) {
    const out = [];
    renderInto(s.layout, { page: pageOf(s) }, out);
    output[`${s.outDir}/index.html`] = out.join('');
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const out = [];
    if (renderInto('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    }, out)) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = out.join('');
  }
  for (const t of tags) {
    const out = [];
    if (renderInto('tag', { tag: tagOf(t) }, out)) output[`tags/${t.slug}/index.html`] = out.join('');
  }
  const tagsOut = [];
  if (renderInto('tags', {}, tagsOut)) output['tags/index.html'] = tagsOut.join('');
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
