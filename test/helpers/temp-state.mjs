// Preloaded by npm test: points LOADER_STATE_DIR at a fresh temp folder unless the caller set one, so the ko mod's
// runtime miss recorder (mods/ko/missing.mjs) can never write to ~/Library during tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.LOADER_STATE_DIR) process.env.LOADER_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-test-state-'));
