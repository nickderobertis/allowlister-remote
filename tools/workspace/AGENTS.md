# AGENTS — `tools/workspace`

- `tools/workspace` (`type:tooling`) holds the repo-level JavaScript checks (the tag-based
  boundary check; the workflow, graph and hook tests) and owns the root `scripts/` and config
  files.
- Biome formats and lints those root files here.
- `check-boundaries.mjs` (run by `lint`) enforces the tag rules over the Nx graph
  and fails when a Cargo path dependency between crates is not also a declared Nx
  edge — Nx does not infer Rust dependencies here, so crates declare
  `implicitDependencies`.
- `tests/` covers the CI workflow contract, the boundary checker, affected
  selection and task ordering asked of `nx` itself, and the SessionStart and
  pre-push hooks in scratch copies. `project.json` lists the test files because
  CI's Node 20 `--test` does not take a directory.
- When a target here starts reading another root file, add it to this project's
  inputs, or a change to that file will skip the check.
