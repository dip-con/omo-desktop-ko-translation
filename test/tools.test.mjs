import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AddKeyError, addKeys } from '../tools/add-key.mjs';
import { uncovered } from '../tools/check.mjs';
import { collectPending } from '../tools/collect.mjs';

const dict = { entries: { Save: '저장' }, patterns: { '^(.+) saved$': '$1 저장됨' }, keep: { OmO: 'product name' } };

function modDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-tools-'));
  fs.writeFileSync(path.join(dir, 'ko.json'), JSON.stringify({ entries: { Save: '저장', Archive: '보관' }, patterns: {} }));
  fs.writeFileSync(path.join(dir, 'keep-english.json'), JSON.stringify({ entries: { OmO: 'product name' } }));
  fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ strings: [{ text: 'Delete', count: 3 }, { text: 'Open', count: 1 }] }));
  return dir;
}
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

test('check counts entries, patterns and keep-english as covered', () => {
  assert.deepEqual(uncovered(['Save', 'Theme saved', 'OmO', 'Delete'], dict), ['Delete']);
});

test('collect keeps uncovered strings only, most seen first, runtime counts winning', () => {
  const misses = { Save: { count: 9, lastSeen: 't' }, Delete: { count: 5, lastSeen: 't' }, Open: { count: 7, lastSeen: 't' } };
  const previous = [{ text: 'Delete', count: 1 }, { text: 'Rename', count: 2 }];
  assert.deepEqual(collectPending({ misses, previous, dict }).map((p) => [p.text, p.count]), [['Open', 7], ['Delete', 5], ['Rename', 2]]);
});

test('add-key inserts sorted pairs and removes them from pending', () => {
  const dir = modDir();
  const pendingFile = path.join(dir, 'pending.json');
  addKeys({ modDir: dir, pendingFile, pairs: [['Delete', '삭제'], ['Add', '추가']] });
  assert.deepEqual(Object.keys(read(dir, 'ko.json').entries), ['Add', 'Archive', 'Delete', 'Save']);
  assert.deepEqual(read(dir, 'pending.json').strings.map((p) => p.text), ['Open']);
});

test('add-key writes keep-english reasons and refuses duplicates and blanks', () => {
  const dir = modDir();
  const pendingFile = path.join(dir, 'pending.json');
  addKeys({ modDir: dir, pendingFile, pairs: [['Open', 'verb kept for shortcut hints']], kind: 'keep' });
  assert.equal(read(dir, 'keep-english.json').entries.Open, 'verb kept for shortcut hints');
  assert.throws(() => addKeys({ modDir: dir, pendingFile, pairs: [['Save', '저장하기']] }), AddKeyError);
  assert.throws(() => addKeys({ modDir: dir, pendingFile, pairs: [[' Pad', '패드']] }), AddKeyError);
  assert.throws(() => addKeys({ modDir: dir, pendingFile, pairs: [['New', '']] }), AddKeyError);
  addKeys({ modDir: dir, pendingFile, pairs: [['Save', '저장하기']], replace: true });
  assert.equal(read(dir, 'ko.json').entries.Save, '저장하기');
});
