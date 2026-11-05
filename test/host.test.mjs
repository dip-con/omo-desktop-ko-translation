import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_KEYS, MISSING_FILE, createRecorder, handle, looksLikeUiText, mergeMissing, recorder } from '../mods/ko/host.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ko-host-'));

test('config returns the exclusion selectors', () => {
  assert.ok(handle('config', [], {}).exclusionSelectors.includes('[data-omo-mod-root]'));
});

test('translate uses the shipped dictionary and records misses only when asked', () => {
  const stateDir = tempDir();
  const ctx = { modId: 'ko', modDir: '', stateDir, modsHome: '' };
  assert.deepEqual(handle('translate', [['Settings', 'Zzq unseen label'], { record: false }], ctx), ['설정', 'Zzq unseen label']);
  recorder.flush();
  assert.equal(fs.existsSync(path.join(stateDir, MISSING_FILE)), false);
  handle('translate', [[' Zzq unseen label '], { record: true }], ctx);
  recorder.flush();
  const doc = JSON.parse(fs.readFileSync(path.join(stateDir, MISSING_FILE), 'utf8'));
  assert.deepEqual(Object.keys(doc.strings), ['Zzq unseen label']);
});

test('translate refuses a malformed batch and unknown methods', () => {
  assert.throws(() => handle('translate', [[1]], {}), /at most 500/);
  assert.throws(() => handle('translate', [new Array(501).fill('a')], {}), /at most 500/);
  assert.throws(() => handle('nope', [], {}), /unknown method/);
});

test('looksLikeUiText rejects numbers, urls, paths and identifiers', () => {
  const keep = new Set(['OmO']);
  for (const t of ['Open settings', 'Archive']) assert.equal(looksLikeUiText(t, keep), true, t);
  for (const t of ['OmO', '12 MB', 'https://x.y', '~/repo', 'camelCase', 'snake_case', 'a']) assert.equal(looksLikeUiText(t, keep), false, t);
});

test('mergeMissing adds counts and drops the least recently seen keys over the cap', () => {
  const doc = mergeMissing({ version: 1, strings: { A: { count: 2, firstSeen: 't0', lastSeen: 't0' } } }, new Map([['A', 1], ['B', 1]]), 't1');
  assert.deepEqual(doc.strings.A, { count: 3, firstSeen: 't0', lastSeen: 't1' });
  const many = Object.fromEntries(Array.from({ length: MAX_KEYS }, (_, i) => [`k${i}`, { count: 1, firstSeen: 't0', lastSeen: 't0' }]));
  const capped = mergeMissing({ version: 1, strings: many }, new Map([['new', 1]]), 't9');
  assert.equal(Object.keys(capped.strings).length, MAX_KEYS);
  assert.ok(capped.strings.new);
});

test('recorder batches writes behind one scheduled flush', () => {
  const file = path.join(tempDir(), 'nested', MISSING_FILE);
  const scheduled = [];
  const rec = createRecorder({ now: () => 'now', schedule: (fn) => scheduled.push(fn) });
  rec.record(file, 'Open settings');
  rec.record(file, 'Open settings');
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).strings['Open settings'], { count: 2, firstSeen: 'now', lastSeen: 'now' });
});
