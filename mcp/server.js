// MCP App server for Claude Desktop: exposes the debate engine as a tool
// whose result renders an interactive viewer inside the chat.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { runDuel } from "../src/duel.js";
import { runParliament } from "../src/parliament.js";
import { ALLOWED_MODELS, DEFAULT_MODEL, MAX_ROUNDS } from "../src/config.js";

const UI_RESOURCE_URI = "ui://agentic-quorum/mcp-app.html";
const UI_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "dist", "mcp-app.html");

// In-memory debate sessions. UI polls them via the app-only poll_debate tool.
const sessions = new Map();

function newSessionId() {
  return Math.random().toString(36).slice(2, 10);
}

function startDebate({ topic, mode, rounds, model }) {
  const id = newSessionId();
  const session = { events: [], done: false };
  sessions.set(id, session);

  const send = (event) => session.events.push(event);
  const run = mode === "parliament" ? runParliament : runDuel;
  const abort = new AbortController();

  run({ topic, rounds, model, send, signal: abort.signal })
    .catch((err) => send({ type: "error", message: String(err.message || err) }))
    .finally(() => {
      session.done = true;
    });

  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Long-poll: wait up to `timeoutMs` for events past `cursor`. */
async function waitForEvents(session, cursor, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (session.events.length <= cursor && !session.done && Date.now() < deadline) {
    await sleep(150);
  }
  return session.events.slice(cursor);
}

function createServer() {
  const server = new McpServer({ name: "Agentic Quorum", version: "1.0.0" });

  registerAppTool(
    server,
    "start_debate",
    {
      title: "Start a debate",
      description:
        "Start a live multi-agent debate on a topic and render an interactive viewer. " +
        "Modes: 'duel' (Advocate vs Skeptic, scored by a Judge) or 'parliament' " +
        "(five members with different value systems debate a motion and vote).",
      inputSchema: {
        topic: z.string().describe("The question or claim to debate"),
        mode: z.enum(["duel", "parliament"]).optional().describe("Debate format (default duel)"),
        rounds: z.number().int().min(1).max(3).optional().describe("Rebuttal/floor rounds (default 1)"),
        model: z.enum([...ALLOWED_MODELS]).optional().describe("Model alias (default sonnet)"),
      },
      outputSchema: {
        debateId: z.string(),
        topic: z.string(),
        mode: z.enum(["duel", "parliament"]),
        rounds: z.number(),
        model: z.string(),
      },
      _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
    },
    async ({ topic, mode = "duel", rounds = 1, model = DEFAULT_MODEL }) => {
      const clampedRounds = Math.min(MAX_ROUNDS[mode], Math.max(1, rounds));
      const debateId = startDebate({ topic, mode, rounds: clampedRounds, model });
      const structuredContent = { debateId, topic, mode, rounds: clampedRounds, model };
      return {
        content: [
          {
            type: "text",
            text: `Debate started (${mode}, ${model}) on: "${topic}". The viewer streams it live.`,
          },
        ],
        structuredContent,
      };
    },
  );

  // Hidden from the model — only the iframe UI calls this to stream events.
  registerAppTool(
    server,
    "poll_debate",
    {
      title: "Poll debate events",
      description: "Fetch debate events past a cursor (used by the debate viewer UI).",
      inputSchema: {
        debateId: z.string(),
        cursor: z.number().int().min(0),
      },
      outputSchema: {
        events: z.array(z.any()),
        cursor: z.number(),
        done: z.boolean(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ debateId, cursor }) => {
      const session = sessions.get(debateId);
      if (!session) {
        return {
          content: [{ type: "text", text: "unknown debate" }],
          structuredContent: { events: [{ type: "error", message: "unknown debate (server restarted?)" }], cursor, done: true },
        };
      }
      const events = await waitForEvents(session, cursor);
      const structuredContent = {
        events,
        cursor: cursor + events.length,
        done: session.done && cursor + events.length >= session.events.length,
      };
      return {
        content: [{ type: "text", text: `${events.length} events` }],
        structuredContent,
      };
    },
  );

  registerAppResource(
    server,
    UI_RESOURCE_URI,
    UI_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await readFile(UI_HTML_PATH, "utf-8");
      return {
        contents: [{ uri: UI_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}

await createServer().connect(new StdioServerTransport());
