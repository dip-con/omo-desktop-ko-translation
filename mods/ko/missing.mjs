// Runtime miss recorder for the ko mod. Text the page asked to translate that came back unchanged, and that looks
// like interface copy, is counted into <state dir>/ko-missing.json so tools/collect-missing.mjs can turn it into
// dictionary work. Writes are batched (at most one per FLUSH_MS), atomic (temp file + rename) and capped at MAX_KEYS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FLUSH_MS = 2000;
export const MAX_KEYS = 5000;
const MIN_LENGTH = 2;
const MAX_LENGTH = 120;

// Same rule as the loader's defaultStateDir(): LOADER_STATE_DIR, else ~/Library/Application Support/omo-app-mods.
export function stateDir(env = process.env) {
  return env.LOADER_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods');
}

export const missingFile = (env = process.env) => path.join(stateDir(env), 'ko-missing.json');

// Whether trimmed text reads as interface copy: a Latin letter, 2..120 characters, not a keep-english key, and not
// a number with a unit, a URL, a path or a code identifier.
export function looksLikeUiText(text, keepEnglish) {
  if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return false;
  if (!/[A-Za-z]/.test(text) || keepEnglish.has(text)) return false;
  if (/^[\d\s.,:;%+\-x×/]*[A-Za-z]{0,3}$/.test(text) && /\d/.test(text)) return false;
  if (/:\/\/|^(mailto|file|data|www\.)/i.test(text)) return false;
  if (/^(~|\.{1,2})?\//.test(text) || /^[A-Za-z]:\\/.test(text)) return false;
  const oneWord = !/\s/.test(text);
  if (oneWord && /[/\\]/.test(text)) return false;
  if (oneWord && /[a-z][A-Z]|[_.]|::|^-|\(\)$/.test(text)) return false;
  return true;
}

// Pure: doc with the pending counts added. Over MAX_KEYS, the keys seen least recently are dropped.
export function mergeMissing(doc, pending, now) {
  const strings = { ...(doc?.version === 1 && doc.strings !== null && typeof doc.strings === 'object' ? doc.strings : {}) };
  for (const [text, count] of pending) {
    const prev = strings[text];
    strings[text] = prev ? { count: prev.count + count, firstSeen: prev.firstSeen, lastSeen: now } : { count, firstSeen: now, lastSeen: now };
  }
  const keys = Object.keys(strings);
  if (keys.length <= MAX_KEYS) return { version: 1, strings };
  const kept = keys.sort((a, b) => (strings[b].lastSeen < strings[a].lastSeen ? -1 : strings[b].lastSeen > strings[a].lastSeen ? 1 : 0)).slice(0, MAX_KEYS);
  return { version: 1, strings: Object.fromEntries(kept.map((k) => [k, strings[k]])) };
}

function readDoc(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`ko mod: ${file} is not valid JSON (${e.message}); starting a new miss list`);
    return null;
  }
}

// One recorder per host process. schedule is the timer (tests pass their own); the file path is read at flush time.
export function createRecorder({ file = () => missingFile(), now = () => new Date().toISOString(), schedule = (fn, ms) => setTimeout(fn, ms).unref() } = {}) {
  let pending = new Map();
  let timer = null;
  let exitHooked = false;

  function flush() {
    timer = null;
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    const target = file();
    try {
      const doc = mergeMissing(readDoc(target), batch, now());
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, target);
    } catch (e) {
      // Recording is a side channel: a failed write must never break translation, so it is reported and dropped.
      console.error(`ko mod: could not record ${batch.size} missing strings to ${target}: ${e.message}`);
    }
  }

  function record(text) {
    pending.set(text, (pending.get(text) ?? 0) + 1);
    if (!exitHooked) {
      exitHooked = true;
      process.once('exit', flush);
    }
    timer ??= schedule(flush, FLUSH_MS);
  }

  return { record, flush, pendingCount: () => pending.size };
}
