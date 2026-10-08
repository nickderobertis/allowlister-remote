# AGENTS — `packages`

- `packages/allowlister-remote-web` is the npm package for the static PWA: a zero-dependency static
  server (`bin/serve.mjs`) plus the prebuilt `out/` bundle vendored into `static/` at release time.
  Run it with `npx @nickderobertis/allowlister-remote-web` (or host the assets anywhere) and point
  it at a broker in the app. It is not a workspace member, so its publish-time version never drifts
  the dev lockfile.
- `packages/allowlister-remote-plugin` is the parent npm package users install; it carries
  only a small JS launcher plus an `install.mjs` that links the native binaries onto the command path.
- `packages/allowlister-remote-plugin-{darwin-arm64,linux-x64,win32-x64}` are the per-platform npm
  packages that each ship the release-built plugin **and** daemon binaries (the plugin auto-starts
  the daemon as a sibling on every OS), gated by `os`/`cpu`. The parent declares
  them as optional dependencies so npm installs only the one matching the host. These are published
  from their directories (not workspace members) so their `os`/`cpu` gates do not break dev installs.
- Native binaries are vendored into the per-platform packages only at release time and are never
  committed; `npm run release:stage-npm` stages them from the downloaded release artifacts. The PWA
  bundle is likewise vendored into the web package only at release time: `npm run release:stage-web`
  builds nothing itself but copies a prebuilt `apps/web/out` into `packages/allowlister-remote-web/static`
  and stamps the version. Both `apps/web/out` and the web package's `static/` are gitignored.
