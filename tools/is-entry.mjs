import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Whether the module at url is the script node was started with. realpath on both sides: on macOS /var is a link
// to /private/var and import.meta.url is already resolved, so a plain compare would skip main() silently.
export function isEntry(url) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
