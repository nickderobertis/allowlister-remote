//! Process-level end-to-end tests that spawn the REAL, separately-built
//! binaries and wire them together exactly as production does: a `broker`
//! axum WebSocket mediator, a `daemon` bridging a local unix socket up to the
//! broker, and the `plugin` that reads an allowlister request on stdin and
//! prints a verdict on stdout.
//!
//! The crate-level integration tests in each binary's own `tests/` directory
//! exercise the wire protocols against in-process library handles (`app()`,
//! `serve()`). Those are fast and precise, but they never prove that the
//! *shipped executables* talk to each other — argument parsing, daemon
//! auto-start, socket discovery, the static-allow short-circuit, and the
//! `--version` stamp all live in `main.rs` and are invisible to a library
//! test. This suite closes that gap by driving the binaries as real OS
//! processes over real sockets, standing in for the PWA with a
//! tokio-tungstenite client on `/ws/pwa`.
//!
//! Every await is wrapped in a generous-but-finite timeout so a routing or
//! startup regression fails fast instead of hanging CI forever, and every
//! port/socket path is made unique per test (via an atomic counter) so the
//! parallel test runner cannot make two stacks collide.

use std::net::TcpStream as StdTcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Monotonic counter mixed with the process id to derive unique socket paths and
/// keep parallel tests from clobbering one another's daemon sockets.
static UNIQUE: AtomicU64 = AtomicU64::new(0);

fn next_unique() -> u64 {
    UNIQUE.fetch_add(1, Ordering::Relaxed)
}

/// Resolve the three sibling binaries the tests drive, building them on demand.
///
/// The test executable lives at `<target>/debug/deps/<name>-<hash>`, so two
/// `parent()` hops land in `<target>/debug/`, where cargo places the workspace's
/// built binaries. Deriving the directory from `current_exe()` rather than a
/// hardcoded `target/debug` keeps this correct under custom `CARGO_TARGET_DIR`.
///
/// If any binary is missing (a fresh checkout, or `cargo test -p ...` that only
/// built this crate's deps), we shell out to `cargo build --bins` for the three
/// crates so the suite is self-sufficient whether invoked via `cargo test` or
/// `just`. We never assume the binaries already exist.
fn binaries() -> (PathBuf, PathBuf, PathBuf) {
    let exe = std::env::current_exe().expect("locate test executable");
    let debug_dir = exe
        .parent()
        .and_then(Path::parent)
        .expect("test exe should live under <target>/debug/deps/")
        .to_path_buf();

    let broker = debug_dir.join(bin_name("allowlister-remote-broker"));
    let daemon = debug_dir.join(bin_name("allowlister-remote-daemon"));
    let plugin = debug_dir.join(bin_name("allowlister-remote-plugin"));

    if !broker.exists() || !daemon.exists() || !plugin.exists() {
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "-p",
                "allowlister-remote-broker",
                "-p",
                "allowlister-remote-daemon",
                "-p",
                "allowlister-remote-plugin",
                "--bins",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .expect("spawn cargo build for the e2e binaries");
        assert!(status.success(), "cargo build of e2e binaries failed");
    }

    assert!(broker.exists(), "broker binary missing at {broker:?}");
    assert!(daemon.exists(), "daemon binary missing at {daemon:?}");
    assert!(plugin.exists(), "plugin binary missing at {plugin:?}");
    (broker, daemon, plugin)
}

/// Append `.exe` on Windows so the path matches what cargo actually emits.
fn bin_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Reserve a free TCP port by binding to port 0, reading the kernel-assigned
/// port, then dropping the listener so the child can bind it. There is an
/// inherent (tiny) race between releasing and the child re-binding, but it gives
/// the broker a *known* address to advertise to the daemon and the PWA client.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("read local addr").port()
}

/// Block until the daemon's unix socket exists and accepts a connection. We test
/// connectability rather than mere file existence because the daemon may create
/// the path slightly before it is listening.
#[cfg(unix)]
fn wait_for_socket(path: &Path, timeout: Duration) {
    use std::os::unix::net::UnixStream;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() && UnixStream::connect(path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("daemon socket {path:?} never became connectable within {timeout:?}");
}

/// Kill-on-Drop guard for a spawned child process. Wrapping the broker/daemon
/// children in this means a panicking assertion still tears the processes down
/// (and frees the port/socket) instead of leaking them for the rest of the run.
struct ChildGuard {
    label: &'static str,
    child: Child,
}

impl ChildGuard {
    fn new(label: &'static str, child: Child) -> Self {
        Self { label, child }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Best-effort: the child may already have exited.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = self.label; // kept for debugging clarity / future logging.
    }
}

async fn ws_send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string()))
        .await
        .expect("send ws frame");
}

/// Read the next JSON frame from the PWA socket, skipping pings/pongs and
/// failing on timeout so a missing `added`/`resolved` shows up as a failure
/// rather than a hang.
async fn ws_recv(ws: &mut Ws) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("pwa recv timed out")
            .expect("ws stream ended")
            .expect("ws error");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).expect("ws frame is JSON"),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected ws frame: {other:?}"),
        }
    }
}

/// Connect the stand-in PWA, subscribe, and consume the initial snapshot so the
/// caller is positioned to receive the next `added` event.
async fn subscribe_pwa(port: u16) -> Ws {
    let (mut pwa, _) = tokio::time::timeout(
        Duration::from_secs(5),
        connect_async(format!("ws://127.0.0.1:{port}/ws/pwa")),
    )
    .await
    .expect("pwa connect timed out")
    .expect("pwa connect failed");
    ws_send(&mut pwa, json!({"type":"subscribe"})).await;
    assert_eq!(ws_recv(&mut pwa).await["type"], "snapshot");
    pwa
}

/// Boot a broker bound to a specific port, retrying the spawn until it is
/// listening. The retry matters for the restart test: immediately after the
/// previous broker is killed the port is usually free, but a racing bind can
/// still lose, so we re-spawn rather than fail.
fn boot_broker_on(broker: &Path, port: u16) -> ChildGuard {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let child = Command::new(broker)
            .env(
                "ALLOWLISTER_REMOTE_BROKER_ADDR",
                format!("127.0.0.1:{port}"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn broker");
        let guard = ChildGuard::new("broker", child);

        let ready_by = Instant::now() + Duration::from_millis(500);
        while Instant::now() < ready_by {
            if StdTcpStream::connect(("127.0.0.1", port)).is_ok() {
                return guard;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // Not listening — the bind likely lost a race with the dying predecessor.
        drop(guard); // kill this attempt and try again
        assert!(
            Instant::now() < deadline,
            "broker never came up on port {port}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Spawn the broker on a fresh free port and wait for it to listen. Returns the
/// guard (kill-on-Drop) and the port.
fn spawn_broker(broker: &Path) -> (ChildGuard, u16) {
    let port = free_port();
    let guard = boot_broker_on(broker, port);
    (guard, port)
}

/// A unique daemon socket path, with any stale file cleared.
fn unique_socket() -> PathBuf {
    let path = PathBuf::from(format!(
        "/tmp/allowlister-e2e-{}-{}.sock",
        std::process::id(),
        next_unique()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

/// Spawn a daemon bound to `socket`, wired to the broker on `port`.
#[cfg(unix)]
fn spawn_daemon(daemon: &Path, socket: &Path, port: u16) -> ChildGuard {
    let child = Command::new(daemon)
        .env("ALLOWLISTER_REMOTE_DAEMON_SOCK", socket)
        .env(
            "ALLOWLISTER_REMOTE_BROKER_URL",
            format!("ws://127.0.0.1:{port}/ws/daemon"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn daemon");
    ChildGuard::new("daemon", child)
}

/// Spawn a plugin in daemon mode that opens an approval request for `command`
/// and blocks waiting for a decision. Returns the child (stdout piped).
#[cfg(unix)]
fn spawn_plugin(plugin: &Path, socket: &Path, command: &str) -> Child {
    use std::io::Write;
    let mut child = Command::new(plugin)
        .args(["--daemon-socket"])
        .arg(socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn plugin");
    let payload =
        format!(r#"{{"subject":"shell","current_verdict":"defer","command":"{command}"}}"#);
    child
        .stdin
        .take()
        .expect("plugin stdin")
        .write_all(payload.as_bytes())
        .expect("write plugin stdin");
    child
}

/// Join a blocked plugin child and return its parsed `{verdict,reason}` output.
async fn plugin_verdict(child: Child) -> Value {
    let output = tokio::task::spawn_blocking(move || {
        child.wait_with_output().expect("plugin wait_with_output")
    })
    .await
    .expect("join plugin");
    assert!(output.status.success(), "plugin exited non-zero");
    serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON")
}

/// Read `n` `added` frames and return a command -> request-id map.
async fn collect_added(ws: &mut Ws, n: usize) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for _ in 0..n {
        let added = ws_recv(ws).await;
        assert_eq!(added["type"], "added");
        let command = added["request"]["command"]
            .as_str()
            .expect("command")
            .to_string();
        let id = added["request"]["id"].as_str().expect("id").to_string();
        map.insert(command, id);
    }
    map
}

/// TEST A — the headline happy path through all three real binaries.
///
/// broker (TCP) ← daemon (unix socket bridge) ← plugin (stdin/stdout), with a
/// PWA WebSocket client deciding the request. We assert the request the daemon
/// minted reaches the PWA with the original `command`, that an `allow` decision
/// from the web is routed back down and printed by the plugin, and that the
/// reason round-trips verbatim.
#[cfg(unix)]
#[tokio::test]
async fn full_chain_with_real_binaries() {
    let (broker_bin, daemon_bin, plugin_bin) = binaries();

    let (_broker, port) = spawn_broker(&broker_bin);

    let socket_path = PathBuf::from(format!(
        "/tmp/allowlister-e2e-{}-{}.sock",
        std::process::id(),
        next_unique()
    ));
    // A stale socket from a crashed prior run would make the daemon's bind fail.
    let _ = std::fs::remove_file(&socket_path);

    let daemon_child = Command::new(&daemon_bin)
        .env("ALLOWLISTER_REMOTE_DAEMON_SOCK", &socket_path)
        .env(
            "ALLOWLISTER_REMOTE_BROKER_URL",
            format!("ws://127.0.0.1:{port}/ws/daemon"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn daemon");
    let _daemon = ChildGuard::new("daemon", daemon_child);
    wait_for_socket(&socket_path, Duration::from_secs(5));

    let mut pwa = subscribe_pwa(port).await;

    // The plugin opens the request: read the defer payload on stdin, talk to the
    // daemon over the unix socket, and block waiting for a decision.
    let mut plugin_child = Command::new(&plugin_bin)
        .args(["--daemon-socket"])
        .arg(&socket_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn plugin");
    {
        use std::io::Write;
        let mut stdin = plugin_child.stdin.take().expect("plugin stdin");
        stdin
            .write_all(
                br#"{"subject":"shell","current_verdict":"defer","command":"gh pr merge 42"}"#,
            )
            .expect("write plugin stdin");
        // Dropping stdin closes it so the plugin's read_to_string returns.
    }

    // The PWA sees the daemon-assigned request carrying the original command.
    let added = ws_recv(&mut pwa).await;
    assert_eq!(added["type"], "added");
    assert_eq!(added["request"]["command"], "gh pr merge 42");
    let id = added["request"]["id"]
        .as_str()
        .expect("request id")
        .to_string();

    // Decide it from the web; the broker must dismiss it for every PWA.
    ws_send(
        &mut pwa,
        json!({"type":"decision","requestId":id,"verdict":"allow","reason":"approved in app"}),
    )
    .await;
    let resolved = ws_recv(&mut pwa).await;
    assert_eq!(resolved["type"], "resolved");

    // The decision is delivered down to the waiting plugin, which prints it and
    // exits. wait_with_output joins the child and captures stdout.
    let output = tokio::task::spawn_blocking(move || {
        plugin_child
            .wait_with_output()
            .expect("plugin wait_with_output")
    })
    .await
    .expect("join plugin");
    assert!(
        output.status.success(),
        "plugin exited non-zero: {:?}",
        output.status
    );
    let verdict: Value = serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON");
    assert_eq!(verdict["verdict"], "allow");
    assert_eq!(verdict["reason"], "approved in app");

    let _ = std::fs::remove_file(&socket_path);
}

/// TEST B — the plugin auto-starts the real daemon when none is listening.
///
/// We never start a daemon ourselves. Instead we point
/// `ALLOWLISTER_REMOTE_DAEMON_BIN` at a wrapper shell script that records its own
/// pid (so the test can reap it) and then `exec`s the real daemon binary. The
/// plugin, finding nothing on the socket, must launch that wrapper. If the
/// request reaches the PWA and the plugin honors the web decision, auto-start
/// worked end-to-end.
#[cfg(unix)]
#[tokio::test]
async fn plugin_auto_starts_the_real_daemon() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let (broker_bin, daemon_bin, plugin_bin) = binaries();

    let (_broker, port) = spawn_broker(&broker_bin);

    let unique = next_unique();
    let pid = std::process::id();
    let socket_path = PathBuf::from(format!("/tmp/allowlister-e2e-{pid}-{unique}.sock"));
    let _ = std::fs::remove_file(&socket_path);

    // The wrapper writes its pid, then becomes the real daemon via exec so the
    // socket-owning process is the genuine binary under test.
    let pidfile = PathBuf::from(format!("/tmp/allowlister-e2e-daemon-{pid}-{unique}.pid"));
    let _ = std::fs::remove_file(&pidfile);
    let wrapper = PathBuf::from(format!("/tmp/allowlister-e2e-daemon-{pid}-{unique}.sh"));
    let script = format!(
        "#!/bin/sh\necho $$ > \"{pidfile}\"\nexec \"{daemon}\" \"$@\"\n",
        pidfile = pidfile.display(),
        daemon = daemon_bin.display(),
    );
    std::fs::write(&wrapper, script).expect("write wrapper script");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))
        .expect("chmod wrapper");

    let mut pwa = subscribe_pwa(port).await;

    let mut plugin_child = Command::new(&plugin_bin)
        .args(["--broker-url"])
        .arg(format!("ws://127.0.0.1:{port}/ws/daemon"))
        .args(["--daemon-socket"])
        .arg(&socket_path)
        .env("ALLOWLISTER_REMOTE_DAEMON_BIN", &wrapper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn plugin");
    {
        let mut stdin = plugin_child.stdin.take().expect("plugin stdin");
        stdin
            .write_all(
                br#"{"subject":"shell","current_verdict":"defer","command":"gh pr merge 99"}"#,
            )
            .expect("write plugin stdin");
    }

    let added = ws_recv(&mut pwa).await;
    assert_eq!(added["type"], "added");
    assert_eq!(added["request"]["command"], "gh pr merge 99");
    let id = added["request"]["id"]
        .as_str()
        .expect("request id")
        .to_string();

    ws_send(
        &mut pwa,
        json!({"type":"decision","requestId":id,"verdict":"allow","reason":"auto-start ok"}),
    )
    .await;
    assert_eq!(ws_recv(&mut pwa).await["type"], "resolved");

    let output = tokio::task::spawn_blocking(move || {
        plugin_child
            .wait_with_output()
            .expect("plugin wait_with_output")
    })
    .await
    .expect("join plugin");
    assert!(output.status.success(), "plugin exited non-zero");
    let verdict: Value = serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON");
    assert_eq!(verdict["verdict"], "allow");
    assert_eq!(verdict["reason"], "auto-start ok");

    // Cleanup: the auto-started daemon outlives the plugin, so reap it via the
    // pid the wrapper recorded. Best-effort — the kernel-assigned pid may already
    // be gone if something tore it down first.
    if let Ok(contents) = std::fs::read_to_string(&pidfile) {
        if let Ok(daemon_pid) = contents.trim().parse::<i32>() {
            // SAFETY: a plain kill(2) of a pid we believe is the daemon. A stale
            // pid simply yields ESRCH, which we ignore.
            unsafe {
                libc_kill(daemon_pid);
            }
        }
    }
    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(&wrapper);
}

/// Minimal `kill(pid, SIGTERM)` without pulling in the `libc` crate: we just need
/// to terminate one auto-started daemon during cleanup, so a tiny extern is
/// cheaper than a new dependency.
#[cfg(unix)]
unsafe fn libc_kill(pid: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    let _ = kill(pid, SIGTERM);
}

/// TEST C.1 — the broker answers `/healthz`. A raw HTTP/1.0 request keeps the
/// dependency surface to `std::net`, proving the running executable (not just the
/// library) serves the health endpoint with `200 ok`.
#[test]
fn broker_healthz_responds() {
    use std::io::{Read, Write};

    let (broker_bin, _, _) = binaries();
    let (_broker, port) = spawn_broker(&broker_bin);

    let mut stream = StdTcpStream::connect(("127.0.0.1", port)).expect("connect broker");
    stream
        .write_all(b"GET /healthz HTTP/1.0\r\nHost: x\r\n\r\n")
        .expect("write healthz request");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("read healthz response");
    assert!(
        response.contains("200"),
        "healthz response missing 200: {response:?}"
    );
    assert!(
        response.contains("ok"),
        "healthz response missing body 'ok': {response:?}"
    );
}

/// TEST C.2 — the plugin prints a non-empty version with `--version` and exits
/// cleanly, mirroring how allowlister probes the binary.
#[test]
fn plugin_reports_version() {
    let (_, _, plugin_bin) = binaries();
    let output = Command::new(&plugin_bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .expect("run plugin --version");
    assert!(output.status.success(), "plugin --version exited non-zero");
    assert!(
        !output.stdout.is_empty(),
        "plugin --version printed nothing"
    );
}

/// TEST C.3 — a static allow verdict short-circuits to `defer` with NO server,
/// daemon, or broker in sight. The input/output shape is copied verbatim from
/// the plugin's own `static_allow_verdict_defers_without_contacting_server`
/// integration test so the two stay in lockstep.
#[test]
fn plugin_static_allow_defers() {
    use std::io::Write;

    let (_, _, plugin_bin) = binaries();
    let mut child = Command::new(&plugin_bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn plugin");
    child
        .stdin
        .take()
        .expect("plugin stdin")
        .write_all(br#"{"current_verdict":"allow"}"#)
        .expect("write plugin stdin");
    let output = child.wait_with_output().expect("plugin exits");
    assert!(output.status.success(), "plugin exited non-zero");
    let verdict: Value = serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON");
    assert_eq!(verdict["verdict"], "defer");
    assert_eq!(
        verdict["reason"],
        "static allowlister verdict does not need remote approval"
    );
}

/// Connect a PWA and subscribe, returning the socket and the initial snapshot so
/// a caller can inspect already-pending requests (used by the restart test).
async fn subscribe_pwa_with_snapshot(port: u16) -> (Ws, Value) {
    let (mut pwa, _) = tokio::time::timeout(
        Duration::from_secs(5),
        connect_async(format!("ws://127.0.0.1:{port}/ws/pwa")),
    )
    .await
    .expect("pwa connect timed out")
    .expect("pwa connect failed");
    ws_send(&mut pwa, json!({"type":"subscribe"})).await;
    let snapshot = ws_recv(&mut pwa).await;
    assert_eq!(snapshot["type"], "snapshot");
    (pwa, snapshot)
}

/// TEST D — many daemons and many PWAs on one broker, with real binaries.
///
/// Two daemons (separate hosts/sockets) each carry a plugin that opens a request.
/// Two PWAs each see BOTH requests, and each PWA decides a DIFFERENT daemon's
/// request — proving cross fan-out (every PWA sees every daemon's work) and
/// correct owner routing (a decision reaches only the daemon/plugin that owns it).
#[cfg(unix)]
#[tokio::test]
async fn multiple_daemons_and_pwas_interoperate_through_real_binaries() {
    let (broker_bin, daemon_bin, plugin_bin) = binaries();
    let (_broker, port) = spawn_broker(&broker_bin);

    let sock_a = unique_socket();
    let sock_b = unique_socket();
    let _daemon_a = spawn_daemon(&daemon_bin, &sock_a, port);
    let _daemon_b = spawn_daemon(&daemon_bin, &sock_b, port);
    wait_for_socket(&sock_a, Duration::from_secs(5));
    wait_for_socket(&sock_b, Duration::from_secs(5));

    let mut pwa1 = subscribe_pwa(port).await;
    let mut pwa2 = subscribe_pwa(port).await;

    let cmd_a = format!("deploy-A-{}", next_unique());
    let cmd_b = format!("deploy-B-{}", next_unique());
    let plugin_a = spawn_plugin(&plugin_bin, &sock_a, &cmd_a);
    let plugin_b = spawn_plugin(&plugin_bin, &sock_b, &cmd_b);

    // Both PWAs see both daemons' requests.
    let ids1 = collect_added(&mut pwa1, 2).await;
    let ids2 = collect_added(&mut pwa2, 2).await;
    assert!(ids1.contains_key(&cmd_a) && ids1.contains_key(&cmd_b));
    assert!(ids2.contains_key(&cmd_a) && ids2.contains_key(&cmd_b));
    assert_eq!(ids1[&cmd_a], ids2[&cmd_a], "same request id across PWAs");
    assert_eq!(ids1[&cmd_b], ids2[&cmd_b]);

    // PWA1 approves daemon A's request; PWA2 denies daemon B's request.
    ws_send(
        &mut pwa1,
        json!({"type":"decision","requestId":ids1[&cmd_a],"verdict":"allow","reason":"via pwa1"}),
    )
    .await;
    ws_send(
        &mut pwa2,
        json!({"type":"decision","requestId":ids2[&cmd_b],"verdict":"deny","reason":"via pwa2"}),
    )
    .await;

    // Each decision is routed to exactly the owning daemon's plugin.
    let verdict_a = plugin_verdict(plugin_a).await;
    let verdict_b = plugin_verdict(plugin_b).await;
    assert_eq!(verdict_a["verdict"], "allow");
    assert_eq!(verdict_a["reason"], "via pwa1");
    assert_eq!(verdict_b["verdict"], "deny");
    assert_eq!(verdict_b["reason"], "via pwa2");

    let _ = std::fs::remove_file(&sock_a);
    let _ = std::fs::remove_file(&sock_b);
}

/// TEST E — a request survives a broker restart.
///
/// The plugin opens a request and blocks. We kill the broker and start a fresh
/// one on the SAME port (so it has lost all state). The daemon must reconnect and
/// re-announce its still-pending request, so a brand-new PWA learns about it and
/// can decide it — and the original, still-waiting plugin gets that decision.
#[cfg(unix)]
#[tokio::test]
async fn a_request_survives_a_broker_restart() {
    let (broker_bin, daemon_bin, plugin_bin) = binaries();
    let port = free_port();
    let broker1 = boot_broker_on(&broker_bin, port);

    let sock = unique_socket();
    let _daemon = spawn_daemon(&daemon_bin, &sock, port);
    wait_for_socket(&sock, Duration::from_secs(5));

    let mut pwa1 = subscribe_pwa(port).await;
    let command = format!("survive-restart-{}", next_unique());
    let plugin = spawn_plugin(&plugin_bin, &sock, &command);

    let added = ws_recv(&mut pwa1).await;
    assert_eq!(added["request"]["command"], command);
    let id = added["request"]["id"].as_str().expect("id").to_string();

    // Restart the broker on the same port; it comes up with empty state.
    drop(broker1);
    drop(pwa1); // its socket died with broker1
    let _broker2 = boot_broker_on(&broker_bin, port);

    // A fresh PWA must learn the still-pending request via the daemon's
    // re-announce — whether it lands in the subscribe snapshot or as a later
    // `added` once the daemon has reconnected.
    let (mut pwa2, snapshot) = subscribe_pwa_with_snapshot(port).await;
    let in_snapshot = snapshot["requests"]
        .as_array()
        .map(|requests| requests.iter().any(|r| r["command"] == command.as_str()))
        .unwrap_or(false);
    if !in_snapshot {
        loop {
            let message = ws_recv(&mut pwa2).await;
            if message["type"] == "added" && message["request"]["command"] == command.as_str() {
                break;
            }
        }
    }

    // Decide it on the new broker; the reconnected daemon routes it to the plugin
    // that has been waiting the whole time.
    ws_send(
        &mut pwa2,
        json!({"type":"decision","requestId":id,"verdict":"allow","reason":"after restart"}),
    )
    .await;
    let verdict = plugin_verdict(plugin).await;
    assert_eq!(verdict["verdict"], "allow");
    assert_eq!(verdict["reason"], "after restart");

    let _ = std::fs::remove_file(&sock);
}
