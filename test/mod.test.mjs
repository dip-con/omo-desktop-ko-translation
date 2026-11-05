import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { invalidPatterns } from '../mods/ko/translate.mjs';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../mods/ko/${name}`, import.meta.url), 'utf8'));

test('mod.json is v2 with only known fields', () => {
  const mod = read('mod.json');
  const known = ['id', 'name', 'nameKo', 'description', 'version', 'enabled', 'locked', 'order', 'entry', 'settingsPage', 'anchors', 'source'];
  assert.deepEqual(Object.keys(mod).filter((k) => !known.includes(k)), []);
  assert.equal(mod.id, 'ko');
  assert.deepEqual(mod.source, { repo: 'dip-con/omo-desktop-ko-translation', path: 'mods/ko', ref: 'main' });
});

test('dictionaries carry only their data fields and valid patterns', () => {
  const ko = read('ko.json');
  assert.deepEqual(Object.keys(ko), ['entries', 'patterns']);
  assert.deepEqual(Object.keys(read('keep-english.json')), ['entries']);
  assert.deepEqual(invalidPatterns(ko.patterns), []);
  assert.ok(Object.values(ko.entries).every((v) => typeof v === 'string' && v.trim() !== ''));
});
