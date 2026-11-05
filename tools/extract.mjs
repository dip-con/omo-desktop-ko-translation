// Extracts UI copy from the installed OmO client: every asset whose file name contains "settings" plus the main
// app chunk that index.html loads. Read only. Writes {app, extractedAt, files, count, strings} (strings.json is gitignored).
// Usage: node tools/extract.mjs [--out strings.json] [--app /Applications/OmO.app]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { STRINGS_FILE, isEntry, loaderCore, writeJson } from './common.mjs';

const REGEX_BEFORE = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new)$/;

// Every string and template literal of a JS source. A template yields its static parts (quasis) separately.
// ctx is the code before the literal with earlier literal contents blanked, so commas inside strings never count.
export function scanLiterals(src) {
  const out = [];
  const templates = []; // open `${` depth per template nesting level
  let skel = ''; // only the recent tail is kept: contexts need 120 characters
  const emit = (s) => {
    skel += s;
    if (skel.length > 600) skel = skel.slice(-300);
  };
  let i = 0;
  const readQuoted = (q) => {
    let j = i + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    out.push({ quasis: [src.slice(i + 1, j)], ctx: skel.slice(-120) });
    emit('""');
    i = j + 1;
  };
  // Reads template text from i (just after ` or }) to the closing ` or the next ${.
  const readQuasi = (lit) => {
    let j = i;
    while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
    lit.quasis.push(src.slice(i, j));
    if (src[j] === '`') {
      emit('`');
      i = j + 1;
    } else {
      templates.push({ depth: 0, lit });
      emit('${');
      i = j + 2;
    }
  };
  const skipRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
      if (src[j] === '\\') j += 1;
      else if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      j += 1;
    }
    emit('/r/');
    i = j + 1;
  };
  while (i < src.length) {
    const c = src[i];
    const top = templates.at(-1);
    if (c === '"' || c === "'") readQuoted(c);
    else if (c === '`') {
      const lit = { quasis: [], ctx: skel.slice(-120) };
      out.push(lit);
      emit('`');
      i += 1;
      readQuasi(lit);
    } else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) === -1 ? src.length : src.indexOf('*/', i + 2) + 2;
    else if (c === '/' && (REGEX_BEFORE.has(skel.trimEnd().at(-1) ?? '(') || REGEX_KEYWORDS.test(skel.trimEnd()))) skipRegex();
    else if (c === '}' && top && top.depth === 0) {
      templates.pop();
      emit('}');
      i += 1;
      readQuasi(top.lit);
    } else {
      if (top && c === '{') top.depth += 1;
      if (top && c === '}') top.depth -= 1;
      emit(c);
      i += 1;
    }
  }
  return out;
}

const unescape = (raw) =>
  raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e) => {
    if (e === 'n' || e === 't' || e === 'r') return ' ';
    if (e[0] === 'u' || (e[0] === 'x' && e.length === 3)) return String.fromCodePoint(parseInt(e.replace(/[u{}x]/g, ''), 16));
    return e;
  });

// Literals in the value of one of these keys are UI copy (also through a ternary or ??).
const KEYED = /(?:\b(?:children|label|title|description|placeholder|tooltip)|"aria-label"|"\/settings\/[a-z-]+")\s*:[^,;{}()]*$/;

// The cleaned text when it reads as screen copy, else null.
export function copyOf(raw) {
  const s = unescape(raw).replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > 160 || !/[A-Za-z]/.test(s)) return null;
  if (/:\/\/|^(mailto|file|data|omo):/i.test(s) || /[{}<>`\\]/.test(s) || /^#[0-9a-f]{3,8}$/i.test(s)) return null;
  const hasSpace = s.includes(' ');
  if (!hasSpace && (s.includes('/') || /[a-z][A-Z]|[-_.]/.test(s))) return null;
  if (!/[A-Z]/.test(s) && /[-:[\]]/.test(s) && s.split(' ').every((t) => /^[!a-z0-9:\-[\]/.%_()#]+$/.test(t))) return null;
  return s;
}

// A sentence anywhere in the code: capitalised first word, at least three words, no code punctuation.
const isSentence = (s) => /^[A-Z][a-z’']*,? \S+ \S/.test(s) && /[a-z]{2}/.test(s) && !/[=;|&$]|\w\(|\)\w|\.\w/.test(s.replace(/\b(e\.g|i\.e|etc)\./g, ''));

export function extractStrings(sources) {
  const found = new Set();
  for (const src of sources) {
    for (const { quasis, ctx } of scanLiterals(src)) {
      const whole = quasis.length === 1 ? copyOf(quasis[0]) : null;
      if (whole !== null && (KEYED.test(ctx) || isSentence(whole))) found.add(whole);
      if (quasis.length > 1) {
        for (const q of quasis) {
          const part = copyOf(q);
          // A part cut off at an opening quote or bracket is half a sentence; patterns cover those.
          if (part !== null && isSentence(part) && !/["'(“‘]$/.test(part)) found.add(part);
        }
      }
    }
  }
  return [...found].sort();
}

// Settings assets plus the chunks index.html's entry script imports. Only plain .js files.
export function assetFiles(clientDir) {
  const assets = path.join(clientDir, 'assets');
  const names = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
  const html = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
  const entry = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  const main = new Set(entry ? [entry] : []);
  if (entry) for (const m of fs.readFileSync(path.join(assets, entry), 'utf8').matchAll(/from"\.\/([^"]+\.js)"/g)) main.add(m[1]);
  return names.filter((f) => f.includes('settings') || main.has(f)).sort().map((f) => path.join(assets, f));
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' }, app: { type: 'string' } } });
  const [paths, app] = [await loaderCore('paths'), await loaderCore('app')];
  const bundle = values.app ?? paths.APP_BUNDLE;
  const files = assetFiles(path.join(paths.appResources(bundle), 'omo-server', 'client'));
  const strings = extractStrings(files.map((f) => fs.readFileSync(f, 'utf8')));
  const out = path.resolve(values.out ?? STRINGS_FILE);
  writeJson(out, { app: app.appInfo(bundle), extractedAt: new Date().toISOString(), files: files.length, count: strings.length, strings });
  console.log(`extract: ${strings.length} strings from ${files.length} files -> ${out}`);
}

if (isEntry(import.meta.url)) await main(process.argv.slice(2));
