// Node 24 resolves `node --test test/` as the module test/index.js rather than searching the folder, so this file
// loads every *.test.mjs next to it. `node --test "test/*.test.mjs"` runs the same tests without it.
import fs from 'node:fs';

for (const name of fs.readdirSync(new URL('.', import.meta.url)).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(new URL(name, import.meta.url));
}
