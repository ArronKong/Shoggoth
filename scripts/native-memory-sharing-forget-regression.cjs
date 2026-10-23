"use strict";
// Real isolated Product runs; no production Service, memories or provider keys.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

const FACT = "The telescope borrowed fact is jade calibration.";
const OTHER = "The telescope independent second fact is an amber lens.";
const SOURCE = "memory/2026-10-09.md";
const OTHER_SOURCE = "memory/2026-10-10.md";
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sfg-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const workspace = path.join(root, "w"); fs.mkdirSync(workspace, { mode: 0o700 });
  const service = createAgentService({ paths, prewarmMcpAuth: false, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const A = DEFAULT_AGENT_PROFILE_ID, B = "source-b", owner = service.memoryEngine;
  const base = service.productStore.getAgentProfile(A), profile = Object.fromEntries(PROFILE_FIELDS.map(key => [key, base[key]]));
  Object.assign(profile, { id: B, agentId: B, name: B, runtimeProfileId: B, isDefault: false });
  service.productStore.putAgentProfile(profile); service.agentDefinitionStore.ensureProfile({ profileId: B });
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  owner.complete = async () => assert.fail("Shared search must never start a source chat model");
  const session = service.chatSessionStore.createSession({ profileId: A, workspace, operationId: "forget-session", createdAt: Date.now() });
  service.chatSessionStore.requestBinding(session.sessionKey, "forget-binding", Date.now());
  service.chatSessionStore.completeBinding(session.sessionKey, "forget-binding", "forget-native");
  let sequence = 0;
  const run = () => {
    const id = `forget-run-${++sequence}`;
    const value = service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey, idempotencyKey: id, workspace });
    service.workDispatcher.admit(value.id); service.workDispatcher.transition(value.id, "running");
    return service.workDispatcher.getRun(value.id);
  };
  const finish = value => { service.workDispatcher.transition(value.id, "completed"); owner.sharing.endRun(value); };
  const input = value => ({ profileId: A, run: value, workspace, maxSensitivity: "private", query: "telescope", minScore: 0, maxResults: 20, lexicalOnly: true });
  const write = (relative, text) => {
    const target = path.join(owner.store.workspace(B), relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, text, { mode: 0o600 });
    return target;
  };
  return { A, B, owner, run, finish, input, write };
}

for (const [name, changed] of [
  ["append another fact", `${FACT}\nA second unrelated observation.\n`],
  ["wrap the same sentence", `${FACT.replace(" is ", "\nis ")}\n`],
  ["add content on the same line", `${FACT} A second unrelated observation.\n`],
  ["add common headings", `# Daily notes\n\n${FACT}\n\n## Other observations\nA second unrelated observation.\n`],
]) {
  test(`borrowed forget still hides the original fact after source edits: ${name}`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const target = f.write(SOURCE, `${FACT}\n`), initial = fs.readFileSync(target);
    const first = f.run(), found = await f.owner.searchMemory(f.input(first));
    const borrowed = found.results.find(result => result.borrowed && result.ownerProfileId === f.B && result.snippet.includes(FACT));
    assert.ok(borrowed, "the real source must be borrowable before forget");
    const forgotten = await f.owner.sharing.forget({ ...f.input(first), id: borrowed.sourceRef,
      expectedRevision: f.owner.store.getRevision(f.A) }, "forget-borrowed-operation");
    assert.equal(forgotten.suppressed, true);
    assert.deepEqual(fs.readFileSync(target), initial, "reader forget never changes source bytes");
    f.finish(first);
    const unchanged = f.run();
    assert.equal((await f.owner.searchMemory(f.input(unchanged))).results.some(result => result.ownerProfileId === f.B), false);
    f.finish(unchanged);
    const rows = f.owner.database.db.prepare("SELECT * FROM memory_borrowed_suppressions WHERE profile_id=?").all(f.A);
    assert.ok(rows.length > 0, "reader persists an explicit suppression receipt");
    assert.doesNotMatch(JSON.stringify(rows), /telescope|jade calibration/u, "suppression rows contain only hashes and metadata");
    assert.ok(rows.every(row => /^[a-f0-9]{64}$/u.test(row.source_hash)), "stored source fingerprints are hashes");
    const contentRows = f.owner.database.db.prepare("SELECT * FROM memory_borrowed_content_suppressions WHERE profile_id=?").all(f.A);
    assert.ok(contentRows.length > 0, "the stable normalized-content fingerprint is persisted without its body");
    assert.doesNotMatch(JSON.stringify(contentRows), /telescope|jade calibration/u);
    assert.ok(contentRows.every(row => /^[a-f0-9]{64}$/u.test(row.content_hash)
      && Number.isSafeInteger(row.text_length) && row.text_length > 0), "substring matching stores only normalized hashes and lengths");
    f.write(SOURCE, changed);
    f.write(OTHER_SOURCE, `# Daily notes\n\n${OTHER}\n`);
    const after = fs.readFileSync(target), later = f.run(), current = await f.owner.searchMemory(f.input(later));
    assert.equal(current.results.some(result => result.ownerProfileId === f.B && result.canonicalRelativePath === SOURCE), false,
      "edited source must not resurrect the forgotten fact, even within a longer chunk");
    assert.ok(current.results.some(result => result.ownerProfileId === f.B && result.canonicalRelativePath === OTHER_SOURCE && result.snippet.includes(OTHER)),
      "common headings do not suppress an independent fact in another source");
    assert.deepEqual(fs.readFileSync(target), after, "rechecking suppression does not rewrite source bytes");
    f.finish(later);
  });
}
