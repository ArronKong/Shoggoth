"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { OwnerMemoryReader } = require("../app/agent-service/shoggoth-memory/owner-memory-reader.cjs");
const { documentKind, canonicalSharedPath } = require("../app/agent-service/shoggoth-memory/shared-document.cjs");
const { sha256 } = require("../app/agent-service/shoggoth-memory/migration.cjs");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sor-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const config = { memory: { search: { provider: "none", rememberAcrossConversations: false, sync: { watchDebounceMs: 10 } } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } };
  const service = createAgentService({ paths, prewarmMcpAuth: false, memoryCoreConfig: config,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const owner = service.memoryEngine, fields = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
  const base = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  for (const id of ["source-b", "source-c"]) {
    const profile = Object.fromEntries(fields.map(field => [field, base[field]]));
    Object.assign(profile, { id, agentId: id, name: id, runtimeProfileId: id, isDefault: false });
    service.productStore.putAgentProfile(profile); service.agentDefinitionStore.ensureProfile({ profileId: id });
    owner.store.ensureProfile(id); owner.recallPolicy.assertReady(id);
  }
  let modelCalls = 0; owner.complete = async () => { modelCalls++; assert.fail("Owner search must not start a chat model"); };
  require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(owner);
  const reader = new OwnerMemoryReader(owner), workspace = path.join(root, "w"); fs.mkdirSync(workspace, { mode: 0o700 });
  const input = { ownerProfileId: "source-b", requesterProfileId: DEFAULT_AGENT_PROFILE_ID, workspace,
    maxSensitivity: "private", query: "telescope", minScore: 0, maxResults: 20, lexicalOnly: true };
  const write = (relative, text, profileId = "source-b") => {
    const file = path.join(owner.store.workspace(profileId), relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 }); return file;
  };
  const save = (content, extra = {}, profileId = "source-b") => owner.propose({ profileId, content, scope: "agent", type: "semantic", classification: "explicit", sourceRefs: [`user-edit:${sha256(content)}`], ...extra });
  return { root, paths, service, owner, reader, input, write, save, config, modelCalls: () => modelCalls };
}

test("shared path whitelist and inline fragment kinds are exact", () => {
  for (const relative of ["USER.md", "MEMORY.md", "DREAMS.md", "dreams.md", "memory/2026-10-09.md", "memory/dreaming/light/2026-10-09.md", "memory/dreaming/rem/2026-10-09.md", "memory/dreaming/deep/2026-10-09.md"]) assert.equal(canonicalSharedPath(relative), relative);
  for (const relative of ["/MEMORY.md", "../MEMORY.md", "memory/../USER.md", "memory/.dreams/session-corpus/x.md", "SOUL.md", "memory/notes.md", "memory/2026-10-09.md/", "memory\\2026-10-09.md"]) assert.equal(canonicalSharedPath(relative), null);
  const text = "daily telescope\n<!-- openclaw:dreaming:light:start -->\nCandidate: telescope\n<!-- openclaw:dreaming:light:end -->\ndaily continuation";
  assert.equal(documentKind("memory/2026-10-09.md", text, 1, 1), "daily");
  assert.equal(documentKind("memory/2026-10-09.md", text, 3, 3), "reflection_report");
  assert.equal(documentKind("memory/2026-10-09.md", text, 5, 5), "daily");
});

test("real Service searches every report type at its owner without chat calls, foreign copies or promotion receipts", async t => {
  const f = await fixture(t);
  const item = await f.save("The telescope uses a sapphire calibration plate.");
  await f.save("The telescope observer prefers Chinese.", { scope: "user" });
  const host = f.owner.host("source-b"), source = { path: item.memoryPath, startLine: item.startLine, endLine: item.endLine,
    sourceHash: sha256(f.owner.store.readFile("source-b", item.memoryPath).split("\n").slice(item.startLine - 1, item.endLine).join("\n")) };
  for (const relative of ["DREAMS.md", "dreams.md", "memory/2026-10-09.md", "memory/dreaming/light/2026-10-09.md", "memory/dreaming/rem/2026-10-09.md", "memory/dreaming/deep/2026-10-09.md"]) {
    const text = relative.startsWith("memory/2026") ? "Daily telescope handwritten calibration.\n" : "# Reflection\n\n- telescope reflected calibration.\n";
    const actual = path.relative(host.workspaceDir, fs.realpathSync.native(f.write(relative, text))).replaceAll(path.sep, "/");
    if (!relative.startsWith("memory/2026")) f.owner.store.registerReportEvidence("source-b", { path: actual, startLine: 1, endLine: text.split("\n").length, sources: [source], sourceHash: sha256(text) });
  }
  const readerRoot = f.owner.store.workspace(f.input.requesterProfileId);
  const inventory = () => fs.readdirSync(readerRoot, { recursive: true }).map(name => { const file = path.join(readerRoot, name); return [name, fs.statSync(file).isFile() ? fs.readFileSync(file).toString() : "directory"]; });
  const before = inventory();
  const result = await f.reader.search(f.input);
  const paths = new Set(result.results.map(row => row.path));
  for (const relative of ["USER.md", "MEMORY.md", "DREAMS.md", "dreams.md", "memory/2026-10-09.md", "memory/dreaming/light/2026-10-09.md", "memory/dreaming/rem/2026-10-09.md", "memory/dreaming/deep/2026-10-09.md"]) if (relative !== "dreams.md" || fs.realpathSync.native(path.join(host.workspaceDir, relative)) === path.join(host.workspaceDir, relative)) assert.ok(paths.has(relative), relative);
  assert.ok(result.results.filter(row => /DREAMS|dreams|dreaming/u.test(row.path)).every(row => row.documentKind === "reflection_report"));
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(inventory(), before);
  assert.equal(host.database.db.prepare("SELECT count(*) n FROM memory_state WHERE namespace=? AND value IS NOT NULL").get(core.SHORT_TERM_RECALL_NAMESPACE).n, 0);
  assert.deepEqual(f.owner.listShared(f.input.requesterProfileId).items, []);
});

test("source filtering happens before native candidate LIMIT even when unshared notes dominate the corpus", async t => {
  const f = await fixture(t);
  await f.save("The telescope shared needle answer is sapphire.");
  const flood = Array.from({ length: 240 }, (_, i) => `telescope telescope telescope unshared flood ${i}.\n` + "Unshared filler ".repeat(120)).join("\n");
  f.write("memory/aaa-unshared.md", flood);
  const result = await f.reader.search({ ...f.input, maxResults: 1 });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].path, "MEMORY.md");
  assert.match(result.results[0].snippet, /shared needle answer/u);
});

function sessionFact(f, workspace, tag) {
  const profileId = "source-b", service = f.service;
  const session = service.chatSessionStore.createSession({ profileId, workspace, operationId: `${tag}-session`, createdAt: Date.now() });
  service.chatSessionStore.requestBinding(session.sessionKey, `${tag}-binding`, Date.now()); service.chatSessionStore.completeBinding(session.sessionKey, `${tag}-binding`, `${tag}-runtime`);
  const run = service.workDispatcher.enqueue({ id: `${tag}-run`, profileId, source: "chat", sourceId: session.sessionKey, idempotencyKey: `${tag}-run`, workspace });
  service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
  const event = service.transcriptStore.appendEvent({ profileId, sessionId: session.id, id: `${tag}-event`, runId: run.id, kind: "user", content: { text: "The telescope flush fact is jade calibration." } });
  service.workDispatcher.transition(run.id, "completed"); return { session, event };
}

test("real flush and source sessions follow D1 exact workspace; foreign results are a subset of the same owner query", async t => {
  const f = await fixture(t), { session } = sessionFact(f, f.input.workspace, "same");
  f.config.agents.defaults.compaction.memoryFlush.enabled = true;
  f.owner.complete = async () => ({ text: JSON.stringify({ append: "The telescope flush fact is jade calibration." }) });
  const flush = await f.owner.flushBeforeCompaction({ profileId: "source-b", sessionId: session.id }); assert.equal(flush.appended, true);
  f.owner.complete = async () => assert.fail("search cannot generate");
  const own = await f.owner.searchMemory({ profileId: "source-b", workspace: f.input.workspace, maxSensitivity: "private", query: "telescope", minScore: 0, maxResults: 20, record: false, sources: ["memory"] });
  const shared = await f.reader.search(f.input); assert.ok(shared.results.some(row => row.path === flush.path));
  assert.ok(shared.results.every(row => own.results.some(source => row.path === source.path && row.startLine === source.startLine && row.endLine === source.endLine)));
  for (const workspace of [path.join(f.root, "other"), path.join(f.input.workspace, "child"), null]) {
    assert.deepEqual((await f.reader.search({ ...f.input, workspace })).results, [], String(workspace));
  }
});

test("fragment references reject modifications, path forgeries, symlinks and forgotten foreign facts, retaining unrelated changes", async t => {
  const f = await fixture(t), fact = await f.save("The telescope stable referenced fact is sapphire.");
  const result = (await f.reader.search(f.input)).results[0]; assert.ok(result);
  f.write("memory/2026-10-08.md", "An unrelated telescope daily note.");
  assert.equal(f.reader.revalidate(f.input, result).sourceHash, result.sourceHash);
  const canonical = path.join(f.owner.store.workspace("source-b"), "MEMORY.md");
  fs.writeFileSync(canonical, fs.readFileSync(canonical, "utf8").replace("sapphire", "amber"), { mode: 0o600 });
  assert.throws(() => f.reader.revalidate(f.input, result), { code: "MEMORY_SOURCE_CHANGED" });
  assert.throws(() => f.reader.revalidate(f.input, { ...result, path: "../MEMORY.md", canonicalRelativePath: "../MEMORY.md" }), { code: "MEMORY_SHARED_READ_INVALID" });
  const peer = await f.save(fact.content, {}, f.input.requesterProfileId); await f.owner.delete({ profileId: f.input.requesterProfileId, id: peer.id, reason: "forgotten" });
  fs.writeFileSync(canonical, fs.readFileSync(canonical, "utf8").replace("amber", "sapphire"), { mode: 0o600 });
  assert.deepEqual((await f.reader.search(f.input)).results.filter(row => row.path === "MEMORY.md"), []);
  fs.unlinkSync(canonical); fs.symlinkSync(path.join(f.owner.store.workspace(f.input.requesterProfileId), "USER.md"), canonical);
  await assert.rejects(f.reader.search(f.input));
});

test("root DREAMS discovery and watcher observe newly created report files without authorizing unproven reports", async t => {
  const f = await fixture(t), host = f.owner.host("source-b"), sources = host.searchIndex.sourceFiles;
  const controller = new AbortController(); let changed;
  const event = new Promise(resolve => { changed = resolve; });
  const watching = sources.watch({ agentId: "source-b", settings: sources.settings() }, changed, controller.signal);
  // Observe lifetime rejection immediately and close the watcher before the
  // fixture's earlier registered teardown can remove its authoritative root.
  const settled = watching.then(() => null, error => error);
  try {
    await watching.ready;
    f.write("DREAMS.md", "- telescope unsupported reflection, no origin.\n");
    await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error("DREAMS watcher did not observe creation")), 5000))]);
    await new Promise(resolve => setTimeout(resolve, 1100)); // Cross the admission health probe after case-alias creation.
    assert.ok((await sources.list(sources.settings())).some(file => file.endsWith("DREAMS.md")));
    assert.ok(f.owner.store.list("source-b", { status: "active" }).some(item => item.memoryPath === "DREAMS.md"));
    assert.deepEqual((await f.reader.search(f.input)).results, []);
  } finally {
    controller.abort(); const error = await settled; if (error) throw error;
  }
});

test("private/restricted source entries and report origins use the reader's current sensitivity and exact workspace", async t => {
  const f = await fixture(t);
  await f.save("The private telescope code name is opal.", { sensitivity: "private" });
  await assert.rejects(f.save("The restricted telescope rejected save.", { sensitivity: "restricted" }), { code: "MEMORY_RESTRICTED" });
  const restricted = await f.save("The restricted telescope route must never appear.", { scope: "user" });
  f.owner.database.db.prepare("UPDATE memory_file_records SET data=json_set(data,'$.sensitivity','restricted') WHERE profile_id=? AND id=?").run("source-b", restricted.id);
  assert.ok((await f.reader.search(f.input)).results.some(row => row.snippet.includes("opal")));
  assert.ok((await f.reader.search(f.input)).results.every(row => !row.snippet.includes("must never appear")));
  assert.deepEqual((await f.reader.search({ ...f.input, maxSensitivity: "normal" })).results, []);
  const plain = await f.save("The telescope report origin is a manual observation.");
  const source = { path: plain.memoryPath, startLine: plain.startLine, endLine: plain.endLine,
    sourceHash: sha256(f.owner.store.readFile("source-b", plain.memoryPath).split("\n").slice(plain.startLine - 1, plain.endLine).join("\n")) };
  const relative = "memory/2026-10-09.md", text = "<!-- openclaw:dreaming:rem:start -->\n- telescope reflective inference.\n<!-- openclaw:dreaming:rem:end -->\n";
  f.write(relative, text); f.owner.store.registerReportEvidence("source-b", { path: relative, startLine: 1, endLine: text.split("\n").length, sources: [source], sourceHash: sha256(text) });
  const reflection = (await f.reader.search(f.input)).results.find(row => row.path === relative);
  assert.equal(reflection.documentKind, "reflection_report");
  const line = { ...reflection, startLine: 2, endLine: 2, sourceHash: sha256("- telescope reflective inference.") };
  f.write(relative, text + "\n- A separate unrelated paragraph.\n");
  assert.equal(f.reader.revalidate(f.input, line).sourceHash, line.sourceHash, "unrelated lines do not invalidate a referenced fragment");
  assert.ok(!JSON.stringify(f.owner.database.db.prepare("SELECT data FROM memory_report_evidence").all()).includes("reflective inference"), "report dependency rows have no body copies");
});

test("missing memory files are empty sources, damaged one-owner indices fail without preventing a healthy owner query", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.reader.search(f.input)).results, []);
  await f.save("The telescope healthy owner uses an onyx plate.", {}, "source-c");
  const host = f.owner.host("source-b"), databasePath = host.database.path;
  await host.searchIndex.close(); host.database.close(); f.owner.hosts.delete("source-b");
  fs.writeFileSync(databasePath, "NOT A SQLITE DATABASE", { mode: 0o600 });
  await assert.rejects(f.reader.search(f.input));
  const healthy = await f.reader.search({ ...f.input, ownerProfileId: "source-c" });
  assert.ok(healthy.results.some(row => row.snippet.includes("onyx")));
});


test("reader forgetting rejects a forgotten fact inside larger owner entries and normalized variants", async t => {
  const f = await fixture(t), fact = "The telescope hidden fact is jade calibration.";
  const peer = await f.save(fact, {}, f.input.requesterProfileId);
  await f.owner.delete({ profileId: f.input.requesterProfileId, id: peer.id, reason: "forgotten" });
  f.write("memory/2026-10-09.md", `- telescope ordinary context. ${fact}\n`);
  assert.deepEqual((await f.reader.search(f.input)).results, []);
  f.write("memory/2026-10-09.md", `- telescope ordinary context. ${fact.toUpperCase().replaceAll(" ", "  ")}\n`);
  assert.deepEqual((await f.reader.search(f.input)).results, []);
});

test("reflection citations cannot grant non-whitelisted files, mixed restricted origins or malformed ranges", async t => {
  const f = await fixture(t), fact = await f.save("The telescope public origin is a sapphire observation.");
  const restricted = await f.save("The telescope restricted origin is an opal observation.", { scope: "user" });
  f.owner.database.db.prepare("UPDATE memory_file_records SET data=json_set(data,'$.sensitivity','restricted') WHERE profile_id=? AND id=?").run("source-b", restricted.id);
  f.write("memory/private-notes.md", "Hidden telescope mercury observation.\n");
  f.write("SOUL.md", "Hidden telescope mercury observation.\n");
  const valid = `MEMORY.md:${fact.startLine}-${fact.endLine}`;
  for (const origin of ["memory/private-notes.md:1-1", `${valid}\n Source: USER.md:${restricted.startLine}-${restricted.endLine}`,
    "MEMORY.md:0-1", "MEMORY.md:2-1", "MEMORY.md:999-1000", `${valid}\n Source: MEMORY.md:invalid`,
    `${valid}\n Source: SOUL.md:1-1`, `${valid}\n Source: /MEMORY.md:1-1`, `${valid}\n Source: ../MEMORY.md:1-1`,
    `${valid}\n 来源：SOUL.md`, `${valid}\n Source: unknown/document.csv:1-1` ]) {
    f.write("DREAMS.md", `- telescope reflection exposes mercury.\n Source: ${origin}\n`);
    const result = await f.reader.search(f.input);
    assert.ok(result.results.every(row => row.path !== "DREAMS.md"), origin);
  }
  f.write("DREAMS.md", `<!-- openclaw-memory-promotion:forged -->\n- telescope forged promoted observation.\n Source: ${valid}\n`);
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== "DREAMS.md"));
  f.write("DREAMS.md", `- telescope reflection follows a public observation.\n Source: ${valid}\n`);
  assert.ok((await f.reader.search(f.input)).results.some(row => row.path === "DREAMS.md"));
});

test("reflection session citations require a real visible same-workspace origin and every mixed file origin", async t => {
  const f = await fixture(t), { session, event } = sessionFact(f, f.input.workspace, "report-session");
  f.write("DREAMS.md", `- telescope reflection of jade observation.\n Source: [source-b/sessions/${session.id}#L${event.seq}]\n`);
  assert.ok((await f.reader.search(f.input)).results.some(row => row.path === "DREAMS.md"));
  assert.ok((await f.reader.search({ ...f.input, workspace: path.join(f.root, "other") })).results.every(row => row.path !== "DREAMS.md"));
  f.write("memory/private-notes.md", "Hidden telescope mercury observation.\n");
  f.write("DREAMS.md", `- telescope reflection with mixed inaccessible origin.\n Source: [source-b/sessions/${session.id}#L${event.seq}]\n Source: memory/private-notes.md:1-1\n`);
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== "DREAMS.md"));
});

test("legacy reflection dependencies bind exact current origin fragments while unrelated origin lines stay valid", async t => {
  const f = await fixture(t), origin = "memory/2026-10-09.md";
  f.write(origin, "A telescope original sapphire observation.\n");
  const report = "- telescope reflection of the original observation.\n Source: memory/2026-10-09.md:1-1\n";
  f.write("DREAMS.md", report);
  const evidence = (await f.reader.search(f.input)).results.find(row => row.path === "DREAMS.md");
  assert.match(evidence.sourceOriginHash, /^[a-f0-9]{64}$/u);
  f.write(origin, "A telescope original sapphire observation.\nAn unrelated second source paragraph.\n");
  assert.equal(f.reader.revalidate(f.input, evidence).sourceOriginHash, evidence.sourceOriginHash);
  f.write(origin, "A telescope changed amber observation.\nAn unrelated second source paragraph.\n");
  assert.equal(f.owner.store.readFile("source-b", "DREAMS.md"), report);
  assert.throws(() => f.reader.revalidate(f.input, evidence), { code: "MEMORY_SOURCE_CHANGED" });
  assert.throws(() => f.reader.revalidate(f.input, { ...evidence, sourceOriginHash: undefined }), { code: "MEMORY_SHARED_READ_INVALID" });
});


test("native promotion keys require committed receipts without being mistaken for malformed file citations", async t => {
  const f = await fixture(t), item = await f.save("The telescope promotion origin is a sapphire observation.");
  const host = f.owner.host("source-b"), key = `memory:${item.memoryPath}:${item.startLine}:${item.endLine}`;
  const stateKey = `${core.memoryCoreWorkspaceStateKey(host.workspaceDir)}:${sha256(key)}`;
  const marker = `<!-- openclaw-memory-promotion:${key} -->`;
  const report = `${marker}\n- telescope reflected committed observation.\n`;
  f.write("DREAMS.md", report);
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== "DREAMS.md"));
  const source = f.owner.store.readFile("source-b", item.memoryPath).split("\n").slice(item.startLine - 1, item.endLine).join("\n");
  host.database.db.prepare("INSERT INTO memory_promotion_sources VALUES (?,?,?,?,?)").run(stateKey, item.memoryPath, item.startLine, item.endLine, sha256(source));
  const evidence = (await f.reader.search(f.input)).results.find(row => row.path === "DREAMS.md");
  assert.ok(evidence); assert.match(evidence.sourceOriginHash, /^[a-f0-9]{64}$/u);
  f.write("DREAMS.md", `${report} Source: ${item.memoryPath}:${item.startLine}:${item.endLine}\n`);
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== "DREAMS.md"), "a valid marker cannot excuse a malformed separate citation");
  f.write("DREAMS.md", report);
  f.write(item.memoryPath, f.owner.store.readFile("source-b", item.memoryPath).replace("sapphire", "emerald"));
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== "DREAMS.md"), "a committed marker cannot excuse a changed source fragment");
});


test("report evidence registers only the proven output range and cannot lend new Deep origins to old narratives", async t => {
  const f = await fixture(t), item = await f.save("The telescope new Deep input is a public sapphire observation.");
  const source = { path: item.memoryPath, startLine: item.startLine, endLine: item.endLine,
    sourceHash: sha256(f.owner.store.readFile("source-b", item.memoryPath).split("\n").slice(item.startLine - 1, item.endLine).join("\n")) };
  const text = "- telescope old narrative with unknown origins.\n\n- telescope newly proved Deep output.\n";
  f.write("DREAMS.md", text);
  const rows = () => f.owner.database.db.prepare("SELECT line FROM memory_report_evidence WHERE profile_id=? AND path=? ORDER BY line").all("source-b", "DREAMS.md").map(row => row.line);
  for (const range of [{}, { startLine: 0, endLine: 3 }, { startLine: 3, endLine: 2 }, { startLine: 3, endLine: 999 }]) {
    assert.throws(() => f.owner.store.registerReportEvidence("source-b", { path: "DREAMS.md", ...range, sources: [source] }), { code: "MEMORY_REPORT_EVIDENCE_INVALID" });
    assert.deepEqual(rows(), []);
  }
  assert.throws(() => f.owner.store.registerReportEvidence("source-b", { path: "DREAMS.md", startLine: 3, endLine: 3, sources: [source], rangeHash: "0".repeat(64) }), { code: "MEMORY_SOURCE_CHANGED" });
  assert.deepEqual(rows(), []);
  f.owner.store.registerReportEvidence("source-b", { path: "DREAMS.md", startLine: 3, endLine: 3, sources: [source], sourceHash: sha256(text), rangeHash: sha256(text.split("\n")[2]) });
  assert.deepEqual(rows(), [3]); assert.equal(f.owner.store.reportEvidence("source-b", "DREAMS.md", 1, 1), null);
  assert.deepEqual(f.owner.store.reportEvidence("source-b", "DREAMS.md", 3, 3), { sources: [source], lines: [{ line: 3, sourceHash: sha256(text.split("\n")[2]), sources: [source] }] });
  assert.equal(f.reader.policy.allowResult(f.input, { path: "DREAMS.md", source: "memory", startLine: 1, endLine: 1 }), false);
  assert.equal(f.reader.policy.allowResult(f.input, { path: "DREAMS.md", source: "memory", startLine: 3, endLine: 3 }), true);
  const shared = (await f.reader.search(f.input)).results.filter(row => row.path === "DREAMS.md");
  assert.ok(shared.some(row => row.snippet.includes("newly proved Deep")), "newly proved entries remain searchable at their exact native boundaries");
  assert.ok(shared.every(row => !row.snippet.includes("old narrative")), "a proved entry cannot expose the old unproved narrative");
});


test("legacy unchanged Root report indexes rebuild only their owner using the new native entry policy", async t => {
  const f = await fixture(t), item = await f.save("The telescope Root migration input is sapphire.");
  const text = "- telescope old narrative migration sentinel.\n\n- telescope new verified migration output.\n";
  f.write("DREAMS.md", text);
  const source = { path: item.memoryPath, startLine: item.startLine, endLine: item.endLine,
    sourceHash: sha256(f.owner.store.readFile("source-b", item.memoryPath).split("\n").slice(item.startLine - 1, item.endLine).join("\n")) };
  f.owner.store.registerReportEvidence("source-b", { path: "DREAMS.md", startLine: 3, endLine: 3, sources: [source] });
  const index = f.owner.host("source-b").searchIndex, original = index.prepareSourceChunks;
  // Construct an actual native old-generation broad chunk with the same
  // source bytes. No shared assertion is relaxed for this legacy fixture.
  index.prepareSourceChunks = function(relative, kind, read, options) {
    if (relative !== "DREAMS.md") return original.call(this, relative, kind, read, options);
    return core.prepareMemoryIndexChunks({ entry: { path: relative, mtimeMs: read.mtime }, source: kind,
      content: read.text, pathClassification: { curatedRoot: false, originClass: "agent" }, chunking: this.settings.chunking,
      hardMaxInputTokens: 8000 }).chunks;
  };
  await index.sync();
  const before = index.db.prepare("SELECT hash FROM memory_index_sources WHERE source='memory' AND path='DREAMS.md'").get().hash;
  assert.ok(index.db.prepare("SELECT text FROM memory_index_chunks WHERE path='DREAMS.md'").all().some(row => /old narrative[\s\S]*new verified/u.test(row.text)));
  index.prepareSourceChunks = original;
  index.db.prepare("DELETE FROM memory_index_meta WHERE key='shoggoth-root-report-policy'").run();
  const other = f.owner.host("source-c").searchIndex; await other.sync();
  other.db.prepare("DELETE FROM memory_index_meta WHERE key='shoggoth-root-report-policy'").run();
  const otherRows = other.db.prepare("SELECT * FROM memory_index_meta ORDER BY key").all();
  const found = (await f.reader.search(f.input)).results.filter(row => row.path === "DREAMS.md");
  assert.ok(found.some(row => row.snippet.includes("new verified migration")));
  assert.ok(found.every(row => !row.snippet.includes("old narrative")));
  assert.equal(index.db.prepare("SELECT value FROM memory_index_meta WHERE key='shoggoth-root-report-policy'").get().value, "1");
  assert.equal(index.db.prepare("SELECT hash FROM memory_index_sources WHERE source='memory' AND path='DREAMS.md'").get().hash, before);
  assert.deepEqual(other.db.prepare("SELECT * FROM memory_index_meta ORDER BY key").all(), otherRows);
  const settings = other.resolveSettings(); other.configurePublication(settings.resolved, settings.stamp);
  assert.equal(other.needsRebuild, false, "an owner without Root reports keeps its valid unchanged native generation");
});


test("an ordinary source edit cannot turn reader forgetting of the original body into reusable edit authority", async t => {
  const f = await fixture(t), content = "The telescope original edited-forget observation is sapphire.";
  const source = await f.save(content), peer = await f.save(content, {}, f.input.requesterProfileId);
  const borrowed = (await f.reader.search(f.input)).results.find(row => row.path === "MEMORY.md");
  assert.ok(borrowed);
  const file = f.owner.store.readFile("source-b", source.memoryPath);
  f.write(source.memoryPath, file.replace("sapphire", "amber"));
  assert.throws(() => f.reader.revalidate(f.input, borrowed), { code: "MEMORY_SOURCE_CHANGED" }, "a plain current-position edit retains only in-flight authority");
  await f.owner.delete({ profileId: f.input.requesterProfileId, id: peer.id, reason: "forgotten" });
  assert.throws(() => f.reader.revalidate(f.input, borrowed), { code: "MEMORY_SHARED_SOURCE_REVOKED" }, "reader forget of the original body takes precedence even if the new body no longer contains that text");
});


test("native semantic candidate filtering precedes its limit when hidden vectors rank above a shared result", async t => {
  const f = await fixture(t);
  await f.save("The telescope semantic shared needle answer is sapphire.");
  f.write("memory/aaa-unshared.md", Array.from({ length: 240 }, (_, index) => `- hidden vector passage ${index}.\n` + "Private corpus filler ".repeat(60)).join("\n"));
  const index = f.owner.host("source-b").searchIndex;
  let queryCalls = 0, passageCalls = 0;
  index.embedding = { identity: "sharing-semantic-filter-fixture-v1", async encode(text, purpose) {
    if (purpose === "query") { queryCalls++; return [1, 0]; }
    passageCalls++; return text.includes("semantic shared needle") ? [0.8, 0.6]
      : /hidden vector passage|Private corpus filler/u.test(text) ? [1, 0] : [0, 1];
  } };
  // Private constructor/runtime controls exercise actual native publication
  // and vector fallback without changing public Product provider settings.
  index.getConfig = () => ({ memory: { search: { provider: "shoggoth-e5", rememberAcrossConversations: false, sources: ["memory"], cache: { enabled: false } } } });
  index.sourceFiles.getConfig = index.getConfig;
  const found = await f.reader.search({ ...f.input, query: "quasar", lexicalOnly: false, maxResults: 1 });
  assert.equal(found.results.length, 1); assert.equal(found.results[0].path, "MEMORY.md");
  assert.match(found.results[0].snippet, /semantic shared needle/u);
  assert.ok(queryCalls > 0 && passageCalls > 200, "native semantic publication and query both ran over the actual flood corpus");
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.owner.host("source-b").database.db.prepare("SELECT count(*) n FROM memory_state WHERE namespace=? AND value IS NOT NULL").get(core.SHORT_TERM_RECALL_NAMESPACE).n, 0);
});


test("typed session corpus is only indirect report proof tied to live owner events and exact workspace", async t => {
  const f = await fixture(t), { session, event } = sessionFact(f, f.input.workspace, "corpus-origin");
  const host = f.owner.host("source-b"), corpusPath = "memory/.dreams/session-corpus/2026-10-09.txt";
  const source = host.sessions.read("source-b", session.id), position = source.lineMap.indexOf(event.seq);
  assert.ok(position >= 0);
  const rendered = `[source-b/sessions/${session.id}#L${event.seq}] ${source.content.split("\n")[position]}`;
  const absolute = path.join(host.workspaceDir, corpusPath);
  await host.run(() => core.appendSessionCorpusText(absolute, `${rendered}\n`));
  const report = `- telescope reflection of a traced jade observation.\n Source: ${corpusPath}:1-1\n`;
  f.write("memory/dreaming/light/2026-10-09.md", report);
  const own = await f.owner.searchOwnMemory({ profileId: "source-b", workspace: f.input.workspace,
    maxSensitivity: "private", query: "telescope", minScore: 0, maxResults: 20, record: false, sources: ["memory"] });
  const found = await f.reader.search(f.input), evidence = found.results.find(row => /dreaming\/light/u.test(row.path));
  assert.ok(evidence, "a cited live same-workspace Product event is verifiable indirect reflection evidence");
  assert.ok(own.results.some(row => row.path === evidence.path && row.startLine === evidence.startLine && row.endLine === evidence.endLine), "foreign report remains a subset of the source's own query");
  assert.match(evidence.sourceOriginHash, /^[a-f0-9]{64}$/u);
  assert.ok(found.results.every(row => row.path !== corpusPath));
  assert.throws(() => f.reader.revalidate(f.input, { ...evidence, path: corpusPath, canonicalRelativePath: corpusPath }), { code: "MEMORY_SHARED_READ_INVALID" });
  assert.throws(() => f.reader.evidence(f.input, { path: corpusPath, startLine: 1, endLine: 1 }));
  for (const workspace of [path.join(f.root, "other"), path.join(f.input.workspace, "child"), null]) {
    assert.ok((await f.reader.search({ ...f.input, workspace })).results.every(row => row.path !== evidence.path));
  }
  f.write(corpusPath, rendered.replace("jade calibration.", "jade…") + "\n");
  assert.throws(() => f.reader.revalidate(f.input, evidence), { code: "MEMORY_SOURCE_CHANGED" }, "a changed still-valid corpus excerpt invalidates report reuse");
  f.write(corpusPath, rendered.replace("source-b/sessions/", "another-owner/sessions/") + "\n");
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== evidence.path), "a corpus file spelling alone cannot authorize a different owner");
  f.write(corpusPath, `[source-b/sessions/${session.id}#L999999] User: invented telescope claim.\n`);
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== evidence.path));
  f.write(corpusPath, rendered + "\n");
  const derivedRun = f.service.workDispatcher.enqueue({ id: "corpus-borrowed-run", profileId: "source-b", source: "chat", sourceId: session.sessionKey, idempotencyKey: "corpus-borrowed-run", workspace: f.input.workspace });
  f.service.workDispatcher.admit(derivedRun.id); f.service.workDispatcher.transition(derivedRun.id, "running");
  const derived = f.service.transcriptStore.appendEvent({ profileId: "source-b", sessionId: session.id, id: "corpus-borrowed-event", runId: derivedRun.id, kind: "user",
    content: { text: "The telescope borrowed-origin input must not become another source.", borrowedMemoryDerived: true, persistPolicy: "reference_only" } });
  f.service.workDispatcher.transition(derivedRun.id, "completed");
  assert.equal(require("../app/agent-service/shoggoth-memory/borrowed-memory-provenance.cjs").isBorrowedMemoryDerived(derived), true);
  f.write(corpusPath, `[source-b/sessions/${session.id}#L${derived.seq}] User: The telescope borrowed-origin input must not become another source.\n`);
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== evidence.path), "an actual borrowed-derived owner event is not an original corpus source");
  f.write(corpusPath, rendered + "\n");
  const peer = await f.save("The telescope flush fact is jade calibration.", {}, f.input.requesterProfileId);
  await f.owner.delete({ profileId: f.input.requesterProfileId, id: peer.id, reason: "forgotten" });
  assert.ok((await f.reader.search(f.input)).results.every(row => row.path !== evidence.path), "reader forgotten original text remains blocked through indirect corpus provenance");
  assert.throws(() => f.reader.revalidate(f.input, evidence), { code: "MEMORY_SHARED_SOURCE_REVOKED" });
});
