// Where the installed OmO app lives (macOS). One rule for every tool: with LOADER_DIR set, the loader's deps.mjs
// decides (its config.json "appBundle"); otherwise the default bundle in /Applications. Read only.
import fs from 'node:fs';
import path from 'node:path';
import { hasLoader } from './loader-dir.mjs';
import { importLoader } from './loader-import.mjs';

export const DEFAULT_APP_BUNDLE = '/Applications/OmO.app';
export const appExeOf = (bundle) => path.join(bundle, 'Contents', 'MacOS', 'OmO');
export const resourcesDirOf = (bundle) => path.join(bundle, 'Contents', 'Resources');

// omo-runtime/darwin-<arch>: this machine's arch first, else the first darwin-* folder; null when none exists.
export function runtimeDirOf(resources, arch = process.arch) {
  const root = path.join(resources, 'omo-runtime');
  const own = path.join(root, `darwin-${arch}`);
  if (fs.existsSync(own)) return own;
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('darwin-')).sort() : [];
  return names.length > 0 ? path.join(root, names[0]) : null;
}

// { bundle, resources, exe } of the app the tools read.
export async function resolveApp() {
  if (hasLoader()) {
    const deps = await importLoader('deps.mjs');
    const bundle = deps.readConfigAppBundle();
    return { bundle, resources: deps.appResourcesDir(bundle), exe: deps.readConfigAppExe() };
  }
  return { bundle: DEFAULT_APP_BUNDLE, resources: resourcesDirOf(DEFAULT_APP_BUNDLE), exe: appExeOf(DEFAULT_APP_BUNDLE) };
}
