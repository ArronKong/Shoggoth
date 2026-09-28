"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

test("Service restart rebuilds reauthorized Memory after transcript stores open and keeps damaged policy closed", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-recall-start-")));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => Buffer.from(value).toString("utf8") };
  let clock = Date.now();
  const now = () => ++clock;
  const create = () => createAgentService({ paths, safeStorage, now,
    version: "recall-startup-regression", prewarmMcpAuth: false });
  let service = null;
  try {
    service = create();
    await service.start();
    const profileId = DEFAULT_AGENT_PROFILE_ID;
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { mode: 0o700 });
    const session = service.chatSessionStore.createSession({ profileId, workspace,
      operationId: "recall-startup-session", createdAt: now() });
    const content = "用户偏好蓝色番茄计划";
    const old = service.transcriptStore.appendEvent({ profileId, sessionId: session.id,
      id: "recall-old-event", runId: "recall-old-run", kind: "user",
      content: { text: "请记住我偏好蓝色番茄计划" }, occurredAt: now() });
    const forgotten = service.memoryEngine.propose({ profileId, scope: "user", type: "semantic",
      content, sourceRefs: [old.id, old.runId], classification: "explicit" });
    service.memoryEngine.delete({ profileId, id: forgotten.id, reason: "forgotten",
      operationId: "recall-startup-forget" });
    const fresh = service.transcriptStore.appendEvent({ profileId, sessionId: session.id,
      id: "recall-new-event", runId: "recall-new-run", kind: "user",
      content: { text: "我现在明确重新授权蓝色番茄计划" }, occurredAt: now() });
    const reauthorized = service.memoryEngine.propose({ profileId, scope: "user", type: "semantic",
      content, sourceRefs: [fresh.id, fresh.runId], classification: "explicit" });
    assert.equal(service.memoryEngine.recallPolicy.isMemoryVisible(profileId, reauthorized), true);
    await service.stop({ notify: false });

    service = create();
    await service.start();
    assert.equal(service.memoryEngine.viewStatus(profileId).stale, false,
      "view rebuild must retry after ChatSessionStore and TranscriptStore open");
    const generated = service.agentDefinitionStore.readGeneratedView(profileId, "MEMORY");
    assert.ok(generated);
    assert.equal(generated.content.split(content).length - 1, 1,
      "generated view includes only the newly authorized claim");
    const search = service.mcpProductToolController.conversationMemoryService.search(profileId,
      { query: "蓝色番茄" }, { workspace });
    assert.deepEqual(search.items.map((item) => item.id), [reauthorized.id]);
    assert.equal(service.memoryEngine.recallPolicy.isMemoryVisible(profileId, forgotten), false);
    await service.stop({ notify: false });

    const log = path.join(paths.agentsDir, profileId, "memory", "recall-policy.jsonl");
    fs.appendFileSync(log, "{", { mode: 0o600 });
    service = create();
    await service.start();
    assert.throws(() => service.mcpProductToolController.conversationMemoryService.search(profileId,
      { query: "蓝色番茄" }, { workspace }),
    (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
    assert.throws(() => service.memoryEngine.recallPolicy.isMemoryVisible(profileId, reauthorized),
      (error) => error.code === "RECALL_POLICY_UNAVAILABLE");
  } finally {
    try { await service?.stop({ notify: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
