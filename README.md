# allowlister-remote

A standalone, modern progressive web app for approving allowlister dynamic
approval requests from a desktop, tablet, or phone.

The app is intentionally separate from `cloud-agent-dev-env`: it is a product UI
for allowlister, not setup glue for agent sessions.

## What it does

- Presents the important allowlister command fragments first, rather than making
  a human parse an entire shell script.
- Preserves rich allowlister context: harness, cwd, current verdict, current
  reason, parsed fragments, matched rules, and risk signals.
- Gives a full-screen installable approval experience with large allow/deny
  controls suitable for desktop and mobile.
- Runs as a Next.js app/server and talks to the Rust plugin over HTTP, so the UI can run on a different machine than the allowlister binary.

## allowlister plugin bridge

The repository ships two pieces that communicate over the network:

- `allowlister-remote-plugin` is the Rust dynamic allowlister plugin client. It
  reads the allowlister plugin JSON payload from stdin, posts an approval request
  to the remote Next.js server, polls for a decision, and then returns the
  `allow` or `deny` verdict to the allowlister process. If allowlister has
  already produced a static `allow` or `deny` verdict, the plugin immediately
  defers so the binary does not wait for the app.
- The Next.js app serves the PWA UI and API endpoints. It can run on another
  host, desktop, phone-accessible LAN address, or tunneled URL while the Rust
  plugin runs on the machine where the allowlister binary executes.

Build and serve the production app:

```console
cargo build --release -p allowlister-remote-plugin
npx nx run web:build
npm run start -- --hostname 0.0.0.0 --port 3000
```

Install the released plugin from npm:

```console
npm install -g @nickderobertis/allowlister-remote-plugin
allowlister-remote-plugin --version
```

Configure allowlister to use the plugin process:

```jsonc
{
  "plugins": [
    {
      "name": "allowlister remote",
      "command": [
        "/path/to/allowlister-remote-plugin",
        "--server-url",
        "https://allowlister-remote.example.com",
        "--timeout-ms",
        "120000",
      ],
      "timeout_ms": 125000,
    },
  ],
}
```

With the Rust plugin pointed at the Next.js server URL, `allowlister check`
blocks only for `ask`/`defer` decisions, the PWA displays the important command
fragments, and the selected button releases the original allowlister process over
the network.

## Releases

PR titles use Conventional Commits. Once a PR is squash-merged to `main` and the
main `check` workflow passes, Release Please opens or updates a release PR using
`RELEASE_TOKEN`. Merging that release PR versions the Rust crate and creates a
`vX.Y.Z` tag. The tag workflow builds native plugin binaries for Linux x64, macOS
arm64, and Windows x64, uploads them to the GitHub Release with checksums, stamps
the npm carrier package from the tag, publishes
`@nickderobertis/allowlister-remote-plugin` to npm with provenance, then installs
the published package and smoke-tests the real plugin entry point.

Repository secrets are declared in `gh-secrets.json` and synced with:

```console
gh-secrets sync
```

## HTTP server contract

`GET /api/approval-requests` returns pending requests:

```json
[
  {
    "id": "req_123",
    "subject": "shell",
    "harness": "codex",
    "cwd": "/workspace/app",
    "command": "npm test && gh pr merge 42",
    "currentVerdict": "ask",
    "currentReason": "gh pr merge requires approval",
    "createdAt": "2026-06-18T00:00:00.000Z",
    "expiresAt": "2026-06-18T00:02:00.000Z",
    "fragments": [
      {
        "argv": ["gh", "pr", "merge", "42"],
        "display": "gh pr merge 42",
        "role": "standalone",
        "verdict": "ask",
        "rule": "GitHub write operations require approval"
      }
    ],
    "riskSignals": ["GitHub write"]
  }
]
```

`POST /api/approval-requests/:id/decision` accepts:

```json
{ "requestId": "req_123", "verdict": "allow", "reason": "approved on phone" }
```

## Development

```console
just bootstrap
just dev
just check
just test-e2e
```

Open the app with `?demo=1` for a built-in allowlister sample request when no
bridge is running.
