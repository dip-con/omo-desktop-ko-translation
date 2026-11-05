// Tests for tools/app-paths.mjs, the macOS process table parser and the never-throwing local fingerprint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appExeOf, DEFAULT_APP_BUNDLE, resolveApp, resourcesDirOf, runtimeDirOf } from '../tools/app-paths.mjs';
import { readFingerprint } from '../tools/extract-strings.mjs';
import { parsePsRows } from '../tools/processes.mjs';

const tempBundle = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ko-app-')) + '/OmO.app';

describe('app paths', () => {
  it('derives the executable and resources folder from the bundle', () => {
    assert.equal(appExeOf('/Applications/OmO.app'), '/Applications/OmO.app/Contents/MacOS/OmO');
    assert.equal(resourcesDirOf('/Applications/OmO.app'), '/Applications/OmO.app/Contents/Resources');
  });

  it('resolves the default bundle when LOADER_DIR is unset', async (t) => {
    if (process.env.LOADER_DIR) return t.skip('LOADER_DIR is set');
    assert.deepEqual(await resolveApp(), { bundle: DEFAULT_APP_BUNDLE, resources: resourcesDirOf(DEFAULT_APP_BUNDLE), exe: appExeOf(DEFAULT_APP_BUNDLE) });
  });

  it('prefers the darwin runtime folder of the given arch, else any darwin-* folder, else null', () => {
    const resources = resourcesDirOf(tempBundle());
    assert.equal(runtimeDirOf(resources, 'arm64'), null);
    fs.mkdirSync(path.join(resources, 'omo-runtime', 'darwin-x64'), { recursive: true });
    assert.equal(runtimeDirOf(resources, 'arm64'), path.join(resources, 'omo-runtime', 'darwin-x64'));
    fs.mkdirSync(path.join(resources, 'omo-runtime', 'darwin-arm64'));
    assert.equal(runtimeDirOf(resources, 'arm64'), path.join(resources, 'omo-runtime', 'darwin-arm64'));
  });
});

describe('readFingerprint (local copy)', () => {
  it('returns null parts for a bundle with no files instead of throwing', () => {
    assert.deepEqual(readFingerprint(tempBundle()), { appVersion: null, client: null, runtime: { omoRef: null, omoSha: null }, plugin: null });
  });

  it('fills the parts whose files exist', () => {
    const bundle = tempBundle();
    const runtime = path.join(resourcesDirOf(bundle), 'omo-runtime', `darwin-${process.arch}`);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'bundle-manifest.json'), JSON.stringify({ omoRef: 'v1', resolvedShas: { omo: 'abc' } }));
    const fp = readFingerprint(bundle);
    assert.deepEqual(fp.runtime, { omoRef: 'v1', omoSha: 'abc' });
    assert.equal(fp.appVersion, null);
  });
});

describe('parsePsRows', () => {
  it('reads pid, ppid, start time and the rest of the line, skipping other lines', () => {
    const text = '  501     1 Wed Nov  4 10:00:00 2026     /Applications/OmO.app/Contents/MacOS/OmO\ngarbage\n';
    const [row, ...rest] = parsePsRows(text);
    assert.deepEqual(rest, []);
    assert.equal(row.pid, 501);
    assert.equal(row.ppid, 1);
    assert.equal(row.rest, '/Applications/OmO.app/Contents/MacOS/OmO');
    assert.equal(row.createdMs, new Date(2026, 10, 4, 10, 0, 0).getTime());
  });
});
