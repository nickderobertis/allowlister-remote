# @nickderobertis/allowlister-remote-plugin

Installs the native `allowlister-remote-plugin` binary used by allowlister to
send dynamic approval requests to the remote approval PWA.

```console
npm install -g @nickderobertis/allowlister-remote-plugin
allowlister-remote-plugin --version
```

Configure allowlister to run `allowlister-remote-plugin --server-url <url>` as a
dynamic plugin command.

## How it installs

The native binary for each platform ships in its own package
(`@nickderobertis/allowlister-remote-plugin-darwin-arm64`, `-linux-x64`,
`-win32-x64`), declared here as optional dependencies and gated by `os`/`cpu`, so
npm downloads only the one matching your machine. On install, a small step links
that native binary directly onto the `allowlister-remote-plugin` command, so the
command on your `PATH` **is** the Rust executable — no Node process is started per
invocation. This matters because allowlister may call the plugin hundreds of
times in a single agent session.

A JS launcher is shipped as a fallback and is used only when the in-place link
cannot be made — on Windows (where npm's command shims require it) or when
install scripts are disabled (`npm install --ignore-scripts`).

On macOS and Linux the resolved `allowlister-remote-plugin` command is already the
native binary, so pointing allowlister (or `ALLOWLISTER_REMOTE_PLUGIN_BIN`) at it
keeps the hot path free of Node.
