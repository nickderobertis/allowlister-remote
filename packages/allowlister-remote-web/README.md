# @nickderobertis/allowlister-remote-web

The static **allowlister-remote** approval PWA, packaged for one-command serving.
This is the browser UI that lets you approve or deny allowlister dynamic approval
requests remotely. It is a fully static single-page app — there is **no
server-side state**; the bundled server just serves files.

## Run it

```sh
npx @nickderobertis/allowlister-remote-web
```

Then open the URL it prints (defaults to `http://0.0.0.0:8787`). Override the
bind address with `PORT` / `HOST` env vars or `--port` / `--host` flags.

## Point it at your broker

The PWA talks to a **broker** to receive and resolve approval requests. Tell the
app which broker to use in one of two ways:

- **In the app:** enter the broker base URL on the setup screen.
- **Deep link:** open the app with a `?broker=` query, e.g.
  `http://localhost:8787/?broker=wss://your-broker.example.com`. The value is
  persisted to `localStorage`, so subsequent visits remember it.

From the broker base URL the app derives the `/ws/pwa` WebSocket endpoint it
connects to.

## The broker is separate

The broker itself is a standalone CLI, **not** part of this package. Install it
from the repository's GitHub Releases using `scripts/install-broker.sh`. Run the
broker, then point this PWA at it as described above.
