#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { startStaticServer } = require("../app/static-server");
const { createEndpointBackendFixture } = require("./fixtures/openclaw-endpoint-backend.cjs");
const root = path.resolve(__dirname, "..");
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-save-integration-"));
  const transport = global.fetch;
  let server;
  try {
    const output = path.join(directory, "controller.cjs");
    await uiRequire("esbuild").build({
      stdin: { contents: 'export { createOpenClawEndpointController } from "./app/manage-ui/src/pages/models/openclaw-endpoint-controller"; export { createEndpointMutationSession } from "./app/manage-ui/src/pages/models/endpoint-controller";', resolveDir: root, loader: "ts" },
      platform: "node", format: "cjs", bundle: true, outfile: output,
      nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent",
    });
    const { createOpenClawEndpointController, createEndpointMutationSession } = require(output);
    const fixture = createEndpointBackendFixture(directory, { latePrimary: true, batchModelSelection: false });
    server = await startStaticServer(0, { registry: fixture.coordinator.registry,
      modelChangeCoordinator: fixture.coordinator, homeDir: directory, userDataRoot: directory });
    global.fetch = (input, init) => transport(new URL(input, server.url), init);
    const controller = createOpenClawEndpointController("openclaw");
    await controller.list();
    const session = createEndpointMutationSession("openclaw", "edit", "first-intent");
    const draft = { id: "modelscope", name: "modelscope", baseUrl: "https://fixture.example/v1", model: "MiniMax/MiniMax-M3", models: ["MiniMax/MiniMax-M3"] };
    let result = await controller.save(draft, session);
    for (let count = 0; count < 2; count++) {
      assert.equal(result.recovery.blockedRemoval.operationId, `first-intent:delete:${count}`);
      result = await controller.confirmBlockedRemoval(session, result.recovery.blockedRemoval.operationId);
    }
    assert.equal(result.code, "primary_model_in_use");
    assert.equal(result.recovery.locked, false);
    assert.equal(result.steps.filter(step => step.status === "applied").length, 2);
    assert.equal(fixture.state().writes, 2);
    assert.equal(result.recovery.baseline.primaryModelUsage.length, 2);
    // This is the exact real-journal failure the old modal caused by recycling
    // its root ID after two committed children. The guard must remain intact.
    await assert.rejects(fixture.remove("modelscope", "MiniMax/MiniMax-M3", "first-intent:delete:0", true),
      error => error.code === "operation_reused");
    assert.equal(fixture.state().writes, 2);
    const nextSession = createEndpointMutationSession("openclaw", "edit", "edited-intent");
    const required = result.recovery.baseline.primaryModelUsage.map(item => item.modelId);
    result = await controller.save({ ...draft, model: required[0], models: required }, nextSession);
    assert.equal(result.recovery.blockedRemoval.operationId, "edited-intent:delete:0");
    result = await controller.confirmBlockedRemoval(nextSession, result.recovery.blockedRemoval.operationId);
    assert.equal(result.status, "applied");
    assert.equal(result.sync, "synced");
    assert.deepEqual(fixture.state().models, required);
    assert.deepEqual(fixture.state().journal.map(row => row.operationId), [
      "first-intent:delete:0", "first-intent:delete:1", "edited-intent:delete:0",
    ]);
    assert.equal(fixture.state().writes, 3);
    assert.equal(fixture.state().primary.main, "modelscope/deepseek-ai/DeepSeek-V4-Flash");
    assert.equal(fixture.state().primary.sara, fixture.state().primary.main);
    assert.equal(fixture.state().primary.travelplanner, "modelscope/ZhipuAI/GLM-5.2");
    console.log("PASS: production client/controller/REST/coordinator/journal/config-only write; partial save -> primary blocker -> edited new intent; 3 writes, all primary models retained");
    await server.close();
    const batchFixture = createEndpointBackendFixture(path.join(directory, "batch"), {
      latePrimary: true, extraModels: ["old-four", "old-five"], catalogDelayMs: 80,
    });
    server = await startStaticServer(0, { registry: batchFixture.coordinator.registry,
      modelChangeCoordinator: batchFixture.coordinator, homeDir: directory, userDataRoot: directory });
    const batchController = createOpenClawEndpointController("openclaw");
    await batchController.list();
    const conflict = await batchController.save({ ...draft, models: ["new-one"], model: "new-one" },
      createEndpointMutationSession("openclaw", "edit", "batch-primary"));
    assert.equal(conflict.code, "primary_model_in_use");
    assert.equal(conflict.recovery.locked, true);
    assert.equal(conflict.canForce, true);
    assert.equal(conflict.recovery.blockedRemoval.operationId, "batch-primary:selection");
    assert.equal(conflict.recovery.baseline.primaryModelUsage.length, 2);
    assert.equal(batchFixture.state().writes, 0, "primary conflicts stop the entire selection before any addition/removal");
    const batchRequired = conflict.recovery.baseline.primaryModelUsage.map(item => item.modelId);
    const batchInput = { ...draft, model: batchRequired[0], models: [...batchRequired, "new-one", "new-two"] };
    const batchSession = createEndpointMutationSession("openclaw", "edit", "batch-selection");
    let batchResult = await batchController.save(batchInput, batchSession);
    assert.equal(batchResult.code, "references_exist");
    assert.equal(batchResult.recovery.blockedRemoval.modelIds.length, 5);
    assert.equal(batchFixture.state().writes, 0);
    assert.equal(batchFixture.state().catalogReads, 0);
    batchResult = await batchController.confirmBlockedRemoval(batchSession, batchResult.recovery.blockedRemoval.operationId);
    assert.equal(batchResult.status, "applied");
    assert.equal(batchResult.sync, "synced");
    assert.equal(batchFixture.state().writes, 1, "five removals and two additions share one configuration patch");
    assert.equal(batchFixture.state().catalogReads, 1, "the slow runtime catalog is refreshed once for the whole selection");
    assert.equal(batchFixture.state().endpointReadOptions.at(-1).refreshAuth, false,
      "model-only save readback must not start another authorization CLI process");
    assert.deepEqual(new Set(batchFixture.state().models), new Set(batchInput.models));
    assert.deepEqual(batchFixture.state().fallbacks, ["modelscope/deepseek-ai/DeepSeek-V4-Flash"]);
    assert.deepEqual(new Set(batchFixture.state().allowed), new Set(batchInput.models.map(id => `modelscope/${id}`)));
    assert.deepEqual(batchFixture.state().primary, fixture.state().primary);
    // Keep the exact frozen batch and confirmation after a committed write's
    // response is lost. Replaying it must not write a second time.
    const lostSession = createEndpointMutationSession("openclaw", "edit", "batch-lost");
    const lostInput = { ...draft, model: batchRequired[0], models: batchRequired };
    let lost = await batchController.save(lostInput, lostSession);
    const blockedId = lost.recovery.blockedRemoval.operationId;
    let loseResponse = true;
    global.fetch = async (input, init) => {
      const response = await transport(new URL(input, server.url), init);
      if (loseResponse && String(input).includes("/config/batch") && JSON.parse(init.body).force) {
        loseResponse = false;
        await response.text();
        throw new Error("simulated lost response");
      }
      return response;
    };
    lost = await batchController.confirmBlockedRemoval(lostSession, blockedId);
    assert.equal(lost.status, "partial");
    assert.equal(lost.recovery.locked, true);
    assert.equal(batchFixture.state().writes, 2);
    lost = await batchController.retry(lostSession);
    assert.equal(lost.status, "applied");
    assert.equal(lost.sync, "synced");
    assert.equal(batchFixture.state().writes, 2, "uncertain batch retry is an idempotent zero-write");
    const attempts = batchFixture.state().requests.filter(request => request.operationId === "batch-lost:selection" && request.force);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    console.log("PASS: atomic endpoint reselection; five removals + two additions = one patch and one fresh catalog; primary/reference guards, fallback cleanup, lost-response retry");
    global.fetch = (input, init) => transport(new URL(input, server.url), init);
    const primaryBefore = structuredClone(batchFixture.state().primary);
    const primarySession = createEndpointMutationSession("openclaw", "edit", "confirmed-primary");
    let primaryResult = await batchController.save({ ...draft, models: ["replacement-choice"], model: "replacement-choice" }, primarySession);
    assert.equal(primaryResult.code, "primary_model_in_use");
    assert.equal(primaryResult.canForce, true);
    assert.equal(batchFixture.state().writes, 2, "removing a primary requires confirmation before any write");
    await assert.rejects(batchFixture.coordinator.batchCompat("openclaw", [
      { op: "delete", providerKey: "modelscope", modelId: batchRequired[0] },
    ], { force: true, preservePrimaryRefs: true }), error => error.code === "primary_model_in_use",
    "a generic force batch cannot bypass the endpoint reference confirmation path");
    primaryResult = await batchController.confirmBlockedRemoval(primarySession, primaryResult.recovery.blockedRemoval.operationId);
    assert.equal(primaryResult.status, "applied");
    assert.equal(primaryResult.sync, "synced");
    assert.equal(batchFixture.state().writes, 3);
    assert.deepEqual(batchFixture.state().models, ["replacement-choice"]);
    assert.deepEqual(batchFixture.state().primary, primaryBefore, "deselection must never choose another primary for an assistant");
    const reopened = await batchController.list();
    assert.equal(reopened.endpoints[0].primaryModelUsage.length, 2, "retained bindings remain visible after a confirmed removal");
    assert.deepEqual(reopened.endpoints[0].models, ["replacement-choice"], "removed primaries must not be silently selected again");
    console.log("PASS: confirmed primary deselection persists while preserving all Agent bindings; reopening and ordinary batch guards");
    await server.close();
    const createFixture = createEndpointBackendFixture(path.join(directory, "create"));
    const createRpc = createFixture.backend.request.bind(createFixture.backend);
    let activityRevision = 0;
    createFixture.backend.request = async (method, params) => {
      if (method === "sessions.list") return { sessions: [{ key: "agent:other:active",
        providerOverride: "other", modelOverride: "unchanged-model", updatedAt: ++activityRevision,
        totalTokens: activityRevision }], hasMore: false };
      if (method === "cron.list") return { jobs: [{ id: "unrelated-job", payload: { model: "other/unchanged-model" },
        state: { lastRunAtMs: ++activityRevision } }], hasMore: false };
      return createRpc(method, params);
    };
    server = await startStaticServer(0, { registry: createFixture.coordinator.registry,
      modelChangeCoordinator: createFixture.coordinator, homeDir: directory, userDataRoot: directory });
    const createController = createOpenClawEndpointController("openclaw");
    await createController.list();
    const createDraft = { id: "newendpoint", name: "newendpoint", baseUrl: "https://fixture.example/v1",
      model: "fixture-model", models: ["fixture-model"] };
    const created = await createController.save(createDraft,
      createEndpointMutationSession("openclaw", "create", "create-with-activity"));
    assert.equal(created.status, "applied", "unrelated Session/Cron activity must not invalidate endpoint creation");
    assert.equal(created.sync, "synced");
    assert.deepEqual(created.snapshot.endpoints.find(endpoint => endpoint.id === createDraft.id).models, createDraft.models);
    assert.equal(createFixture.state().writes, 1);
    assert.deepEqual(createFixture.state().journal.map(row => [row.operationId, row.status]), [["create-with-activity:provider", "applied"]]);
    assert.equal(createFixture.state().allowed.includes("newendpoint/fixture-model"), true);
    console.log("PASS: new endpoint saves and reads back through client/controller/REST/coordinator despite unrelated Session/Cron activity");
    await server.close();
    const staleDirectory = path.join(directory, "create-config-conflict");
    const staleFixture = createEndpointBackendFixture(staleDirectory);
    const originalPreview = staleFixture.backend.previewModelChange.bind(staleFixture.backend);
    let externalWrites = 0;
    staleFixture.backend.previewModelChange = async (spec) => {
      const preview = await originalPreview(spec);
      if (externalWrites === 0) {
        const snapshot = await staleFixture.backend._configSnapshot();
        // A separate configuration edit really changes the fixture's hash between
        // the initial preview and the provider-locked preflight.
        await staleFixture.backend.request("config.patch", { baseHash: snapshot.hash,
          raw: JSON.stringify({ agents: { defaults: { model: { primary: "other/changed-default" } } } }) });
        externalWrites++;
      }
      return preview;
    };
    server = await startStaticServer(0, { registry: staleFixture.coordinator.registry,
      modelChangeCoordinator: staleFixture.coordinator, homeDir: directory, userDataRoot: directory });
    const staleController = createOpenClawEndpointController("openclaw");
    await staleController.list();
    const stale = await staleController.save(createDraft,
      createEndpointMutationSession("openclaw", "create", "create-config-stale"));
    assert.equal(stale.code, "preview_stale");
    assert.equal(stale.status, "blocked");
    assert.equal(stale.stage, "preflight");
    assert.equal(stale.recovery.locked, false, "proven zero-write conflicts must leave the draft editable");
    assert.equal(staleFixture.state().writes, externalWrites, "the rejected create must not write configuration");
    assert.deepEqual(staleFixture.state().journal, [], "config conflicts must stop before journal.begin");
    assert.equal(fs.existsSync(path.join(staleDirectory, "model-change-journal.json")), false);
    assert.equal(stale.snapshot.endpoints.some(endpoint => endpoint.id === createDraft.id), false);
    const revisedDraft = { ...createDraft, model: "revised-model", models: ["revised-model"] };
    const revised = await staleController.save(revisedDraft,
      createEndpointMutationSession("openclaw", "create", "create-after-conflict"));
    assert.equal(revised.status, "applied");
    assert.equal(revised.sync, "synced");
    assert.deepEqual(revised.snapshot.endpoints.find(endpoint => endpoint.id === createDraft.id).models, revisedDraft.models);
    assert.equal(staleFixture.state().writes, externalWrites + 1);
    assert.deepEqual(staleFixture.state().journal.map(row => [row.operationId, row.status]), [["create-after-conflict:provider", "applied"]]);
    console.log("PASS: real config drift returns preview_stale before journal/config writes, unlocks the draft, and allows a revised submission");
  } finally {
    global.fetch = transport;
    await server?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
