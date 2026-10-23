"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readPrivateFile } = require("../private-file");
const { MemoryStore } = require("../memory-store");
const { MemoryEngine, hasSecret, memoryTrust } = require("../memory-engine");
const { sha256 } = require("./migration.cjs");
const { HistoricalMemoryAnnotations } = require("../historical-memory-annotations");
const { MemoryCandidateStore } = require("../memory-candidate-store");

// Legacy algorithms are used only to verify legacy receipts during migration.
// The reader refuses writes and never rebuilds legacy generated views.
class LegacyMemoryReader {
  constructor({ paths, recallPolicy, candidateStore, getRecall, now = Date.now }) {
    this.paths = paths; this.policy = recallPolicy; this.getRecall = getRecall; this.now = now;
    this.store = new MemoryStore({ paths, readOnly: true });
    this.history = new HistoricalMemoryAnnotations({ memoryStore: this.store, recallPolicy, now });
    this.verifier = new MemoryEngine({ store: this.store, recallPolicy, now,
      reviewReceiptStore: candidateStore instanceof MemoryCandidateStore ? new MemoryCandidateStore({ paths, now, readOnly: true }) : candidateStore });
    this.verifier.setReviewSourceVerifier((profileId, candidate) => {
      const recall = this.getRecall(), source = candidate.source;
      const session = recall.sessions.listSessions().find(item => item.id === source.sessionId && item.profileId === profileId);
      if (!session || session.workspace !== source.workspace) return false;
      const page = recall.scanEligibleSession({ profileId, sessionId: source.sessionId,
        afterSeq: source.seq - 1, limit: 1, completedOnly: true });
      const event = page.events.find(item => item.kind === "user" && item.eventId === source.eventId
        && item.runId === source.runId && item.seq === source.seq && item.contentHash === source.contentHash);
      if (!event) return false;
      const quote = event.text.slice(source.quoteStart, source.quoteStart + source.quoteLength);
      return quote.length === source.quoteLength && sha256(quote) === source.quoteHash
        && !this.history.view(profileId).forEvent({ kind: "user", id: event.eventId, runId: event.runId });
    });
  }
  open() { this.store.open(); }
  close() { this.store.close(); }
  read(profileId) {
    const previous = this.policy.memoryStore;
    this.policy.memoryStore = this.store;
    try {
      this.policy.assertReady(profileId);
      const records = this.store.list(profileId);
      const dir = path.join(this.paths.agentsDir, profileId), files = [];
      const candidates = [
        ...["events.jsonl", "snapshot.json", "recall-policy.jsonl", "recall-policy.seal.json", "provenance.jsonl", "candidate-review.json"]
          .map(name => ({ name, path: path.join(dir, "memory", name) })),
        { name: "recall-policy-installed.json", path: path.join(dir, "recall-policy-installed.json") },
        { name: "recall-policy-installation.json", path: path.join(this.paths.agentsDir, ".recall-policy-installations", `${profileId}.json`) },
      ];
      for (const file of candidates) if (fs.existsSync(file.path)) files.push(file);
      return { records, files, revision: this.store.getRevision(profileId), recallRevision: this.policy.getRevision(profileId),
        historicalSourceItems: this.store.listHistoricalSourceItems(profileId),
        contentRevisions: Object.fromEntries(records.map(item => [item.id, this.store.getContentRevision(profileId, item.id)])),
        visibleIds: records.filter(item => item.status === "active" && !hasSecret(item.content) && memoryTrust(item) !== "untrusted"
          && this.policy.isMemoryVisible(profileId, item) && this.verifier.isReviewCommitted(profileId, item)).map(item => item.id) };
    } finally { this.policy.memoryStore = previous; }
  }
  assertCurrent(profileId, snapshot, files) {
    if (this.store.getRevision(profileId) !== snapshot.revision || this.policy.getRevision(profileId) !== snapshot.recallRevision) throw new Error("Legacy memory changed during migration");
    for (const file of files) {
      if (sha256(readPrivateFile(file.source, { maxBytes: 512 * 1024 * 1024 })) !== file.sha256) throw new Error("Legacy memory file changed during migration");
    }
  }
}

module.exports = { LegacyMemoryReader };
