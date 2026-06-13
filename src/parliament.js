import { PARLIAMENT_MEMBERS, SPEAKER } from "./personas.js";
import { runTurn } from "./claude.js";
import { transcriptText, extractJson, firstLineParser, parseStance } from "./parse.js";
import { WORD_LIMITS } from "./config.js";

const STANCE_FORMAT = `\n\nFormat: first line is exactly "STANCE: FOR — <headline>" or "STANCE: AGAINST — <headline>" or "STANCE: UNDECIDED — <headline>" where the headline is your core point in at most 10 words. Then a blank line, then your remarks in short paragraphs of 2-3 sentences.`;

function motionPrompt(topic) {
  return `Topic submitted to the house: "${topic}"

Reframe this as a single crisp, binary, debatable motion of at most 20 words, starting with "This house believes" (or "This house would"). If the topic is an open question, pick the most central claim hidden inside it and make that the motion. Respond with ONLY the motion sentence.`;
}

function outcomePrompt({ motion, topic, transcript, tally, result }) {
  return `Motion: "${motion}"
Original topic: "${topic}"

Full debate transcript:

${transcriptText(transcript)}

Final vote tally: FOR ${tally.for}, AGAINST ${tally.against}, UNDECIDED ${tally.undecided}. The motion ${result === "hung" ? "is hung" : result}.

Synthesize the debate. Respond with ONLY a JSON object, no other text:
{
  "summary": "<3-5 sentences: how the debate evolved, which arguments dominated, who changed whose mind>",
  "coalitions": ["<1-3 short descriptions of alliances that formed, e.g. 'Pragmatist and Economist aligned on implementation cost'>"],
  "dissent": "<1-2 sentences: the strongest surviving counterargument from the losing side>",
  "final_answer": "<2-4 sentences: the actual usable answer to the original topic, reflecting the house's collective judgment>"
}`;
}

/** Run a 5-member parliament debate, emitting SSE events via `send`. */
export async function runParliament({ topic, rounds, model, send, signal }) {
  const transcript = [];
  const stances = {}; // member id -> latest declared stance
  const limits = WORD_LIMITS.parliament;

  // 1. The Speaker frames the motion.
  send({ type: "phase", name: "Motion" });
  const motionRaw = await runTurn({
    system: SPEAKER.system,
    prompt: motionPrompt(topic),
    model,
    send: () => {},
    signal,
  });
  const motion = motionRaw.replace(/^["']|["']$/g, "").trim();
  send({ type: "motion", text: motion });

  const speak = async (member, phase, instruction, wordLimit) => {
    send({ type: "speaker_start", agent: member.id, label: member.label, phase });
    const parser = firstLineParser(send, { stance: true, agent: member.id });
    const context = transcript.length
      ? `Motion before the house: "${motion}"\n(Original topic: "${topic}")\n\nDebate so far:\n\n${transcriptText(transcript)}\n\n`
      : `Motion before the house: "${motion}"\n(Original topic: "${topic}")\n\n`;
    const text = await runTurn({
      system: member.system,
      prompt: `${context}${instruction} Maximum ${wordLimit} words.${STANCE_FORMAT}`,
      model,
      send: parser.send,
      signal,
    });
    parser.flush();
    const stance = parseStance(text);
    if (stance) stances[member.id] = stance;
    transcript.push({ agent: member.id, label: member.label, phase, text });
    send({ type: "speaker_end", agent: member.id });
  };

  // 2. Opening positions.
  send({ type: "phase", name: "Opening positions" });
  for (const member of PARLIAMENT_MEMBERS) {
    await speak(member, "opening", "State your opening position on the motion through your lens.", limits.opening);
  }

  // 3. Open floor.
  for (let r = 1; r <= rounds; r++) {
    send({ type: "phase", name: rounds > 1 ? `Open floor — round ${r}` : "Open floor" });
    for (const member of PARLIAMENT_MEMBERS) {
      await speak(
        member,
        `floor ${r}`,
        "Respond to the strongest points other members made, by name. Defend, attack, or update your stance. If someone moved you, credit them.",
        limits.floor
      );
    }
  }

  // 4. Division — final binding vote.
  send({ type: "phase", name: "Division — final vote" });
  for (const member of PARLIAMENT_MEMBERS) {
    await speak(member, "vote", "Cast your final vote on the motion with a one-or-two-sentence justification. This is binding.", limits.vote);
  }

  // Tally is computed from parsed stances, not trusted to the Speaker.
  const tally = { for: 0, against: 0, undecided: 0 };
  for (const member of PARLIAMENT_MEMBERS) {
    tally[stances[member.id] || "undecided"]++;
  }
  const result =
    tally.for > tally.against ? "passes" : tally.against > tally.for ? "fails" : "hung";

  // 5. Speaker synthesis.
  send({ type: "phase", name: "Outcome" });
  send({ type: "judging" });

  const outcomeRaw = await runTurn({
    system: SPEAKER.system,
    prompt: outcomePrompt({ motion, topic, transcript, tally, result }),
    model,
    send: () => {},
    signal,
  });

  send({
    type: "outcome",
    data: { ...extractJson(outcomeRaw), tally, result, motion },
  });
  send({ type: "done" });
}
