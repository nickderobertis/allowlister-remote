# Changelog

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
