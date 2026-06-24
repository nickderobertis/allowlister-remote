//! Tests for the plugin's daemon handoff over the local IPC channel. The
//! Unix-domain-socket backend is driven here against a fake daemon socket; the
//! full broker↔daemon chain is covered by the daemon crate's end-to-end tests.
//! The Windows named-pipe backend shares the same line protocol and is exercised
//! by the cross-platform e2e suite.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn plugin() -> &'static str {
    env!("CARGO_BIN_EXE_allowlister-remote-plugin")
}

/// An absolute path to a binary that spawns successfully and exits immediately,
/// used to drive the "daemon started but never listened" path. `false` lives at
/// `/usr/bin/false` on macOS and at `/usr/bin/false` (with a `/bin` symlink) on
/// Linux, so prefer that and fall back to `/bin/false`; hardcoding `/bin/false`
/// alone fails to spawn on macOS (ENOENT), turning a listen-timeout into a
/// spurious spawn-failure.
fn exits_immediately_bin() -> &'static str {
    ["/usr/bin/false", "/bin/false"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or("/usr/bin/false")
}

#[test]
fn plugin_hands_off_to_daemon_and_returns_its_decision() {
    let socket = format!("/tmp/allowlister-plugin-daemon-{}.sock", std::process::id());
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();

    // A fake daemon: read the create line, then relay a web decision back.
    let daemon = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut create = String::new();
        reader.read_line(&mut create).unwrap();
        assert!(create.contains("\"type\":\"create\""), "got {create}");
        assert!(
            create.contains("\"command\":\"gh pr merge 42\""),
            "got {create}"
        );
        // The harness session id (protocol v3) is forwarded verbatim to the daemon.
        assert!(
            create.contains("\"session_id\":\"9f3c1a2b\""),
            "got {create}"
        );
        writeln!(
            stream,
            "{{\"type\":\"decision\",\"requestId\":\"x\",\"verdict\":\"allow\",\"reason\":\"approved\"}}"
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    let input = r#"{"protocol_version":3,"subject":"shell","session_id":"9f3c1a2b","current_verdict":"defer","command":"gh pr merge 42","cwd":"/repo"}"#;
    let mut child = Command::new(plugin())
        .args(["--daemon-socket", &socket])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["verdict"], "allow");
    assert_eq!(value["reason"], "approved");

    daemon.join().unwrap();
    let _ = std::fs::remove_file(&socket);
}

#[test]
fn plugin_asks_when_no_daemon_can_be_reached() {
    // A bogus socket and a daemon binary that exits immediately: the plugin
    // cannot reach a daemon and there is no other transport, so the deterministic
    // outcome is `ask` naming the unavailable approval channel.
    let bogus_socket = format!(
        "/tmp/allowlister-plugin-nodaemon-{}.sock",
        std::process::id()
    );
    let _ = std::fs::remove_file(&bogus_socket);

    let input = r#"{"subject":"shell","current_verdict":"defer","command":"ls"}"#;
    let mut child = Command::new(plugin())
        .args(["--daemon-socket", &bogus_socket])
        .env("ALLOWLISTER_REMOTE_DAEMON_BIN", exits_immediately_bin())
        .env("ALLOWLISTER_REMOTE_DAEMON_WAIT_MS", "200")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["verdict"], "ask");
    let reason = value["reason"].as_str().unwrap();
    assert!(
        reason.contains("daemon unavailable"),
        "expected daemon-unavailable ask, got {value}"
    );
    // `false` spawns fine but exits at once, so the specific cause is the socket
    // never coming up — not a spawn failure.
    assert!(
        reason.contains("did not start listening"),
        "expected the listen-timeout cause, got {value}"
    );
}

#[test]
fn plugin_reports_a_failed_daemon_spawn() {
    // A daemon binary path that does not exist: the spawn itself fails, and the
    // plugin must surface that specific cause (not a generic "unavailable") so the
    // operator can see the daemon binary could not be launched at all.
    let bogus_socket = format!(
        "/tmp/allowlister-plugin-nospawn-{}.sock",
        std::process::id()
    );
    let _ = std::fs::remove_file(&bogus_socket);

    let input = r#"{"subject":"shell","current_verdict":"defer","command":"ls"}"#;
    let mut child = Command::new(plugin())
        .args(["--daemon-socket", &bogus_socket])
        .env(
            "ALLOWLISTER_REMOTE_DAEMON_BIN",
            "/nonexistent/allowlister-remote-daemon",
        )
        .env("ALLOWLISTER_REMOTE_DAEMON_WAIT_MS", "200")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["verdict"], "ask");
    let reason = value["reason"].as_str().unwrap();
    assert!(
        reason.contains("could not start the daemon binary"),
        "expected a spawn-failure cause, got {value}"
    );
}
