// Shared helpers for the dictionary tools: repo paths, JSON files and the loader core import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MOD_DIR = path.join(REPO_DIR, 'mods', 'ko');
export const STRINGS_FILE = path.join(REPO_DIR, 'strings.json');
export const PENDING_FILE = path.join(REPO_DIR, 'pending.json');

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// 2-space JSON plus a final newline, written to a temp file and renamed over the target.
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// The dictionary files of one mod folder.
export function dictionary(modDir = MOD_DIR) {
  const ko = readJson(path.join(modDir, 'ko.json'));
  const keep = readJson(path.join(modDir, 'keep-english.json'));
  return { entries: ko.entries, patterns: ko.patterns ?? {}, keep: keep.entries };
}

// A module of the loader core: $OMO_MODS_DIR/src/core/<name>.mjs, default the sibling omo-desktop-mod checkout.
export function loaderCore(name, env = process.env) {
  const root = env.OMO_MODS_DIR || path.join(REPO_DIR, '..', 'omo-desktop-mod');
  return import(pathToFileURL(path.join(root, 'src', 'core', `${name}.mjs`)).href);
}

// True when this module is the script node was started with (realpath on both sides: /var -> /private/var).
export function isEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}
