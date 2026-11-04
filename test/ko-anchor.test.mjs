// Pattern anchoring (G6 S3, M1): a pattern must match the whole text. A prefix or suffix around a match stays unchanged.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { translateText } from '../mods/ko/translate.mjs';

const PATTERNS = { '(\\d+) tools? loaded\\.': '도구 $1개를 불러왔어요.' };

it('translates a text that is exactly the pattern match and leaves a text with a prefix or suffix unchanged', () => {
  // Given: an unanchored pattern; When: the whole text matches, or a prefix or suffix surrounds the match; Then: only the whole match is translated
  assert.equal(translateText('3 tools loaded.', {}, PATTERNS), '도구 3개를 불러왔어요.');
  assert.equal(translateText('x 3 tools loaded.', {}, PATTERNS), 'x 3 tools loaded.');
  assert.equal(translateText('3 tools loaded. extra', {}, PATTERNS), '3 tools loaded. extra');
});
