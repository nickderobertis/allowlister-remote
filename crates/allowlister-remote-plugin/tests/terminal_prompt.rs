//! Guard the visual-docs terminal fixture against the real prompt.
//!
//! `apps/web/screenshots/terminal/prompts.json` is what the visual gallery
//! renders to SVG (see `apps/web/screenshots/terminal.capture.ts`). It is
//! recorded from the genuine binary by `scripts/record-terminal-prompts.py`, but
//! a committed fixture can silently rot when the prompt wording changes. This
//! test re-derives each fixture entry from the very function the binary prints
//! (`local_prompt`) and fails if they diverge — so the screenshots can never
//! depict a prompt the plugin no longer emits. Regenerate the fixture (re-run the
//! recorder) and this test goes green again.

use std::path::PathBuf;

use allowlister_remote_plugin::{flagged_fragments, local_prompt, tool_input_json};
use serde_json::{json, Value};

#[test]
fn terminal_fixture_matches_the_real_prompt() {
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/web/screenshots/terminal/prompts.json");
    let raw = std::fs::read_to_string(&fixture_path)
        .unwrap_or_else(|error| panic!("read {fixture_path:?}: {error}"));
    let fixture: Value = serde_json::from_str(&raw).expect("prompts.json is valid JSON");

    let prompts = fixture["prompts"].as_array().expect("prompts array");
    assert!(
        !prompts.is_empty(),
        "fixture must record at least one prompt"
    );

    for entry in prompts {
        let name = entry["name"].as_str().expect("name");
        let command = entry["command"].as_str().expect("command");
        let cwd = entry["cwd"].as_str().expect("cwd");
        let recorded = entry["prompt"].as_str().expect("prompt");

        // Re-derive the flagged fragments the binary surfaced from the recorded
        // payload fragments, exactly as `main`/`daemon` do before prompting.
        let flagged = flagged_fragments(&json!({ "fragments": entry["fragments"].clone() }));

        // Re-derive the tool-call JSON the binary rendered from the recorded
        // tool, the same way. A shell entry has no `tool`, so this is `None`.
        let tool_input = tool_input_json(&json!({ "tool": entry["tool"].clone() }));

        // The recorder strips the leading newline `local_prompt` opens with, so
        // re-add it before comparing against the live function's output.
        let expected = format!("\n{recorded}");
        assert_eq!(
            local_prompt(command, cwd, &flagged, tool_input.as_deref()),
            expected,
            "fixture '{name}' is stale; re-run scripts/record-terminal-prompts.py",
        );
    }
}
