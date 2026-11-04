// Tests for mods/ko/translate.mjs. The dictionary is an inline fixture, so the suite runs without the gitignored ko.json.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invalidPatterns, MAX_PATTERN_TEXT, translateText } from '../mods/ko/translate.mjs';

const entries = { Settings: '설정', Cancel: '취소', 'Save changes': '변경 사항 저장' };
const patterns = { '^(\\d+) items?$': '항목 $1개', '^(\\d+) of (\\d+)$': '$2개 중 $1' };

describe('translateText', () => {
  it('replaces an exact registered string', () => {
    // Given: a registered label; When: translated; Then: the Korean value is returned
    assert.equal(translateText('Settings', entries), '설정');
  });

  it('keeps leading, trailing and newline whitespace around the match', () => {
    // Given: a registered label padded with spaces, tabs and a newline; When: translated; Then: padding is kept byte for byte
    assert.equal(translateText('  Cancel\t\n', entries), '  취소\t\n');
  });

  it('does not translate text that only contains a registered string', () => {
    // Given: a registered label followed by other words; When: translated; Then: the text is unchanged
    assert.equal(translateText('Settings page', entries), 'Settings page');
  });

  it('is case sensitive', () => {
    // Given: a registered label in lowercase; When: translated; Then: the text is unchanged
    assert.equal(translateText('settings', entries), 'settings');
  });

  it('leaves unregistered and whitespace-only text unchanged', () => {
    // Given: text that is not registered, and text that is only whitespace; When: translated; Then: both come back unchanged
    assert.equal(translateText('Unknown label', entries), 'Unknown label');
    assert.equal(translateText('   ', entries), '   ');
  });

  it('does not resolve inherited object keys', () => {
    // Given: a word that names an Object.prototype member; When: translated; Then: it is returned as it was
    assert.equal(translateText('constructor', entries), 'constructor');
  });
});

describe('translateText patterns', () => {
  it('prefers an exact entry over a pattern that also matches', () => {
    // Given: an exact entry and a pattern that matches the same text; When: translated; Then: the exact entry wins
    assert.equal(translateText('3 items', { '3 items': '세 항목' }, patterns), '세 항목');
  });

  it('applies the first matching pattern in object order', () => {
    // Given: two patterns that both match; When: translated; Then: the one listed first supplies the result
    const ordered = { '^(\\w+) saved$': 'first $1', '^(.+) saved$': 'second $1' };
    assert.equal(translateText('Draft saved', {}, ordered), 'first Draft');
  });

  it('substitutes $1 and $2 from the capture groups', () => {
    // Given: a pattern with two groups; When: translated; Then: the groups are placed in the template order
    assert.equal(translateText('3 of 10', {}, patterns), '10개 중 3');
  });

  it('skips an invalid pattern, reports it, and still applies the rest', () => {
    // Given: one invalid pattern and one valid one; When: translated and checked; Then: the valid one applies and the invalid one is reported
    const mixed = { '^(unclosed$': 'x', '^(\\d+) items?$': '항목 $1개' };
    assert.equal(translateText('3 items', {}, mixed), '항목 3개');
    assert.deepEqual(invalidPatterns(mixed), ['^(unclosed$']);
  });

  it('keeps leading and trailing whitespace around a pattern match', () => {
    // Given: a padded text that a pattern matches; When: translated; Then: the padding is kept
    assert.equal(translateText('  3 items\t\n', {}, patterns), '  항목 3개\t\n');
  });

  it('matches the whole text only', () => {
    // Given: a pattern that matches a part of the text; When: translated; Then: the text is unchanged
    assert.equal(translateText('my 3 items', {}, patterns), 'my 3 items');
  });

  it('does not match text longer than the limit', () => {
    // Given: text at the limit and text one character over it, both matching a catch-all pattern; When: translated; Then: only the one at the limit changes
    const catchAll = { '^(.+)$': 'X $1' };
    const atLimit = 'a'.repeat(MAX_PATTERN_TEXT);
    const over = 'a'.repeat(MAX_PATTERN_TEXT + 1);
    assert.equal(translateText(atLimit, {}, catchAll), 'X ' + atLimit);
    assert.equal(translateText(over, {}, catchAll), over);
  });
});
