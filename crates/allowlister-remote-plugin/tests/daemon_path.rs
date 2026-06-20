//! Tests for the plugin's daemon mode: the unix-socket handoff and the
//! fall-back-to-HTTP path when no daemon can be reached. The full broker↔daemon
//! chain is covered by the daemon crate's end-to-end tests; here we drive the
//! real plugin binary against a fake daemon socket.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn plugin() -> &'static str {
    env!("CARGO_BIN_EXE_allowlister-remote-plugin")
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
        writeln!(
            stream,
            "{{\"type\":\"decision\",\"requestId\":\"x\",\"verdict\":\"allow\",\"reason\":\"approved\"}}"
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    let input = r#"{"protocol_version":2,"subject":"shell","current_verdict":"defer","command":"gh pr merge 42","cwd":"/repo"}"#;
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
fn plugin_falls_back_to_http_when_daemon_unreachable() {
    // A bogus socket and a daemon binary that exits immediately: the plugin
    // cannot reach a daemon, so it must fall through to the HTTP path. The HTTP
    // server is also unreachable here, so the deterministic outcome is the
    // "server unavailable" ask — which proves the fallback branch ran.
    let bogus_socket = format!(
        "/tmp/allowlister-plugin-nodaemon-{}.sock",
        std::process::id()
    );
    let _ = std::fs::remove_file(&bogus_socket);

    let input = r#"{"subject":"shell","current_verdict":"defer","command":"ls"}"#;
    let mut child = Command::new(plugin())
        .args([
            "--use-daemon",
            "--daemon-socket",
            &bogus_socket,
            "--server-url",
            "http://127.0.0.1:9", // discard port: connection refused
        ])
        .env("ALLOWLISTER_REMOTE_DAEMON_BIN", "/bin/false")
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
    assert!(
        value["reason"]
            .as_str()
            .unwrap()
            .contains("server unavailable"),
        "expected HTTP fallback, got {value}"
    );
}
