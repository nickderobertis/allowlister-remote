// Deterministic SVG renderer for the plugin's local-terminal approval prompt —
// the Option-B companion to the Playwright web capture. It turns the committed,
// real-binary-recorded fixture (apps/web/screenshots/terminal/prompts.json) into
// a vector terminal image, embedding a tiny subset monospace font so the result
// is self-contained and identical everywhere.
//
// Why vector, not a rasterized terminal screenshot: screencomp's strict gate is
// a digest comparison, and its own classify.rs warns that the real hazard is
// "cross-CPU anti-aliasing drift" on heterogeneous CI runners. A PNG/GIF from a
// terminal-to-image tool would rasterize fonts through CPU SIMD and drift bytes
// between Intel and AMD; an SVG never rasterizes here, so its bytes are a pure
// function of the fixture text, the committed font, and this template — byte-
// identical on every runner. The web lane fights the same jitter with
// supersampling; this lane sidesteps it.
//
// `node scripts/terminal-svg.mjs --digests` prints the sha256 of each shot for
// maintaining shots/baseline/<arch>.json without standing up the capture server.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const terminalDir = resolve(here, "../apps/web/screenshots/terminal");
const fontB64 = readFileSync(resolve(terminalDir, "mono-subset.woff2")).toString("base64");

export const THEMES = ["dark", "light"];

// Integer monospace grid: textLength pins every line to the column grid, so the
// layout — and thus the SVG bytes — never depends on a float advance metric.
const CELL_W = 9;
const LINE_H = 24;
const FONT_SIZE = 15;
const PAD_X = 22;
const PAD_TOP = 20;
const PAD_BOTTOM = 22;
const CHROME_H = 38; // window title bar with its three traffic-light dots

const PALETTE = {
  dark: { bg: "#11131a", chrome: "#1b1e29", fg: "#d6dae4", title: "#828a9c" },
  light: { bg: "#ffffff", chrome: "#eef0f4", fg: "#1f2430", title: "#5b6473" },
};
const DOTS = ["#ff5f57", "#febc2e", "#28c840"];

const xmlEscape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Read the real-prompt fixture recorded from the binary. */
export function loadFixture() {
  const raw = readFileSync(resolve(terminalDir, "prompts.json"), "utf8");
  return JSON.parse(raw).prompts;
}

/** Render one prompt in one theme to a self-contained SVG string. */
export function renderTerminalSvg(prompt, theme) {
  const pal = PALETTE[theme];
  // Trim the blank lines the prompt brackets itself with; keep interior spacing.
  const lines = prompt.split("\n");
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  const cols = Math.max(...lines.map((line) => line.length));
  const width = PAD_X * 2 + cols * CELL_W;
  const height = CHROME_H + PAD_TOP + lines.length * LINE_H + PAD_BOTTOM;
  const baseline0 = CHROME_H + PAD_TOP + FONT_SIZE; // first row text baseline

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-label="allowlister-remote local terminal approval prompt">`,
    "<style>" +
      '@font-face{font-family:"TermMono";font-style:normal;font-weight:400;' +
      `src:url(data:font/woff2;base64,${fontB64}) format("woff2");}` +
      `text{font-family:"TermMono",monospace;font-size:${FONT_SIZE}px;` +
      "white-space:pre;dominant-baseline:alphabetic;}</style>",
    `<rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${pal.bg}"/>`,
    `<rect x="0" y="0" width="${width}" height="${CHROME_H}" rx="10" fill="${pal.chrome}"/>`,
    `<rect x="0" y="${CHROME_H - 10}" width="${width}" height="10" fill="${pal.chrome}"/>`,
  ];
  DOTS.forEach((dot, i) => {
    parts.push(
      `<circle cx="${20 + i * 20}" cy="${Math.floor(CHROME_H / 2)}" r="6" fill="${dot}"/>`,
    );
  });
  parts.push(
    `<text x="${Math.floor(width / 2)}" y="${Math.floor(CHROME_H / 2) + 5}" text-anchor="middle" ` +
      `font-size="13" fill="${pal.title}">allowlister-remote</text>`,
  );

  lines.forEach((line, row) => {
    if (!line) return;
    const y = baseline0 + row * LINE_H;
    const length = line.length * CELL_W;
    parts.push(
      `<text x="${PAD_X}" y="${y}" fill="${pal.fg}" ` +
        `textLength="${length}" lengthAdjust="spacing" ` +
        `xml:space="preserve">${xmlEscape(line)}</text>`,
    );
  });
  // Block cursor parked at the end of the final prompt line.
  const curX = PAD_X + lines[lines.length - 1].length * CELL_W;
  const curY = baseline0 + (lines.length - 1) * LINE_H - FONT_SIZE + 3;
  parts.push(
    `<rect x="${curX}" y="${curY}" width="${CELL_W}" height="${FONT_SIZE + 3}" ` +
      `fill="${pal.fg}" opacity="0.75"/>`,
  );
  parts.push("</svg>\n");
  return parts.join("");
}

// `--digests`: print each shot's name, toggles, image, and sha256 so the
// baseline manifest can be maintained without running the capture pipeline.
if (process.argv[2] === "--digests") {
  for (const { name, prompt } of loadFixture()) {
    for (const theme of THEMES) {
      const svg = renderTerminalSvg(prompt, theme);
      const hash = createHash("sha256").update(svg, "utf8").digest("hex");
      process.stdout.write(`${name}\ttheme=${theme}\t${name}-${theme}.svg\t${hash}\n`);
    }
  }
}
