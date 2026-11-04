# Korean UI mod

**This mod does not work on its own.** Install the loader platform first: https://github.com/grim-susemi/omo-desktop-mod-loader

This optional mod translates supported OmO interface text into Korean while leaving selected names and technical terms in English.

**App-text licence notice:** the dictionary includes text derived from the application's interface. Read [KO-DICTIONARY-NOTICE.md](KO-DICTIONARY-NOTICE.md) and [LICENSES.md](LICENSES.md) before using or redistributing it.

## Install

1. Install the loader platform using the instructions at https://github.com/grim-susemi/omo-desktop-mod-loader
2. From the loader checkout, add this mod (replace the path with this checkout's `mods/ko` folder):

   ```sh
   node tools/install.mjs --mod <path-to-this-checkout>/mods/ko
   ```

Use the **Settings > 모드** switch to turn it off. To uninstall only this mod, rerun the loader's installer without its `--mod` argument; include `--mod` for every other external mod you want to keep. The installer removes files omitted from its new install plan. See the loader repository's installation instructions (https://github.com/grim-susemi/omo-desktop-mod-loader).

## Coverage

The measured gated untranslated ratios on OmO 2026.1102.3, 2026-11-04, were: home 0.0%, settings/models 2.7%, settings/tools 2.2%, settings/general 1.3%, settings/diagnostics 1.1%, and every other settings screen 0.0%.

## Development

Run `npm test` for the standalone unit suite. `npm run test:local` runs local integration checks, which need a loader checkout, Chrome, and, for app-dependent checks, an installed app and generated inputs. Set `LOADER_DIR` to the loader checkout root containing `loader/cdp.mjs`. Missing prerequisites are reported as skips where supported. See [DICTIONARY.md](DICTIONARY.md) for extraction and maintenance.

## 한국어 요약

이 모드는 OmO 데스크톱 앱의 화면을 한국어로 바꾸며 단독으로 실행되지 않습니다. 로더를 먼저 설치한 뒤 이 모드를 추가하세요. 설정 > 모드에서 끌 수 있습니다. 앱 화면 문구의 사용 및 배포 조건은 위 라이선스 고지를 확인하세요.
