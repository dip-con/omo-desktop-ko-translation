# ko dictionary: where each string comes from

`tools/extract-strings.mjs` writes `mods/ko/strings.json`. The runtime reads only `mods/ko/ko.json` (`mods/ko/host.mjs:36-37`), so every key in `ko.json` must be either an extracted string or a documented manual entry.

## What the extractor matches today

The client scan runs over `resources/omo-server/client/assets` only. Three regexes (`tools/extract-strings.mjs:46-49`) pick up literals:

- `children:` followed directly by a literal (`` `...` `` or `"..."`).
- `label:`, `title:`, `description:`, `placeholder:`, `tooltip:` or `"aria-label":` followed by a literal.
- `"/settings/<name>":` followed by a literal.

Each captured literal then goes through `keepCandidate` (`tools/extract-strings.mjs:54-68`). It is dropped when it is longer than 120 characters (line 57), has no letter, contains `${`, a URL, a `/`-only token, or markup characters.

## What the matcher misses

Found in the bundle survey (28 keys):

- Object keys other than the listed ones (`created:`, `loading:`, `checking:`, `action:`, `markNotDone:`, `emptyLabel:`).
- Lookup tables and ternary or `??` values, assignments, and array children such as `children:[l,\`Add option\`]`.
- Strings longer than 120 characters, even under a matched key.
- Anything outside the client assets: `resources/app.asar` (main process), `resources/omo-server/t3.exe`, `resources/omo-server/client/third-party-licenses.json`.
- Text joined at runtime from parts, which has no literal in any file.

## The rule for anything outside those shapes

Add a `mods/ko/manual.json` entry with:

- `ko`: identical to the `ko.json` text (checked by the test).
- `source`: the bundle file (path relative to the install directory) where the string was found, or `runtime-assembled`.
- `note`: a one-line reason. Required, and required for `runtime-assembled` too.

The dictionary checks enforce this. A `ko.json` key passes when it is extracted or listed in `manual.json` with a non-empty source and note. A manual entry must match `ko.json`. A recorded source must still contain the string, and a string found nowhere in the bundle is reported as stale. `runtime-assembled` entries are skipped with a diagnostic instead of failing.

Do not weaken the extracted-string rule to make a key pass. Extend the matcher or add a manual entry with provenance.
