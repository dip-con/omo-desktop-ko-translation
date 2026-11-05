# OmO 한글 화면 모드

OmO 데스크톱 앱 화면을 한글로 바꾸는 모드예요. [OmO Mods](https://github.com/dip-con/omo-desktop-mod) 로더 위에서 돌아요.

## 설치

```bash
curl -fsSL https://raw.githubusercontent.com/dip-con/omo-desktop-mod/main/install.sh | bash
```

이 한 줄이 로더와 이 모드를 같이 설치해요. 그다음 OmO를 종료하고 `OmO Mods.app`을 열면 돼요. 업데이트는 앱의 **설정 > 모드**에서 해요.

## 구성

```
mods/ko/mod.json            모드 정보
mods/ko/page.js             화면 글자, aria-label, title, placeholder 번역
mods/ko/host.mjs            번역 처리, 빠진 문구 기록
mods/ko/translate.mjs       정확히 같은 문구를 먼저 찾고, 없으면 $1..$9 패턴
mods/ko/ko.json             사전 {entries, patterns}
mods/ko/keep-english.json   일부러 영어로 두는 문구
tools/                      사전 작업 도구
docs/GLOSSARY.md            용어집
```

사전 작업 방법은 [DICTIONARY.md](DICTIONARY.md)에 있어요.

## 로더 코드 위치 (OMO_MODS_DIR)

`extract`, `collect` 같은 도구는 앱 경로와 상태 폴더를 알려고 로더의 `src/core/*.mjs`를 불러요. 기본으로 옆 폴더 `../omo-desktop-mod`를 찾아요. 다른 곳에 있으면 지정하세요.

```bash
OMO_MODS_DIR=/path/to/omo-desktop-mod npm run extract
```

## 테스트

```bash
npm test
```

사전의 영어 원문은 OmO 앱 화면 문구예요.

## English

Korean UI mod for the OmO desktop app, installed together with the OmO Mods loader by the one-line installer. Tools read the
loader core from `$OMO_MODS_DIR` (default `../omo-desktop-mod`). See DICTIONARY.md for adding keys. License: MIT.
