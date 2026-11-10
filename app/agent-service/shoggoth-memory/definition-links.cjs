"use strict";

const { serviceError } = require("../security");
const { factWasPresent, hashLine, normalizeRule: normalize } = require("../agent-definition-provenance");
// A correction often appends a separate retirement clause after a comma
// ("new code ..., 旧短语 ... 已作废"). Keep it separate from the new fact.
const clauses = text => text.split(/[。；;.!?！？\n]|[，,]\s*(?=(?:旧|原先|此前|the old\b|old\b|previous\b))/iu)
  .map(normalize).filter(value => value.length >= 8);
const matchesFact = (line, facts) => facts.some(fact => normalize(line).includes(fact));

// Keep source-to-revision receipts independently of the bounded MCP replay
// cache. Current rules and compact provenance survive bounded file backups.
class MemoryDefinitionLinks {
  constructor(owner, products) { this.owner = owner; this.products = products; }
  store(profileId) {
    return this.owner.host(profileId).database.openKeyedStore({ namespace: "memory-definition-links",
      maxEntries: 50_000, overflowPolicy: "reject-new" });
  }
  async prepare(profileId, args, call) {
    if (args.kind !== "AGENTS") return;
    await this.store(profileId).registerIfAbsent(call.operationId, {
      revision: args.expectedRevision + 1, resultHash: call.binding.resultHash,
      eventId: call.binding.source.eventId,
    });
  }
  async links(profileId) {
    const store = this.store(profileId), definitions = this.owner.definitionStore;
    // Older releases already retained the exact source binding and a verified
    // revision hash in their MCP receipts. Adopt those without rewriting files.
    for (const call of this.products?.listMcpToolCalls({ profileId, name: "agent_definition_update" }) || []) {
      const result = call.result?.ok && call.result.result;
      if (result?.saved !== true || result.file !== "AGENTS.md" || !call.binding?.source?.eventId) continue;
      const value = definitions.readReceipt?.(profileId, result.revision)
        || definitions.readRevision(profileId, result.revision);
      if (value?.manifest.reason !== `conversation-definition:${call.operationId}`
        || value.manifest.documents.AGENTS.contentHash !== call.binding.resultHash) continue;
      await store.registerIfAbsent(call.operationId, { revision: result.revision,
        resultHash: call.binding.resultHash, eventId: call.binding.source.eventId });
    }
    return store.entries();
  }
  async retract(profileId, items, { assertCurrent } = {}) {
    const definitions = this.owner.definitionStore;
    if (!definitions) return;
    const links = await this.links(profileId);
    assertCurrent?.();
    if (!links.length) return;
    const current = definitions.get(profileId), original = current.documents.AGENTS;
    const births = definitions.ruleProvenance?.(profileId);
    let content = original, review = false;
    for (const { key, value: link } of links) {
      let facts = items.filter(item => item.sourceRefs.includes(link.eventId)).flatMap(item => clauses(item.content));
      if (!facts.length || link.revision < 2) continue;
      if (births) {
        const receipt = definitions.readReceipt(profileId, link.revision);
        if (receipt?.manifest.reason !== `conversation-definition:${key}`
          || receipt.manifest.documents.AGENTS.contentHash !== link.resultHash) continue;
        let missing = false;
        const reintroduced = new Set();
        for (const rule of receipt.rules) {
          const lines = content.split("\n"), matching = lines.filter(line => hashLine(line) === rule.hash);
          if (matching.length !== 1) { missing = true; continue; }
          const line = matching[0];
          if (births[rule.hash] !== link.revision) { reintroduced.add(line); continue; }
          const owned = facts.filter(fact => normalize(line).includes(fact)
            && !factWasPresent(line, fact, rule.priorCoverage));
          review ||= facts.some(fact => factWasPresent(line, fact, rule.priorCoverage));
          if (!owned.length) continue;
          const parts = line.match(/[^。；;.!?！？]+(?:[。；;.!?！？]+|$)/gu) || [line];
          const retained = parts.filter(part => !matchesFact(part, owned)).join("");
          content = lines.flatMap(value => value !== line ? [value] : retained.trim() ? [retained] : []).join("\n");
        }
        // An edited copy needs review; an exact line removed and later added
        // again belongs to the later user decision, not this old source.
        review ||= missing && content.split("\n").some(line => !reintroduced.has(line) && matchesFact(line, facts));
        continue;
      }
      const applied = definitions.readRevision(profileId, link.revision);
      if (applied?.manifest.reason !== `conversation-definition:${key}`
        || applied.manifest.documents.AGENTS.contentHash !== link.resultHash) continue;
      const before = definitions.readRevision(profileId, link.revision - 1);
      if (!before) continue;
      // Appending to an old line does not acquire ownership of its existing
      // facts. Those need an explicit definition edit, not automatic removal.
      const existing = facts.filter(fact => normalize(before.documents.AGENTS).includes(fact));
      review ||= matchesFact(content, existing);
      facts = facts.filter(fact => !existing.includes(fact));
      if (!facts.length) continue;
      const oldLines = new Set(before.documents.AGENTS.split("\n"));
      const added = applied.documents.AGENTS.split("\n").filter(line => line.trim()
        && !oldLines.has(line) && matchesFact(line, facts));
      for (const line of added) {
        const lines = content.split("\n"), occurrences = lines.filter(value => value === line).length;
        if (occurrences !== 1) {
          review ||= lines.some(value => matchesFact(value, facts));
          continue;
        }
        // A later removal/re-addition is a new user decision, not this source's
        // still-live copy. Never undo it from an earlier memory receipt.
        let continuous = true;
        for (let revision = link.revision + 1; revision <= current.manifest.revision; revision++) {
          if (!definitions.readRevision(profileId, revision)?.documents.AGENTS.split("\n").includes(line)) { continuous = false; break; }
        }
        if (continuous) {
          const parts = line.match(/[^。；;.!?！？]+(?:[。；;.!?！？]+|$)/gu) || [line];
          const retained = parts.filter(part => !matchesFact(part, facts)).join("");
          content = lines.flatMap(value => value !== line ? [value] : retained.trim() ? [retained] : []).join("\n");
        }
      }
    }
    if (content !== original) {
      assertCurrent?.();
      try {
        definitions.update({ profileId, expectedRevision: current.manifest.revision,
          actor: "user", documents: { AGENTS: content }, reason: "memory-forget:linked-definition" });
      } catch (cause) {
        const error = serviceError("MEMORY_DEFINITION_COMMIT_UNCERTAIN", "记忆已撤回，关联设定提交结果待恢复");
        error.cause = cause; throw error;
      }
    }
    if (review) throw serviceError("MEMORY_DEFINITION_REVIEW_REQUIRED", "记忆已撤回，关联设定有后续修改，需要核对");
  }
}

module.exports = { MemoryDefinitionLinks };
