use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;

fn plugin() -> &'static str {
    env!("CARGO_BIN_EXE_allowlister-remote-plugin")
}

fn run_plugin(input: &str, args: &[&str]) -> serde_json::Value {
    let mut child = Command::new(plugin())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
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

fn read_request(stream: &mut TcpStream) -> (String, String) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut request = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read request header");
        if line == "\r\n" || line.is_empty() {
            break;
        }
        request.push_str(&line);
    }
    let content_length = request
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body).expect("read request body");
    (request, String::from_utf8(body).expect("body is utf8"))
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("write response");
}

fn spawn_server() -> (String, mpsc::Receiver<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let url = format!("http://{}", listener.local_addr().expect("local addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut create_stream, _) = listener.accept().expect("create request");
        let create = read_request(&mut create_stream);
        tx.send(create).expect("send create request");
        respond(&mut create_stream, "200 OK", r#"{"id":"req_test"}"#);

        let (mut poll_stream, _) = listener.accept().expect("poll request");
        let poll = read_request(&mut poll_stream);
        tx.send(poll).expect("send poll request");
        respond(
            &mut poll_stream,
            "200 OK",
            r#"{"requestId":"req_test","verdict":"deny","reason":"remote denied"}"#,
        );
    });
    (url, rx)
}

#[test]
fn static_allow_verdict_defers_without_contacting_server() {
    let output = run_plugin(
        r#"{"current_verdict":"allow","command":"git status","cwd":"/tmp"}"#,
        &["--server-url", "http://127.0.0.1:9"],
    );

    assert_eq!(output["verdict"], "defer");
    assert_eq!(
        output["reason"],
        "static allowlister verdict does not need remote approval"
    );
}

#[test]
fn unavailable_server_falls_back_to_ask() {
    let output = run_plugin(
        r#"{"current_verdict":"defer","command":"gh pr merge 42","cwd":"/tmp"}"#,
        &["--server-url", "http://127.0.0.1:9", "--timeout-ms", "500"],
    );

    assert_eq!(output["verdict"], "ask");
    assert!(output["reason"]
        .as_str()
        .expect("reason")
        .contains("server unavailable"));
}

#[test]
fn posts_request_and_returns_remote_decision() {
    let (url, requests) = spawn_server();
    let output = run_plugin(
        r#"{"current_verdict":"defer","current_reason":"needs approval","command":"gh pr merge 42","cwd":"/tmp","harness":"codex"}"#,
        &[
            "--server-url",
            &url,
            "--timeout-ms",
            "2000",
            "--poll-ms",
            "10",
        ],
    );

    assert_eq!(output["verdict"], "deny");
    assert_eq!(output["reason"], "remote denied");

    let (create_headers, create_body) = requests.recv().expect("create captured");
    assert!(create_headers.starts_with("POST /api/plugin/requests HTTP/1.1"));
    assert!(create_headers.contains(&format!(
        "user-agent: allowlister-remote-plugin/{}",
        env!("CARGO_PKG_VERSION")
    )));
    let create_json: serde_json::Value = serde_json::from_str(&create_body).expect("create JSON");
    assert_eq!(create_json["command"], "gh pr merge 42");
    assert_eq!(create_json["current_verdict"], "defer");

    let (poll_headers, _) = requests.recv().expect("poll captured");
    assert!(poll_headers.starts_with("GET /api/plugin/requests/req_test/decision HTTP/1.1"));
}
