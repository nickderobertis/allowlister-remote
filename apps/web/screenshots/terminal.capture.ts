import { test } from "@playwright/test";
// The terminal lane renders a fixture recorded from the real plugin binary
// (no browser), so it shares only the captures.json upsert with the web lane.
import { loadFixture, renderTerminalSvg, THEMES } from "../../../scripts/terminal-svg.mjs";
import { recordShot } from "./capture-index";

// The plugin presents the SAME approval request at the local terminal (via
// /dev/tty) as in the web app, and whichever side decides first wins (see
// crates/allowlister-remote-plugin/src/main.rs). This lane documents that
// terminal surface: each fixture prompt — captured byte-for-byte from the
// running binary by scripts/record-terminal-prompts.py and guarded by the Rust
// test tests/terminal_prompt.rs — is rendered to a deterministic vector SVG in
// both themes. Unlike the browser shots there is no viewport dimension (a
// terminal frame is not responsive), so each shot carries only the `theme`
// toggle and screencomp treats viewport as a wildcard.
for (const { name, prompt } of loadFixture()) {
  test(name, async () => {
    // Viewport-independent: emit once rather than redundantly per browser project.
    test.skip(test.info().project.name !== "desktop", "terminal shot is viewport-independent");
    for (const theme of THEMES) {
      const svg = Buffer.from(renderTerminalSvg(prompt, theme), "utf8");
      await recordShot(name, { theme }, svg, "svg");
    }
  });
}
