#!/usr/bin/env node
"use strict";

// Production backend/coordinator/journal, isolated Gateway and stores. No real
// provider, credential or Agent is changed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createEndpointBackendFixture } = require("./fixtures/openclaw-endpoint-backend.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-endpoint-activity-"));
  const f = createEndpointBackendFixture(root);
  const request = f.backend.request.bind(f.backend);
  let revision = 0;
  let related = false;
  f.backend.request = async (method, params) => {
    if (method === "sessions.list") return { sessions: [{ key: "agent:other:active",
      providerOverride: related ? "modelscope" : "other", modelOverride: related ? "MiniMax/MiniMax-M3" : "unchanged",
      version: `v-${++revision}`, updatedAt: revision, totalTokens: revision }], hasMore: false };
    if (method === "cron.list") return { jobs: [{ id: "unrelated-cron", payload: { model: "other/unchanged" },
      revision: ++revision, state: { lastRunAtMs: revision } }], hasMore: false };
    return request(method, params);
  };
  return { ...f, relate: () => { related = true; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("editing an endpoint URL ignores unrelated Session/Cron activity", async () => {
  const f = fixture();
  try {
    const result = await f.coordinator.updateProviderCompat("openclaw", "modelscope",
      { baseUrl: "https://changed.example/v1" }, { operationId: "edit-with-activity" });
    assert.equal(result.status, "applied");
    assert.equal(f.state().writes, 1);
    assert.equal(f.coordinator.observeOperation("openclaw", { providerKey: "modelscope", operationId: "edit-with-activity" }).terminal, true);
  } finally { f.cleanup(); }
});

test("confirmed model deletion ignores unrelated Session/Cron activity", async () => {
  const f = fixture();
  try {
    const result = await f.remove("modelscope", "MiniMax/MiniMax-M3", "delete-with-activity", true);
    assert.equal(result.status, "applied");
    assert.equal(f.state().models.includes("MiniMax/MiniMax-M3"), false);
    assert.equal(f.state().writes, 1);
  } finally { f.cleanup(); }
});

test("a new related Session between preview and delete still stops before any write", async () => {
  const f = fixture();
  try {
    const preview = f.backend.previewModelChange.bind(f.backend);
    let calls = 0;
    f.backend.previewModelChange = async (spec) => {
      const value = await preview(spec);
      if (++calls === 1) f.relate();
      return value;
    };
    await assert.rejects(f.remove("modelscope", "MiniMax/MiniMax-M3", "delete-new-reference", true), { code: "preview_stale" });
    assert.equal(f.state().writes, 0);
    assert.deepEqual(f.state().journal, []);
  } finally { f.cleanup(); }
});

test("real configuration drift during an edit remains a zero-write conflict", async () => {
  const f = fixture();
  try {
    const preview = f.backend.previewModelChange.bind(f.backend);
    let changed = false;
    f.backend.previewModelChange = async (spec) => {
      const value = await preview(spec);
      if (!changed) {
        changed = true;
        const config = await f.backend._configSnapshot();
        await f.backend.request("config.patch", { baseHash: config.hash,
          raw: JSON.stringify({ agents: { defaults: { model: { primary: "other/new-default" } } } }) });
      }
      return value;
    };
    await assert.rejects(f.coordinator.updateProviderCompat("openclaw", "modelscope",
      { baseUrl: "https://changed.example/v1" }, { operationId: "edit-real-conflict" }), { code: "preview_stale" });
    assert.equal(f.state().writes, 1, "only the independent configuration edit is written");
    assert.deepEqual(f.state().journal, []);
  } finally { f.cleanup(); }
});

test("a pending catalog preserves the credential checkpoint and restart hint across journal reload", async () => {
  const f = fixture();
  try {
    f.backend._isLocalGateway = () => true;
    f.backend._usesGatewayCredentialRpc = async () => true;
    let keyWrites = 0;
    f.backend._saveProviderApiKeyViaGateway = async () => {
      keyWrites++;
      return { profileId: "modelscope:manual", restartRequired: true };
    };
    const list = f.coordinator.registry.listModelsSnapshot;
    let catalogReady = false;
    f.coordinator.registry.listModelsSnapshot = async (...args) => {
      if (!catalogReady) throw new Error("catalog refresh pending");
      return list(...args);
    };
    const operationId = "edit-saved-refresh-failed";
    const result = await f.coordinator.updateProviderCompat("openclaw", "modelscope", { apiKey: "fixture-only-key" }, { operationId });
    assert.equal(result.status, "partial");
    assert.equal(result.code, "catalog_pending");
    assert.deepEqual(result.activation, { kind: "gateway_restart", available: true });
    const { createModelChangeJournal } = require("../app/core/model-change-journal");
    f.coordinator.journal = createModelChangeJournal(f.coordinator.journal.filePath);
    // Read the durable file through the production journal, not an in-memory receipt.
    const saved = f.coordinator.journal.get(operationId);
    assert.equal(saved.secretStep, "applied");
    assert.equal(saved.fingerprints.configOnlyRestartRequired, true);
    catalogReady = true;
    const observed = await f.coordinator.recoverOperation("openclaw", { operationId, providerKey: "modelscope" });
    assert.equal(observed.status, "applied");
    assert.equal(keyWrites, 1, "recovery only reads; it never repeats the acknowledged key write");
    assert.deepEqual(f.coordinator.journal.get(operationId).result.activation, result.activation);
  } finally { f.cleanup(); }
});
