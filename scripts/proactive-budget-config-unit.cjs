"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const app = process.env.SHOGGOTH_PROACTIVE_APP_PATH;
const source = app ? path.join(app, "Contents/Resources/app.asar/app") : path.resolve(__dirname, "../app");
const { createAgentService } = require(path.join(source, "agent-service/server"));
const { resolveServicePaths } = require(path.join(source, "agent-service/paths"));
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(source, "agent-service/product-store"));
const { requestService, readClientToken } = require(path.join(source, "agent-service/client"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(source, "agent-service/service-protocol-version"));

test("daily inspiration accepts ten million tokens through IPC and preserves other settings across restart", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-daily-budget-")));
  const paths = resolveServicePaths({ trustedRoot: root, homeDir: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, autoSparkNotes: false, prewarmMcpAuth: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    proactiveProfileAvailable: () => true, setProactiveTimer: () => 1, clearProactiveTimer() {},
    setCronTimer: () => 1, clearCronTimer() {} });
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true }); });
  await service.start();
  const rpc = (method, params) => requestService(paths, { token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params });
  const get = () => rpc("proactive.monitor.get", { kind: "inspiration", profileId: null });
  const set = (config, expectedRevision) => rpc("proactive.monitor.set", { operationId: crypto.randomUUID(), expectedRevision, config });
  const original = (await get()).monitor;
  const priorConfig = { ...original.config, profileId: DEFAULT_AGENT_PROFILE_ID, enabled: false,
    schedule: { kind: "cron", expr: "0 10 * * *", tz: "Asia/Shanghai" }, timezone: "Asia/Shanghai",
    budget: { maxRunsPerDay: 1, maxTokensPerDay: 20_000 } };
  const prior = (await set(priorConfig, original.revision)).monitor;
  const desired = { ...prior.config, budget: { ...prior.config.budget, maxTokensPerDay: 10_000_000 } };
  for (const maxTokensPerDay of [10_000_001, 1023, 10_000_000.5]) {
    await assert.rejects(() => set({ ...desired, budget: { ...desired.budget, maxTokensPerDay } }, prior.revision), { code: "PROACTIVE_INVALID" });
  }
  assert.deepEqual((await get()).monitor, prior);
  const updated = (await set(desired, prior.revision)).monitor;
  assert.deepEqual(updated.config, desired);
  await assert.rejects(() => set(prior.config, prior.revision), { code: "PROACTIVE_REVISION_CONFLICT" });
  await service.stop({ notify: false }); await service.start();
  assert.deepEqual((await get()).monitor.config, desired);
  assert.equal(service.workDispatcher.listRuns({ source: "proactive" }).length, 0);
});
