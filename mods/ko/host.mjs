// Host side of the ko mod. The page cannot import modules, so it asks this file for the exclusion list and for
// translations. translate uses the same translateText rule as translate.mjs, so the page and the rule cannot drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateText } from './translate.mjs';

// FACTS exclusionSelectors plus the mod's own zones. Text and attributes inside these are never changed.
// Key chips: every key cap is a kbd with data-slot="kbd". Key names are not copy, so the translator never changes them.
export const KEY_CHIP_SELECTORS = ['kbd[data-slot="kbd"]'];
export const EXCLUSION_SELECTORS = [
  'pre', 'code', '.ProseMirror', 'textarea', 'input', '[contenteditable]', '[role="log"]', '[role="tree"]',
  '[data-diff]', '.xterm', '[data-omo-mod]', ...KEY_CHIP_SELECTORS,
];
const MAX_BATCH = 500;
let dict = null;

// ko.json holds the exact entries and the runtime patterns; both reach the page only through translate below.
function dictionary() {
  if (dict === null) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ko.json');
    const ko = JSON.parse(fs.readFileSync(file, 'utf8'));
    dict = { entries: ko.entries, patterns: ko.patterns ?? {} };
  }
  return dict;
}

// Bridge entry point: method and args are the values page.js sent through omoMods.call.
export function handle(method, args) {
  if (method === 'config') return { exclusionSelectors: EXCLUSION_SELECTORS };
  if (method === 'translate') {
    const texts = args[0];
    if (!Array.isArray(texts) || texts.length > MAX_BATCH || !texts.every((t) => typeof t === 'string')) {
      throw new Error('translate takes one array of at most 500 strings');
    }
    const { entries, patterns } = dictionary();
    return texts.map((t) => translateText(t, entries, patterns));
  }
  throw new Error(`unknown method ${method}`);
}
