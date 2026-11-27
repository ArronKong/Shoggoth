"use strict";

const crypto = require("node:crypto");

// This describes where a Runtime keeps instructions, not whether an Agent may
// use a tool. Tool admission continues to use the frozen execution contract.
const DELIVERY = Object.freeze({
  codex: "developer_updates",
  "pi": "request_system",
  "claude-code": "request_system",
  "deepseek-harness": "system_sections",
  opencode: "request_system",
  "grok-build": "negotiated_session_system",
  antigravity: "prompt_fallback",
});

function instructionDelivery(runtime) {
  return DELIVERY[runtime] ?? "prompt_fallback";
}

function systemInstructions(stable, turn) {
  return [stable, turn].filter(value => typeof value === "string" && value.length > 0).join("\n\n");
}

function turnInstructions(input) {
  const text = input?.turnDeveloperInstructions;
  if (text == null) return "";
  if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")
    || Buffer.byteLength(text) > 1024 * 1024) {
    throw require("./security").serviceError("RUNTIME_TURN_PARAMS_INVALID", "Current turn instructions are invalid");
  }
  return text;
}

// Omitting the property for legacy callers preserves their persisted operation
// fingerprints. New callers bind the complete turn policy into idempotency.
function turnInstructionFingerprint(input) {
  const text = turnInstructions(input);
  return input?.turnDeveloperInstructions == null ? {} : { turnDeveloperInstructions: text };
}

function historyInstructions(runtime, stable, turn) {
  const mode = instructionDelivery(runtime);
  // Before acquisition Grok's negotiated mode may still be a legacy prompt
  // fallback. Budget that uncertainty conservatively, never as measured usage.
  if (["prompt_fallback", "negotiated_session_system"].includes(mode)) return systemInstructions(stable, turn);
  return mode === "developer_updates" ? turn : "";
}

// The Run ID changes every turn; the other turn rules usually do not. Runtimes
// that keep turn rules in a system prompt send this paragraph with the user
// message instead, so the system prefix stays identical (and cacheable).
const RUN_ID_PREFIX = "Current Shoggoth Run ID: ";
function runIdInstruction(runId) { return `${RUN_ID_PREFIX}${runId}`; }
function splitTurnInstructions(text) {
  const paragraphs = (text || "").split("\n\n").filter(Boolean);
  const isRun = paragraph => paragraph.startsWith(RUN_ID_PREFIX);
  return { rules: paragraphs.filter(paragraph => !isRun(paragraph)).join("\n\n"),
    run: paragraphs.filter(isRun).join("\n\n") };
}

// Blocks sent inside user messages stay in the native session's own history.
// Repeat one only when that session has no record of it, its text changed, or
// PROMPT_BLOCK_REFRESH_TURNS turns passed: compaction inside the CLI is not
// always observable and may have summarized it away. A plan is committed only
// after the Runtime accepted the turn, so a failed send repeats. A shared
// NativePromptLedgerStore keeps the record across per-Run Hosts and restarts.
const PROMPT_BLOCK_REFRESH_TURNS = 8;
const BLOCK_LABELS = Object.freeze({ stable: "Shoggoth developer instructions", rules: "Shoggoth Run rules",
  context: "Shoggoth memory and Skill context" });
// Continuing-turn context is the "\n\n" join of ordered compiler blocks. Each
// block is recorded separately so one changed memory block does not resend
// the profile, connectors and Skill catalog with it.
const SECTION_PREFIX = "context:";
const MAX_CONTEXT_SECTIONS = 256;
const SECTION_LABELS = Object.freeze({
  "mcp-connectors": "MCP connector list", "skill-catalog": "enabled Skill catalog", user: "saved user profile",
  "active-memory": "active memory", memory: "memory files", "published-notices": "published notices",
});
// Blocks that describe current state: once one disappears, its earlier copy
// in the thread must stop applying. Recall blocks may simply not match a turn.
const STATEFUL_SECTIONS = new Set(["mcp-connectors", "skill-catalog", "user"]);
const ONCE_SECTION_KINDS = new Set(["transcript", "handoff", "checkpoint"]);
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

function blockLabel(key) {
  if (!key.startsWith(SECTION_PREFIX)) return BLOCK_LABELS[key] ?? key;
  const id = key.slice(SECTION_PREFIX.length);
  return SECTION_LABELS[id] ?? (id.startsWith("hook-contribution:") ? `hook data (${id.slice(18)})` : `context data (${id})`);
}

// Index of the blocks joined into one context projection: id, length and
// whether the block is history that is delivered once and never recorded.
function contextIndexFor(items) {
  return items.map(item => ({ key: item.id, length: item.content.length,
    ...(ONCE_SECTION_KINDS.has(item.kind) ? { once: true } : {}) }));
}

// Split a joined context back into its blocks. Null when the text does not
// match the index (a projection changed it); the caller then sends it whole.
function contextSections(context, index) {
  if (typeof context !== "string" || !Array.isArray(index) || index.length === 0
    || index.length > MAX_CONTEXT_SECTIONS) return null;
  const sections = [], keys = new Set();
  let offset = 0;
  for (const entry of index) {
    if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || entry.key.length === 0
      || entry.key.length > 256 || !Number.isSafeInteger(entry.length) || entry.length < 0
      || (entry.once !== undefined && entry.once !== true) || keys.has(entry.key)) return null;
    if (sections.length) {
      if (!context.startsWith("\n\n", offset)) return null;
      offset += 2;
    }
    if (offset + entry.length > context.length) return null;
    keys.add(entry.key);
    sections.push({ key: entry.key, text: context.slice(offset, offset + entry.length), once: entry.once === true });
    offset += entry.length;
  }
  return offset === context.length ? sections : null;
}

class PromptBlockLedger {
  #sessions = new Map();

  constructor({ store = null, scope = "" } = {}) {
    this.store = store;
    this.scope = scope;
  }

  #key(sessionId) { return JSON.stringify([this.scope, sessionId]); }

  #state(sessionId) {
    if (this.#sessions.has(sessionId)) return this.#sessions.get(sessionId);
    const stored = this.store?.get(this.#key(sessionId)) ?? null;
    if (stored) this.#sessions.set(sessionId, stored);
    return stored;
  }

  #save(sessionId, state) {
    this.#sessions.set(sessionId, state);
    this.store?.set(this.#key(sessionId), state);
  }

  plan(sessionId, blocks, { once = [] } = {}) {
    const state = this.#state(sessionId);
    const turn = state?.turn ?? 0;
    const send = {}, omitted = [], hashes = {};
    for (const [key, text] of Object.entries(blocks)) {
      if (!text) continue;
      hashes[key] = sha256(text);
      const sent = state?.blocks.get(key);
      if (!once.includes(key) && sent && sent.hash === hashes[key] && turn - sent.turn < PROMPT_BLOCK_REFRESH_TURNS) omitted.push(key);
      else send[key] = text;
    }
    // Context blocks delivered earlier that this sectioned turn no longer has.
    // A context sent whole still carries every block it contains.
    const sectioned = Object.keys(blocks).some(key => key.startsWith(SECTION_PREFIX));
    const removed = state && sectioned
      ? [...state.blocks.keys()].filter(key => key.startsWith(SECTION_PREFIX) && !hashes[key]) : [];
    let committed = false;
    return { send, omitted, removed, commit: () => {
      if (committed) return;
      committed = true;
      const current = this.#state(sessionId) ?? { turn: 0, blocks: new Map() };
      const next = { turn: current.turn + 1, blocks: new Map(current.blocks) };
      for (const key of Object.keys(send)) if (!once.includes(key)) next.blocks.set(key, { hash: hashes[key], turn: current.turn });
      for (const key of removed) next.blocks.delete(key);
      this.#save(sessionId, next);
    } };
  }

  // Hash of a block this session recorded, for state kept outside plan().
  deliveredHash(sessionId, key) { return this.#state(sessionId)?.blocks.get(key)?.hash ?? null; }

  record(sessionId, key, text) {
    const current = this.#state(sessionId) ?? { turn: 0, blocks: new Map() };
    const next = { turn: current.turn, blocks: new Map(current.blocks) };
    next.blocks.set(key, { hash: sha256(text), turn: current.turn });
    this.#save(sessionId, next);
  }

  // keep: keys that survive the reset (Codex compaction keeps developer items).
  reset(sessionId, { keep = [] } = {}) {
    const state = this.#state(sessionId);
    const kept = state ? [...state.blocks].filter(([key]) => keep.includes(key)) : [];
    if (kept.length) { this.#save(sessionId, { turn: state.turn, blocks: new Map(kept) }); return; }
    this.#sessions.delete(sessionId);
    this.store?.delete(this.#key(sessionId));
  }
}

function unchangedBlocksNotice(keys) {
  return keys.length === 0 ? "" : `SHOGGOTH CONTEXT UNCHANGED\nThe latest ${keys.map(blockLabel).join(", ")}`
    + " sent earlier in this conversation are unchanged; keep using them.";
}

function removedBlocksNotice(keys) {
  const stateful = keys.filter(key => STATEFUL_SECTIONS.has(key.slice(SECTION_PREFIX.length)));
  return stateful.length === 0 ? "" : `SHOGGOTH CONTEXT REMOVED\nThe ${stateful.map(blockLabel).join(", ")}`
    + " sent earlier in this conversation no longer apply; none is available now.";
}

// The parts of one turn's prompt after the ledger decided what to repeat.
// context is the user-authority data; notices travel with the rules.
function promptBlockPlan(ledger, sessionId, { stable = "", rules = "", context = "", contextIndex = null }) {
  const sections = contextSections(context, contextIndex);
  const entries = { stable, rules, ...(sections
    ? Object.fromEntries(sections.map(section => [SECTION_PREFIX + section.key, section.text])) : { context }) };
  const once = sections ? sections.filter(section => section.once).map(section => SECTION_PREFIX + section.key) : [];
  const plan = ledger ? ledger.plan(sessionId, entries, { once })
    : { send: entries, omitted: [], removed: [], commit() {} };
  return {
    stable: plan.send.stable || "",
    rules: plan.send.rules || "",
    context: sections ? sections.map(section => plan.send[SECTION_PREFIX + section.key]).filter(Boolean).join("\n\n")
      : plan.send.context || "",
    notices: [removedBlocksNotice(plan.removed), unchangedBlocksNotice(plan.omitted)].filter(Boolean),
    commit: plan.commit,
  };
}

// Ordered prompt blocks for one turn. Without a ledger every block is sent.
function promptBlocks(ledger, sessionId, { stable = "", rules = "", context = "", contextIndex = null, run = "" }) {
  const plan = promptBlockPlan(ledger, sessionId, { stable, rules, context, contextIndex });
  const blocks = [plan.stable, plan.rules, plan.context, ...plan.notices, run];
  return { blocks: blocks.filter(Boolean), commit: plan.commit };
}

module.exports = { instructionDelivery, systemInstructions, turnInstructions, turnInstructionFingerprint, historyInstructions, DELIVERY,
  RUN_ID_PREFIX, runIdInstruction, splitTurnInstructions, PROMPT_BLOCK_REFRESH_TURNS, PromptBlockLedger, promptBlocks,
  promptBlockPlan, unchangedBlocksNotice, removedBlocksNotice, contextIndexFor, contextSections };
