//! Client-side daemon prototype — validates the multiplexing core of the
//! realtime-sync design (see ../realtime-sync.md): a single long-lived daemon
//! accepting many short-lived plugin processes over a Unix-domain socket,
//! routing each decision back to the right waiting plugin by request id, and
//! resolving the local-terminal-vs-remote race with the local decision relayed
//! upstream.
//!
//! std-only on purpose — no Cargo, no workspace entanglement. Build & run:
//!     rustc -O docs/design/prototypes/daemon-proto.rs -o /tmp/daemon-proto && /tmp/daemon-proto
//!
//! The plugin<->daemon IPC is a *real* Unix socket. The daemon's single
//! "upstream" (the one SSE/long-poll connection to the broker) is simulated
//! in-process here, because the broker transport itself is validated separately
//! by broker-proto.mjs. Together they cover the full path.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug)]
struct Decision {
    verdict: String,
    reason: String,
}

/// A decision arriving at a waiting plugin handler, tagged by origin so the
/// daemon knows whether it must relay a local decision upstream.
enum Event {
    Upstream(Decision),
    Local(Decision),
}

type Registry = Arc<Mutex<HashMap<String, Sender<Event>>>>;

fn main() {
    let socket_path = format!("/tmp/allowlister-daemon-proto-{}.sock", std::process::id());
    let _ = std::fs::remove_file(&socket_path);

    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
    // Records the local decisions the daemon relayed upstream (i.e. the POSTs it
    // would make to dismiss the pending web approval).
    let relayed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    // ---- the long-lived daemon: one listener, many plugin connections -------
    let listener = UnixListener::bind(&socket_path).expect("bind unix socket");
    {
        let registry = registry.clone();
        let relayed = relayed.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let registry = registry.clone();
                let relayed = relayed.clone();
                thread::spawn(move || handle_plugin(stream, registry, relayed));
            }
        });
    }

    // ---- the daemon's single upstream, simulated: decisions for the "remote"
    // requests arrive out of order (r3, r1, r2) and are routed by id. ----------
    {
        let registry = registry.clone();
        thread::spawn(move || {
            for (id, verdict) in [("r3", "allow"), ("r1", "allow"), ("r2", "deny")] {
                deliver_upstream(&registry, id, verdict);
                thread::sleep(Duration::from_millis(20));
            }
        });
    }

    // ---- many short-lived plugin processes (threads here) over one socket ----
    let results: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut handles = Vec::new();
    // r1..r3 wait for the remote/web decision; l1 decides at the local terminal
    // first and must win the race.
    let plugins = [("r1", false), ("r2", false), ("r3", false), ("l1", true)];
    for (id, local_first) in plugins {
        let path = socket_path.clone();
        let results = results.clone();
        handles.push(thread::spawn(move || {
            let verdict = run_plugin(&path, id, local_first);
            results.lock().unwrap().insert(id.to_string(), verdict);
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }

    let _ = std::fs::remove_file(&socket_path);

    // ---- assertions ---------------------------------------------------------
    let results = results.lock().unwrap();
    let relayed = relayed.lock().unwrap();
    let mut pass = true;
    let mut check = |name: &str, cond: bool, detail: String| {
        println!("{}  {name}{}", if cond { "PASS" } else { "FAIL" }, if detail.is_empty() { String::new() } else { format!("  ({detail})") });
        pass &= cond;
    };

    check("all 4 plugins resolved over one socket", results.len() == 4, format!("{} resolved", results.len()));
    check("r1 routed to its upstream verdict", results.get("r1").map(String::as_str) == Some("allow"), format!("{:?}", results.get("r1")));
    check("r2 routed to its upstream verdict", results.get("r2").map(String::as_str) == Some("deny"), format!("{:?}", results.get("r2")));
    check("r3 routed despite out-of-order delivery", results.get("r3").map(String::as_str) == Some("allow"), format!("{:?}", results.get("r3")));
    check("l1 won the local-terminal race", results.get("l1").map(String::as_str) == Some("deny"), format!("{:?}", results.get("l1")));
    check("daemon relayed l1's local decision upstream", relayed.contains(&"l1".to_string()), format!("relayed={:?}", *relayed));
    check("daemon did NOT relay remote-decided requests", !relayed.iter().any(|id| id.starts_with('r')), format!("relayed={:?}", *relayed));

    println!("\n{}", if pass { "ALL PASS" } else { "FAILURES" });
    std::process::exit(if pass { 0 } else { 1 });
}

/// Route an upstream decision to the waiting plugin handler by id. Retries
/// briefly so a decision that races ahead of registration still lands.
fn deliver_upstream(registry: &Registry, id: &str, verdict: &str) {
    for _ in 0..100 {
        if let Some(tx) = registry.lock().unwrap().get(id).cloned() {
            let _ = tx.send(Event::Upstream(Decision {
                verdict: verdict.to_string(),
                reason: format!("remote {verdict}"),
            }));
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

/// The daemon's per-connection handler: register the request, then race a local
/// decision (read off the socket) against the upstream decision (delivered via
/// the registry). First one wins; a local win is relayed upstream.
fn handle_plugin(stream: UnixStream, registry: Registry, relayed: Arc<Mutex<Vec<String>>>) {
    let mut writer = stream.try_clone().expect("clone stream");
    let mut reader = BufReader::new(stream);

    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    let id = match first.trim().strip_prefix("REGISTER ") {
        Some(id) => id.to_string(),
        None => return,
    };

    let (tx, rx) = channel::<Event>();
    registry.lock().unwrap().insert(id.clone(), tx.clone());

    // Reader thread turns a "LOCAL ..." line from the plugin into a Local event,
    // racing the upstream delivery on the same channel.
    thread::spawn(move || {
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() {
            if let Some(rest) = line.trim().strip_prefix("LOCAL ") {
                let mut parts = rest.splitn(2, ' ');
                let verdict = parts.next().unwrap_or("deny").to_string();
                let reason = parts.next().unwrap_or("local").to_string();
                let _ = tx.send(Event::Local(Decision { verdict, reason }));
            }
        }
    });

    match rx.recv() {
        Ok(Event::Upstream(decision)) => {
            let _ = writeln!(writer, "DECISION {} {}", decision.verdict, decision.reason);
        }
        Ok(Event::Local(decision)) => {
            // The local terminal won: relay upstream so the web approval is
            // dismissed, then answer the plugin.
            relayed.lock().unwrap().push(id.clone());
            let _ = writeln!(writer, "DECISION {} {}", decision.verdict, decision.reason);
        }
        Err(_) => {}
    }
    registry.lock().unwrap().remove(&id);
}

/// A short-lived plugin process: connect, register, optionally submit a local
/// decision, then block for the resolved verdict.
fn run_plugin(socket_path: &str, id: &str, local_first: bool) -> String {
    let stream = connect(socket_path);
    let mut writer = stream.try_clone().expect("clone");
    let mut reader = BufReader::new(stream);

    writeln!(writer, "REGISTER {id}").expect("register");
    if local_first {
        // Operator typed "d" at /dev/tty before the web responded.
        thread::sleep(Duration::from_millis(2));
        writeln!(writer, "LOCAL deny denied-at-terminal").expect("local");
    }

    let mut line = String::new();
    reader.read_line(&mut line).expect("read decision");
    line.trim().strip_prefix("DECISION ")
        .and_then(|rest| rest.split(' ').next())
        .unwrap_or("")
        .to_string()
}

/// Retry the connect briefly so plugins racing the listener's startup still land.
fn connect(socket_path: &str) -> UnixStream {
    for _ in 0..100 {
        if let Ok(stream) = UnixStream::connect(socket_path) {
            return stream;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("could not connect to daemon socket");
}
