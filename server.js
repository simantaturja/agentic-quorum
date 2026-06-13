import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { PORT, ALLOWED_MODELS, DEFAULT_MODEL, MODES, DEFAULT_MODE, MAX_ROUNDS } from "./src/config.js";
import { runDuel } from "./src/duel.js";
import { runParliament } from "./src/parliament.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function serveStatic(res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const type = CONTENT_TYPES[ext];
  if (!type) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function parseDebateParams(searchParams) {
  const topic = (searchParams.get("topic") || "").trim();
  const mode = MODES.has(searchParams.get("mode")) ? searchParams.get("mode") : DEFAULT_MODE;
  const rounds = Math.min(
    MAX_ROUNDS[mode],
    Math.max(1, parseInt(searchParams.get("rounds") || "1", 10) || 1)
  );
  const model = ALLOWED_MODELS.has(searchParams.get("model"))
    ? searchParams.get("model")
    : DEFAULT_MODEL;
  return { topic, mode, rounds, model };
}

async function handleDebate(req, res, searchParams) {
  const { topic, mode, rounds, model } = parseDebateParams(searchParams);
  if (!topic) {
    res.writeHead(400).end("missing topic");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  try {
    const run = mode === "parliament" ? runParliament : runDuel;
    await run({ topic, rounds, model, send, signal: abort.signal });
  } catch (err) {
    if (!abort.signal.aborted) {
      send({ type: "error", message: String(err.message || err) });
    }
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/debate") {
    await handleDebate(req, res, url.searchParams);
  } else {
    await serveStatic(res, url.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`agentic-quorum running at http://localhost:${PORT}`);
});
