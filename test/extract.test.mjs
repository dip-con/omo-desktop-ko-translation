import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assetFiles, extractStrings, scanLiterals } from '../tools/extract.mjs';

test('keyed literals, ternary values and sentence templates are found', () => {
  const src = [
    'x(w,{label:"Save",description:j?`How new worktrees in this project populate git submodules.`:`How new worktrees populate git submodules. Projects and their omo.json can override it.`})',
    'K,{description:n??`System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while OmO is open.${jt&&ce(p)?` ${il}`:``}`}',
    'toast("Could not save the theme.")',
  ].join(';');
  assert.deepEqual(extractStrings([src]), [
    'Could not save the theme.',
    'How new worktrees in this project populate git submodules.',
    'How new worktrees populate git submodules. Projects and their omo.json can override it.',
    'Save',
    'System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while OmO is open.',
  ]);
});

test('code-like strings and unkeyed single words are skipped', () => {
  const src = 'a="Content-Type";b={label:"flex items-center"};c="Error";d={title:"camelCase"};e=/"[a-z]"/g;f={children:"Done"}';
  assert.deepEqual(extractStrings([src]), ['Done']);
});

test('a regex literal holding a quote does not desynchronise the scan', () => {
  const lits = scanLiterals('x=s.replace(/"/g,"");y={label:"Open"}').map((l) => l.quasis.join('|'));
  assert.deepEqual(lits, ['', 'Open']);
});

test('assetFiles takes settings chunks and the entry imports only', () => {
  const client = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-extract-'));
  fs.mkdirSync(path.join(client, 'assets'));
  fs.writeFileSync(path.join(client, 'index.html'), '<script type="module" crossorigin src="/assets/index-A.js"></script>');
  const files = { 'index-A.js': 'import{t}from"./web-B.js";', 'web-B.js': '', 'app~settings.general-C.js': '', 'app~settings.general-C.js.gz': '', 'chat-D.js': '' };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(client, 'assets', name), body);
  assert.deepEqual(assetFiles(client).map((f) => path.basename(f)), ['app~settings.general-C.js', 'index-A.js', 'web-B.js']);
});
