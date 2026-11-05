import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PATTERN_TEXT, invalidPatterns, translateText } from '../mods/ko/translate.mjs';

const entries = { Save: '저장', 'Thread archived': '스레드 보관됨' };
const patterns = { '^(.+) saved$': '$1 저장됨', '^(\\d+) files$': '파일 $1개', '(': 'broken' };

test('exact entry wins and keeps surrounding whitespace', () => {
  assert.equal(translateText('  Save\n', entries, patterns), '  저장\n');
});

test('whole-string pattern fills $1 from the capture group', () => {
  assert.equal(translateText('Theme saved', entries, patterns), 'Theme 저장됨');
  assert.equal(translateText('12 files', entries, patterns), '파일 12개');
});

test('partial pattern match and unknown text come back unchanged', () => {
  assert.equal(translateText('12 files left', entries, patterns), '12 files left');
  assert.equal(translateText('Unknown', entries, patterns), 'Unknown');
  assert.equal(translateText('   ', entries, patterns), '   ');
});

test('patterns skip text longer than the limit', () => {
  const long = `${'x'.repeat(MAX_PATTERN_TEXT)} saved`;
  assert.equal(translateText(long, entries, patterns), long);
});

test('an invalid pattern is reported, not thrown', () => {
  assert.deepEqual(invalidPatterns(patterns), ['(']);
});
