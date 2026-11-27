"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const hash = key => crypto.createHash("sha256").update(key).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;
const MAX_SESSIONS = 512;
const MAX_BLOCKS = 300;

// Which prompt blocks each native session already holds (PromptBlockLedger).
// Hashes and turn counters only, never content. Per-Run Hosts and a restarted
// Service share it; a lost file only means unchanged blocks are sent again.
class NativePromptLedgerStore {
  constructor({ paths }) {
    this.paths = paths;
    this.file = path.join(paths.cacheDir, "native-prompt-ledger-v1.json");
    this.sessions = new Map(); this.loaded = false;
  }
  #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain"
        || !lstatIfExists(this.file)) return;
      const data = JSON.parse(readPrivateFile(this.file, { maxBytes: 4 * 1024 * 1024 }));
      if (data?.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS) return;
      for (const item of data.sessions) {
        if (!item || !HASH.test(item.key) || !Number.isSafeInteger(item.turn) || item.turn < 0
          || !Array.isArray(item.blocks) || item.blocks.length > MAX_BLOCKS) continue;
        const blocks = new Map();
        for (const entry of item.blocks) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length > 512
            || !HASH.test(entry[1]?.hash) || !Number.isSafeInteger(entry[1]?.turn)) { blocks.clear(); break; }
          blocks.set(entry[0], { hash: entry[1].hash, turn: entry[1].turn });
        }
        if (blocks.size) this.sessions.set(item.key, { turn: item.turn, blocks });
      }
    } catch { this.sessions.clear(); }
  }
  // Called after a turn was accepted: a failed write must not fail that turn.
  // The file then keeps an older record of blocks that were really delivered.
  #write() {
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    try {
      atomicWritePrivateFile(this.file, `${JSON.stringify({ version: 1, sessions: [...this.sessions]
        .map(([key, state]) => ({ key, turn: state.turn, blocks: [...state.blocks] })) })}\n`,
      { trustedRoot: this.paths.trustedRoot });
    } catch {}
  }
  get(key) {
    this.#load();
    const state = this.sessions.get(hash(key));
    return state ? { turn: state.turn, blocks: new Map(state.blocks) } : null;
  }
  set(key, state) {
    this.#load();
    const id = hash(key);
    if (state.blocks.size > MAX_BLOCKS) return;
    this.sessions.delete(id);
    this.sessions.set(id, { turn: state.turn, blocks: new Map(state.blocks) });
    this.#write();
  }
  delete(key) {
    this.#load();
    if (this.sessions.delete(hash(key))) this.#write();
  }
}
module.exports = { NativePromptLedgerStore };
