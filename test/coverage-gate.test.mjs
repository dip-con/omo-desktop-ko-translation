// Pure coverage gate rules (G7 T4): newOverflow, the screen failure rules and the keepHidden count. The coverage run
// itself is covered by a local-only browser check; these tests drive the rules with synthetic rows.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCopyLike, keepHiddenOf, newOverflowOf, screenFailures } from '../tools/coverage.mjs';

const GOOD = { screen: 'settings/general', untranslatedRatio: 0, styleCheck: { styled: true }, newOverflow: 0, onPassChangedNodes: 5, visibleButtons: 0, onPassKoreanButtons: 0 };

describe('newOverflowOf', () => {
  it('returns the elements that overflow only with the mod on', () => {
    // Given: element 1 overflows in both passes and element 2 only with the mod on; When: compared; Then: only element 2 is new
    const off = [{ i: 1, tag: 'button', text: 'Add action' }];
    const on = [{ i: 1, tag: 'button', text: 'Add action' }, { i: 2, tag: 'button', text: '액션 추가 버튼' }];
    assert.deepEqual(newOverflowOf(off, on).map((h) => h.i), [2]);
  });

  it('is empty when the off and on passes overflow the same elements', () => {
    // Given: the same hits in both passes; When: compared; Then: nothing is new
    const hits = [{ i: 1, tag: 'button', text: 'Add' }];
    assert.deepEqual(newOverflowOf(hits, hits), []);
  });
});

describe('screenFailures', () => {
  it('fails a screen whose mod-on pass overflows an element the off pass does not', () => {
    // Given: a screen with one new overflow; When: the rules run; Then: the screen fails on newOverflow
    const failures = screenFailures({ ...GOOD, newOverflow: 1 });
    assert.ok(failures.some((f) => f.includes('newOverflow 1')), failures.join(' | '));
  });

  it('passes a clean screen', () => {
    // Given: a screen with no failing measure; When: the rules run; Then: no failure
    assert.deepEqual(screenFailures(GOOD), []);
  });

  it('fails a screen whose on pass changed no node, and one rendered without app CSS', () => {
    // Given: two screens each broken in one measure; When: the rules run; Then: each names its failure
    assert.ok(screenFailures({ ...GOOD, onPassChangedNodes: 0 }).some((f) => f.includes('changed 0 nodes')));
    assert.ok(screenFailures({ ...GOOD, styleCheck: { styled: false } }).some((f) => f.includes('without app CSS')));
  });

  it('reports a missing screen unless it is allowed', () => {
    // Given: a missing screen row; When: the rules run with and without the allow flag; Then: it fails only without the flag
    const row = { screen: 'conversation', status: 'missing screen' };
    assert.equal(screenFailures(row).length, 1);
    assert.deepEqual(screenFailures(row, true), []);
  });
});

describe('keepHiddenOf', () => {
  it('counts copy-like keep-english values and leaves out non-linguistic ones', () => {
    // Given: a headline, a dotted label, a single long word, a units label, a version and a size; When: counted; Then: three copy-like values
    const r = keepHiddenOf(['What do you want to build in', 'Daily · Normal', 'across', 'Read/s', 'v1.2', '12 MB']);
    assert.equal(r.nodes, 3);
    assert.equal(r.distinct, 3);
    assert.deepEqual(r.strings, ['Daily · Normal', 'What do you want to build in', 'across']);
  });

  it('counts a single word of four or more letters', () => {
    // Given: one word 'across' and one short word 'to'; When: tested; Then: only the long word is copy-like
    assert.equal(isCopyLike('across'), true);
    assert.equal(isCopyLike('to'), false);
  });
});
