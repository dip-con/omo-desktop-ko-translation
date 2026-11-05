# 한글 사전

한글 모드는 `mods/ko/ko.json`으로 화면 글자를 바꿔요. 영어로 둘 문구는 `mods/ko/keep-english.json`, 자동 추출로 못 잡는 문구의 출처 기록은 `mods/ko/manual.json`에 있어요. 사전 라이선스는 [KO-DICTIONARY-NOTICE.md](KO-DICTIONARY-NOTICE.md)를 보세요.

## 새 한글 키는 이 저장소에서 추가

설치된 `~/.omo/app-mods/ko`를 직접 고치지 마세요. 업데이트할 때 덮어써져요. 순서는 이래요.

1. **앱을 쓰는 동안 모아져요.** ko 모드는 번역하지 못한 화면 문구를 `~/Library/Application Support/omo-app-mods/ko-missing.json`에 기록해요 (2초마다 한 번, 최대 5000개).
2. **모으기:**

   ```sh
   npm run collect
   ```

   `ko-missing.json`에서 아직 처리 안 된 문구만 골라 `mods/ko/pending.json`에 많이 나온 순서로 적어요. 다른 파일을 읽으려면 `npm run collect -- --from <파일>`.
3. **한글 추가:**

   ```sh
   npm run add-key -- "<영문>" "<한글>"
   npm run add-key -- "<영문>" --keep-english "<이유>"   # 영어로 둘 때
   ```

   `ko.json`에 항목을 붙이고 `manual.json`에 출처(`runtime`)를 남긴 뒤 `pending.json`에서 지워요. 메모는 `--note "<메모>"`. 이미 있는 키면 거부해요. 영문은 앞뒤 공백 없이 화면 글자 그대로 넣어요.
4. **커밋:** `git commit`으로 이 저장소에 남겨요.
5. **반영:** 설정 > 모드 > 업데이트에서 [업데이트 확인] → [업데이트 적용], 또는

   ```sh
   node ~/.omo/app-mods/_loader/update.mjs --mod ko
   ```

   그다음 [지금 새로 고침]을 누르거나 앱을 다시 열어요.

## 사전 전체 검사 (macOS)

`strings.json`은 설치된 앱 빌드의 화면 문구 목록이라 빌드마다 달라서 배포하지 않아요. 내 컴퓨터에서 뽑아요.

```sh
node tools/extract-strings.mjs --out mods/ko/strings.json
node tools/dictionary-check.mjs
```

추출기는 `/Applications/OmO.app/Contents/Resources`를 읽기만 해요. `LOADER_DIR`(로더 체크아웃 폴더)를 설정하면 로더에 기록된 앱 위치와 지문 함수를 써요. 검사는 지문이 안 맞는 항목과 어느 사전에도 없는 문구를 알려 줘요. 깨끗하면 0, 문제가 있으면 1, `strings.json`이 없으면 2로 끝나요.

### 추출기가 잡는 것

클라이언트 파일의 문자열 중 이런 모양만 잡아요.

- `children:` 바로 뒤의 문자열
- `label:`, `title:`, `description:`, `placeholder:`, `tooltip:`, `"aria-label":` 뒤의 문자열
- `"/settings/<name>":` 뒤의 문자열

120자 넘는 것, 글자가 없는 것, `${`·URL·마크업이 든 것은 빼요. 나머지(실행 중 조립되는 문구 등)는 위의 런타임 수집과 `add-key`로 넣어요.

## OmO 업데이트 뒤

1. 앱을 실행해 써 보고 `npm run collect`로 새로 빠진 문구를 확인해요. 위 1~5단계로 채워요.
2. 전체를 보려면 `extract-strings` → `dictionary-check`를 다시 돌려요.
3. 화면별 커버리지: `node tools/coverage.mjs --out <폴더>`는 `fixtures/live`의 스냅숏으로 오프라인 측정해요. 스냅숏은 OmO를 종료한 뒤 `node tools/probe-app.mjs --out <폴더>`, `node tools/snapshot-app.mjs --ev <폴더> --snap fixtures/live --expect-version <버전>`, 다시 `probe-app` 순서로 만들어요. 이 두 도구는 앱을 직접 띄우는데, macOS판에서는 아직 실제로 돌려 보지 않았어요.

빌드를 기록할 필요는 없어요. 모드가 붙을지는 앵커가 정해요.

## 원작

이 사전과 도구는 grim-susemi의 [omo-desktop-ko-translation](https://github.com/grim-susemi/omo-desktop-ko-translation)(MIT)에서 왔어요. [LICENSES.md](LICENSES.md)도 함께 보세요.

## English

New Korean keys are added in this repository: the ko mod logs untranslated UI text to `~/Library/Application Support/omo-app-mods/ko-missing.json`; `npm run collect` turns it into `mods/ko/pending.json`; `npm run add-key -- "<en>" "<ko>"` (or `--keep-english <reason>`) adds one; commit; then apply with Settings > 모드 > 업데이트 or `node ~/.omo/app-mods/_loader/update.mjs --mod ko`. Full check: `node tools/extract-strings.mjs --out mods/ko/strings.json` then `node tools/dictionary-check.mjs`.
