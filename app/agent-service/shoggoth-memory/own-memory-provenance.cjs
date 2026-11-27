"use strict";

const crypto = require("node:crypto");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_REFS = 128;
const MAX_REF_BYTES = 12 * 1024;
const OUTPUT = new Set(["assistant", "tool_call", "tool_result", "artifact"]);
const hashContent = text => crypto.createHash("sha256")
  .update(text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase()).digest("hex");

const validTime = value => Number.isSafeInteger(value) && value >= 0;

// This evidence can only restrict recall. It never authorizes reading a fact,
// copying a borrowed body, or restoring a revoked item. No text is retained.
// Optional unattributedThrough bounds an incomplete proof: every unattributed
// input was itself an output produced no later than that time.
function ownMemoryProof(event, profileId) {
  const proof = event?.content?.ownMemoryProvenance;
  if (!proof || proof.version !== 1 || proof.profileId !== profileId || proof.runId !== event.runId
    || !ID.test(proof.profileId) || !ID.test(proof.runId) || typeof proof.complete !== "boolean"
    || !Array.isArray(proof.refs) || proof.refs.length > MAX_REFS
    || proof.refs.some(ref => !ref || typeof ref.id !== "string" || !ID.test(ref.id) || !HASH.test(ref.hash))
    || Buffer.byteLength(JSON.stringify(proof.refs)) > MAX_REF_BYTES
    || (proof.unattributedThrough !== undefined && (proof.complete || !validTime(proof.unattributedThrough)))) return null;
  return proof;
}

// Latest time an output's unattributed dependencies could have existed. An
// output cannot depend on a fact created after it was written; a valid
// inherited bound can only tighten that. null means unbounded.
function unattributedHorizon(event, proof) {
  const own = validTime(event?.occurredAt) ? event.occurredAt : null;
  const inherited = proof && !proof.complete && validTime(proof.unattributedThrough) ? proof.unattributedThrough : null;
  if (own === null) return inherited;
  return inherited === null ? own : Math.min(own, inherited);
}

class OwnMemoryProvenance {
  constructor(owner) { this.owner = owner; this.runs = new Map(); }
  state(input) {
    const profileId = input.profileId || input.profile?.id, runId = input.run?.id;
    if (!ID.test(profileId || "") || !ID.test(runId || "")) return null;
    let state = this.runs.get(runId);
    if (state && state.profileId !== profileId) throw new Error("Memory provenance Run owner changed");
    if (!state) {
      state = { profileId, runId, initialized: false, complete: true, refs: new Map(), refBytes: 2,
        unattributedThrough: -Infinity, unbounded: false };
      this.runs.set(runId, state);
    }
    return state;
  }
  // Dropped refs or unlisted context may come from any fact existing now.
  unattributed(state) { state.complete = false; state.unbounded = true; }
  add(state, refs) {
    for (const ref of refs) {
      const key = `${ref.id}:${ref.hash}`;
      if (state.refs.has(key)) continue;
      const bytes = Buffer.byteLength(JSON.stringify({ id: ref.id, hash: ref.hash })) + 1;
      if (state.refs.size >= MAX_REFS || state.refBytes + bytes > MAX_REF_BYTES) { this.unattributed(state); break; }
      state.refs.set(key, { id: ref.id, hash: ref.hash });
      state.refBytes += bytes;
    }
  }
  inherit(state, events) {
    for (const event of events) {
      if (!OUTPUT.has(event.kind) || event.contextExcluded) continue;
      const proof = ownMemoryProof(event, state.profileId);
      if (proof) this.add(state, proof.refs);
      if (proof?.complete) continue;
      // An inherited output carries only what could exist when it was written.
      const horizon = unattributedHorizon(event, proof);
      if (horizon === null) this.unattributed(state);
      else { state.complete = false; state.unattributedThrough = Math.max(state.unattributedThrough, horizon); }
    }
  }
  begin(input, items = [], events = [], unattributedContext = false) {
    const state = this.state(input); if (!state) return;
    state.initialized = true;
    if (unattributedContext) this.unattributed(state);
    this.add(state, items.map(item => ({ id: item.id, hash: hashContent(item.content) })));
    this.inherit(state, events);
  }
  read(input, { items = [], results = [] } = {}) {
    const state = this.state(input); if (!state) return;
    const profileId = state.profileId;
    this.add(state, items.filter(item => item.profileId === profileId)
      .map(item => ({ id: item.id, hash: hashContent(item.content) })));
    const byPath = new Map();
    for (const result of results) {
      if (result.borrowed === true) continue;
      if (result.source === "sessions") {
        const host = this.owner.host(profileId), sessionId = host.searchIndex.sessionIdForPath(result.path);
        const events = this.owner.transcriptStore.listEvents(profileId, sessionId)
          .filter(event => event.seq >= (result.startLine ?? 1) && event.seq <= (result.endLine ?? Infinity)
            && this.owner.recallPolicy.isEventVisible(profileId, event));
        this.inherit(state, events);
      } else {
        if (!byPath.has(result.path)) byPath.set(result.path, this.owner.activeFileEntries(profileId, result.path));
        const overlaps = byPath.get(result.path).filter(item => item.startLine <= (result.endLine ?? Infinity)
          && item.endLine >= (result.startLine ?? 1));
        if (!overlaps.length) this.unattributed(state);
        this.add(state, overlaps.map(item => ({ id: item.id, hash: hashContent(item.content) })));
      }
    }
  }
  projection(run) {
    const state = this.runs.get(run?.id);
    if (!state || state.profileId !== run.profileId) return null;
    const complete = state.initialized && state.complete;
    const proof = { version: 1, profileId: state.profileId, runId: state.runId, complete, refs: [...state.refs.values()] };
    if (!complete && state.initialized && !state.unbounded && Number.isFinite(state.unattributedThrough)) {
      proof.unattributedThrough = state.unattributedThrough;
    }
    return proof;
  }
  end(run) { this.runs.delete(run?.id); }
  stopProfile(profileId) { for (const [key, state] of this.runs) if (state.profileId === profileId) this.runs.delete(key); }
  close() { this.runs.clear(); }
}

module.exports = { OwnMemoryProvenance, ownMemoryProof, unattributedHorizon };
