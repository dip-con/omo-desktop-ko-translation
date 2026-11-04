import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loaderDir } from './loader-dir.mjs';

export function importLoader(name) {
  return import(pathToFileURL(join(loaderDir(), 'loader', name)).href);
}

export function importLoaderTool(name) {
  return import(pathToFileURL(join(loaderDir(), 'tools', name)).href);
}
