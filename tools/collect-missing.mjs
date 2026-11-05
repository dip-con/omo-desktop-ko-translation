// Turns the runtime miss list (ko-missing.json, written by mods/ko/host.mjs) into mods/ko/pending.json: the strings
// still unhandled, i.e. not translated by ko.json (entries or patterns) and not listed in keep-english.json or
// manual.json. Strings already in pending.json stay while they are unhandled; runtime counts replace theirs.
// Usage: node tools/collect-missing.mjs [--from <ko-missing.json>] [--out <pending.json>] [--dir <mods/ko folder>]
import { isEntry } from './is-entry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { missingFile } from '../mods/ko/missing.mjs';
import { translateText } from '../mods/ko/translate.mjs';
import { DEFAULT_MOD_DIR, modFiles, readJson, writeJson } from './dictionary-files.mjs';

// Pure: the pending list. misses is ko-missing.json's strings object; previous is the old pending.json strings array.
export function collectPending({ misses, previous, ko, keep, manual }) {
  const handled = (text) => Object.hasOwn(keep.entries, text) || Object.hasOwn(manual.entries, text) || translateText(text, ko.entries, ko.patterns ?? {}) !== text;
  const byText = new Map(previous.map((p) => [p.text, p]));
  for (const [text, m] of Object.entries(misses)) byText.set(text, { text, count: m.count, lastSeen: m.lastSeen });
  return [...byText.values()].filter((p) => !handled(p.text)).sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { from: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string' } } });
  const files = modFiles(values.dir ?? DEFAULT_MOD_DIR);
  const from = values.from ?? missingFile();
  const out = values.out ?? files.pending;
  const misses = fs.existsSync(from) ? readJson(from).strings ?? {} : {};
  const previous = fs.existsSync(out) ? readJson(out).strings : [];
  const strings = collectPending({ misses, previous, ko: readJson(files.ko), keep: readJson(files.keep), manual: readJson(files.manual) });
  writeJson(out, { generatedAt: new Date().toISOString(), strings });
  console.log(JSON.stringify({ from, exists: fs.existsSync(from), out: path.resolve(out), pending: strings.length }));
}

if (isEntry(import.meta.url)) main(process.argv.slice(2));
