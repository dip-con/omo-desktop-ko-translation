// Adds translations to mods/ko/ko.json (keys kept sorted) or a keep-english.json entry, then drops those strings
// from pending.json. Usage:
//   node tools/add-key.mjs "<english>" "<korean>"
//   node tools/add-key.mjs --file pairs.json            ({"<english>": "<korean>", ...})
//   node tools/add-key.mjs "<english>" --keep-english "<reason>"
//   common options: [--dir mods/ko] [--pending pending.json] [--replace]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MOD_DIR, PENDING_FILE, isEntry, readJson, writeJson } from './common.mjs';

export class AddKeyError extends Error {}

const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

// pairs: [[english, value]]. kind 'ko' writes ko.json entries, 'keep' writes keep-english.json reasons.
// An existing key is refused unless replace is set. Returns the English texts written.
export function addKeys({ modDir = MOD_DIR, pendingFile = PENDING_FILE, pairs, kind = 'ko', replace = false }) {
  const koFile = path.join(modDir, 'ko.json');
  const keepFile = path.join(modDir, 'keep-english.json');
  const ko = readJson(koFile);
  const keep = readJson(keepFile);
  for (const [en, value] of pairs) {
    if (typeof en !== 'string' || en.trim() === '' || en !== en.trim()) throw new AddKeyError(`English text must be non-empty with no outer spaces: ${JSON.stringify(en)}`);
    if (typeof value !== 'string' || value.trim() === '') throw new AddKeyError(`missing ${kind === 'ko' ? 'Korean text' : 'reason'} for ${JSON.stringify(en)}`);
    if (!replace && (Object.hasOwn(ko.entries, en) || Object.hasOwn(keep.entries, en))) throw new AddKeyError(`already registered: ${JSON.stringify(en)}`);
  }
  const target = kind === 'ko' ? ko : keep;
  target.entries = sorted({ ...target.entries, ...Object.fromEntries(pairs) });
  writeJson(kind === 'ko' ? koFile : keepFile, target);
  const texts = pairs.map(([en]) => en);
  if (fs.existsSync(pendingFile)) {
    const pending = readJson(pendingFile);
    writeJson(pendingFile, { ...pending, strings: pending.strings.filter((p) => !texts.includes(p.text)) });
  }
  return texts;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { file: { type: 'string' }, 'keep-english': { type: 'string' }, dir: { type: 'string' }, pending: { type: 'string' }, replace: { type: 'boolean' } },
  });
  const keepReason = values['keep-english'];
  let pairs;
  if (values.file !== undefined) pairs = Object.entries(readJson(values.file));
  else if (keepReason !== undefined) pairs = [[positionals[0], keepReason]];
  else pairs = [[positionals[0], positionals[1]]];
  try {
    const kind = keepReason === undefined ? 'ko' : 'keep';
    const texts = addKeys({ modDir: values.dir, pendingFile: values.pending, pairs, kind, replace: values.replace });
    console.log(JSON.stringify({ kind, added: texts.length }));
  } catch (e) {
    if (!(e instanceof AddKeyError)) throw e;
    console.error(`add-key: ${e.message}`);
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) main(process.argv.slice(2));
