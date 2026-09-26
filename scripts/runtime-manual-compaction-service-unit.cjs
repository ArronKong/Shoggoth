#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { FakeHost, waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");

test("manual compact shares global and session admission, and cancel settles sibling runs on the stopped Codex host", async () => {
  const root = fs.mkdtempSync("/tmp/sgcompact-");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const host = new FakeHost([]);
  let compactCalls = 0;
  let compactThread = null;
  let stops = 0;
  host.threadCompactStart = async ({ threadId }) => { compactCalls += 1; compactThread = threadId; return {}; };
  host.stop = async () => { stops += 1; host.termination.resolve(); };
  const service = createAgentService({ paths, version: "compact-admission-fixture",
    runtimePool: { async get() { return host; }, async stop() {}, async stopAll() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() },
  });
  try {
    await service.start();
    const config = service.nativeRuntimeConfig.read();
    service.nativeRuntimeConfig.apply({ ...config, revision: 1, maxActive: 1,
      flags: { ...config.flags, runtimeAdmissionV1: true } });
    const profile = service.productStore.listAgentProfiles()[0];
    const sessions = ["first", "second"].map(name => {
      const workspace = path.join(root, name); fs.mkdirSync(workspace);
      return service.chatSessionStore.createSession({ operationId: `compact-${name}`,
        profileId: profile.id, workspace, createdAt: Date.now() });
    });
    const send = (index, operationId, prompt) => service.workRunCoordinator.send({
      operationId, sessionKey: sessions[index].sessionKey, prompt,
    });
    const normal = await send(0, "normal-holds-global", "hold");
    await service.workRunCoordinator.waitForIdle(normal.run.id);
    const queued = await send(1, "compact-queued-global", "/compact");
    assert.equal(queued.disposition, "queued");
    assert.equal(queued.reason, "GLOBAL_CAPACITY");
    assert.equal(compactCalls, 0);
    await service.workRunCoordinator.abort({ operationId: "release-global",
      sessionKey: sessions[0].sessionKey, runId: normal.run.id });
    await waitUntil(() => compactCalls === 1, 2000, "queued compact dispatch");
    assert.equal(service.workRunCoordinator.getRun(queued.run.id).status, "running");
    const sameSession = await send(1, "same-session-queued", "/compact");
    assert.equal(sameSession.disposition, "queued");
    assert.equal(sameSession.reason, "CHAT_SESSION_BUSY");
    assert.equal(compactCalls, 1);
    await service.workRunCoordinator.abort({ operationId: "cancel-queued-compact",
      sessionKey: sessions[1].sessionKey, runId: sameSession.run.id });
    host.emit({ known: true, type: "context_compacted", threadId: compactThread });
    await service.workRunCoordinator.waitForIdle(queued.run.id);
    assert.equal(service.workRunCoordinator.getRun(queued.run.id).status, "completed");
    const configTwo = service.nativeRuntimeConfig.read();
    service.nativeRuntimeConfig.apply({ ...configTwo, revision: 2, maxActive: 2 });
    const sibling = await send(0, "normal-sibling", "hold sibling");
    await service.workRunCoordinator.waitForIdle(sibling.run.id);
    const compact = await send(1, "compact-cancel-shared", "/compact");
    await waitUntil(() => compactCalls === 2, 2000, "second compact dispatch");
    await service.workRunCoordinator.abort({ operationId: "cancel-active-compact",
      sessionKey: sessions[1].sessionKey, runId: compact.run.id });
    await service.workRunCoordinator.waitForIdle(sibling.run.id);
    assert.equal(stops, 1);
    assert.equal(service.workRunCoordinator.getRun(compact.run.id).status, "canceled");
    assert.equal(service.workRunCoordinator.getRun(sibling.run.id).status, "interrupted");
    assert.equal(service.workRunCoordinator.getMemoryStats().runHostAssignments, 0);
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
