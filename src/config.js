export const PORT = Number(process.env.PORT) || 3457;

export const ALLOWED_MODELS = new Set(["opus", "sonnet", "haiku"]);
export const DEFAULT_MODEL = "sonnet";

export const MODES = new Set(["duel", "parliament"]);
export const DEFAULT_MODE = "duel";

export const MAX_ROUNDS = { duel: 3, parliament: 2 };

// Per-turn word limits keep debates tight and skimmable.
export const WORD_LIMITS = {
  duel: { opening: 220, rebuttal: 180, closing: 130 },
  parliament: { opening: 130, floor: 140, vote: 45 },
};

// Tools the debate agents must never reach for — they are pure text generators.
export const BLOCKED_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebSearch", "WebFetch", "Task", "TodoWrite", "NotebookEdit",
];
