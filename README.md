# 한글 화면 모드 (macOS)

OmO 데스크톱 앱의 화면 글자를 한글로 바꾸는 모드예요. 모델 이름이나 기술 용어처럼 영어가 나은 것은 그대로 둬요. **혼자서는 동작하지 않아요.** 모드 로더를 함께 설치해야 해요.

**앱 문구 라이선스 안내:** 사전에는 앱 화면에서 가져온 문구가 들어 있어요. 쓰거나 다시 배포하기 전에 [KO-DICTIONARY-NOTICE.md](KO-DICTIONARY-NOTICE.md)와 [LICENSES.md](LICENSES.md)를 읽어 주세요.

## 설치 (macOS)

1. Node.js 24 이상을 준비하고 로더 저장소와 이 저장소를 나란히 받아요.

   ```sh
   git clone https://github.com/dip-con/omo-desktop-mod
   git clone https://github.com/dip-con/omo-desktop-ko-translation
   ```

2. 로더 저장소 폴더에서 이 저장소의 `mods/ko`를 넣어 설치해요.

   ```sh
   cd omo-desktop-mod
   node tools/install.mjs --mod ../omo-desktop-ko-translation/mods/ko
   ```

3. OmO를 종료하고 `~/Applications/OmO Mods.app`(Spotlight에서 "OmO Mods")으로 실행해요.

자세한 순서는 로더 저장소의 `INSTALL.ko.md`에 있어요. 끄려면 설정 > 모드의 스위치를 써요. 이 모드만 빼려면 이 `--mod` 없이 로더 설치를 다시 실행하세요(남길 다른 외부 모드의 `--mod`는 넣어야 해요).

## 업데이트

이 저장소에 새 번역이 들어오면 설정 > 모드 > 업데이트에서 [업데이트 확인] → [업데이트 적용]을 누르거나, 터미널에서 `node ~/.omo/app-mods/_loader/update.mjs --pull --mod ko`를 실행해요.

## 번역 추가와 개발

빠진 문구를 모으고 한글 키를 추가하는 방법은 [DICTIONARY.md](DICTIONARY.md)에 있어요. `npm test`는 단독 단위 테스트, `npm run test:local`은 로더 체크아웃(`LOADER_DIR`), Chrome, 설치된 앱이 필요한 로컬 통합 검사예요. 없는 조건은 건너뜀으로 표시돼요.

## 라이선스

코드 라이선스는 [LICENSE](LICENSE)(MIT), 사전 고지는 [KO-DICTIONARY-NOTICE.md](KO-DICTIONARY-NOTICE.md)를 보세요. 로더는 [dip-con/omo-desktop-mod](https://github.com/dip-con/omo-desktop-mod)에 있어요.

## English

Korean UI mod for OmO desktop on macOS (MIT). It needs the mod loader ([dip-con/omo-desktop-mod](https://github.com/dip-con/omo-desktop-mod)): from the loader checkout run `node tools/install.mjs --mod <this repo>/mods/ko`, quit OmO, then open `~/Applications/OmO Mods.app`. Read [KO-DICTIONARY-NOTICE.md](KO-DICTIONARY-NOTICE.md) and [LICENSES.md](LICENSES.md) before redistributing. See [DICTIONARY.md](DICTIONARY.md) for adding translations.
