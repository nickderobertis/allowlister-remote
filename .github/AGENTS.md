# AGENTS — `.github`

- `macos-policy.mjs classify` is the only authority for omitting the PR Mac
  lane; `check.yml` routing and the `check` carrier never omit it on their own.
- **Draft rule (manager-approved amendment).** An ordinary `pull_request` whose
  payload has `draft` set to the literal boolean `true` classifies as
  `macosRequired:false` with reason `draft pull request: Mac lane deferred to
  ready_for_review`; the carrier succeeds naming that reason. A missing, null or
  non-boolean flag fails closed to Mac, and `isReleaseOnly` is unchanged.
- Every workflow reporting a required context triggers on `ready_for_review`, so
  lifting a draft re-runs them all and runs the one Mac job: draft pushes spend
  0 Mac runs, the lift 1, the release build 1.
- See `README.md` for the proof and budget tooling.
