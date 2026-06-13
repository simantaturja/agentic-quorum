/** Render a debate transcript as labeled plain text for agent prompts. */
export function transcriptText(transcript) {
  return transcript
    .map((t) => `[${t.label} — ${t.phase}]\n${t.text}`)
    .join("\n\n");
}

/** Extract the first JSON object from agent output (tolerates code fences). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in output");
  return JSON.parse(candidate.slice(start, end + 1));
}

const STANCE_RE = /^stance:\s*(for|against|undecided)\s*[—–:-]?\s*(.*)$/i;

/**
 * Wrap a `send` function so the first line of a streamed turn is held back,
 * parsed (optionally for a leading "STANCE: X —" prefix), and emitted as its
 * own `stance`/`headline` events before the body streams as deltas.
 *
 * Call `flush()` after the turn completes to handle single-line turns that
 * never produced a newline.
 *
 * @param {(msg: object) => void} send
 * @param {{stance?: boolean, agent?: string|null}} [opts]
 * @returns {{send: (msg: object) => void, flush: () => void}}
 */
export function firstLineParser(send, { stance = false, agent = null } = {}) {
  let buffer = "";
  let done = false;

  const emitFirstLine = (line) => {
    let headline = line.replace(/^headline:\s*/i, "").trim();
    if (stance) {
      const m = headline.match(STANCE_RE);
      if (m) {
        send({ type: "stance", agent, stance: m[1].toLowerCase() });
        headline = m[2].trim() || headline;
      } else {
        send({ type: "stance", agent, stance: "undecided" });
      }
    }
    send({ type: "headline", text: headline });
  };

  return {
    send: (msg) => {
      if (msg.type !== "delta" || done) return send(msg);
      buffer += msg.text;
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      done = true;
      emitFirstLine(buffer.slice(0, nl));
      const rest = buffer.slice(nl + 1).replace(/^\n+/, "");
      if (rest) send({ type: "delta", text: rest });
    },
    flush: () => {
      if (!done && buffer) emitFirstLine(buffer);
      done = true;
    },
  };
}

/** Parse a declared stance from a completed turn's full text. */
export function parseStance(text) {
  const m = text.match(/^stance:\s*(for|against|undecided)/i);
  return m ? m[1].toLowerCase() : null;
}
