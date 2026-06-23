#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function parseArgs(argv) {
  const opts = { dir: "apps/web/out", port: 4183, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      opts.dir = argv[++i];
    } else if (arg === "--port") {
      opts.port = Number(argv[++i]);
    } else if (arg === "--host") {
      opts.host = argv[++i];
    }
  }
  return opts;
}

function mimeFor(filePath) {
  return MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveTarget(dir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(dir, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) {
    return { forbidden: true };
  }
  if (isFile(candidate)) {
    return { file: candidate };
  }
  if (extname(candidate) === "") {
    const asHtml = `${candidate}.html`;
    if (isFile(asHtml)) {
      return { file: asHtml };
    }
    const asIndex = join(candidate, "index.html");
    if (isFile(asIndex)) {
      return { file: asIndex };
    }
  }
  const fallback = join(dir, "index.html");
  if (isFile(fallback)) {
    return { file: fallback, fallback: true };
  }
  return { notFound: true };
}

function sendFile(req, res, filePath) {
  const headers = { "Content-Type": mimeFor(filePath) };
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/sw.js") {
    headers["Service-Worker-Allowed"] = "/";
    headers["Cache-Control"] = "no-cache";
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = resolve(process.cwd(), opts.dir);

  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    const target = resolveTarget(dir, req.url ?? "/");
    if (target.forbidden) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (target.notFound) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    sendFile(req, res, target.file);
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`serve-web: serving ${dir} at http://${opts.host}:${opts.port}`);
  });

  const shutdown = () => {
    // Force the listener and any lingering keep-alive sockets shut, then exit.
    // `server.close()` alone waits for open keep-alive connections (the browser's
    // and Playwright's) to drain, which can hang indefinitely — wedging the
    // Playwright webServer teardown to the CI job's hard timeout. Destroying the
    // sockets, plus a short hard-exit fallback, guarantees a prompt exit.
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
