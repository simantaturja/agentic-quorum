// Agentic Quorum — MCP App viewer. Runs inside a sandboxed iframe in Claude
// Desktop. Receives the start_debate tool result, then streams events by
// long-polling the app-only poll_debate tool.
import { App } from "@modelcontextprotocol/ext-apps";

const PARLIAMENT_MEMBERS = {
  pragmatist: { label: "Pragmatist", color: "#60a5fa", dim: "rgba(96,165,250,0.12)" },
  idealist:   { label: "Idealist",   color: "#f472b6", dim: "rgba(244,114,182,0.12)" },
  economist:  { label: "Economist",  color: "#34d399", dim: "rgba(52,211,153,0.12)" },
  contrarian: { label: "Contrarian", color: "#fb7185", dim: "rgba(251,113,133,0.12)" },
  ethicist:   { label: "Ethicist",   color: "#c084fc", dim: "rgba(192,132,252,0.12)" },
};

const el = {
  arena: document.getElementById("arena"),
  stickybar: document.getElementById("stickybar"),
  stickytopic: document.getElementById("stickytopic"),
  stepper: document.getElementById("stepper"),
  house: document.getElementById("house"),
  status: document.getElementById("status"),
};

const state = {
  mode: "duel",
  currentCard: null,
  currentBody: null,
  cursor: null,
  currentSection: null,
  steps: [],
  stepIdx: -1,
  seats: {},
  lastStance: {},
};

// ----------------------------------------------------------------- utilities

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function autoscroll() {
  window.scrollTo({ top: document.body.scrollHeight });
}

function removeCursor() {
  if (state.cursor) {
    state.cursor.remove();
    state.cursor = null;
  }
}

function placeCursor(parent) {
  removeCursor();
  state.cursor = document.createElement("span");
  state.cursor.className = "cursor";
  parent.appendChild(state.cursor);
}

// ------------------------------------------------------- sticky bar widgets

function buildStepper(names) {
  el.stepper.innerHTML = "";
  state.steps = names.map((name) => {
    const s = document.createElement("span");
    s.className = "step";
    s.textContent = name;
    el.stepper.appendChild(s);
    return s;
  });
  state.stepIdx = -1;
}

function advanceStep() {
  const { steps, stepIdx } = state;
  if (stepIdx >= 0 && steps[stepIdx]) {
    steps[stepIdx].classList.remove("active");
    steps[stepIdx].classList.add("done");
  }
  state.stepIdx++;
  steps[state.stepIdx]?.classList.add("active");
}

function buildHouse() {
  el.house.innerHTML = "";
  state.seats = {};
  state.lastStance = {};
  for (const [id, m] of Object.entries(PARLIAMENT_MEMBERS)) {
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.innerHTML = `<span class="dot"></span><span class="name">${m.label}</span>`;
    seat.querySelector(".name").style.color = m.color;
    el.house.appendChild(seat);
    state.seats[id] = seat;
  }
  el.house.classList.add("on");
}

function setSeat(member, stance) {
  const seat = state.seats[member];
  if (!seat) return;
  seat.classList.remove("for", "against");
  if (stance === "for" || stance === "against") seat.classList.add(stance);
}

function stepperNames(mode, rounds) {
  if (mode === "parliament") {
    const names = ["Motion", "Opening"];
    for (let i = 1; i <= rounds; i++) names.push(rounds > 1 ? `Floor ${i}` : "Floor");
    names.push("Vote", "Outcome");
    return names;
  }
  const names = ["Opening"];
  for (let i = 1; i <= rounds; i++) names.push(rounds > 1 ? `Rebuttal ${i}` : "Rebuttal");
  names.push("Closing", "Verdict");
  return names;
}

// -------------------------------------------------------------- event router

const handlers = {
  phase: onPhase,
  motion: onMotion,
  speaker_start: onSpeakerStart,
  stance: onStance,
  headline: onHeadline,
  delta: onDelta,
  speaker_end: onSpeakerEnd,
  judging: onJudging,
  verdict: (msg) => onFinale(() => renderVerdict(msg.data)),
  outcome: (msg) => onFinale(() => renderOutcome(msg.data)),
  error: onError,
  done: onDone,
};

function handle(msg) {
  handlers[msg.type]?.(msg);
}

function onPhase(msg) {
  advanceStep();
  if (state.mode === "parliament" && msg.name === "Motion") return;

  const divider = document.createElement("div");
  divider.className = "phase";
  divider.textContent = msg.name;
  el.arena.appendChild(divider);

  const name = msg.name.toLowerCase();
  state.currentSection = null;
  if (state.mode === "duel" && name !== "verdict") {
    state.currentSection = document.createElement("div");
    state.currentSection.className = "exchange";
    el.arena.appendChild(state.currentSection);
  } else if (state.mode === "parliament" && name !== "outcome") {
    state.currentSection = document.createElement("div");
    state.currentSection.className = "chamber" + (name.includes("vote") ? " votes" : "");
    el.arena.appendChild(state.currentSection);
  }
  autoscroll();
}

function onMotion(msg) {
  const banner = document.createElement("div");
  banner.className = "motion";
  banner.innerHTML = `<div class="mlabel">Motion before the house</div><div class="mtext">${esc(msg.text)}</div>`;
  el.arena.appendChild(banner);
  el.stickytopic.textContent = msg.text;
  autoscroll();
}

function onSpeakerStart(msg) {
  removeCursor();
  const card = state.mode === "parliament" ? memberCard(msg) : duelCard(msg);
  card.dataset.agent = msg.agent;
  state.currentCard = card;
  state.currentBody = card.querySelector(".body");
  placeCursor(card.querySelector(".headline"));
  autoscroll();
}

function duelCard(msg) {
  const card = document.createElement("div");
  card.className = `card ${msg.agent}`;
  const tag = msg.agent === "advocate" ? "For" : "Against";
  card.innerHTML = `
    <div class="meta"><span class="tag">${msg.label} · ${tag}</span></div>
    <div class="headline"></div>
    <div class="body"></div>`;
  const section = state.currentSection || el.arena;
  section.appendChild(card);

  if (state.currentSection) {
    if (state.currentSection.children.length === 1) {
      const ph = document.createElement("div");
      ph.className = "card waiting";
      ph.textContent = msg.agent === "advocate" ? "Skeptic is up next…" : "Advocate is up next…";
      state.currentSection.appendChild(ph);
    } else {
      state.currentSection.querySelector(".waiting")?.remove();
      if (msg.agent === "advocate") state.currentSection.prepend(card);
    }
  }
  return card;
}

function memberCard(msg) {
  const m = PARLIAMENT_MEMBERS[msg.agent] || { label: msg.label, color: "var(--muted)", dim: "var(--panel-2)" };
  const card = document.createElement("div");
  card.className = "card member";
  card.style.setProperty("--mcolor", m.color);
  card.style.setProperty("--mdim", m.dim);
  card.innerHTML = `
    <div class="meta"><span class="tag">${m.label}</span><span class="stance-slot"></span><span class="flip-slot"></span></div>
    <div class="headline"></div>
    <div class="body"></div>`;
  for (const seat of Object.values(state.seats)) seat.classList.remove("speaking");
  state.seats[msg.agent]?.classList.add("speaking");
  (state.currentSection || el.arena).appendChild(card);
  return card;
}

function onStance(msg) {
  if (state.mode !== "parliament") return;
  const isCurrent = state.currentCard?.dataset.agent === msg.agent;
  const prev = state.lastStance[msg.agent];

  if (prev && prev !== msg.stance && isCurrent) {
    const flip = state.currentCard.querySelector(".flip-slot");
    if (flip) {
      flip.className = "flip-chip";
      flip.textContent = "↺ changed stance";
    }
  }
  state.lastStance[msg.agent] = msg.stance;
  setSeat(msg.agent, msg.stance);

  if (isCurrent) {
    const slot = state.currentCard.querySelector(".stance-slot");
    if (slot) {
      slot.className = `stance-chip ${msg.stance}`;
      slot.textContent = msg.stance;
    }
  }
}

function onHeadline(msg) {
  if (!state.currentCard) return;
  state.currentCard.querySelector(".headline").textContent = msg.text;
  placeCursor(state.currentBody);
  autoscroll();
}

function onDelta(msg) {
  if (!state.currentBody) return;
  state.currentBody.insertBefore(document.createTextNode(msg.text), state.cursor);
  autoscroll();
}

function onSpeakerEnd(msg) {
  removeCursor();
  state.seats[msg.agent]?.classList.remove("speaking");
  state.currentCard = null;
  state.currentBody = null;
}

function onJudging() {
  const elJudging = document.createElement("div");
  elJudging.className = "judging";
  elJudging.id = "judging";
  const text = state.mode === "parliament" ? "The Speaker is summarizing the debate" : "The judge is deliberating";
  elJudging.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span> ${text}`;
  el.arena.appendChild(elJudging);
  autoscroll();
}

function onFinale(render) {
  document.getElementById("judging")?.remove();
  render();
  autoscroll();
}

function onError(msg) {
  document.getElementById("judging")?.remove();
  const err = document.createElement("div");
  err.className = "error";
  err.textContent = "Debate failed: " + msg.message;
  el.arena.appendChild(err);
  setStatus("failed");
}

function onDone() {
  advanceStep();
  removeCursor();
  setStatus("finished");
}

function setStatus(text) {
  el.status.textContent = text;
}

// ----------------------------------------------------------------- rendering

function renderVerdict(v) {
  const winnerLabel = v.winner === "advocate" ? "Advocate wins"
    : v.winner === "skeptic" ? "Skeptic wins" : "Draw";
  const card = document.createElement("div");
  card.className = "verdict";
  card.innerHTML = `
    <div class="vtitle">
      <h2>⚖ Judge's verdict</h2>
      <span class="winner-badge ${esc(v.winner)}">${winnerLabel}</span>
    </div>
    <div class="answer">
      <div class="alabel">The answer</div>
      ${esc(v.final_answer)}
    </div>
    <div class="scores">
      <div class="score advocate"><div class="num">${Number(v.advocate_score) || 0}</div><div class="lbl">Advocate</div></div>
      <div class="score skeptic"><div class="num">${Number(v.skeptic_score) || 0}</div><div class="lbl">Skeptic</div></div>
    </div>
    <div class="confbar">
      <div class="clabel"><span>Judge confidence</span><span>${Number(v.confidence) || 0}%</span></div>
      <div class="track"><div class="fill"></div></div>
    </div>
    <h3>Why</h3>
    <p>${esc(v.analysis)}</p>
    <h3>Decisive points</h3>
    <ul>${(v.key_points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
  el.arena.appendChild(card);
  requestAnimationFrame(() => {
    card.querySelector(".fill").style.width = `${Math.min(100, Number(v.confidence) || 0)}%`;
  });
}

function renderOutcome(o) {
  const t = o.tally || { for: 0, against: 0, undecided: 0 };
  const total = Math.max(1, t.for + t.against + t.undecided);
  const resultLabel = o.result === "passes" ? "Motion passes"
    : o.result === "fails" ? "Motion fails" : "House is hung";
  const card = document.createElement("div");
  card.className = "verdict";
  card.innerHTML = `
    <div class="vtitle">
      <h2>🏛 The house has decided</h2>
      <span class="winner-badge ${esc(o.result)}">${resultLabel} · ${t.for}–${t.against}</span>
    </div>
    <div class="answer">
      <div class="alabel">The answer</div>
      ${esc(o.final_answer)}
    </div>
    <div class="tallybar">
      <div class="tfor" style="width:${(t.for / total) * 100}%">${t.for ? `FOR ${t.for}` : ""}</div>
      <div class="tund" style="width:${(t.undecided / total) * 100}%">${t.undecided ? `± ${t.undecided}` : ""}</div>
      <div class="tagn" style="width:${(t.against / total) * 100}%">${t.against ? `AGAINST ${t.against}` : ""}</div>
    </div>
    <h3>How the debate moved</h3>
    <p>${esc(o.summary)}</p>
    <h3>Coalitions</h3>
    <ul>${(o.coalitions || []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    <h3>Strongest dissent</h3>
    <p>${esc(o.dissent)}</p>`;
  el.arena.appendChild(card);
}

// ----------------------------------------------------- MCP App bootstrapping

const app = new App({ name: "Agentic Quorum Viewer", version: "1.0.0" });
let started = false;

async function follow({ debateId, topic, mode, rounds }) {
  if (started) return; // a single viewer follows one debate
  started = true;

  state.mode = mode;
  el.arena.innerHTML = "";
  el.stickytopic.textContent = topic;
  el.stickybar.classList.add("on");
  buildStepper(stepperNames(mode, rounds));
  if (mode === "parliament") buildHouse();
  setStatus("live");

  let cursor = 0;
  let done = false;
  while (!done) {
    try {
      const result = await app.callServerTool({
        name: "poll_debate",
        arguments: { debateId, cursor },
      });
      const data = result.structuredContent;
      if (!data) break;
      for (const event of data.events) handle(event);
      cursor = data.cursor;
      done = data.done;
      if (!data.events.length && !done) await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      onError({ message: String(err?.message || err) });
      break;
    }
  }
}

// Register before connect() so the initial tool result isn't missed.
app.ontoolresult = (result) => {
  const data = result.structuredContent;
  if (data?.debateId) follow(data);
};

app.connect();
