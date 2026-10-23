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
// Repeat one only when this process has not delivered it to that session, its
// text changed, or PROMPT_BLOCK_REFRESH_TURNS turns passed: compaction inside
// the CLI is not observable and may have summarized it away. A plan is
// committed only after the Runtime accepted the turn, so a failed send repeats.
const PROMPT_BLOCK_REFRESH_TURNS = 8;
const BLOCK_LABELS = Object.freeze({ stable: "Shoggoth developer instructions", rules: "Shoggoth Run rules",
  context: "Shoggoth memory and Skill context" });
class PromptBlockLedger {
  #sessions = new Map();

  plan(sessionId, blocks) {
    const state = this.#sessions.get(sessionId);
    const turn = state?.turn ?? 0;
    const send = {}, omitted = [], hashes = {};
    for (const [key, text] of Object.entries(blocks)) {
      if (!text) continue;
      hashes[key] = crypto.createHash("sha256").update(text).digest("hex");
      const sent = state?.blocks.get(key);
      if (sent && sent.hash === hashes[key] && turn - sent.turn < PROMPT_BLOCK_REFRESH_TURNS) omitted.push(key);
      else send[key] = text;
    }
    let committed = false;
    return { send, omitted, commit: () => {
      if (committed) return;
      committed = true;
      const current = this.#sessions.get(sessionId) ?? { turn: 0, blocks: new Map() };
      for (const key of Object.keys(send)) current.blocks.set(key, { hash: hashes[key], turn: current.turn });
      current.turn += 1;
      this.#sessions.set(sessionId, current);
    } };
  }

  reset(sessionId) { this.#sessions.delete(sessionId); }
}

function unchangedBlocksNotice(keys) {
  return keys.length === 0 ? "" : `SHOGGOTH CONTEXT UNCHANGED\nThe latest ${keys.map(key => BLOCK_LABELS[key]).join(", ")}`
    + " sent earlier in this conversation are unchanged; keep using them.";
}

// Ordered prompt blocks for one turn. Without a ledger every block is sent.
function promptBlocks(ledger, sessionId, { stable = "", rules = "", context = "", run = "" }) {
  const plan = ledger ? ledger.plan(sessionId, { stable, rules, context })
    : { send: { stable, rules, context }, omitted: [], commit() {} };
  const blocks = [...["stable", "rules", "context"].map(key => plan.send[key]), unchangedBlocksNotice(plan.omitted), run];
  return { blocks: blocks.filter(Boolean), commit: plan.commit };
}

module.exports = { instructionDelivery, systemInstructions, turnInstructions, turnInstructionFingerprint, historyInstructions, DELIVERY,
  RUN_ID_PREFIX, runIdInstruction, splitTurnInstructions, PROMPT_BLOCK_REFRESH_TURNS, PromptBlockLedger, promptBlocks,
  unchangedBlocksNotice };
