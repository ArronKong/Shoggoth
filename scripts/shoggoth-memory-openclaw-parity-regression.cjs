"use strict";

// 2026-11-06 OpenClaw parity, Agent-side writes and native CLI memory:
// memory_save can add a fact without first reading a revision, and can keep a
// working note in today's daily note (OpenClaw "write it down"); Grok's own
// memory notes for a Shoggoth Agent are imported once at Agent trust.
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateMemoryMcpArguments } = require("../app/agent-service/memory-mcp-tools");
const { ConversationMemoryService } = require("../app/agent-service/conversation-memory-service");
const { importGrokMemory } = require("../app/agent-service/shoggoth-memory/grok-memory-import.cjs");
const { memoryTrust } = require("../app/agent-service/memory-engine");
const { A, fixture } = require("./fixtures/memory-repair-fixture.cjs");

function boundSession(f) {
  const session = f.session(), id = crypto.randomUUID();
  f.service.chatSessionStore.requestBinding(session.sessionKey, `binding-${id}`, f.now());
  f.service.chatSessionStore.completeBinding(session.sessionKey, `binding-${id}`, `runtime-${id}`);
  return f.service.chatSessionStore.getSession(session.sessionKey);
}

function runningTurn(f, session, text) {
  const { service } = f, id = crypto.randomUUID();
  service.workDispatcher.enqueue({ id, profileId: A, source: "chat", sourceId: session.sessionKey, idempotencyKey: id, workspace: f.workspace });
  service.workDispatcher.admit(id); service.workDispatcher.transition(id, "running");
  const event = service.transcriptStore.appendEvent({ profileId: A, sessionId: session.id, id: `user-${id}`, runId: id,
    kind: "user", content: { text }, occurredAt: f.now() });
  return { event, run: () => service.workDispatcher.getRun(id) };
}

const dailyNotes = f => {
  const directory = path.join(f.owner.store.workspace(A), "memory");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
    .map(name => ({ name, text: fs.readFileSync(path.join(directory, name), "utf8") })) : [];
};

test("memory_save adds without a revision read, but corrections still need one; daily placement is an Agent note", () => {
  const base = { source: "chat", sourceId: "s", content: "The repo uses pnpm", scope: "agent", classification: "observed" };
  assert.equal(validateMemoryMcpArguments("memory_save", base), true);
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, placement: "daily" }), true);
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, placement: "long-term", expectedRevision: 3 }), true);
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, supersedes: "old-id" }), false, "a correction reads the revision first");
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, supersedes: "old-id", expectedRevision: 3 }), true);
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, supersedes: null }), true);
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, placement: "daily", supersedes: "old-id", expectedRevision: 3 }), true,
    "a daily note can be atomically corrected");
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, placement: "daily", supersedes: null }), true);
  for (const scope of ["user", "project", "workspace"]) {
    assert.equal(validateMemoryMcpArguments("memory_save", { ...base, scope, classification: "explicit", sourceQuote: "pnpm", placement: "daily" }), false, scope);
  }
  assert.equal(validateMemoryMcpArguments("memory_save", { ...base, placement: "weekly" }), false);
});

test("an Agent keeps a working note in today's daily note and a durable fact in MEMORY.md, both without a revision", async (t) => {
  const f = await fixture(t);
  const memory = new ConversationMemoryService({ memoryEngine: f.owner, memoryStore: f.owner.store,
    transcriptStore: f.service.transcriptStore, chatSessionStore: f.service.chatSessionStore,
    memoryProvenanceService: f.service.memoryProvenanceService, getRunSessionKey: run => run.sourceId });
  const session = boundSession(f);
  const turn = runningTurn(f, session, "帮我把发布流程跑一遍。");
  const save = args => {
    const full = { source: "chat", sourceId: session.sessionKey, ...args };
    return memory.write("memory_save", A, full, { binding: memory.bind("memory_save", full, turn.run()), operationId: crypto.randomUUID() });
  };
  // The revision moved since the Agent last looked; an addition still lands.
  await f.owner.propose({ profileId: A, scope: "agent", type: "semantic", content: "Unrelated earlier note.",
    classification: "explicit", sourceRefs: [`user-edit:${crypto.randomUUID()}`] });
  const daily = await save({ content: "Release dry run: step 3 (tagging) still fails on the CI cache.", scope: "agent",
    classification: "observed", placement: "daily" });
  assert.equal(daily.saved, true);
  const notes = dailyNotes(f);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /step 3 \(tagging\) still fails/u);
  assert.doesNotMatch(fs.readFileSync(path.join(f.owner.store.workspace(A), "MEMORY.md"), "utf8"), /tagging/u);
  const durable = await save({ content: "Releases are tagged from the main branch only.", scope: "agent", classification: "observed" });
  assert.equal(durable.saved, true);
  assert.match(fs.readFileSync(path.join(f.owner.store.workspace(A), "MEMORY.md"), "utf8"), /tagged from the main branch/u);
  // A correction without the current revision is refused.
  const target = f.owner.store.list(A, { status: "active" }).find(item => item.content === "Releases are tagged from the main branch only.");
  await assert.rejects(save({ content: "Releases are tagged from release branches.", scope: "agent", classification: "observed",
    supersedes: target.id, expectedRevision: f.owner.store.getRevision(A) - 1 }), { code: "MEMORY_REVISION_CONFLICT" });
});

test("Grok's own notes for this Agent are imported once at Agent trust, searchable but not in the bootstrap", async (t) => {
  const f = await fixture(t);
  const grokHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gm-"));
  t.after(() => fs.rmSync(grokHome, { recursive: true, force: true }));
  const write = (relative, text) => {
    const target = path.join(grokHome, "memory-v2", "workspaces", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  };
  const created = Math.floor(f.now() / 1000) - 3 * 24 * 60 * 60;
  const note = (type, body) => `---\nschema_version: 2\ntype: ${type}\ncreated_at: ${created}\n---\n\n# ${body}\n`;
  write(`${A}-1a2b3c4d/observations/_inbox/s1__n000.md`, note("user", "User wants news briefs in Chinese with sources."));
  write(`${A}-1a2b3c4d/topics/deploy.md`, note("project", "Deploys go through the staging-polaris gate."));
  write(`${A}-1a2b3c4d/MEMORY.md`, "# Workspace memory index\n\nGenerated by Grok.\n");
  write(`${A}-1a2b3c4d/observations/_inbox/secret.md`, note("reference", "token sk-proj-abcdefghijklmnopqrstuvwxyz123456"));
  write(`other-project-9f8e7d6c/topics/x.md`, note("project", "Another project's note must stay out."));
  write(`${A}-notahash/topics/y.md`, note("project", "A lookalike directory must stay out."));

  assert.deepEqual(await importGrokMemory(f.owner, A, { grokHome }), { imported: 2, reason: "imported" });
  const imported = f.owner.store.list(A, { status: "active" }).filter(item => item.id.startsWith("grok-memory-"));
  assert.deepEqual(imported.map(item => item.content).sort(), [
    "Imported from Grok's own memory (project): Deploys go through the staging-polaris gate.",
    "Imported from Grok's own memory (user): User wants news briefs in Chinese with sources.",
  ]);
  for (const item of imported) {
    assert.equal(memoryTrust(item), "agent");
    assert.match(item.memoryPath, /^memory\/\d{4}-\d{2}-\d{2}\.md$/u);
  }
  const boot = f.owner.bootstrap({ profileId: A, workspace: f.workspace, mainSession: true, maxSensitivity: "private" });
  assert.doesNotMatch(JSON.stringify(boot), /staging-polaris|news briefs/u, "a past day's note is not part of the bootstrap");
  assert.doesNotMatch(dailyNotes(f).map(file => file.text).join("\n"), /sk-proj-|Another project|lookalike|Workspace memory index/u);
  // Once only, even if Grok later writes more.
  write(`${A}-1a2b3c4d/topics/later.md`, note("project", "Written after the import."));
  assert.deepEqual(await importGrokMemory(f.owner, A, { grokHome }), { imported: 0, reason: "done" });
});

// Deep promotion writes MEMORY.md, which also holds the entries Shoggoth
// saved (memory_save, the nightly review). The consolidation model may only
// add, merge a true duplicate or supersede its own lineage; a Shoggoth entry
// survives byte-for-byte whatever the model asks for.
const { DAY, FACT } = require("./fixtures/memory-repair-fixture.cjs");
const QUESTIONS = ["When is the amber telescope calibrated?", "How often is the amber telescope lens calibrated?",
  "What is calibrated every evening?", "Is the telescope calibrated daily?", "Which lens gets calibrated in the evening?"];
const KEPT = "Releases are tagged from the main branch only.";

async function promoteWith(t, plan) {
  const f = await fixture(t);
  await f.dailyNote(`- ${FACT}`);
  const kept = await f.owner.propose({ profileId: A, scope: "agent", type: "semantic", content: KEPT,
    classification: "explicit", sourceRefs: [`user-edit:${crypto.randomUUID()}`] });
  const before = f.owner.store.readFile(A, "MEMORY.md"), start = before.indexOf(`<!-- shoggoth-memory-entry:${kept.id} -->`);
  const end = before.indexOf("<!-- /shoggoth-memory-entry -->", start) + "<!-- /shoggoth-memory-entry -->".length;
  const block = before.slice(start, end);
  assert.match(block, /Releases are tagged/u);
  for (const question of QUESTIONS) {
    const input = f.turn(question);
    await f.search("amber telescope calibrated", input, { minScore: 0 });
    await f.finish(input); f.advance(DAY);
  }
  let consolidations = 0;
  f.model = async ({ prompt }) => {
    const at = prompt.indexOf("{\"currentMemory\"");
    if (at < 0) return { text: "NONE" };
    consolidations++;
    const request = JSON.parse(prompt.slice(at));
    return { text: JSON.stringify({ operations: request.candidates.map(candidate => plan(candidate, `- ${KEPT}`)) }) };
  };
  assert.equal((await f.owner.dream(A)).handled, true);
  return { f, kept, block, consolidations, memory: f.owner.store.readFile(A, "MEMORY.md") };
}

test("deep promotion keeps Shoggoth's own MEMORY.md entries whatever the consolidation model asks", { timeout: 240000 }, async (t) => {
  const plans = {
    supersede: (candidate, prior) => ({ candidateKey: candidate.key, action: "superseded", priorEntries: [prior] }),
    "merge unrelated": (candidate, prior) => ({ candidateKey: candidate.key, action: "merged", priorEntries: [prior] }),
    add: candidate => ({ candidateKey: candidate.key, action: "added", priorEntries: [] }),
  };
  for (const [name, plan] of Object.entries(plans)) {
    const { f, kept, block, memory, consolidations } = await promoteWith(t, plan);
    assert.ok(consolidations >= 1, `${name}: the consolidation model was asked`);
    assert.match(memory, /calibrated every evening/u, `${name}: the candidate is promoted`);
    assert.ok(memory.includes(block), `${name}: the Shoggoth entry is unchanged`);
    assert.ok(f.owner.store.list(A, { status: "active" }).some(item => item.id === kept.id), `${name}: the record stays active`);
  }
});
