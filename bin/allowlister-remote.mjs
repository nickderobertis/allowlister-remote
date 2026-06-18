#!/usr/bin/env node
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function stateDir() {
  return resolve(
    arg(
      "--state-dir",
      process.env.ALLOWLISTER_REMOTE_STATE_DIR ?? ".allowlister-remote",
    ),
  );
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function commandFragments(command) {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/u)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((display) => ({
      argv: display.split(/\s+/u),
      display,
      role: "standalone",
      verdict: "ask",
    }));
}

function riskSignals(command, cwd) {
  const haystack = `${command} ${cwd}`.toLowerCase();
  return [
    ["rm", "destructive file operation"],
    ["sudo", "privileged command"],
    ["curl", "network fetch"],
    ["wget", "network fetch"],
    ["push", "remote write"],
    ["merge", "merge action"],
    ["delete", "deletion"],
    ["token", "secret-looking argument"],
    [".env", "secret-looking path"],
  ]
    .filter(([term]) => haystack.includes(term))
    .map(([, label]) => label);
}

function requestFromPlugin(input, timeoutMs) {
  const now = Date.now();
  const command = String(input.command ?? "");
  const cwd = String(input.cwd ?? "");
  return {
    id: randomUUID(),
    subject: "shell",
    harness: String(input.harness ?? "allowlister"),
    cwd,
    command,
    currentVerdict: input.current_verdict ?? "defer",
    currentReason: input.current_reason ?? "",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    fragments: commandFragments(command),
    riskSignals: riskSignals(command, cwd),
  };
}

async function runPlugin() {
  const timeoutMs = Number(arg("--timeout-ms", "120000"));
  const pollMs = Number(arg("--poll-ms", "250"));
  const dir = stateDir();
  const input = JSON.parse(await readStdin());
  if (
    input.current_verdict &&
    input.current_verdict !== "defer" &&
    input.current_verdict !== "ask"
  ) {
    process.stdout.write(
      JSON.stringify({
        verdict: "defer",
        reason: "static allowlister verdict does not need remote approval",
      }),
    );
    process.exit(0);
  }
  const request = requestFromPlugin(input, timeoutMs);
  await writeJson(join(dir, "requests", `${request.id}.json`), request);

  const deadline = Date.now() + timeoutMs;
  const decisionPath = join(dir, "decisions", `${request.id}.json`);
  while (Date.now() < deadline) {
    try {
      const decision = await readJson(decisionPath);
      const verdict = decision.verdict === "deny" ? "deny" : "allow";
      process.stdout.write(
        JSON.stringify({
          verdict,
          reason: decision.reason ?? `remote ${verdict}`,
        }),
      );
      process.exit(0);
    } catch {
      await sleep(pollMs);
    }
  }
  process.stdout.write(
    JSON.stringify({
      verdict: "ask",
      reason: `allowlister-remote timed out after ${timeoutMs}ms`,
    }),
  );
  process.exit(0);
}

async function listRequests(dir) {
  const requestDir = join(dir, "requests");
  await mkdir(requestDir, { recursive: true });
  const files = await readdir(requestDir);
  const now = Date.now();
  const requests = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const request = await readJson(join(requestDir, file));
    try {
      await stat(join(dir, "decisions", `${request.id}.json`));
      continue;
    } catch {
      if (Date.parse(request.expiresAt) > now) requests.push(request);
    }
  }
  return requests.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

async function sendJson(response, status, body) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
}

async function serve() {
  const dir = stateDir();
  const appDir = resolve(arg("--app-dir", "dist"));
  const port = Number(arg("--port", "4173"));
  const host = arg("--host", "127.0.0.1");
  await mkdir(join(dir, "requests"), { recursive: true });
  await mkdir(join(dir, "decisions"), { recursive: true });

  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    if (request.method === "GET" && url.pathname === "/api/approval-requests") {
      await sendJson(response, 200, await listRequests(dir));
      return;
    }
    const decisionMatch = url.pathname.match(
      /^\/api\/approval-requests\/([^/]+)\/decision$/u,
    );
    if (request.method === "POST" && decisionMatch) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.verdict !== "allow" && body.verdict !== "deny") {
        await sendJson(response, 400, {
          error: "verdict must be allow or deny",
        });
        return;
      }
      await writeJson(join(dir, "decisions", `${decisionMatch[1]}.json`), {
        verdict: body.verdict,
        reason: body.reason ?? `remote ${body.verdict}`,
      });
      await sendJson(response, 200, { ok: true });
      return;
    }

    const pathname = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname,
    );
    const file = resolve(appDir, `.${pathname}`);
    if (!file.startsWith(appDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    try {
      response.writeHead(200, {
        "content-type": mime.get(extname(file)) ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(
      `allowlister-remote listening on http://${host}:${port}\n`,
    );
  });
}

async function reset() {
  await rm(stateDir(), { recursive: true, force: true });
}

const command = process.argv[2];
if (command === "plugin") await runPlugin();
else if (command === "serve") await serve();
else if (command === "reset") await reset();
else {
  process.stderr.write(
    "Usage: allowlister-remote <plugin|serve|reset> [--state-dir DIR]\n",
  );
  process.exit(2);
}
