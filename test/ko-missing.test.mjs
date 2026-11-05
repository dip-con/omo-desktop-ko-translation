// Tests for the runtime miss recorder (mods/ko/missing.mjs) and its wiring in mods/ko/host.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRecorder, FLUSH_MS, looksLikeUiText, MAX_KEYS, mergeMissing, missingFile, stateDir } from '../mods/ko/missing.mjs';
import { flushMissing, handle } from '../mods/ko/host.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ko-missing-'));
const readDoc = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('state dir rule', () => {
  it('uses LOADER_STATE_DIR when set and ~/Library/Application Support/omo-app-mods otherwise', () => {
    assert.equal(missingFile({ LOADER_STATE_DIR: '/tmp/x' }), path.join('/tmp/x', 'ko-missing.json'));
    assert.equal(stateDir({}), path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods'));
  });
});

describe('looksLikeUiText', () => {
  const keep = new Set(['GitHub']);
  it('accepts interface copy', () => {
    for (const s of ['Some Untranslated Label XYZ', 'Save changes', 'Ok', 'Retry in 5 seconds']) assert.equal(looksLikeUiText(s, keep), true, s);
  });
  it('rejects keep-english keys, numbers, paths, URLs, identifiers and length outliers', () => {
    for (const s of ['GitHub', '15m', '0.05s', '1,024', 'https://example.com', '/Users/me/project', '~/x', 'src/main.ts', 'camelCase', 'snake_case', 'file.json', 'a', 'x'.repeat(121), '한글만']) {
      assert.equal(looksLikeUiText(s, keep), false, s);
    }
  });
});

describe('mergeMissing', () => {
  it('adds counts and keeps firstSeen', () => {
    const first = mergeMissing(null, new Map([['A b', 2]]), 't1');
    const second = mergeMissing(first, new Map([['A b', 3]]), 't2');
    assert.deepEqual(second, { version: 1, strings: { 'A b': { count: 5, firstSeen: 't1', lastSeen: 't2' } } });
  });
  it('drops the least recently seen keys over the cap', () => {
    const strings = Object.fromEntries(Array.from({ length: MAX_KEYS }, (_, i) => [`old ${i}`, { count: 1, firstSeen: 't0', lastSeen: i === 0 ? 't0' : 't1' }]));
    const doc = mergeMissing({ version: 1, strings }, new Map([['brand new', 1]]), 't2');
    assert.equal(Object.keys(doc.strings).length, MAX_KEYS);
    assert.ok(Object.hasOwn(doc.strings, 'brand new'));
    assert.ok(!Object.hasOwn(doc.strings, 'old 0'));
  });
});

describe('createRecorder', () => {
  it('batches records into one atomic write per tick', () => {
    const file = path.join(tempDir(), 'ko-missing.json');
    const ticks = [];
    const rec = createRecorder({ file: () => file, now: () => 'T', schedule: (fn, ms) => ticks.push({ fn, ms }) });
    rec.record('Open file');
    rec.record('Open file');
    rec.record('Close');
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].ms, FLUSH_MS);
    assert.equal(fs.existsSync(file), false);
    ticks[0].fn();
    assert.deepEqual(readDoc(file).strings, { 'Open file': { count: 2, firstSeen: 'T', lastSeen: 'T' }, Close: { count: 1, firstSeen: 'T', lastSeen: 'T' } });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ko-missing.json']);
  });
});

describe('host translate', () => {
  it('records unchanged interface text and skips translated or keep-english text', () => {
    const dir = tempDir();
    const saved = process.env.LOADER_STATE_DIR;
    process.env.LOADER_STATE_DIR = dir;
    try {
      flushMissing();
      const out = handle('translate', [['Some Untranslated Label XYZ', '(optional)', 'Amazon Bedrock', '  Another Missing Label  ', '42']]);
      assert.equal(out[1], '(선택 사항)');
      flushMissing();
      const strings = readDoc(path.join(dir, 'ko-missing.json')).strings;
      assert.deepEqual(Object.keys(strings).sort(), ['Another Missing Label', 'Some Untranslated Label XYZ']);
    } finally {
      process.env.LOADER_STATE_DIR = saved;
    }
  });

  it('records nothing when the page sends record: false', () => {
    const dir = tempDir();
    const saved = process.env.LOADER_STATE_DIR;
    process.env.LOADER_STATE_DIR = dir;
    try {
      flushMissing();
      handle('translate', [['Chat Only Label QQQ'], { record: false }]);
      flushMissing();
      const file = path.join(dir, 'ko-missing.json');
      const strings = fs.existsSync(file) ? readDoc(file).strings : {};
      assert.equal(Object.hasOwn(strings, 'Chat Only Label QQQ'), false);
    } finally {
      process.env.LOADER_STATE_DIR = saved;
    }
  });
});
