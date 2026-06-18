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
- Talks to any bridge that implements the HTTP contract below.

## HTTP bridge contract

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
