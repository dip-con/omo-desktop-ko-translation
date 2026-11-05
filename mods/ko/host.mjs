// Host side of the ko mod. page.js asks it for the exclusion list (config) and for translations (translate).
// Text that comes back unchanged and reads as interface copy is counted into <ctx.stateDir>/ko-missing.json when
// the page passes {record: true}; tools/collect.mjs turns that file into dictionary work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateText } from './translate.mjs';

// Text and attributes inside these are never changed. Key caps (kbd[data-slot="kbd"]) are key names, not copy.
export const EXCLUSION_SELECTORS = [
  'pre', 'code', '.ProseMirror', 'textarea', 'input', '[contenteditable]', '[role="log"]', '[role="tree"]',
  '[data-diff]', '.xterm', '[data-omo-mod-root]', 'kbd[data-slot="kbd"]',
];
export const MAX_BATCH = 500;
export const MISSING_FILE = 'ko-missing.json';
export const FLUSH_MS = 2000;
export const MAX_KEYS = 5000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
let dict = null;

function dictionary() {
  if (dict === null) {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));
    const ko = read('ko.json');
    dict = { entries: ko.entries, patterns: ko.patterns ?? {}, keep: new Set(Object.keys(read('keep-english.json').entries)) };
  }
  return dict;
}

// Whether trimmed text reads as interface copy: a Latin letter, 2..120 characters, not kept English on purpose,
// and not a number with a unit, a URL, a path or a code identifier.
export function looksLikeUiText(text, keepEnglish) {
  if (text.length < 2 || text.length > 120 || !/[A-Za-z]/.test(text) || keepEnglish.has(text)) return false;
  if (/^[\d\s.,:;%+\-x×/]*[A-Za-z]{0,3}$/.test(text) && /\d/.test(text)) return false;
  if (/:\/\/|^(mailto|file|data|www\.)/i.test(text) || /^(~|\.{1,2})?\//.test(text)) return false;
  const oneWord = !/\s/.test(text);
  return !(oneWord && (/[/\\]/.test(text) || /[a-z][A-Z]|[_.]|::|^-|\(\)$/.test(text)));
}

// Pure: doc ({version: 1, strings: {text: {count, firstSeen, lastSeen}}}) plus the pending counts. Over MAX_KEYS
// the least recently seen keys are dropped.
export function mergeMissing(doc, pending, now) {
  const strings = doc?.version === 1 && doc.strings && typeof doc.strings === 'object' ? { ...doc.strings } : {};
  for (const [text, count] of pending) {
    const prev = strings[text];
    strings[text] = { count: (prev?.count ?? 0) + count, firstSeen: prev?.firstSeen ?? now, lastSeen: now };
  }
  const keys = Object.keys(strings);
  if (keys.length <= MAX_KEYS) return { version: 1, strings };
  const kept = keys.sort((a, b) => strings[b].lastSeen.localeCompare(strings[a].lastSeen)).slice(0, MAX_KEYS);
  return { version: 1, strings: Object.fromEntries(kept.map((k) => [k, strings[k]])) };
}

// Batches misses per state dir: at most one atomic write per FLUSH_MS, plus one at process exit. A failed write is
// reported and dropped; recording must never break translation.
export function createRecorder({ now = () => new Date().toISOString(), schedule = (fn, ms) => setTimeout(fn, ms).unref() } = {}) {
  const pending = new Map(); // file -> Map(text -> count)
  let timer = null;
  let exitHooked = false;

  function flush() {
    timer = null;
    for (const [file, batch] of pending) {
      pending.delete(file);
      try {
        let doc = null;
        try {
          doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          if (e.code !== 'ENOENT') console.error(`ko mod: ${file} unreadable (${e.message}); starting a new list`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(mergeMissing(doc, batch, now()), null, 2)}\n`);
        fs.renameSync(tmp, file);
      } catch (e) {
        console.error(`ko mod: could not record ${batch.size} missing strings to ${file}: ${e.message}`);
      }
    }
  }

  function record(file, text) {
    if (!exitHooked) {
      exitHooked = true;
      process.once('exit', flush);
    }
    const batch = pending.get(file) ?? new Map();
    batch.set(text, (batch.get(text) ?? 0) + 1);
    pending.set(file, batch);
    timer ??= schedule(flush, FLUSH_MS);
  }

  return { record, flush };
}

export const recorder = createRecorder();

// Bridge entry point. ctx = {modId, modDir, stateDir, modsHome} from the loader.
export function handle(method, args, ctx) {
  if (method === 'config') return { exclusionSelectors: EXCLUSION_SELECTORS };
  if (method === 'translate') {
    const [texts, opts] = args;
    if (!Array.isArray(texts) || texts.length > MAX_BATCH || !texts.every((t) => typeof t === 'string')) {
      throw new Error(`translate takes one array of at most ${MAX_BATCH} strings`);
    }
    const { entries, patterns, keep } = dictionary();
    const file = opts?.record === true && ctx?.stateDir ? path.join(ctx.stateDir, MISSING_FILE) : null;
    return texts.map((t) => {
      const out = translateText(t, entries, patterns);
      if (file !== null && out === t && looksLikeUiText(t.trim(), keep)) recorder.record(file, t.trim());
      return out;
    });
  }
  throw new Error(`unknown method ${method}`);
}
