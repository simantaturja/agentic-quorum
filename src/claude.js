import { query } from "@anthropic-ai/claude-agent-sdk";
import { BLOCKED_TOOLS } from "./config.js";

/**
 * Run a single one-shot agent turn and stream its text.
 *
 * Uses the Claude Agent SDK, which authenticates via the local Claude Code
 * login — no API key required. All tools are disabled: agents are pure text
 * generators.
 *
 * @param {object} opts
 * @param {string} opts.system   System prompt for the agent.
 * @param {string} opts.prompt   User prompt for this turn.
 * @param {string} opts.model    Model alias ("opus" | "sonnet" | "haiku").
 * @param {(msg: object) => void} opts.send  Receives `{type: "delta", text}` chunks.
 * @param {AbortSignal} opts.signal          Aborts the turn (client disconnect).
 * @returns {Promise<string>} The complete turn text, trimmed.
 */
export async function runTurn({ system, prompt, model, send, signal }) {
  let full = "";
  let sawDelta = false;

  const q = query({
    prompt,
    options: {
      model,
      systemPrompt: system,
      maxTurns: 1,
      tools: [],
      disallowedTools: BLOCKED_TOOLS,
      includePartialMessages: true,
    },
  });

  for await (const msg of q) {
    if (signal.aborted) {
      try { await q.interrupt?.(); } catch { /* best effort */ }
      throw new Error("client disconnected");
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        sawDelta = true;
        full += ev.delta.text;
        send({ type: "delta", text: ev.delta.text });
      }
    } else if (msg.type === "assistant" && !sawDelta) {
      // Fallback if partial events were not delivered.
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") {
          full += block.text;
          send({ type: "delta", text: block.text });
        }
      }
    } else if (msg.type === "result" && msg.subtype !== "success") {
      throw new Error(`agent turn failed: ${msg.subtype}`);
    }
  }
  return full.trim();
}
