#!/usr/bin/env node
"use strict";

// Exercises the production REST -> controller -> registry -> authenticated IPC
// facade using a private config file and an in-memory Service receiver.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConfigStore, projectNativeRuntimeConfig } = require("../app/core/config-store");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { startStaticServer } = require("../app/static-server");

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-rest-"));
  let server;
  try {
    const store = createConfigStore(path.join(temp, "config.json"));
    store.write({ locale: "en", token: "private-fixture-token" });
    let applied = projectNativeRuntimeConfig(store.read());
    let failNext = false;
    const ipc = [];
    const registry = new BackendRegistry();
    registry.register(new ShoggothBackend({ paths: {}, readToken: () => "fixture-service-token",
      requestService: async (_paths, request) => {
        assert.equal(request.token, "fixture-service-token");
        ipc.push(request.method);
        if (request.method === "runtime.config.apply") {
          assert.ok(request.params.revision >= applied.revision);
          applied = request.params;
          if (failNext) { failNext = false; throw Error("fixture private failure must not escape"); }
          return applied;
        }
        assert.equal(request.method, "runtime.capacity.read");
        return { revision: applied.revision, maxActive: applied.maxActive,
          startupConcurrency: applied.startupConcurrency, enabled: applied.flags.runtimeAdmissionV1,
          active: 7, queued: 2, byReason: [{ reason: "SESSION_LOCKED", count: 2 }] };
      },
    }));
    server = await startStaticServer(0, { registry, configStore: store, homeDir: temp, userDataRoot: path.join(temp, "data") });
    const request = async (route, value, origin = server.url) => {
      const response = await fetch(`${server.url}/__api/${route}`, value === undefined ? undefined : {
        method: "PUT", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(value),
      });
      const body = await response.text();
      return { status: response.status, body: body.startsWith("{") ? JSON.parse(body) : { error: body } };
    };
    const first = await request("native-capacity");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { revision: 0, maxActive: 100, startupConcurrency: 8,
      enabled: true, active: 7, queued: 2, byReason: [{ reason: "SESSION_LOCKED", count: 2 }] });
    const update = { expectedRevision: 0, maxActive: 75, startupConcurrency: 6, enabled: true };
    assert.equal((await request("native-capacity", update, null)).status, 403);
    assert.equal((await request("native-capacity", update, "https://untrusted.example")).status, 403);
    assert.equal(store.read().nativeConcurrency.revision, 0);
    const saved = await request("native-capacity", update);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.enabled, true);
    assert.equal(applied.maxActive, 75);
    assert.equal((await request("native-capacity", update)).body.code, "NATIVE_RUNTIME_CONFIG_STALE");
    assert.equal((await request("native-capacity", { ...update, expectedRevision: 1, startupConcurrency: 17 })).status, 400);
    failNext = true;
    const failed = await request("native-capacity", { ...update, expectedRevision: 1, maxActive: 35 });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.code, "NATIVE_RUNTIME_CONFIG_APPLY_FAILED");
    assert.ok(!JSON.stringify(failed.body).includes("private"));
    assert.equal(applied.revision, 3);
    assert.equal(applied.maxActive, 75);
    assert.equal(store.read().nativeConcurrency.maxActive, 75);
    const bypass = await request("config", { locale: "zh-CN", nativeConcurrency: { revision: 999, maxActive: 1, startupConcurrency: 1 },
      runtimeFrameworkFlags: { runtimeAdmissionV1: false } });
    assert.equal(bypass.status, 200);
    assert.equal(store.read().locale, "zh-CN");
    assert.equal(store.read().nativeConcurrency.revision, 3);
    assert.equal(store.read().runtimeFrameworkFlags.runtimeAdmissionV1, true);
    assert.deepEqual(ipc, ["runtime.config.apply", "runtime.capacity.read",
      "runtime.config.apply", "runtime.capacity.read", "runtime.config.apply", "runtime.config.apply"]);
    console.log("Native config REST: passed (production routes/facade; isolated config, fake IPC).");
  } finally {
    await server?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
