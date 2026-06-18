# @nickderobertis/allowlister-remote-plugin

Installs the native `allowlister-remote-plugin` binary used by allowlister to
send dynamic approval requests to the remote approval PWA.

```console
npm install -g @nickderobertis/allowlister-remote-plugin
allowlister-remote-plugin --version
```

Configure allowlister to run `allowlister-remote-plugin --server-url <url>` as a
dynamic plugin command. The package includes the release-built native binary for
the current platform.
