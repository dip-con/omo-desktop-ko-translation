#!/usr/bin/env node
// Checks the ko dictionary against the extracted strings: every dictionary fingerprint must match strings.json, and every
// extracted string must be a key of ko.json or keep-english.json. Exits 1 on any mismatch or gap.
// Usage: node tools/dictionary-check.mjs [--dir <folder holding strings.json, ko.json, keep-english.json>]
import { isEntry } from './is-entry.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mods', 'ko');

// Pure: the dictionaries whose fingerprint differs from strings.json, and the extracted strings neither dictionary has.
export function checkDictionary({ strings, ko, keep }) {
  const expected = JSON.stringify(strings.fingerprint);
  const mismatches = [['ko.json', ko], ['keep-english.json', keep]]
    .filter(([, dict]) => JSON.stringify(dict.fingerprint) !== expected)
    .map(([name]) => name);
  const covered = new Set([...Object.keys(ko.entries), ...Object.keys(keep.entries)]);
  const missing = strings.strings.filter((s) => !covered.has(s));
  return { mismatches, missing };
}

if (isEntry(import.meta.url)) {
  const dirIx = process.argv.indexOf('--dir');
  const dir = dirIx >= 0 ? path.resolve(process.argv[dirIx + 1]) : DEFAULT_DIR;
  const FILES = ['strings.json', 'ko.json', 'keep-english.json'];
  const absent = FILES.filter((name) => !fs.existsSync(path.join(dir, name)));
  if (absent.includes('strings.json')) {
    console.error('dictionary-check: strings.json is missing (it is gitignored and built from the installed app). Run: node tools/extract-strings.mjs --out mods/ko/strings.json first');
    process.exitCode = 2;
  } else if (absent.length > 0) {
    console.error('dictionary-check: missing ' + absent.join(', ') + ' in ' + dir);
    process.exitCode = 2;
  } else {
    try {
      const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const { mismatches, missing } = checkDictionary({ strings: read('strings.json'), ko: read('ko.json'), keep: read('keep-english.json') });
      for (const name of mismatches) console.log('fingerprint mismatch: ' + name);
      for (const s of missing) console.log('not in any dictionary: ' + s);
      const problems = mismatches.length + missing.length;
      console.log('dictionary-check: ' + problems + ' problem(s)');
      process.exitCode = problems > 0 ? 1 : 0;
    } catch (error) {
      console.error('dictionary-check: could not read the dictionaries: ' + error.message);
      process.exitCode = 2;
    }
  }
}
