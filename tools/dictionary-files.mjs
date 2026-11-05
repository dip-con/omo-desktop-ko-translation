// Reads and writes the mods/ko dictionary files in their committed format: 2-space JSON plus a final newline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MOD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mods', 'ko');

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Atomic: written to a temp file and renamed over the target.
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// The mods/ko file paths under modDir.
export function modFiles(modDir) {
  const at = (name) => path.join(modDir, name);
  return { ko: at('ko.json'), keep: at('keep-english.json'), manual: at('manual.json'), pending: at('pending.json') };
}
