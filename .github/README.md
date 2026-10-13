# macOS scheduling proofs

`macos-policy.mjs classify --event EVENT_JSON --base REF --head REF` is the
production classifier. Only a same-repository `release-please--branches--main`
head with a parsed version/changelog-only diff may omit PR Mac coverage. Author
and title are deliberately irrelevant: automation uses a personal access token.
Unreadable events, refs and manifests require Mac coverage on PRs. Known non-PR
GitHub events never require it. The check workflow offers a separate manual
`macos` diagnostic input, default false.

`github-workflows:test` executes the classifier over temporary git histories,
expands actual matrices and job conditions with `@actions/expressions`, traverses
reusable calls and downstream events, and records ignored `.telemetry/` output.
The screencomp fixture preserves the pinned reusable workflow declarations,
normalized through YAML parse/stringify to remove third-party comments. Source
URL, original-source digest, normalization and fixture digest in `tests/fixtures/provenance.json`; changing its call requires
refreshing that source fixture. Strict checkJs checks the classifier/carrier
contract types; graph/telemetry boundaries validate dynamic data at runtime. Unknown calls/runners/outputs are errors.

The recording target has caching disabled. Budget commands consume that output
without rerunning journeys and refuse a source-digest mismatch. Only the budget
registrations compare cost with limits. Their two separate scheduling bounds are
an explicit manager-approved exception, described at each registration. No
`budgets_track_product_owner_outcomes` marker is present because this repository
has no such configured rule; llmlint configuration/plugins are unchanged.

The slow Linux-only `allowlister-remote-plugin-npm:test-release` journey builds real binaries
through `packages/allowlister-remote-plugin/scripts/build-release-binaries.sh`, packs and installs the native npm
carrier and launcher, verifies byte reuse and version, and exercises failure on
a missing broker. It publishes nothing. Its explicit, cache-disabled target is selected by packaging
helper changes through the affected test recipe. The manager approved explicit
non-Linux skips: Darwin native smoke runs on the real Mac release builder, and
Windows gets real staging/packing contract coverage. No old assertion is skipped; Rust-only changes intentionally
retain their existing selection contract, as ruled by the manager. Local Linux execution uses rustc's host
GNU target; the release matrix's musl/Darwin/Windows target and artifact contracts
are checked separately. The Darwin release job executes the native smoke on its
actual Apple Silicon runner before Linux jobs publish anything.
