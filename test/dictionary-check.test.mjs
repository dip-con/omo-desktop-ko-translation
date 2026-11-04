import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = fileURLToPath(new URL('../tools/dictionary-check.mjs', import.meta.url));
const FINGERPRINT = { appVersion: '1', client: 'c', runtime: { omoRef: 'v1', omoSha: 's' }, plugin: 'p' };

// Writes the three dictionary files into a temp folder and runs the check against it.
function runCheck({ strings, ko, keep }) {
  const dir = mkdtempSync(join(tmpdir(), 'dict-check-'));
  try {
    writeFileSync(join(dir, 'strings.json'), JSON.stringify(strings));
    writeFileSync(join(dir, 'ko.json'), JSON.stringify(ko));
    writeFileSync(join(dir, 'keep-english.json'), JSON.stringify(keep));
    return spawnSync(process.execPath, [CHECK, '--dir', dir], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const strings = { fingerprint: FINGERPRINT, strings: ['Save', 'Open'] };
const ko = { fingerprint: FINGERPRINT, entries: { Save: '저장' } };
const keep = { fingerprint: FINGERPRINT, entries: { Open: 'Open' } };

test('every string is covered and every fingerprint matches, so the check passes', () => {
  // Given: two dictionaries that together cover both extracted strings, with matching fingerprints
  // When: the check runs
  const result = runCheck({ strings, ko, keep });
  // Then: it exits 0
  assert.equal(result.status, 0);
});

test('a dictionary with a different fingerprint is reported and fails the check', () => {
  // Given: ko.json built from another app version
  const staleKo = { ...ko, fingerprint: { ...FINGERPRINT, appVersion: '2' } };
  // When: the check runs
  const result = runCheck({ strings, ko: staleKo, keep });
  // Then: it names the file and exits 1
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fingerprint mismatch: ko\.json/);
});

test('an extracted string in neither dictionary is reported and fails the check', () => {
  // Given: an extracted string that no dictionary lists
  const extra = { fingerprint: FINGERPRINT, strings: ['Save', 'Open', 'Close'] };
  // When: the check runs
  const result = runCheck({ strings: extra, ko, keep });
  // Then: it names the string and exits 1
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not in any dictionary: Close/);
});

test('a missing strings.json exits 2 with the extract command and no stack trace', () => {
  // Given: a dictionary folder without strings.json, as on a fresh clone (the file is gitignored)
  const dir = mkdtempSync(join(tmpdir(), 'dict-check-'));
  try {
    writeFileSync(join(dir, 'ko.json'), JSON.stringify(ko));
    writeFileSync(join(dir, 'keep-english.json'), JSON.stringify(keep));
    // When: the check runs
    const result = spawnSync(process.execPath, [CHECK, '--dir', dir], { encoding: 'utf8' });
    // Then: exit 2 names the extract command, with no raw Node error and no stack frames
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('node tools/extract-strings.mjs --out mods/ko/strings.json'));
    assert.equal(result.stderr.includes('ENOENT'), false);
    assert.equal(result.stderr.split('\n').some((line) => line.trim().startsWith('at ')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
