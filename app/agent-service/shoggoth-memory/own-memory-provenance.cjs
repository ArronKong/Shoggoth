"use strict";

const crypto = require("node:crypto");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_REFS = 128;
const MAX_REF_BYTES = 12 * 1024;
const OUTPUT = new Set(["assistant", "tool_call", "tool_result", "artifact"]);
const hashContent = text => crypto.createHash("sha256")
  .update(text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase()).digest("hex");

// This evidence can only restrict recall. It never authorizes reading a fact,
// copying a borrowed body, or restoring a revoked item. No text is retained.
function ownMemoryProof(event, profileId) {
  const proof = event?.content?.ownMemoryProvenance;
  if (!proof || proof.version !== 1 || proof.profileId !== profileId || proof.runId !== event.runId
    || !ID.test(proof.profileId) || !ID.test(proof.runId) || typeof proof.complete !== "boolean"
    || !Array.isArray(proof.refs) || proof.refs.length > MAX_REFS
    || proof.refs.some(ref => !ref || typeof ref.id !== "string" || !ID.test(ref.id) || !HASH.test(ref.hash))
    || Buffer.byteLength(JSON.stringify(proof.refs)) > MAX_REF_BYTES) return null;
  return proof;
}

class OwnMemoryProvenance {
  constructor(owner) { this.owner = owner; this.runs = new Map(); }
  state(input) {
    const profileId = input.profileId || input.profile?.id, runId = input.run?.id;
    if (!ID.test(profileId || "") || !ID.test(runId || "")) return null;
    let state = this.runs.get(runId);
    if (state && state.profileId !== profileId) throw new Error("Memory provenance Run owner changed");
    if (!state) {
      state = { profileId, runId, initialized: false, complete: true, refs: new Map(), refBytes: 2 };
      this.runs.set(runId, state);
    }
    return state;
  }
  add(state, refs) {
    for (const ref of refs) {
      const key = `${ref.id}:${ref.hash}`;
      if (state.refs.has(key)) continue;
      const bytes = Buffer.byteLength(JSON.stringify({ id: ref.id, hash: ref.hash })) + 1;
      if (state.refs.size >= MAX_REFS || state.refBytes + bytes > MAX_REF_BYTES) { state.complete = false; break; }
      state.refs.set(key, { id: ref.id, hash: ref.hash });
      state.refBytes += bytes;
    }
  }
  inherit(state, events) {
    for (const event of events) {
      if (!OUTPUT.has(event.kind) || event.contextExcluded) continue;
      const proof = ownMemoryProof(event, state.profileId);
      if (!proof) { state.complete = false; continue; }
      state.complete &&= proof.complete;
      this.add(state, proof.refs);
    }
  }
  begin(input, items = [], events = [], unattributedContext = false) {
    const state = this.state(input); if (!state) return;
    state.initialized = true; state.complete &&= !unattributedContext;
    this.add(state, items.map(item => ({ id: item.id, hash: hashContent(item.content) })));
    this.inherit(state, events);
  }
  read(input, { items = [], results = [] } = {}) {
    const state = this.state(input); if (!state) return;
    const profileId = state.profileId;
    this.add(state, items.filter(item => item.profileId === profileId)
      .map(item => ({ id: item.id, hash: hashContent(item.content) })));
    let active;
    for (const result of results) {
      if (result.borrowed === true) continue;
      if (result.source === "sessions") {
        const host = this.owner.host(profileId), sessionId = host.searchIndex.sessionIdForPath(result.path);
        const events = this.owner.transcriptStore.listEvents(profileId, sessionId)
          .filter(event => event.seq >= (result.startLine ?? 1) && event.seq <= (result.endLine ?? Infinity)
            && this.owner.recallPolicy.isEventVisible(profileId, event));
        this.inherit(state, events);
      } else {
        active ??= this.owner.store.list(profileId, { status: "active" });
        const overlaps = active.filter(item => item.memoryPath === result.path
          && item.startLine <= (result.endLine ?? Infinity) && item.endLine >= (result.startLine ?? 1));
        if (!overlaps.length) state.complete = false;
        this.add(state, overlaps.map(item => ({ id: item.id, hash: hashContent(item.content) })));
      }
    }
  }
  projection(run) {
    const state = this.runs.get(run?.id);
    if (!state || state.profileId !== run.profileId) return null;
    return { version: 1, profileId: state.profileId, runId: state.runId,
      complete: state.initialized && state.complete, refs: [...state.refs.values()] };
  }
  end(run) { this.runs.delete(run?.id); }
  stopProfile(profileId) { for (const [key, state] of this.runs) if (state.profileId === profileId) this.runs.delete(key); }
  close() { this.runs.clear(); }
}

module.exports = { OwnMemoryProvenance, ownMemoryProof };
