// Turns the runtime miss list (<state dir>/ko-missing.json, written by mods/ko/host.mjs) into pending.json:
// the strings still uncovered, most seen first. Earlier pending strings stay while uncovered; runtime counts win.
// Usage: node tools/collect.mjs [--from ko-missing.json] [--out pending.json] [--dir mods/ko]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MISSING_FILE } from '../mods/ko/host.mjs';
import { uncovered } from './check.mjs';
import { MOD_DIR, PENDING_FILE, dictionary, isEntry, loaderCore, readJson, writeJson } from './common.mjs';

// Pure: misses is ko-missing.json's strings object, previous the old pending.json strings array.
export function collectPending({ misses, previous, dict }) {
  const byText = new Map(previous.map((p) => [p.text, p]));
  for (const [text, m] of Object.entries(misses)) byText.set(text, { text, count: m.count, lastSeen: m.lastSeen });
  const open = new Set(uncovered([...byText.keys()], dict));
  return [...byText.values()].filter((p) => open.has(p.text)).sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { from: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string' } } });
  const from = values.from ?? path.join((await loaderCore('paths')).stateDir(), MISSING_FILE);
  const out = path.resolve(values.out ?? PENDING_FILE);
  const misses = fs.existsSync(from) ? (readJson(from).strings ?? {}) : {};
  const previous = fs.existsSync(out) ? readJson(out).strings : [];
  const strings = collectPending({ misses, previous, dict: dictionary(values.dir ?? MOD_DIR) });
  writeJson(out, { generatedAt: new Date().toISOString(), strings });
  console.log(JSON.stringify({ from, found: fs.existsSync(from), out, pending: strings.length }));
}

if (isEntry(import.meta.url)) await main(process.argv.slice(2));
