# 사전 다루기

사전은 `mods/ko/ko.json`이에요.

- `entries`: 영어 문구 그대로를 키로, 한글을 값으로 둬요.
- `patterns`: 문장 전체에 맞는 패턴이에요. `$1`..`$9`로 바뀌는 부분을 받아요.
- `mods/ko/keep-english.json`의 `entries`: 번역하지 않을 문구와 그 이유예요.

## 빠진 문구 추가하기

설정 화면(`#/settings`)을 돌아다니면 번역이 없는 문구가 상태 폴더의 `ko-missing.json`에 쌓여요.

1. 모아요.

   ```bash
   npm run collect
   ```

   기록된 것 중 아직 사전에 없는 것만 많이 나온 순서로 `pending.json`에 써요. 옵션: `--from <ko-missing.json>`, `--out <file>`, `--dir <mod 폴더>`.

2. 추가해요.

   ```bash
   npm run add-key -- "Open settings" "설정 열기"
   npm run add-key -- --file pairs.json
   npm run add-key -- "GitHub" --keep-english "제품 이름"
   ```

   `pairs.json`은 `{"영어": "한글"}` 묶음이에요. 키는 정렬된 위치에 들어가고 `pending.json`에서 빠져요. 이미 있는 키를 바꾸려면 `--replace`를 붙여요. `--pending`, `--dir`로 파일 위치를 바꿀 수 있어요.

3. 테스트하고 커밋, push 해요.

   ```bash
   npm test
   git add mods/ko && git commit -m "ko: 문구 추가" && git push
   ```

4. 앱의 **설정 > 모드**에서 [업데이트 확인], [업데이트 적용], [지금 새로 고침]을 눌러요.

## 앱에서 문구 뽑기 (extract / check)

```bash
npm run extract              # strings.json 생성 (--out, --app)
npm run check                # 사전에 없는 문구 목록 (--strings, --dir)
npm run check -- --strict    # 빠진 게 있으면 exit 1
```

`extract`는 OmO.app 클라이언트 파일 중 이름에 `settings`가 들어간 것과 메인 청크에서 화면 문구처럼 보이는 문자열을 뽑아요. `strings.json`과 `pending.json`은 git에 올리지 않아요.

## English

Dictionary lives in `mods/ko/ko.json` (`entries`, `patterns`) plus `keep-english.json`. Workflow: `npm run collect` ->
`npm run add-key -- "<en>" "<ko>"` (or `--file`, `--keep-english`) -> `npm test`, commit, push -> update from Settings > 모드.
Use `npm run extract` and `npm run check` to find uncovered strings in the app.
