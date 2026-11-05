// Tests for tools/collect-missing.mjs and tools/add-key.mjs against a temp copy of the dictionary files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addKey, AddKeyError } from '../tools/add-key.mjs';
import { collectPending } from '../tools/collect-missing.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fp = { appVersion: 'v' };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// A mods/ko folder with a small dictionary in the committed format.
function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-dict-'));
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  put('ko.json', { fingerprint: fp, entries: { Save: '저장' }, patterns: { '^(\\d+) files$': '파일 $1개' } });
  put('keep-english.json', { fingerprint: fp, entries: { 'Amazon Bedrock': 'brand' } });
  put('manual.json', { fingerprint: fp, entries: {} });
  put('pending.json', { generatedAt: 't', strings: [{ text: 'Open project', count: 3, lastSeen: 't' }, { text: 'Other', count: 1, lastSeen: 't' }] });
  return dir;
}

describe('collectPending', () => {
  it('keeps unhandled misses sorted by count and drops translated, pattern-matched, kept and manual strings', () => {
    const dir = fixtureDir();
    const load = (n) => readJson(path.join(dir, n));
    const manual = { entries: { 'Manual one': { ko: '수동' } } };
    const misses = {
      Save: { count: 9, lastSeen: 'a' },
      '3 files': { count: 9, lastSeen: 'a' },
      'Amazon Bedrock': { count: 9, lastSeen: 'a' },
      'Manual one': { count: 9, lastSeen: 'a' },
      'New label': { count: 5, lastSeen: 'b' },
      Other: { count: 7, lastSeen: 'c' },
    };
    const out = collectPending({ misses, previous: load('pending.json').strings, ko: load('ko.json'), keep: load('keep-english.json'), manual });
    assert.deepEqual(out, [
      { text: 'Other', count: 7, lastSeen: 'c' },
      { text: 'New label', count: 5, lastSeen: 'b' },
      { text: 'Open project', count: 3, lastSeen: 't' },
    ]);
  });

  it('runs as a CLI from --from into --out', () => {
    const dir = fixtureDir();
    const from = path.join(dir, 'ko-missing.json');
    fs.writeFileSync(from, JSON.stringify({ version: 1, strings: { 'Fresh text': { count: 2, firstSeen: 'x', lastSeen: 'y' } } }));
    const out = path.join(dir, 'out.json');
    execFileSync(process.execPath, [path.join(root, 'tools/collect-missing.mjs'), '--dir', dir, '--from', from, '--out', out]);
    assert.deepEqual(readJson(out).strings, [{ text: 'Fresh text', count: 2, lastSeen: 'y' }]);
  });
});

describe('addKey', () => {
  it('adds a Korean entry at the end of ko.json, records it in manual.json and removes it from pending.json', () => {
    const dir = fixtureDir();
    assert.deepEqual(addKey({ modDir: dir, english: 'Open project', korean: '프로젝트 열기', note: 'sidebar' }), { kind: 'ko', text: 'Open project' });
    const ko = readJson(path.join(dir, 'ko.json'));
    assert.deepEqual(Object.entries(ko.entries), [['Save', '저장'], ['Open project', '프로젝트 열기']]);
    assert.deepEqual(readJson(path.join(dir, 'manual.json')).entries['Open project'], { ko: '프로젝트 열기', source: 'runtime', note: 'sidebar' });
    assert.deepEqual(readJson(path.join(dir, 'pending.json')).strings.map((p) => p.text), ['Other']);
    assert.ok(fs.readFileSync(path.join(dir, 'ko.json'), 'utf8').endsWith('}\n'));
  });

  it('adds a keep-english entry with its reason', () => {
    const dir = fixtureDir();
    addKey({ modDir: dir, english: 'Other', keepEnglish: 'product name' });
    assert.equal(readJson(path.join(dir, 'keep-english.json')).entries.Other, 'product name');
    assert.equal(Object.hasOwn(readJson(path.join(dir, 'ko.json')).entries, 'Other'), false);
  });

  it('refuses duplicates, padded text and missing values without writing', () => {
    const dir = fixtureDir();
    const before = fs.readFileSync(path.join(dir, 'ko.json'), 'utf8');
    for (const req of [{ english: 'Save', korean: '저장' }, { english: 'Amazon Bedrock', korean: 'x' }, { english: ' Pad ', korean: 'x' }, { english: 'New' }, { english: 'New', korean: 'x', keepEnglish: 'r' }]) {
      assert.throws(() => addKey({ modDir: dir, ...req }), AddKeyError, JSON.stringify(req));
    }
    assert.equal(fs.readFileSync(path.join(dir, 'ko.json'), 'utf8'), before);
  });
});
