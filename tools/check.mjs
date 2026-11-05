// Lists extracted strings that neither ko.json (entries or patterns) nor keep-english.json covers.
// Usage: node tools/check.mjs [--strings strings.json] [--dir mods/ko] [--strict]   (--strict: exit 1 on any gap)
import path from 'node:path';
import { parseArgs } from 'node:util';
import { translateText } from '../mods/ko/translate.mjs';
import { MOD_DIR, STRINGS_FILE, dictionary, isEntry, readJson } from './common.mjs';

// Pure: the strings not covered, in input order.
export function uncovered(strings, { entries, patterns, keep }) {
  return strings.filter((s) => !Object.hasOwn(keep, s) && translateText(s, entries, patterns) === s);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { strings: { type: 'string' }, dir: { type: 'string' }, strict: { type: 'boolean' } } });
  const file = path.resolve(values.strings ?? STRINGS_FILE);
  const { strings } = readJson(file);
  const gaps = uncovered(strings, dictionary(values.dir ?? MOD_DIR));
  for (const s of gaps) console.log(`uncovered: ${s}`);
  console.log(`check: ${gaps.length} uncovered of ${strings.length} strings (${file})`);
  if (values.strict && gaps.length > 0) process.exitCode = 1;
}

if (isEntry(import.meta.url)) main(process.argv.slice(2));
