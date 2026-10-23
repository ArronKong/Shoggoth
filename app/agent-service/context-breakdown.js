"use strict";

// Per-reply context composition, in the spirit of OpenClaw's /context. The
// compiler records Shoggoth's own token estimate of each part in the immutable
// snapshot. The chat UI reads one reply on demand and subtracts these parts from
// the Runtime-reported occupancy to show the CLI's share as an approximation.
const { estimateContextTokens } = require("./conversation-context-budget");
const { attachmentTokens } = require("./context-request-budget");
const { validComposition, COMPOSITION_FIELDS } = require("./product-context-protocol");

const COMPOSITION_VERSION = 1;

const blockTokens = (blocks, kinds) => blocks.filter(block => kinds.includes(block.kind))
  .reduce((total, block) => total + (Number.isSafeInteger(block.estimatedTokens) ? block.estimatedTokens : 0), 0);

// `definitionText` is the exact AGENTS/IDENTITY/SOUL text inside the stable
// instructions. Selected Skill bodies are `skill` blocks inside the turn text.
// History counts only when Shoggoth sends it; a resumed native session keeps
// its own history, which then belongs to the Runtime's remainder. Only
// "resident" Runtimes are known to load every listed tool definition.
function measureComposition({ stableInstructions, turnInstructions, definitionText, tools, toolExposure, blocks,
  historyDelivered, prompt = "", attachments = [] }) {
  const definitionTokens = estimateContextTokens(definitionText);
  const skillBodyTokens = blockTokens(blocks, ["skill"]);
  return {
    version: COMPOSITION_VERSION,
    historyDelivered,
    toolExposure,
    rulesTokens: Math.max(0, estimateContextTokens(stableInstructions) + estimateContextTokens(turnInstructions)
      - definitionTokens - skillBodyTokens),
    definitionTokens,
    toolTokens: estimateContextTokens(JSON.stringify(tools)),
    memoryTokens: blockTokens(blocks, ["user", "memory", "hook-data"]),
    skillTokens: skillBodyTokens + blockTokens(blocks, ["skill-catalog"]),
    historyTokens: historyDelivered ? blockTokens(blocks, ["transcript", "checkpoint", "handoff"]) : 0,
    messageTokens: estimateContextTokens(prompt) + attachmentTokens(attachments),
    toolCount: tools.length,
  };
}

// Snapshots written before this field existed, or with an unknown version,
// have no composition rather than a guessed one.
function compositionOf(snapshot) {
  const value = snapshot?.report?.composition;
  if (!value || typeof value !== "object" || value.version !== COMPOSITION_VERSION) return null;
  const { version: _version, ...composition } = value;
  return validComposition(composition) ? Object.freeze(Object.fromEntries(COMPOSITION_FIELDS
    .map(key => [key, composition[key]]))) : null;
}

// Snapshot ids are content hashes, so a parsed composition never changes. The
// file is read and verified at most once per Service process per snapshot.
class ContextBreakdownReader {
  constructor({ snapshotStore, limit = 256 }) {
    this.snapshotStore = snapshotStore;
    this.limit = limit;
    this.cache = new Map();
  }

  read(profileId, snapshotId) {
    const key = `${profileId}\n${snapshotId}`;
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, value);
      return value;
    }
    const value = compositionOf(this.snapshotStore.get(profileId, snapshotId));
    this.cache.set(key, value);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  forRun(run) {
    return { runId: run.id, snapshotId: run.contextSnapshotId ?? null,
      composition: run.contextSnapshotId ? this.read(run.profileId, run.contextSnapshotId) : null };
  }
}

module.exports = { COMPOSITION_VERSION, measureComposition, compositionOf, ContextBreakdownReader };
