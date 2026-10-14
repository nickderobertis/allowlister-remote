# AGENTS — `pool-maintenance`

- Owns `allowlister-remote-pool-maintenance-seconds`: how long one steady-state pass of the
  pool maintenance `onevcs.toml` declares (`just pool-maintenance`) holds a warm slot out of
  service. `measure.sh` clears the backlog untimed, builds the gate's test targets under an
  alternative profile and backdates them, rebuilds normally, then reports the timed pass.
- The measurement builds the workspace twice, so its target is `budgets-release`, not
  `budgets-host`: no per-change run (`just check`, `nx affected -t budgets budgets-host`)
  reaches it. Only the release PR runs it, after the sweep (`check.yml`).
- `result.mjs` validates the JSON `measure.sh` reads and writes. `POOL_MAINTENANCE_WORK_DIR`
  keeps the before/after entry listings for inspection. `tools/workspace/tests/pool-maintenance.test.mjs`
  runs `measure.sh` with only cargo's builds stubbed.
