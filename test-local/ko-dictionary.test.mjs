import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR } from '../tools/extract-strings.mjs';

// The dictionary is built from the installed client on this PC, so these checks read mods/ko directly.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const stringsPath = path.join(root, 'mods/ko/strings.json');
const strings = fs.existsSync(stringsPath) ? JSON.parse(fs.readFileSync(stringsPath, 'utf8')) : null;
const needsStrings = { skip: strings ? false : 'strings.json absent; generated-data assertion skipped' };
const ko = JSON.parse(read('mods/ko/ko.json'));
const keep = JSON.parse(read('mods/ko/keep-english.json'));
const facts = JSON.parse(read('docs/app-facts.json'));
const manual = JSON.parse(read('mods/ko/manual.json'));
const glossary = read('mods/ko/glossary.md');

const KEEP_CATEGORIES = new Set(['brand', 'shortcut', 'code', 'term', 'sample', 'name']);
const HANGUL = /[가-힣]/;
const FRAGMENT = /^[a-z]/;
const PLACEHOLDER = /\{\{[^{}]+\}\}|\{[^{}]+\}|%s|%d|\$\{[^{}]+\}/g;
const SETTINGS_PAGES = {
  General: '일반', Appearance: '모양', Keybindings: '단축키', 'Models & providers': '모델 & 공급자',
  Runtime: '런타임', Tools: '도구', Memory: '메모리', Integrations: '통합', 'Source control': '소스 컨트롤',
  Connections: '연결', Storage: '저장 공간', About: '정보', Diagnostics: '진단',
  'Open source licenses': '오픈소스 라이선스', Project: '프로젝트',
};

const FAMILIES = [
  { name: 'storage', en: 'storage', key: /\bstorages?\b/i, term: '저장 공간', forbidden: [/저장소/] },
  { name: 'repository', en: 'repository', key: /\brepositor(?:y|ies)\b/i, term: '저장소', forbidden: [/리포지토리|레포/] },
  { name: 'diff', en: 'diff', key: /\bdiffs?\b/i, term: 'diff', forbidden: [/디프|변경점|변경 내용/] },
  { name: 'pull request', en: 'pull request', key: /\bpull requests?\b/i, term: '풀 리퀘스트', forbidden: [/풀 요청|끌어오기 요청/] },
  { name: 'push', en: 'push', key: /\bpush\b/i, term: '푸시', forbidden: [/\bpush\b/i] },
  { name: 'pull', en: 'pull', key: /\bpull\b/i, exclude: /pull request|pull the dot/i, term: '풀', forbidden: [/\bpull\b/i] },
  { name: 'PR', en: 'PR', key: /\bPRs?\b/, exclude: /pull request/i, term: 'PR', forbidden: [/풀 리퀘스트/] },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseRows(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((c) => c.length === 2 && c[0] !== '영어' && !/^-+$/.test(c[0]));
}

// Single-term rows are the first table, before the first "## " heading.
const [glossaryHead, ...glossarySections] = glossary.split(/^## /m);
const termRows = parseRows(glossaryHead);
const settingsSection = glossarySections.find((s) => s.startsWith('설정 페이지'));

// Prose only: code spans and path-like or file-like tokens are not screen wording.
const prose = (s) =>
  s.replace(/`[^`]*`/g, ' ').split(/\s+/).filter((t) => !/[/.?=_]/.test(t)).join(' ');

function entryKeysInFile(file) {
  const lines = read(file).split('\n');
  const start = lines.findIndex((l) => /^ {2}"entries": \{/.test(l));
  const keys = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^ {4}"((?:[^"\\]|\\.)*)": /.exec(l);
    if (m) keys.push(JSON.parse(`"${m[1]}"`));
  }
  return keys;
}

// First matching pattern wins, in key order, as an applier reading ko.patterns would do.
const applyPattern = (s) => {
  for (const [re, tpl] of Object.entries(ko.patterns ?? {})) {
    if (new RegExp(re).test(s)) return s.replace(new RegExp(re), tpl);
  }
  return null;
};

describe('dictionary files', () => {
  it('strings fingerprint matches the committed app facts', needsStrings, () => {
    assert.deepEqual(strings.fingerprint, facts.fingerprint);
  });

  it('fingerprints match the committed app facts', () => {
    assert.deepEqual(ko.fingerprint, facts.fingerprint);
    assert.deepEqual(keep.fingerprint, facts.fingerprint);
  });

  it('strings.json count equals the number of strings', needsStrings, () => {
    assert.equal(strings.count, strings.strings.length);
  });

  it('every extracted string is in ko entries or keep-english', needsStrings, () => {
    const missing = strings.strings.filter((s) => !(s in ko.entries) && !(s in keep.entries));
    assert.deepEqual(missing, []);
  });

  it('no string is both translated and kept English', () => {
    const overlap = Object.keys(ko.entries).filter((k) => k in keep.entries);
    assert.deepEqual(overlap, []);
  });

  it('ko entries are extracted strings or documented manual entries; keep-english entries are extracted', needsStrings, () => {
    const known = new Set(strings.strings);
    const manualOk = new Set(Object.entries(manual.entries)
      .filter(([, m]) => typeof m.source === 'string' && m.source.trim() && typeof m.note === 'string' && m.note.trim())
      .map(([k]) => k));
    const staleKo = Object.keys(ko.entries).filter((k) => !known.has(k) && !manualOk.has(k)).map((k) => `ko: ${JSON.stringify(k)}`);
    const staleKeep = Object.keys(keep.entries).filter((k) => !known.has(k)).map((k) => `keep: ${JSON.stringify(k)}`);
    assert.deepEqual([...staleKo, ...staleKeep], []);
  });

  it('manual.json pairs with ko.json, carries a source and note, and matches the app facts', () => {
    const errors = [];
    if (JSON.stringify(manual.fingerprint) !== JSON.stringify(facts.fingerprint)) errors.push('fingerprint differs from docs/app-facts.json');
    for (const [k, m] of Object.entries(manual.entries)) {
      if (!(k in ko.entries)) errors.push(`missing from ko.json: ${JSON.stringify(k)}`);
      else if (ko.entries[k] !== m.ko) errors.push(`ko text differs from ko.json: ${JSON.stringify(k)}`);
      if (typeof m.source !== 'string' || !m.source.trim()) errors.push(`empty source: ${JSON.stringify(k)}`);
      if (typeof m.note !== 'string' || !m.note.trim()) errors.push(`empty note: ${JSON.stringify(k)}`);
    }
    assert.deepEqual(errors, []);
  });

  it('manual sources still hold their string in the installed bundle; runtime-assembled entries are skipped', { skip: APP_DIR ? false : 'LOADER_DIR not set or invalid; app-dependent assertion skipped' }, (t) => {
    const forms = (s) => [...new Set([s, JSON.stringify(s).slice(1, -1), s.replace(/'/g, "\\'"), [...s].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')])];
    const holds = (buf, s) => forms(s).some((f) => buf.indexOf(Buffer.from(f, 'utf8')) >= 0);
    assert.ok(fs.existsSync(APP_DIR), `installed app not found at ${APP_DIR}`);
    let bundleFiles = null;
    const listBundle = () => {
      const out = [path.join(APP_DIR, 'resources/app.asar')];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
      walk(path.join(APP_DIR, 'resources/omo-server'));
      return out;
    };
    const stale = [];
    for (const [k, m] of Object.entries(manual.entries)) {
      if (m.source === 'runtime-assembled') { t.diagnostic(`skipped runtime-assembled: ${JSON.stringify(k.slice(0, 60))} (${m.note})`); continue; }
      const file = path.join(APP_DIR, m.source);
      if (fs.existsSync(file) && holds(fs.readFileSync(file), k)) continue;
      bundleFiles ??= listBundle();
      const elsewhere = bundleFiles.find((f) => holds(fs.readFileSync(f), k));
      stale.push(`${JSON.stringify(k.slice(0, 60))}: ${elsewhere ? `moved to ${path.relative(APP_DIR, elsewhere)}` : 'not found anywhere in the installed bundle'} (recorded source: ${m.source})`);
    }
    assert.deepEqual(stale, []);
  });

  it('no duplicate keys inside the entries objects', () => {
    for (const file of ['mods/ko/ko.json', 'mods/ko/keep-english.json']) {
      const keys = entryKeysInFile(file);
      assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], file);
    }
  });

  it('every translation is non-empty and contains Hangul', () => {
    const bad = Object.entries(ko.entries).filter(([, v]) => !v.trim() || !HANGUL.test(v));
    assert.deepEqual(bad, []);
  });

  it('every keep-english reason is a known category', () => {
    const bad = Object.entries(keep.entries).filter(([, v]) => !KEEP_CATEGORIES.has(v));
    assert.deepEqual(bad, []);
  });

  // The extractor drops braces, so brace placeholders ({x}, {{x}}) cannot reach strings.json today; this only covers the forms that can.
  it('placeholders in the source survive translation', () => {
    const bad = Object.entries(ko.entries).filter(([en, v]) => {
      const tokens = en.match(PLACEHOLDER) ?? [];
      return tokens.some((t) => !v.includes(t));
    });
    assert.deepEqual(bad, []);
  });

  it('"still appear(s) outdated" template keeps its subject and leaves no Latin template words', () => {
    const samples = [
      'Claude Code still appears outdated. Review provider settings for details.',
      'Claude Code and Codex still appear outdated. Check provider settings for details.',
    ];
    for (const sample of samples) {
      const out = applyPattern(sample);
      assert.ok(out !== null, sample);
      assert.ok(out.startsWith(sample.split(' still ')[0]), out);
      assert.doesNotMatch(out, /still|appears?|outdated|Review|Check|provider settings/, sample);
    }
  });

  it('pattern templates only reference capture groups that exist', () => {
    for (const [re, tpl] of Object.entries(ko.patterns ?? {})) {
      const groups = new RegExp(`${re}|`).exec('').length - 1;
      const refs = [...tpl.matchAll(/\$(\d)/g)].map((m) => Number(m[1]));
      assert.ok(refs.every((n) => n >= 1 && n <= groups), `${re} -> ${tpl}`);
      for (let n = 1; n <= groups; n++) assert.ok(refs.includes(n), `${re} drops capture $${n}: ${tpl}`);
    }
  });

  it('"was not updated" is matched before "updated" (first match wins)', () => {
    const keys = Object.keys(ko.patterns);
    assert.ok(keys.indexOf('^(.+) was not updated$') < keys.indexOf('^(.+) updated$'));
    assert.equal(applyPattern('Work machine was not updated'), 'Work machine 업데이트 안 됨');
    assert.equal(applyPattern('Work machine updated'), 'Work machine 업데이트됨');
  });

  it('plural and count templates keep their number and leave no Latin template words', () => {
    const samples = [
      ['^(\\d+) tools?$', '1 tool', '3 tools'],
      ['^(\\d+) more changes? in this release$', '1 more change in this release', '4 more changes in this release'],
      ['^(\\d+) older releases? not shown$', '1 older release not shown', '2 older releases not shown'],
      ['^Started (\\d+) threads? in background$', 'Started 1 thread in background', 'Started 5 threads in background'],
      ['^(\\d+) tool calls?$', '1 tool call', '7 tool calls'],
      ['^(\\d+) items?$', '1 item', '9 items'],
      ['^That prompt was restored or deleted before (\\d+) images? finished saving\\. Re-attach (?:it|them) if you still need (?:it|them)\\.$', 'That prompt was restored or deleted before 1 image finished saving. Re-attach it if you still need it.', 'That prompt was restored or deleted before 2 images finished saving. Re-attach them if you still need them.'],
    ];
    const latin = /\b(tools?|changes?|releases?|threads?|calls?|items?|images?|Started|background|Re-attach|them|it)\b/i;
    for (const [re, one, many] of samples) {
      assert.ok(re in ko.patterns, re);
      for (const sample of [one, many]) {
        const out = applyPattern(sample);
        assert.ok(out !== null, sample);
        assert.ok(out.includes(sample.match(/\d+/)[0]), `${sample} -> ${out}`);
        assert.doesNotMatch(out, latin, sample);
      }
    }
  });
});

describe('glossary', () => {
  it('single-term glossary words are used consistently in screen text', () => {
    const violations = [];
    // Mid-sentence fragments (English starts lowercase) are continuations that inline elements split off; the glossary noun can sit in a neighbouring node, so a fragment cannot carry it alone. Only fragments that would otherwise fail are exempt.
    const fragmentSkips = [];
    for (const [en, kr] of termRows) {
      const re = new RegExp(`\\b${escapeRe(en)}(s)?\\b`, 'i');
      for (const [source, value] of Object.entries(ko.entries)) {
        if (!re.test(prose(source)) || value.includes(kr)) continue;
        if (FRAGMENT.test(source)) { fragmentSkips.push(source); continue; }
        violations.push(`${en} -> ${kr}: ${source} => ${value}`);
      }
    }
    const skipped = [...new Set(fragmentSkips)];
    assert.ok(skipped.every((s) => FRAGMENT.test(s)), 'every exempt entry must start with a lowercase letter');
    console.log(`single-term fragment exemptions: ${skipped.length}`);
    assert.ok(skipped.length <= 12, `fragment exemptions ${skipped.length} exceed 12`);
    assert.deepEqual(violations, []);
  });

  it('each glossary family uses one rendering and no forbidden alternative', () => {
    const violations = [];
    for (const family of FAMILIES) {
      for (const [source, value] of Object.entries(ko.entries)) {
        if (!family.key.test(source) || family.exclude?.test(source)) continue;
        if (!value.includes(family.term)) violations.push(`${family.name} needs ${family.term}: ${source} => ${value}`);
        for (const bad of family.forbidden) if (bad.test(value)) violations.push(`${family.name} forbids ${bad}: ${source} => ${value}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('every glossary family term has its row in glossary.md', () => {
    const rows = parseRows(glossary);
    const missing = FAMILIES.filter((f) => !rows.some(([en, kr]) => en === f.en && kr === f.term)).map((f) => f.en);
    assert.deepEqual(missing, []);
  });

  it('glossary nouns take the right Korean particle', () => {
    const NOUNS = [
      { noun: '저장 공간', cls: 'consonant' },
      { noun: '저장소', cls: 'vowel' },
      { noun: '풀 리퀘스트', cls: 'vowel' },
      { noun: '푸시', cls: 'vowel' },
      { noun: '풀', cls: 'rieul', skip: ['이', '가'] },
      { noun: 'diff', cls: 'vowel' },
      { noun: '챌린지', cls: 'vowel' },
    ];
    const RIGHT = {
      consonant: ['을', '은', '이', '으로'],
      vowel: ['를', '는', '가', '로'],
      rieul: ['을', '은', '이', '로'],
    };
    const violations = [];
    for (const { noun, cls, skip = [] } of NOUNS) {
      const re = new RegExp(`(?<![가-힣])${escapeRe(noun)}(으로|을|를|은|는|이|가|로)(?=\\s|\\p{P}|$)`, 'gu');
      for (const [source, value] of Object.entries(ko.entries)) {
        for (const m of value.matchAll(re)) {
          if (skip.includes(m[1])) continue;
          if (!RIGHT[cls].includes(m[1])) violations.push(`${noun} takes ${m[1]} (${cls}): ${source} => ${value}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('no sentence ends in the formal -니다 style', () => {
    const formal = /(니다)[.!?]?$/;
    const bad = [];
    for (const [k, v] of Object.entries(ko.entries)) {
      for (const s of v.split(/(?<=[.!?])\s+/)) if (formal.test(s.trim())) bad.push(`${k} => ${s}`);
    }
    for (const [k, t] of Object.entries(ko.patterns)) {
      for (const s of t.split(/(?<=[.!?])\s+/)) if (formal.test(s.trim())) bad.push(`${k} => ${s}`);
    }
    assert.deepEqual(bad, []);
  });

  it('pattern templates use the glossary words', () => {
    const violations = [];
    for (const [en, kr] of termRows) {
      const re = new RegExp(`\\b${escapeRe(en)}(s)?\\b`, 'i');
      for (const [source, tpl] of Object.entries(ko.patterns)) {
        if (re.test(source) && !tpl.includes(kr)) violations.push(`${en} -> ${kr}: ${source} => ${tpl}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('repaired values stay repaired', () => {
    const REPAIRED = [
      ['Send shortcut', '보내기 단축키'],
      ['Open keybindings.json', 'keybindings.json 열기'],
      ['Read PRs', 'PR 읽기'],
    ];
    for (const [k, v] of REPAIRED) assert.equal(ko.entries[k], v, k);
    assert.ok(!('Open keybindings.json' in keep.entries));
    const token = Object.keys(ko.entries).find((k) => ko.entries[k] === '토큰을 복사한 뒤, 이 백엔드에 접근할 수 있는 호스트로 다른 클라이언트에서 페어링하세요.');
    assert.ok(token, 'token line present');
    assert.ok(!(token in keep.entries));
    assert.ok(ko.entries['Requested capabilities for a new environment-link challenge.'].includes('챌린지'));
    assert.equal(applyPattern('That prompt was restored or deleted before 2 images finished saving. Re-attach them if you still need them.'), '이미지 2개의 저장이 끝나기 전에 프롬프트가 복원되거나 삭제됐어요. 필요하면 다시 첨부하세요.');
  });

  it('settings page names used by the mod are in the dictionary with the glossary words', () => {
    assert.ok(settingsSection, 'settings section present');
    const rows = Object.fromEntries(parseRows(settingsSection));
    for (const [en, kr] of Object.entries(SETTINGS_PAGES)) {
      assert.equal(rows[en], kr, `glossary row for ${en}`);
      assert.equal(ko.entries[en], kr, `dictionary entry for ${en}`);
    }
  });
});
