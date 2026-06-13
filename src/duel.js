import { DUEL_AGENTS } from "./personas.js";
import { runTurn } from "./claude.js";
import { transcriptText, extractJson, firstLineParser } from "./parse.js";
import { WORD_LIMITS } from "./config.js";

const HEADLINE_FORMAT = `\n\nFormat: first line is a punchy headline stating your core claim (maximum 10 words, no quotes), then a blank line, then your argument in short paragraphs of 2-3 sentences. Use "- " dashes for lists.`;

function verdictPrompt(topic, transcript) {
  return `Debate topic: "${topic}"

Full transcript:

${transcriptText(transcript)}

Score the debate and produce a verdict. Respond with ONLY a JSON object, no other text:
{
  "winner": "advocate" | "skeptic" | "draw",
  "confidence": <integer 50-100, how confident you are in the verdict>,
  "advocate_score": <integer 0-10>,
  "skeptic_score": <integer 0-10>,
  "analysis": "<3-5 sentences: the decisive arguments and why they won>",
  "final_answer": "<2-4 sentences: the actual usable answer to the original question, synthesizing the strongest points from both sides>",
  "key_points": ["<the 3-4 arguments that most shaped the outcome>"]
}`;
}

/** Run a 1v1 Advocate-vs-Skeptic debate, emitting SSE events via `send`. */
export async function runDuel({ topic, rounds, model, send, signal }) {
  const transcript = [];
  const limits = WORD_LIMITS.duel;

  const speak = async (agent, phase, instruction, wordLimit) => {
    const meta = DUEL_AGENTS[agent];
    send({ type: "speaker_start", agent, label: meta.label, phase });
    const parser = firstLineParser(send);
    const context = transcript.length
      ? `Debate topic: "${topic}"\n\nTranscript so far:\n\n${transcriptText(transcript)}\n\n`
      : `Debate topic: "${topic}"\n\n`;
    const text = await runTurn({
      system: meta.system,
      prompt: `${context}${instruction} Maximum ${wordLimit} words.${HEADLINE_FORMAT}`,
      model,
      send: parser.send,
      signal,
    });
    parser.flush();
    transcript.push({ agent, label: meta.label, phase, text });
    send({ type: "speaker_end", agent });
  };

  send({ type: "phase", name: "Opening statements" });
  await speak("advocate", "opening", "Deliver your opening statement.", limits.opening);
  await speak("skeptic", "opening", "Deliver your opening statement, and briefly counter the Advocate's framing.", limits.opening);

  for (let r = 1; r <= rounds; r++) {
    send({ type: "phase", name: rounds > 1 ? `Rebuttal round ${r}` : "Rebuttals" });
    await speak("advocate", `rebuttal ${r}`, "Rebut the Skeptic's strongest arguments. Reinforce your weakest flank.", limits.rebuttal);
    await speak("skeptic", `rebuttal ${r}`, "Rebut the Advocate's strongest arguments. Reinforce your weakest flank.", limits.rebuttal);
  }

  send({ type: "phase", name: "Closing statements" });
  await speak("advocate", "closing", "Deliver your closing statement. Crystallize why your position wins.", limits.closing);
  await speak("skeptic", "closing", "Deliver your closing statement. Crystallize why your position wins.", limits.closing);

  send({ type: "phase", name: "Verdict" });
  send({ type: "judging" });

  const judgeRaw = await runTurn({
    system: DUEL_AGENTS.judge.system,
    prompt: verdictPrompt(topic, transcript),
    model,
    send: () => {}, // raw JSON is not streamed to the UI
    signal,
  });

  send({ type: "verdict", data: extractJson(judgeRaw) });
  send({ type: "done" });
}
