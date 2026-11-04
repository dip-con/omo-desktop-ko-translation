// Attach-mode rules of tools/coverage.mjs: text the window already shows in Korean, home and hash-routed base urls, and
// redaction of what the run writes. Pure: synthetic rows and made-up values, no browser. The attach run itself is driven
// through its CLI by a local-only browser check.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markPreTranslated, redactStrings, scoreScreen, screenFailures, screensToRun, unopenedRow } from '../tools/coverage.mjs';

const ALL = [{ screen: 'home', file: 'home.html' }, { screen: 'settings/general', file: 'settings-general.html' }];
const APP_URL = 'omo://app/#/env-1/thread-1';
const node = (en, extra = {}) => ({ en, changed: false, now: en, region: false, inKey: false, parentTag: 'p', parentText: en, prev: null, next: null, ...extra });
// A window where a translator already ran: a Korean string that keeps a Latin word, an English leftover, and a node the
// on pass changed.
const WINDOW = [node('샘플 Widget 설정'), node('Open the sample panel'), node('Close', { changed: true, now: '닫기' })];

describe('attach mode: text the window already shows in Korean', () => {
  it('counts a candidate that already holds Hangul as translated and keeps an English leftover untranslated', () => {
    // Given: the window rows; When: scored the attach-mode way; Then: only the English leftover is untranslated, gated and strict
    const row = scoreScreen('settings/general', markPreTranslated(WINDOW), {}, [], []);
    assert.deepEqual([row.notTranslated, row.total, row.strictNotTranslated, row.strictTotal], [1, 3, 1, 3]);
    assert.deepEqual(row.remaining, ['Open the sample panel']);
  });

  it('lists a Korean candidate that keeps a word outside keep-english in changedStillLatin, as for a changed node', () => {
    // Given: the window rows; When: scored with and without the word in keep-english; Then: listed only when keep-english lacks it
    assert.equal(scoreScreen('settings/general', markPreTranslated(WINDOW), {}, [], []).changedStillLatin, 1);
    assert.equal(scoreScreen('settings/general', markPreTranslated(WINDOW), {}, ['Widget'], []).changedStillLatin, 0);
  });

  it('leaves the snapshot-mode score as it was', () => {
    // Given: the window rows; When: scored without the attach-mode step; Then: the Korean string still counts as untranslated
    assert.equal(scoreScreen('settings/general', WINDOW, {}, [], []).notTranslated, 2);
  });
});

describe('attach mode: home and hash-routed base urls', () => {
  it('skips home when --screens is not given, and the skip fails nothing', () => {
    // Given: attach mode without --screens; When: home comes up; Then: its row is skipped with a reason and passes the gate
    const row = unopenedRow(screensToRun(ALL, null, true)[0], APP_URL, false);
    assert.equal(row.status, 'skipped');
    assert.equal(typeof row.reason, 'string');
    assert.deepEqual(screenFailures(row), []);
  });

  it('runs exactly the screens --screens names, home included', () => {
    // Given: attach mode with --screens naming home; When: the list is built; Then: it is home alone, not skipped
    assert.deepEqual(screensToRun(ALL, 'home', true), [ALL[0]]);
  });

  it('does not navigate on a base url that routes in its hash, so no load event is awaited', () => {
    // Given: the app main-window url; When: home, named in --screens, would be loaded by navigation; Then: a not-opened row that fails the gate
    const row = unopenedRow(ALL[0], APP_URL, false);
    assert.match(row.status, /^not opened: /);
    assert.equal(screenFailures(row).length, 1);
  });

  it('still navigates on a plain base url, and clicks settings screens on a hash url', () => {
    // Given: the snapshot server url and a clicked settings screen; When: checked; Then: neither is held back
    assert.equal(unopenedRow(ALL[0], 'http://127.0.0.1:9/', false), null);
    assert.equal(unopenedRow(ALL[1], APP_URL, true), null);
  });

  it('measures home in snapshot mode as before', () => {
    // Given: snapshot mode without --screens; When: the list is built; Then: it is every screen, none skipped
    assert.deepEqual(screensToRun(ALL, null, false), ALL);
  });
});

describe('attach mode: the on-pass rule', () => {
  // A row that passes every other rule.
  const CLEAN = { screen: 'settings/general', untranslatedRatio: 0, styleCheck: { styled: true }, newOverflow: 0, visibleButtons: 0, onPassKoreanButtons: 0 };

  it('passes a screen whose text was already Korean though the on pass changed nothing', () => {
    // Given: an attach row with 0 changed and 3 pre-translated nodes; When: the rules run; Then: no failure
    assert.deepEqual(screenFailures({ ...CLEAN, onPassChangedNodes: 0, preTranslatedNodes: 3 }), []);
  });

  it('fails an attach screen where the mod changed nothing and nothing was already Korean', () => {
    // Given: an attach row with both counts 0; When: the rules run; Then: one failure, the on-pass one
    const failures = screenFailures({ ...CLEAN, onPassChangedNodes: 0, preTranslatedNodes: 0 });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].startsWith('settings/general mod changed 0 nodes on the on pass'), failures[0]);
  });

  it('fails a captures-mode screen whose on pass changed nothing exactly as before', () => {
    // Given: a snapshot row (no preTranslatedNodes) with 0 changed nodes; When: the rules run; Then: the same single failure line as before
    assert.deepEqual(screenFailures({ ...CLEAN, onPassChangedNodes: 0 }), ['settings/general mod changed 0 nodes on the on pass']);
  });
});

describe('attach mode: redaction of what the run writes', () => {
  it('masks made-up e-mail addresses and local paths in every string and keeps every count', () => {
    // Given: output rows with addresses and paths in removed strings, remaining and parent text
    const address = (name) => `${name}@${'example'}.${'invalid'}`;
    const out = redactStrings({
      removed: [{ screen: 'settings/general', class: 'email', distinct: 2, capped: false, strings: [address('a'), address('someone')] }],
      screens: [{ screen: 'settings/general', notTranslated: 2, remaining: ['Saved in C:\\Users\\someone\\x', 'Opened /home/someone/x'],
        remainingDetail: [{ en: `Signed in as ${address('someone')}`, parentText: `Signed in as ${address('someone')}`, prev: null }] }],
    });
    // When: serialised as the run writes it; Then: no address or path is left, the markers stand in, the counts are as measured
    const text = JSON.stringify(out);
    assert.equal(/example\.invalid|Users[\\/]+someone|home\/someone/.test(text), false, text);
    assert.deepEqual(out.removed[0].strings, ['[redacted-email]', '[redacted-email]']);
    assert.deepEqual([out.removed[0].distinct, out.screens[0].notTranslated, out.screens[0].remainingDetail[0].prev], [2, 2, null]);
  });
});
