"use strict";
// Actual Product Service and owner indexes with deliberately mixed report text.
// These legacy/inline fixtures have citations and no generated-evidence rows.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
async function fixture() {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
      plugins: { entries: { "active-memory": { config: { enabled: false } } } } } } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "report-range-source-b", profile = Object.fromEntries(FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(profile, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(profile); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine; owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  const source = await owner.propose({ profileId: B, content: "The telescope has a source-local blue calibration REPORT_ORIGIN_473810.",
    scope: "agent", classification: "explicit", sourceRefs: ["user-edit:report-range-source"] });
  const session = f.createSession(), run = await f.send(session.sessionKey, "report-range", "Find telescope reports");
  assert.equal(run.status, "running", run.errorCode);
  return { ...f, B, owner, source, session, run };
}
for (const scenario of [
  { name: "legacy Light phase report", relative: "memory/dreaming/light/2026-10-09.md", prefix: "## Light Sleep\n\n", suffix: "" },
  { name: "daily inline Light report", relative: "memory/2026-10-09.md", prefix: "<!-- openclaw:dreaming:light:start -->\n", suffix: "<!-- openclaw:dreaming:light:end -->\n" },
]) test(`${scenario.name} requires origin authority for every returned body paragraph`, { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const root = f.owner.store.workspace(f.B), target = path.join(root, scenario.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const current = f.owner.store.get(f.B, f.source.id), citation = `MEMORY.md#L${current.startLine}-L${current.endLine}`;
    const good = "LEGACY_VALID_REPORT_BODY_794321", bad = "UNPROVED_NEIGHBOR_REPORT_BODY_431827";
    const report = `${scenario.prefix}- telescope verified reflection ${good}. Source: ${citation}\n\n- telescope unproved neighboring reflection ${bad}.\n${scenario.suffix}`;
    fs.writeFileSync(target, report, { mode: 0o600 });
    const lines = report.split("\n"), startLine = lines.findIndex(line => line.includes(good)) + 1;
    const scope = { ownerProfileId: f.B, requesterProfileId: f.profile.id, workspace: f.workspace, maxSensitivity: "private" };
    const policy = f.owner.sharing.reader.policy;
    assert.equal(f.owner.store.reportEvidence(f.B, scenario.relative, 1, lines.length), null,
      "the regression exercises handwritten legacy text without generated evidence");
    assert.equal(policy.allowResult(scope, { path: scenario.relative, source: "memory", startLine, endLine: startLine, snippet: lines[startLine - 1] }), true,
      "the directly cited paragraph retains exact source authority");
    assert.equal(policy.allowResult(scope, { path: scenario.relative, source: "memory", startLine: 1, endLine: lines.length, snippet: report }), false,
      "one valid citation cannot authorize another paragraph in the same chunk");
    const badLine = lines.findIndex(line => line.includes(bad)) + 1;
    assert.equal(policy.allowResult(scope, { path: scenario.relative, source: "memory", startLine: badLine, endLine: badLine, snippet: lines[badLine - 1] }), false,
      "an exact unproved body line cannot inherit a nearby citation from its broad projection");
    const compact = report.replace("\n\n- telescope unproved", "\n- telescope unproved");
    fs.writeFileSync(target, compact, { mode: 0o600 });
    assert.equal(policy.allowResult(scope, { path: scenario.relative, source: "memory", startLine: 1, endLine: compact.split("\n").length, snippet: compact }), false,
      "adjacent list items do not share origin authority just because they have no blank separator");
    fs.writeFileSync(target, report, { mode: 0o600 });
    const input = { profileId: f.profile.id, workspace: f.workspace, sessionId: f.session.id, run: f.run,
      query: "telescope", ownerProfileId: f.B, maxSensitivity: "private", lexicalOnly: true, maxResults: 20, minScore: 0, record: false };
    const found = await f.owner.searchMemory(input);
    assert.equal(found.results.some(result => result.snippet.includes(bad)), false,
      "ordinary owner-index search never returns the unproved neighboring body");
    const triggers = await f.owner.sharing.search({ ...input, candidateMode: "trigger", triggerOptions: { query: input.query, maxResults: 20 } }, { results: [], items: [] });
    assert.equal(triggers.results.some(result => result.snippet.includes(bad)), false,
      "trigger candidates follow the same complete-body authorization");
    const evidence = f.owner.sharing.reader.evidence(scope, { path: scenario.relative, source: "memory", startLine, endLine: startLine });
    const access = f.owner.sharing.issue(input, evidence, f.owner.sharing.policy(input));
    const read = f.owner.sharing.get({ ...input, id: access.sourceRef });
    assert.match(read.text, new RegExp(good)); assert.doesNotMatch(read.text, new RegExp(bad));
    assert.throws(() => f.owner.sharing.get({ ...input, id: access.sourceRef, from: startLine, lines: 3 }), { code: "MEMORY_SHARED_REFERENCE_INVALID" },
      "the exact borrowed capability cannot expand into the next paragraph");
  } finally { await f.close(); }
});
