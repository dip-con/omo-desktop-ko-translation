// Extracts UI string literals from the installed OmO client bundle. Read only: APP_DIR is never written.
// Usage: node tools/extract-strings.mjs --out mods/ko/strings.json
import fs from 'node:fs';
import { importLoader } from './loader-import.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasLoader, loaderDir } from './loader-dir.mjs';
const readConfigAppExe = hasLoader() ? (await importLoader('deps.mjs')).readConfigAppExe : null;

export const APP_DIR = readConfigAppExe ? path.dirname(readConfigAppExe()) : null;

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// Reads one entry of app.asar from its header, in memory only (same layout as tools/probe-app.mjs).
function readAsarEntry(asarPath, inner) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerPickle = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const seg of inner.split('/')) node = node.files[seg];
    if (!node || node.size === undefined) throw new Error(`asar entry not found: ${inner}`);
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, 8 + headerPickle + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// Same four-part fingerprint as docs/app-facts.json (copied: probe-app.mjs is a script, not a module).
export function readFingerprint(appDir) {
  const pkg = JSON.parse(readAsarEntry(`${appDir}/resources/app.asar`, 'package.json').toString('utf8'));
  const bm = JSON.parse(fs.readFileSync(`${appDir}/resources/omo-runtime/win32-x64/bundle-manifest.json`, 'utf8'));
  return {
    appVersion: pkg.version,
    client: sha256File(`${appDir}/resources/omo-server/client/index.html`),
    runtime: { omoRef: bm.omoRef, omoSha: bm.resolvedShas && bm.resolvedShas.omo },
    plugin: sha256File(`${appDir}/resources/omo-runtime/win32-x64/plugin/extensions/omo.js`),
  };
}

// Literal sources: `...` (group 1) or "..." (group 2), escapes allowed, no raw newline.
const CHILDREN_RE = /children:(?:`((?:[^`\\\n]|\\.)*)`|"((?:[^"\\\n]|\\.)*)")/g;
const ATTR_RE = /(?:\b(?:label|title|description|placeholder|tooltip)|"aria-label"):(?:`((?:[^`\\\n]|\\.)*)`|"((?:[^"\\\n]|\\.)*)")/g;
const SETTINGS_RE = /"\/settings\/[a-z-]+":(?:`((?:[^`\\\n]|\\.)*)`|"((?:[^"\\\n]|\\.)*)")/g;
const SOURCES = [CHILDREN_RE, ATTR_RE, SETTINGS_RE];

const unescapeLiteral = (raw) => raw.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 't' ? ' ' : c));

// Returns the cleaned string, or null when the literal is not screen text.
export function keepCandidate(raw) {
  if (raw.includes('${')) return null;
  const s = unescapeLiteral(raw).trim();
  if (s.length < 1 || s.length > 120) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  if (/:\/\/|^(mailto|file|data|omo):/i.test(s)) return null;
  if (/[{}<>]/.test(s)) return null;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return null;
  const hasSpace = /\s/.test(s);
  if (!hasSpace && s.includes('/')) return null;
  if (!hasSpace && /[a-z][A-Z]|[-_.]/.test(s)) return null;
  const tokens = s.split(/\s+/);
  if (!/[A-Z]/.test(s) && /[-:[\]]/.test(s) && tokens.every((t) => /^[!a-z0-9:\-[\]/.%_()#]+$/.test(t))) return null;
  return s;
}

export function extractStrings(texts) {
  const found = new Set();
  for (const text of texts) {
    for (const re of SOURCES) {
      for (const m of text.matchAll(re)) {
        const s = keepCandidate(m[1] ?? m[2]);
        if (s !== null) found.add(s);
      }
    }
  }
  return [...found].sort();
}

// Runtime-only strings live in mods/ko/extra-strings.json. Every regeneration merges them back in, so they are never dropped.
export const EXTRAS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../mods/ko/extra-strings.json');
export function mergeExtras(strings, extras) {
  return [...new Set([...strings, ...extras])].sort();
}

// Template literals with ${...} that carry screen text; these become ko.json patterns by hand.
export function templateCandidates(texts) {
  const found = new Set();
  const re = /(?:children:|\b(?:label|title|description|placeholder|tooltip):)`((?:[^`\\\n]|\\.)*)`/g;
  for (const text of texts) {
    for (const m of text.matchAll(re)) if (m[1].includes('${')) found.add(m[1]);
  }
  return [...found].sort();
}

function main(argv) {
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1]) {
    console.error('usage: node tools/extract-strings.mjs --out <file>');
    process.exit(2);
  }
  if (!APP_DIR) loaderDir();
  const out = argv[i + 1];
  const assets = path.join(APP_DIR, 'resources/omo-server/client/assets');
  const files = fs.readdirSync(assets).filter((f) => f.endsWith('.js')).sort();
  const texts = files.map((f) => fs.readFileSync(path.join(assets, f), 'utf8'));
  const extras = fs.existsSync(EXTRAS_PATH) ? JSON.parse(fs.readFileSync(EXTRAS_PATH, 'utf8')).strings : [];
  const strings = mergeExtras(extractStrings(texts), extras);
  const doc = {
    fingerprint: readFingerprint(APP_DIR),
    extractedAt: new Date().toISOString(),
    count: strings.length,
    strings,
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`extracted ${strings.length} strings from ${files.length} files -> ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
