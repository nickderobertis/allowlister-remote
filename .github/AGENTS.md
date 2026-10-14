# AGENTS — `.github`

- Only `macos-policy.mjs classify` may omit the PR Mac lane; `check.yml` and the
  `check` carrier never omit it on their own.
- Draft rule: only a literal-true `draft` defers the Mac lane, and never makes a
  PR release-only; anything else fails closed to Mac.
- Workflows reporting a required context must trigger on `ready_for_review`, the
  run that proves a lifted draft on macOS.
