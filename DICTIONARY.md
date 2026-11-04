# The Korean dictionary

KoMod replaces interface text using `mods/ko/ko.json`. Strings that should stay English are listed in `mods/ko/keep-english.json`. The licensing of the dictionary is in [KO-DICTIONARY-NOTICE.md](KO-DICTIONARY-NOTICE.md).

## strings.json isn't shipped

`mods/ko/strings.json` is the list of interface strings in your installed OmO build. It changes with every app build, so it's extracted on your machine rather than shipped. Before checking the dictionary, run:

Set `LOADER_DIR` to the loader checkout root containing `loader/cdp.mjs`. The extraction, probe, snapshot, and coverage tools use that checkout's helpers. The local integration suite also uses it.

```
node tools/extract-strings.mjs --out mods/ko/strings.json
node tools/dictionary-check.mjs
```

The extractor reads the installed app and never writes to it. The check reports dictionary entries whose build fingerprint doesn't match `strings.json`, and extracted strings that neither dictionary covers. It exits 0 when clean and 1 when it found problems. If `strings.json` is missing, it exits 2 and prints the extract command above.

## What the extractor covers

It scans the app's client assets and picks up string literals in these shapes:

- `children:` followed directly by a literal
- `label:`, `title:`, `description:`, `placeholder:`, `tooltip:` or `"aria-label":` followed by a literal
- `"/settings/<name>":` followed by a literal

Literals longer than 120 characters, without a letter, or containing `${`, a URL or markup are dropped.

## Everything else needs a manual entry

Other object keys, lookup tables, ternaries, text built at runtime, and strings outside the client assets aren't extracted. Translate those by adding an entry to `mods/ko/manual.json` with:

- `ko`: the same text as in `ko.json`
- `source`: the app file where the string was found, or `runtime-assembled`
- `note`: a one-line reason

## After an OmO update

Run these in this order from the folder you installed from. `<dir>` is any empty folder for the output, and `<version>` is the new OmO version.

1. Run `node loader/check.mjs status` from the loader checkout to see which mods attached on the new build. `UNKNOWN_BUILD` here is expected; `ANCHOR_MISSING` means a mod was switched off because the layout changed.
2. Quit OmO from the tray. Then run `node tools/probe-app.mjs --out <dir>`. It starts the app itself, measures it, and writes `docs/app-facts.json`.
3. `node tools/snapshot-app.mjs --ev <dir> --snap fixtures/live --expect-version <version>` saves snapshots of each screen under `fixtures/live/<client>`. It stops if the installed version isn't `<version>`. Coverage reads only these snapshots.
4. `node tools/probe-app.mjs --out <dir>` once more, so `docs/app-facts.json` records where the snapshots are.
5. `node tools/extract-strings.mjs --out mods/ko/strings.json` rebuilds the string list from the new build.
6. `node tools/dictionary-check.mjs` lists fingerprint mismatches and new strings that neither dictionary covers. Exit 1 means it found some.
7. Translate: add each new string to `mods/ko/ko.json`, or to `mods/ko/keep-english.json` if it should stay English, or as a manual entry (see above). Run step 6 again until it exits 0.
8. `node tools/coverage.mjs --out <dir>` measures each screen offline over the snapshots and writes `coverage.json` to `<dir>`. Exit 1 means a screen leaves more than 5% of its text in English, a settings screen is under 95% translated, or a page script threw. Translate what it lists and run it again.
9. From the loader checkout, run `node loader/check.mjs --record-build` by hand only when `npm test` passed, the coverage run wrote its JSON with no exceptions, and `node tools/dictionary-check.mjs` exits 0.

## Current translation coverage

Measured 2026-11-04 on OmO 2026.1102.3. "Gated" is the untranslated ratio the gate uses: it leaves out text that isn't human language, such as model IDs and key chips.

| Screen | Untranslated (gated) |
| --- | --- |
| home | 0.0% |
| settings/models | 2.7% |
| settings/tools | 2.2% |
| settings/general | 1.3% |
| settings/diagnostics | 1.1% |
| every other settings screen | 0.0% |

## 한국어 요약

`strings.json`은 앱 빌드마다 달라서 배포하지 않아요. 먼저 `node tools/extract-strings.mjs --out mods/ko/strings.json`으로 뽑고,
`node tools/dictionary-check.mjs`로 지문 불일치와 번역 안 된 문자열을 확인해요. 파일이 없으면 검사 도구가 2로 끝나요.
OmO가 업데이트되면 위 9단계(상태 확인, probe, snapshot, probe, 추출, 검사, 번역, coverage, record-build)를 순서대로 해요.
