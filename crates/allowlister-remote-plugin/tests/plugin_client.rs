//! Tests for the plugin binary's stdin handling that need no transport: the
//! static-verdict short-circuit and the malformed-input guard both settle the
//! command before the plugin ever opens the daemon channel. The daemon handoff
//! itself is covered by `daemon_path.rs`.

use std::io::Write;
use std::process::{Command, Stdio};

fn plugin() -> &'static str {
    env!("CARGO_BIN_EXE_allowlister-remote-plugin")
}

fn run_plugin(input: &str, args: &[&str]) -> serde_json::Value {
    let mut child = Command::new(plugin())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn plugin");
    child
        .stdin
        .as_mut()
        .expect("plugin stdin")
        .write_all(input.as_bytes())
        .expect("write plugin stdin");
    let output = child.wait_with_output().expect("plugin exits");
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON")
}

#[test]
fn static_allow_verdict_defers_without_opening_the_daemon_channel() {
    // A point at an unreachable daemon socket proves the static short-circuit
    // never tries to connect: the verdict settles the command first.
    let output = run_plugin(
        r#"{"current_verdict":"allow","command":"git status","cwd":"/tmp"}"#,
        &["--daemon-socket", "/nonexistent/allowlister-remote.sock"],
    );

    assert_eq!(output["verdict"], "defer");
    assert_eq!(
        output["reason"],
        "static allowlister verdict does not need remote approval"
    );
}

#[test]
fn malformed_input_settles_as_ask_without_a_transport() {
    let output = run_plugin(
        "not json at all",
        &["--daemon-socket", "/nonexistent/allowlister-remote.sock"],
    );

    assert_eq!(output["verdict"], "ask");
    assert!(output["reason"]
        .as_str()
        .expect("reason")
        .contains("invalid allowlister plugin input"));
}

#[test]
fn version_flag_prints_the_compiled_version() {
    // `--version` answers before reading stdin, so it needs no payload.
    let output = Command::new(plugin())
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .expect("plugin runs");
    assert!(output.status.success());
    let printed = String::from_utf8(output.stdout).expect("version is utf8");
    assert_eq!(printed.trim(), env!("CARGO_PKG_VERSION"));
}
