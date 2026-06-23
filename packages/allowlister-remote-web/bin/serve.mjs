#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

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

// The text-based assets gzip to roughly a third of their size — the PWA's first
// load is ~700 kB of JS/CSS raw but ~210 kB gzipped — so serving them compressed
// is the single biggest first-load win a static host gives (a Lighthouse audit of
// the uncompressed build spent most of its LCP budget waiting on those bytes).
// The image/font types are already compressed, so gzipping them only burns CPU
// (and can grow them); they are excluded.
const COMPRESSIBLE = new Set([
  "text/html",
  "text/javascript",
  "text/css",
  "application/json",
  "application/manifest+json",
  "image/svg+xml",
  "text/plain",
]);

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = join(packageDir, "static");

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "0.0.0.0",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
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
  const type = mimeFor(filePath);
  const headers = { "Content-Type": type };
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/sw.js") {
    headers["Service-Worker-Allowed"] = "/";
    headers["Cache-Control"] = "no-cache";
  }
  // Compress text assets when the client accepts gzip; `Vary` keeps any shared
  // cache from serving a gzipped body to a client that did not ask for one.
  const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  const compress = acceptsGzip && COMPRESSIBLE.has(type);
  if (compress) {
    headers["Content-Encoding"] = "gzip";
    headers.Vary = "Accept-Encoding";
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const file = createReadStream(filePath);
  if (compress) {
    file.pipe(createGzip()).pipe(res);
  } else {
    file.pipe(res);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(staticDir)) {
    process.stderr.write(`allowlister-remote-web: static assets missing at ${staticDir}\n`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    const target = resolveTarget(staticDir, req.url ?? "/");
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
    process.stdout.write(
      `allowlister-remote-web: serving the PWA at http://${opts.host}:${opts.port}  (set your broker URL in the app, or open with ?broker=wss://your-broker)\n`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
