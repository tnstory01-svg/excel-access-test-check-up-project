# product-launcher

Windows-only lifecycle launcher for the bundled localhost application. This is distinct from `win-job-launcher`: it starts the product server and browser, while the worker helper creates the Job Object for untrusted inspection work.

## Invocation

```text
product-launcher <absolute-bundle-root> <absolute-node.exe> <absolute-server.js>
```

Both executable and script are canonicalized, must be files below the canonical bundle root, and the executable must be named `node.exe`. The launcher reserves an available `127.0.0.1` port, starts bundled Node with `--loopback-port <port> --bootstrap-stdin`, and never accepts a host/address argument.

Node receives exactly `BOOTSTRAP <64-lowercase-hex-token>\n` on inherited stdin, must bind loopback, and must write exactly `READY <same-token>\n` to inherited stdout only after it is ready to accept the same-origin bootstrap request. The token is generated from Windows CNG, is 256 bits, memory-only, valid for at most 60 seconds, and exchangeable once. Node must reject expiry, mismatch, and replay; on acceptance it issues an `HttpOnly; SameSite=Strict` session plus CSRF token. It must not emit the bootstrap token to logs, responses, databases, or stderr.

Only after the strict readiness message does the launcher use ShellExecute to open:

```text
http://127.0.0.1:<port>/#bootstrap=<token>
```

The fragment is not sent in the HTTP request or referrer. Client bootstrap must immediately exchange it with the same-origin endpoint and call `history.replaceState` to remove it. This reduces, but does not eliminate, exposure to a compromised local browser or process.

On launcher exit before normal server completion, it terminates the server and its descendants with Windows `taskkill /T /F`. No external Rust crates are used; `Cargo.lock` therefore contains only this package.
