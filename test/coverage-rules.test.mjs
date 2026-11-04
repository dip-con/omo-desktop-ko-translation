// Tests for the non-linguistic rules in tools/coverage.mjs. The cases are strings from the measured screens.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXCLUSION_SELECTORS, KEY_CHIP_SELECTORS } from '../mods/ko/host.mjs';
import { isNonLinguistic, KEYCAP_REGION_SELECTORS, nonLinguisticClass, scoreScreen, THREAD_CONTENT_SELECTORS } from '../tools/coverage.mjs';

const NON_LINGUISTIC = [
  '1.88 GB', '21.4 KB/s', '97.24 ms', '711 MB/s', '30 fps', '250 ms', '16 px', '12px',
  '0.1.0', '0.1.0 · PID 95852', '[redacted]', '[redacted-email]', '[redacted-path]',
  'http://127.0.0.1:3773/', ['user', 'example.com'].join('@'), 'C:\\Users\\alice\\project', '/home/user/project',
  'Ctrl', 'Alt', 'Shift', 'Esc', 'Meta', 'F5', 'Ctrl+K', 'Ctrl+Home', 'Shift+Tab', 'Alt+Left',
  '12px · 3 fps', '42',
  'antigravity-ocx', 'CO', 'routeway', 'OO', 'gpt-5.6-sol', 'moonshotai/Kimi-K3', 'claude-haiku-4-5-20251001',
  'Qwen3.8-27B', 'gpt-5.6-sol · On', 'claude-sonnet-5, claude-fable-5, claude-opus-5 · On',
  'dompurify', 'katex', 'pele', 'remark-math', '@types/trusted-types', 'ISC', 'ISC · Desktop, Web', 'OFL-1.1 · Desktop, Web',
  'MIT AND ISC · Web', 'Routeway (routeway)', 'Ollama Local (Qwen3.8-27B) (ollama-local)',
  'deepseek-v4-flash', 'MiniMaxAI/MiniMax-M3',
  'Command Code (Provider API) (commandcode)',
  'union-alpha, big-pickle · On', 'x-preview-f-free, big-pickle, deepseek-v4-flash-free · On',
  'muse-spark-1.2-contributor, muse-spark-1.3-contributor, union-alpha · On', 'jev-latest, grok-4.7 · On',
];

// Ordinary UI words. As stand-alone text they are copy, not key names, so the gate must still see them.
const KEY_WORDS_ALONE = ['Home', 'Delete', 'End', 'Space', 'Tab', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Insert', 'Menu', 'Back'];

const LINGUISTIC = [
  '30 minutes', 'Idle · 200s', 'Daily · Normal', 'Obsessive · Heavy', 'Cancel', 'Settings', '1 of 3',
  'Restore device defaults', 'Let agents mark their own thread as done',
  'Ask for changes, send follow-ups, or attach images', 'Claude Code', 'GPT-6 Astra', 'Segoe UI',
  'master', 'across', 'hooks', 'Free', 'Enter a value', 'Up to 3 items', 'Ctrl-click to select',
  '10 minutes ago', 'Searches and rewrites code by AST shape across 25 languages.', '3 tools loaded.',
  ...KEY_WORDS_ALONE,
  'Turn off', 'Check for Updates', 'read-only', 'OK', 'Routeway', 'Routeway (Provider API)', 'Models providers',
  'KaTeX mathematical fonts', 'Desktop, Web', 'Created', 'Add option', 'Today', 'Measuring attachment storage...',
  'open-source', 'desktop, web', 'big-pickle · On', 'Work Log', 'Mark as not done', 'Start a thread',
  'Read/s', 'Write/s', '15m', '1h', '30m', '5m', 'and/or', 'Read/Write', 'Input/Output', 'Base64', 'open-source, read-only',
  'This provider is configured outside OmO, so there is nothing to sign in or out of here.',
];

describe('isNonLinguistic matches values with no human-language word', () => {
  for (const text of NON_LINGUISTIC) {
    it('matches ' + JSON.stringify(text), () => {
      // Given: a value from the measured screens with no word in it; When: classified; Then: it is non-linguistic
      assert.equal(isNonLinguistic(text), true);
    });
  }
});

describe('isNonLinguistic leaves human-language text alone', () => {
  for (const text of LINGUISTIC) {
    it('keeps ' + JSON.stringify(text), () => {
      // Given: text with a word or phrase in it; When: classified; Then: it is not matched
      assert.equal(isNonLinguistic(text), false);
    });
  }
});

describe('key chip selector has one source', () => {
  it('the translator exclusion list contains every key chip selector', () => {
    // Given: the key chip selectors; When: the page exclusion list is read; Then: each chip selector is in it
    for (const sel of KEY_CHIP_SELECTORS) assert.ok(EXCLUSION_SELECTORS.includes(sel));
  });

  it('the coverage key chip region is the same list', () => {
    // Given: the coverage tool's key chip region; When: compared with the host list; Then: they are equal
    assert.deepEqual(KEYCAP_REGION_SELECTORS, KEY_CHIP_SELECTORS);
  });
});

describe('nonLinguisticClass names the rule that matched', () => {
  it('reports number-unit for a number with a unit', () => {
    // Given: a number and a unit; When: classified; Then: the class is number-unit
    assert.equal(nonLinguisticClass('1.88 GB'), 'number-unit');
  });

  it('reports version for a dotted version with a process id', () => {
    // Given: a version followed by a PID; When: classified; Then: the class is version
    assert.equal(nonLinguisticClass('0.1.0 · PID 95852'), 'version');
  });

  it('reports redaction for a placeholder', () => {
    // Given: a redaction placeholder; When: classified; Then: the class is redaction
    assert.equal(nonLinguisticClass('[redacted-email]'), 'redaction');
  });

  it('reports keycap for a modifier combo that contains an ordinary word', () => {
    // Given: a modifier combined with a word-like key; When: classified; Then: the class is keycap
    assert.equal(nonLinguisticClass('Ctrl+Home'), 'keycap');
  });

  it('reports provider-id for a provider id or short code', () => {
    // Given: a provider id from the settings/models list; When: classified; Then: the class is provider-id
    assert.equal(nonLinguisticClass('antigravity-ocx'), 'provider-id');
  });

  it('reports model-id for a single model id', () => {
    // Given: a model id with a slash and a digit; When: classified; Then: the class is model-id
    assert.equal(nonLinguisticClass('moonshotai/Kimi-K3'), 'model-id');
  });

  it('reports model-id-list for model ids joined with the status suffix', () => {
    // Given: a model list ending in ' · On'; When: classified; Then: the class is model-id-list
    assert.equal(nonLinguisticClass('gpt-5.6-sol, gpt-5.4 · On'), 'model-id-list');
  });

  it('reports package-name for a package on the licenses screen', () => {
    // Given: a package name the screen shows; When: classified; Then: the class is package-name
    assert.equal(nonLinguisticClass('dompurify'), 'package-name');
  });

  it('reports license-name for a license line with a platform list', () => {
    // Given: an SPDX id and a platform list; When: classified; Then: the class is license-name
    assert.equal(nonLinguisticClass('ISC · Desktop, Web'), 'license-name');
  });

  it('reports provider-display-name for a name with a known provider id', () => {
    // Given: a provider row whose trailing id is a known provider id; When: classified; Then: the class is provider-display-name
    assert.equal(nonLinguisticClass('OpenCode Zen (opencode)'), 'provider-display-name');
  });

  it('does not exclude a provider name whose trailing parenthesis is not a provider id', () => {
    // Given: a name with a parenthesis that is not a provider id; When: classified; Then: it is copy and stays counted
    assert.equal(nonLinguisticClass('Routeway (Provider API)'), null);
  });

  it('does not exclude a license-shaped sentence or an unknown SPDX id', () => {
    // Given: a sentence, and a token that is not a known SPDX id; When: classified; Then: both stay counted
    assert.equal(nonLinguisticClass('Desktop, Web'), null);
    assert.equal(nonLinguisticClass('GPL-3.0 · Web'), null);
  });

  it('classifies a bullet relative timestamp without hiding ordinary time text', () => {
    assert.equal(nonLinguisticClass('· 1d'), 'relative-timestamp');
    assert.equal(nonLinguisticClass('1d'), null);
    assert.equal(nonLinguisticClass('· 1 day ago'), null);
  });

  it('classifies the observed model profile id without hiding hyphenated copy', () => {
    assert.equal(nonLinguisticClass('daily-normal'), 'model-profile-id');
    assert.equal(nonLinguisticClass('daily-normal mode'), null);
    assert.equal(nonLinguisticClass('open-source'), null);
  });
});

describe('thread-content rule and the excluded list', () => {
  // Given: a row as the gate builds it; the fields the scorer reads, all false unless the test sets them
  const node = (en, extra = {}) => ({ en, changed: false, now: en, region: false, inKey: false, inThread: false, parentTag: 'p', parentText: en, prev: null, next: null, ...extra });

  it('excludes owner session content on home and names the thread-content rule', () => {
    // Given: one owner message and one English sentence; When: scored; Then: the message is excluded with its rule and the sentence is counted
    const row = scoreScreen('home', [node('Delegate one very short task', { inThread: true }), node('Open the sample panel')], {}, [], []);
    assert.equal(row.total, 1);
    assert.deepEqual(row.excluded, [{ text: 'Delegate one very short task', rule: 'thread-content' }]);
  });

  it('keeps home chrome counted when it is outside the thread content region', () => {
    // Given: home chrome strings with no thread-content marker; When: scored; Then: all four are counted and none is excluded
    const row = scoreScreen('home', [node('Start a thread'), node('Work Log'), node('Mark as not done'), node('Add option')], {}, [], []);
    assert.equal(row.total, 4);
    assert.deepEqual(row.excluded, []);
  });

  it('names the thread-content selectors the page applies', () => {
    // Given: the exported thread-content selectors; When: read; Then: they are the message body, live line and title markers
    assert.deepEqual(THREAD_CONTENT_SELECTORS, ['[data-assistant-citation-source]', '[data-live-activity-label]', '[data-base-ui-tooltip-trigger] > h1', '[data-sidebar-thread-title]']);
  });

  it('excludes the assistant reply body (DONE) on home and keeps home chrome counted beside it', () => {
    // Given: an assistant reply in the thread-content region and a home chrome label outside it; When: scored; Then: the reply is excluded with its rule and the chrome label is counted
    const row = scoreScreen('home', [node('DONE', { inThread: true }), node('Work Log')], {}, [], []);
    assert.equal(row.total, 1);
    assert.deepEqual(row.excluded, [{ text: 'DONE', rule: 'thread-content' }]);
  });

  it('keeps an ordinary English UI sentence counted against the ratio', () => {
    // Given: an English settings sentence and a provider id; When: scored; Then: the sentence is untranslated and gated, the id is excluded by its rule
    const row = scoreScreen('settings/models', [node('This provider is configured outside OmO, so there is nothing to sign in or out of here.'), node('gpt-5.6-sol')], {}, [], []);
    assert.equal(row.total, 1);
    assert.equal(row.notTranslated, 1);
    assert.deepEqual(row.excluded, [{ text: 'gpt-5.6-sol', rule: 'model-id' }]);
  });

  it('counts ordinary home UI copy beside the sidebar thread title', () => {
    const row = scoreScreen('home', [node('Delegate writing task reply OK', { inThread: true }), node('Open the sample panel')], {}, [], []);
    assert.equal(row.total, 1);
    assert.equal(row.notTranslated, 1);
    assert.deepEqual(row.excluded, [{ text: 'Delegate writing task reply OK', rule: 'thread-content' }]);
  });
});
