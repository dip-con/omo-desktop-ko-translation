import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function hasLoader() {
  return Boolean(process.env.LOADER_DIR && existsSync(join(process.env.LOADER_DIR, 'loader', 'cdp.mjs')));
}

export function loaderDir() {
  if (!hasLoader()) throw new Error('LOADER_DIR must name a loader checkout containing loader/cdp.mjs');
  return process.env.LOADER_DIR;
}
