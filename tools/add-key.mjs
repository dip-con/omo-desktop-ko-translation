// Registers one string found at runtime: a Korean translation in mods/ko/ko.json (with its provenance in
// manual.json as {ko, source: "runtime", note}), or a keep-english.json entry with --keep-english. The string is
// then removed from pending.json. ko.json entries stay plain strings: the runtime reads them directly.
// Usage: node tools/add-key.mjs "<english>" "<korean>" [--note <text>] [--dir <mods/ko folder>]
//        node tools/add-key.mjs "<english>" --keep-english <reason> [--dir <mods/ko folder>]
import { isEntry } from './is-entry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MOD_DIR, modFiles, readJson, writeJson } from './dictionary-files.mjs';

export const DEFAULT_NOTE = 'added from a runtime miss (tools/add-key.mjs)';

export class AddKeyError extends Error {}

// Applies one request to the dictionary files under modDir. Returns { kind: 'ko' | 'keep-english', text }.
export function addKey({ modDir, english, korean, note, keepEnglish }) {
  const text = english ?? '';
  if (text.trim() === '' || text !== text.trim()) throw new AddKeyError('the English text must be non-empty with no leading or trailing spaces');
  const files = modFiles(modDir);
  const ko = readJson(files.ko);
  const keep = readJson(files.keep);
  if (Object.hasOwn(ko.entries, text)) throw new AddKeyError(`already in ko.json: ${JSON.stringify(text)} -> ${JSON.stringify(ko.entries[text])}`);
  if (Object.hasOwn(keep.entries, text)) throw new AddKeyError(`already in keep-english.json: ${JSON.stringify(text)}`);
  let kind;
  if (keepEnglish !== undefined) {
    if (korean !== undefined) throw new AddKeyError('give either a Korean text or --keep-english, not both');
    if (keepEnglish.trim() === '') throw new AddKeyError('--keep-english needs a reason');
    writeJson(files.keep, { ...keep, entries: { ...keep.entries, [text]: keepEnglish } });
    kind = 'keep-english';
  } else {
    if (korean === undefined || korean.trim() === '') throw new AddKeyError('a Korean text is required (or --keep-english <reason>)');
    const manual = readJson(files.manual);
    writeJson(files.ko, { ...ko, entries: { ...ko.entries, [text]: korean } });
    writeJson(files.manual, { ...manual, entries: { ...manual.entries, [text]: { ko: korean, source: 'runtime', note: note ?? DEFAULT_NOTE } } });
    kind = 'ko';
  }
  if (fs.existsSync(files.pending)) {
    const pending = readJson(files.pending);
    writeJson(files.pending, { ...pending, strings: pending.strings.filter((p) => p.text !== text) });
  }
  return { kind, text };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { note: { type: 'string' }, 'keep-english': { type: 'string' }, dir: { type: 'string' } },
  });
  try {
    const result = addKey({ modDir: values.dir ?? DEFAULT_MOD_DIR, english: positionals[0], korean: positionals[1], note: values.note, keepEnglish: values['keep-english'] });
    console.log(JSON.stringify(result));
  } catch (e) {
    if (!(e instanceof AddKeyError)) throw e;
    console.error(`add-key: ${e.message}`);
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) main(process.argv.slice(2));
