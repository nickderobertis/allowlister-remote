# Changelog

## [0.15.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.14.1...v0.15.0) (2026-06-24)


### Features

* add logging, CLI help, and first-load/auto-start robustness ([#95](https://github.com/nickderobertis/allowlister-remote/issues/95)) ([860b4ef](https://github.com/nickderobertis/allowlister-remote/commit/860b4ef67f85d6412d932630b783003c3124f7a9))


### Bug Fixes

* **plugin:** make the no-daemon test portable so macOS CI passes ([#98](https://github.com/nickderobertis/allowlister-remote/issues/98)) ([a809de2](https://github.com/nickderobertis/allowlister-remote/commit/a809de261f836ffd945acbd1bcc281f5b0146ff5))

## [0.14.1](https://github.com/nickderobertis/allowlister-remote/compare/v0.14.0...v0.14.1) (2026-06-23)


### Bug Fixes

* **daemon:** derive broker /ws/daemon endpoint from a base URL ([#94](https://github.com/nickderobertis/allowlister-remote/issues/94)) ([3f9fa9a](https://github.com/nickderobertis/allowlister-remote/commit/3f9fa9a2f0b223c832563c6307a6035058d0ec4b))


### Performance Improvements

* **web:** gzip text assets in the static PWA server ([#89](https://github.com/nickderobertis/allowlister-remote/issues/89)) ([81c82dd](https://github.com/nickderobertis/allowlister-remote/commit/81c82ddbfb3c79d154aaee89e2fc4166bc100dff))
* **web:** prerender the resting view to paint LCP at first paint ([#90](https://github.com/nickderobertis/allowlister-remote/issues/90)) ([6afc1c8](https://github.com/nickderobertis/allowlister-remote/commit/6afc1c8ac26f4cd7f7c416d752e5473e139f08fc))

## [0.14.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.13.0...v0.14.0) (2026-06-23)


### Features

* **web:** add deterministic heap-footprint profiling for the PWA ([#87](https://github.com/nickderobertis/allowlister-remote/issues/87)) ([2f0730e](https://github.com/nickderobertis/allowlister-remote/commit/2f0730e6cb6028a1a4bbb0c63bd86bd02e8802ee))

## [0.13.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.12.0...v0.13.0) (2026-06-23)


### Features

* **web:** lint-error React Compiler bailouts and fix the one we had ([#84](https://github.com/nickderobertis/allowlister-remote/issues/84)) ([e621b94](https://github.com/nickderobertis/allowlister-remote/commit/e621b9435ca2188fcddbd5dd4bfb00ac11bbafe1))


### Performance Improvements

* add profiling coverage for the daemon and broker ([#85](https://github.com/nickderobertis/allowlister-remote/issues/85)) ([0384086](https://github.com/nickderobertis/allowlister-remote/commit/0384086597df0b02a45bd4100426f151cddb36b2))

## [0.12.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.11.0...v0.12.0) (2026-06-23)


### Features

* **web:** enable React Compiler and add deterministic render-cost harness ([#80](https://github.com/nickderobertis/allowlister-remote/issues/80)) ([ddcce06](https://github.com/nickderobertis/allowlister-remote/commit/ddcce06a5de5ea8dfdb7be56e04c690052674168))
* **web:** harden PWA conventions — connection status, error boundaries, broker reconfigure ([#77](https://github.com/nickderobertis/allowlister-remote/issues/77)) ([3ba3f7c](https://github.com/nickderobertis/allowlister-remote/commit/3ba3f7cecfde7f81ca8867fb387141d6302fa43e))

## [0.11.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.10.0...v0.11.0) (2026-06-23)


### ⚠ BREAKING CHANGES

* make the broker the only approval transport, remove HTTP polling ([#75](https://github.com/nickderobertis/allowlister-remote/issues/75))

### Features

* auto-release every component — static PWA on npm, broker as a standalone CLI ([#76](https://github.com/nickderobertis/allowlister-remote/issues/76)) ([d708245](https://github.com/nickderobertis/allowlister-remote/commit/d70824528d0411c789ed9991311fc9bf7fc7079d))


### Bug Fixes

* **web:** render the approval script as a real for-loop and trip a loop-body command ([#70](https://github.com/nickderobertis/allowlister-remote/issues/70)) ([e7240b0](https://github.com/nickderobertis/allowlister-remote/commit/e7240b0e675f71809d309cfa22e2482e5a0b6a9d))


### Code Refactoring

* make the broker the only approval transport, remove HTTP polling ([#75](https://github.com/nickderobertis/allowlister-remote/issues/75)) ([58e9272](https://github.com/nickderobertis/allowlister-remote/commit/58e927219829ef1fd5dffc6ad2baae2fe288f4a5))

## [0.10.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.9.1...v0.10.0) (2026-06-22)


### Features

* **plugin:** render tool-call JSON input in terminal approval prompt ([#67](https://github.com/nickderobertis/allowlister-remote/issues/67)) ([d066c18](https://github.com/nickderobertis/allowlister-remote/commit/d066c1867b1ae516f52e429b765a5b466b94b48c))

## [0.9.1](https://github.com/nickderobertis/allowlister-remote/compare/v0.9.0...v0.9.1) (2026-06-22)


### Bug Fixes

* **web:** make dark-theme JSON coloring read clearly ([#68](https://github.com/nickderobertis/allowlister-remote/issues/68)) ([f892744](https://github.com/nickderobertis/allowlister-remote/commit/f892744126a731dd567faa825e279958d5870f6b))

## [0.9.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.8.0...v0.9.0) (2026-06-22)


### Features

* **web:** add app logo and README banner ([#64](https://github.com/nickderobertis/allowlister-remote/issues/64)) ([5526db4](https://github.com/nickderobertis/allowlister-remote/commit/5526db416ef3a2c17b878a9e8afa3304feee87b1))

## [0.8.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.7.0...v0.8.0) (2026-06-21)


### Features

* **web:** preview script and tool-call data on inbox cards ([#62](https://github.com/nickderobertis/allowlister-remote/issues/62)) ([3407869](https://github.com/nickderobertis/allowlister-remote/commit/340786956ba345403033d191774d373dc8b1a809))
* **web:** syntax-highlight the tool call JSON view ([#61](https://github.com/nickderobertis/allowlister-remote/issues/61)) ([d6d1536](https://github.com/nickderobertis/allowlister-remote/commit/d6d1536294be6dab43f280e983a397e5eed2dd78))

## [0.7.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.6.1...v0.7.0) (2026-06-21)


### Features

* **plugin:** surface flagged fragments at the local terminal prompt ([#60](https://github.com/nickderobertis/allowlister-remote/issues/60)) ([168df72](https://github.com/nickderobertis/allowlister-remote/commit/168df72040b6566800e6919c00c1739642501a18))
* remove approval timeouts and refine approval UI ([#54](https://github.com/nickderobertis/allowlister-remote/issues/54)) ([1d31a8c](https://github.com/nickderobertis/allowlister-remote/commit/1d31a8c5a8ca7b4bf0c970c00e2778026ae5134a))
* surface the harness session id from allowlister protocol v3 ([#57](https://github.com/nickderobertis/allowlister-remote/issues/57)) ([ba718fe](https://github.com/nickderobertis/allowlister-remote/commit/ba718fe4affa390995f6f83eceaf57cc3df72caf))

## [0.6.1](https://github.com/nickderobertis/allowlister-remote/compare/v0.6.0...v0.6.1) (2026-06-20)


### Bug Fixes

* **plugin:** make daemon mode Unix-only so the Windows release builds ([#52](https://github.com/nickderobertis/allowlister-remote/issues/52)) ([21209fa](https://github.com/nickderobertis/allowlister-remote/commit/21209fa2ff588d75ab9ecd0acf2af4793a9b4632))

## [0.6.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.5.0...v0.6.0) (2026-06-20)


### Features

* realtime PWA↔plugin approval sync via Rust broker and daemon ([#50](https://github.com/nickderobertis/allowlister-remote/issues/50)) ([d919c14](https://github.com/nickderobertis/allowlister-remote/commit/d919c14db40185cfc0ccb0ad7cb791897a9d627c))

## [0.5.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.4.0...v0.5.0) (2026-06-20)


### Features

* **web:** add system-aware dark/light theme with toggle ([#46](https://github.com/nickderobertis/allowlister-remote/issues/46)) ([d671be7](https://github.com/nickderobertis/allowlister-remote/commit/d671be71432578247950e90c2ed89845f2faa3a7))

## [0.4.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.3.0...v0.4.0) (2026-06-20)


### Features

* **web:** full desktop keyboard navigation with in-UI shortcut hints ([#36](https://github.com/nickderobertis/allowlister-remote/issues/36)) ([000e8a9](https://github.com/nickderobertis/allowlister-remote/commit/000e8a9fa7cf4cb5afd9e47963ea2a194665f889))
* **web:** render real allowlister v2 data and tool-call approvals ([#31](https://github.com/nickderobertis/allowlister-remote/issues/31)) ([6aa329c](https://github.com/nickderobertis/allowlister-remote/commit/6aa329c3ad920183bff06088f7f637f2299619c0))


### Bug Fixes

* **release:** drive releases from all paths via simple release-type + tag-stamped version ([#44](https://github.com/nickderobertis/allowlister-remote/issues/44)) ([8fe47f6](https://github.com/nickderobertis/allowlister-remote/commit/8fe47f6a8d9133c4fb1ba0d2b2bce9d47486c622))


### Performance Improvements

* **plugin:** cut per-invocation startup on the no-network hot path ([#38](https://github.com/nickderobertis/allowlister-remote/issues/38)) ([028b7c9](https://github.com/nickderobertis/allowlister-remote/commit/028b7c9c7b8d0fa6f61bf66c9ef0e0e5f51652b6))
* **plugin:** ship the linux binary as a static musl build ([#39](https://github.com/nickderobertis/allowlister-remote/issues/39)) ([ba5b2f2](https://github.com/nickderobertis/allowlister-remote/commit/ba5b2f26299f11602fed02617e7332e73b1df8c8))

## [0.3.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.2.4...v0.3.0) (2026-06-19)


### Features

* approve at the local terminal and wait indefinitely ([#21](https://github.com/nickderobertis/allowlister-remote/issues/21)) ([1e1562c](https://github.com/nickderobertis/allowlister-remote/commit/1e1562c82f6df2e264950f9d7629f1425e94cd4b))


### Performance Improvements

* **plugin:** add performance profiling and benchmarking suite ([#26](https://github.com/nickderobertis/allowlister-remote/issues/26)) ([69a9479](https://github.com/nickderobertis/allowlister-remote/commit/69a9479fdfa3c4df9aa9109d0a162f0b3d8c09bd))

## [0.2.4](https://github.com/nickderobertis/allowlister-remote/compare/v0.2.3...v0.2.4) (2026-06-19)


### Bug Fixes

* return ask verdict on invalid plugin input instead of panicking ([#16](https://github.com/nickderobertis/allowlister-remote/issues/16)) ([7edb467](https://github.com/nickderobertis/allowlister-remote/commit/7edb4671836cb90e1daa0ccb6e482b77dbf6f255))

## [0.2.3](https://github.com/nickderobertis/allowlister-remote/compare/v0.2.2...v0.2.3) (2026-06-19)


### Bug Fixes

* add crate repository metadata ([ab42460](https://github.com/nickderobertis/allowlister-remote/commit/ab42460f3ddb7c9115564861d00c9b2a75a722c6))

## [0.2.2](https://github.com/nickderobertis/allowlister-remote/compare/v0.2.1...v0.2.2) (2026-06-19)


### Bug Fixes

* use current plugin version in user agent ([c2a8773](https://github.com/nickderobertis/allowlister-remote/commit/c2a8773503eba24a14f1c4c00679bc65e12dff18))

## [0.2.1](https://github.com/nickderobertis/allowlister-remote/compare/v0.2.0...v0.2.1) (2026-06-19)


### Bug Fixes

* publish supported release artifacts ([a1c536b](https://github.com/nickderobertis/allowlister-remote/commit/a1c536b539383a4dfbd20888cd22a40e27a83a77))

## [0.2.0](https://github.com/nickderobertis/allowlister-remote/compare/v0.1.0...v0.2.0) (2026-06-18)


### Features

* add automated release publishing ([7a35c9f](https://github.com/nickderobertis/allowlister-remote/commit/7a35c9fe688696979d0bb16a9187ed7700f1901b))
