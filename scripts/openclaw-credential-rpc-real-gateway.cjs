#!/usr/bin/env node
"use strict";

// End-to-end check of custom-endpoint credential writes through the official
// Control UI RPCs, against the installed OpenClaw Gateway in an isolated temp
// state directory and a local fake OpenAI-compatible model. The production
// OpenClawBackend, ModelChangeCoordinator and durable journal run unmodified,
// wired like app/ui-entry.js (legacy runtime apply => config-only writes).
//
// It proves, per Agent, which key the real runtime sends after:
//   create endpoint with key -> legacy per-Agent override -> edit key -> rename -> clear.
// Exits 0 with "SKIP" when the installed OpenClaw lacks the official RPCs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const BIN = process.env.SHOGGOTH_TEST_OPENCLAW_BIN || "openclaw";
const TOKEN = "shoggoth-credential-rpc-fixture-token";
const MODEL = "fixture-model";
const KEYS = { create: "sk-fixture-create-0001", legacy: "sk-fixture-legacy-0002", edit: "sk-fixture-edit-0003",
  card: "sk-fixture-card-0004" };

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function installedVersion() {
  try { return execFileSync(BIN, ["--version"], { encoding: "utf8", timeout: 60_000 }).match(/(\d{4}\.\d+\.\d+)/)?.[1] || null; }
  catch { return null; }
}

/** OpenAI-compatible fake that records the bearer each request carries. */
function fakeModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* keep empty */ }
      requests.push({ auth: req.headers.authorization || null, model: parsed.model || null, at: Date.now() });
      const text = "fixture reply";
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: MODEL,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
    });
  });
  return { requests, server };
}

async function main() {
  const version = installedVersion();
  if (!version || version < "2026.9") {
    console.log(`SKIP openclaw credential RPC real gateway: installed OpenClaw ${version || "missing"} predates the official RPCs`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-credential-rpc-real-"));
  const state = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(state, "openclaw.json");
  const model = fakeModel();
  await new Promise((resolve) => model.server.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${model.server.address().port}/v1`;
  const gatewayPort = await freePort();
  const modelEntry = { id: MODEL, name: MODEL, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024 };
  fs.writeFileSync(configPath, JSON.stringify({
    models: { mode: "merge", providers: { seed: { baseUrl: modelUrl, apiKey: "seed-fixture-key", api: "openai-completions",
      models: [modelEntry] } } },
    agents: { defaults: { model: { primary: `seed/${MODEL}` }, workspace, skipBootstrap: true,
      modelPolicy: { allow: [`seed/${MODEL}`] } }, entries: { main: {}, cto: {} } },
    gateway: { mode: "local", port: gatewayPort, bind: "loopback", auth: { mode: "token", token: TOKEN }, controlUi: { enabled: true } },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    // Keep the fixture Gateway out of the user's rolling /tmp/openclaw log.
    logging: { file: path.join(root, "openclaw.log") },
  }, null, 2));
  const env = { HOME: root, PATH: process.env.PATH || "/usr/bin:/bin", LANG: process.env.LANG || "en_US.UTF-8",
    TMPDIR: os.tmpdir(), USER: process.env.USER || "fixture", LOGNAME: process.env.LOGNAME || "fixture",
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_DISABLE_BONJOUR: "1" };
  let gatewayOutput = "";
  const gateway = spawn(BIN, ["gateway", "run", "--port", String(gatewayPort), "--auth", "token", "--token", TOKEN],
    { cwd: workspace, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", (chunk) => { gatewayOutput += chunk; });
  gateway.stderr.on("data", (chunk) => { gatewayOutput += chunk; });

  // The backend reads the same isolated config/state as the Gateway.
  process.env.OPENCLAW_HOME = state;
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
  const { createOpenClawRuntimeApply } = require("../app/core/openclaw-runtime-apply");
  const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
  const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
  const { createModelChangeJournal } = require("../app/core/model-change-journal");
  const { generateIdentity, DEFAULT_OPERATOR_SCOPES } = require("../app/core/device-auth");
  const identity = generateIdentity();
  const backend = new OpenClawBackend({
    getUpstreamUrl: () => `ws://127.0.0.1:${gatewayPort}`,
    authResolver: {
      resolveConnectAuthAsync: async () => ({ ...identity, token: TOKEN, scopes: DEFAULT_OPERATOR_SCOPES }),
      storeDeviceToken() {}, clearDeviceToken() {},
    },
  });
  backend._registryPathOverride = path.join(root, "registry.json");
  let cliCalls = 0;
  const cli = backend._runModelAuthCli.bind(backend);
  backend._runModelAuthCli = (...args) => { cliCalls += 1; return cli(...args); };
  const admissionGate = createWorkAdmissionGate();
  const runtimeApply = createOpenClawRuntimeApply({ backend, admissionGate });
  backend.attachModelRuntimeApply(runtimeApply);
  backend.attachModelChangeAdapter(createOpenClawModelChange({ backend, runtimeApply }));
  // The production registry projects and fingerprints the catalog exactly as the App does.
  const { BackendRegistry } = require("../app/core/backend-registry");
  const registry = new BackendRegistry();
  registry.register(backend);
  const coordinator = new ModelChangeCoordinator({
    journal: createModelChangeJournal(path.join(root, "model-change-journal.json")),
    workAdmissionGate: admissionGate,
    registry,
  });
  coordinator.markReady();

  const report = { version, timings: {}, keys: {} };
  const timed = async (label, action) => {
    const started = Date.now();
    const value = await action();
    report.timings[label] = Date.now() - started;
    return value;
  };
  const patchConfig = async (patch) => {
    const { hash } = await backend._configSnapshot();
    await backend.request("config.patch", { raw: JSON.stringify(patch), baseHash: hash }, 15_000);
  };
  const apiKeyProfiles = async (agentId, provider) => (await backend._gatewayAuthProfileRows(agentId) || [])
    .filter((row) => backend._gatewayRowsForProvider([row], provider).length && row.type === "api_key")
    .map((row) => `${row.profileId}:${row.source}`).sort();
  // One real turn per Agent; the fake model records the bearer the runtime chose.
  const keyUsedBy = async (agentId, provider) => {
    const before = model.requests.length;
    await backend.request("chat.send", { sessionKey: `agent:${agentId}:credential-${randomUUID().slice(0, 8)}`,
      message: `ping ${provider}`, idempotencyKey: randomUUID() }, 30_000);
    const hit = await waitUntil(() => model.requests.slice(before).find((request) => request.model === MODEL), 60_000,
      `${agentId} model request`);
    return hit.auth ? hit.auth.replace(/^Bearer\s+/i, "") : null;
  };

  try {
    await waitUntil(async () => { await backend._connect(); return true; }, 90_000, "Gateway start");
    assert.equal(await backend._usesGatewayCredentialRpc(), true, `Gateway ${version} must advertise the official RPCs`);

    // 1. New custom endpoint with a key (the "新增模型" button).
    const created = await timed("createEndpointWithKey", () => coordinator.applyCompat("openclaw", {
      providerKey: "xmxm", providerMode: "new", baseUrl: modelUrl, api: "openai-completions",
      apiKey: KEYS.create, model: { id: MODEL },
    }, { operationId: "real-create" }));
    if (created.status !== "applied") {
      const probe = await backend.getModelCatalogSources({ fresh: true }).then(() => "catalog ok on reread", (error) => ({
        message: error.message, code: error.code, cause: error.cause?.message, causeCode: error.cause?.code }));
      console.error("catalog probe after create:", JSON.stringify(probe));
    }
    assert.equal(created.status, "applied", JSON.stringify(created));
    await patchConfig({ agents: { defaults: { model: { primary: `xmxm/${MODEL}` } } } });
    report.keys.afterCreate = { main: await keyUsedBy("main", "xmxm"), cto: await keyUsedBy("cto", "xmxm") };
    assert.deepEqual(report.keys.afterCreate, { main: KEYS.create, cto: KEYS.create });

    // 2. A legacy per-Agent override exactly like older Shoggoth versions left behind.
    execFileSync(BIN, ["--no-color", "models", "auth", "paste-api-key", "--provider", "xmxm",
      "--profile-id", "xmxm:default", "--agent", "cto"], { env, input: `${KEYS.legacy}\n`, timeout: 120_000, stdio: ["pipe", "ignore", "ignore"] });
    report.profilesWithLegacy = { main: await apiKeyProfiles("main", "xmxm"), cto: await apiKeyProfiles("cto", "xmxm") };

    // 3. Edit endpoint and replace the key (the "编辑自定义端点" save).
    const edited = await timed("editEndpointKey", () => coordinator.updateProviderCompat("openclaw", "xmxm",
      { apiKey: KEYS.edit }, { operationId: "real-edit" }));
    assert.equal(edited.status, "applied", JSON.stringify(edited));
    report.profilesAfterEdit = { main: await apiKeyProfiles("main", "xmxm"), cto: await apiKeyProfiles("cto", "xmxm") };
    assert.deepEqual(report.profilesAfterEdit.cto.filter((row) => row.startsWith("xmxm:default")), [],
      "the legacy per-Agent override is removed");
    report.keys.afterEdit = { main: await keyUsedBy("main", "xmxm"), cto: await keyUsedBy("cto", "xmxm") };
    assert.deepEqual(report.keys.afterEdit, { main: KEYS.edit, cto: KEYS.edit });
    const revealed = await backend.revealModelProviderKey("xmxm");
    assert.equal(revealed.apiKey, KEYS.edit, "reveal reads the bound official profile");

    // 4. Rename the endpoint (changing its ID in the editor).
    const renamed = await timed("renameEndpoint", () => coordinator.updateProviderCompat("openclaw", "xmxm",
      { renameTo: "mimo" }, { operationId: "real-rename" }));
    assert.equal(renamed.status, "applied", JSON.stringify(renamed));
    report.keys.afterRename = { main: await keyUsedBy("main", "mimo"), cto: await keyUsedBy("cto", "mimo") };
    assert.deepEqual(report.keys.afterRename, { main: KEYS.edit, cto: KEYS.edit });
    report.profilesAfterRename = { old: await apiKeyProfiles("main", "xmxm"), cto: await apiKeyProfiles("cto", "mimo") };
    assert.deepEqual(report.profilesAfterRename.old, [], "the old ID keeps no key");

    // 5. Clear the endpoint key.
    const cleared = await timed("clearEndpointKey", () => coordinator.updateProviderCompat("openclaw", "mimo",
      { clearApiKey: true }, { operationId: "real-clear" }));
    assert.equal(cleared.status, "applied", JSON.stringify(cleared));
    report.profilesAfterClear = { main: await apiKeyProfiles("main", "mimo"), cto: await apiKeyProfiles("cto", "mimo") };
    assert.deepEqual(report.profilesAfterClear, { main: [], cto: [] });

    // 6. Provider card: a built-in provider key with no config connection.
    const card = await timed("providerCardKey", () => backend.setModelAuthProfileKey("openrouter", KEYS.card));
    assert.equal(card.activation, null);
    report.cardProfiles = { main: await apiKeyProfiles("main", "openrouter"), cto: await apiKeyProfiles("cto", "openrouter") };
    assert.ok(report.cardProfiles.main.length === 1 && report.cardProfiles.cto.length === 1, JSON.stringify(report.cardProfiles));
    const cardCleared = await timed("providerCardClear", () => backend.clearModelAuthProviderKeys("openrouter"));
    assert.ok(cardCleared.removed >= 1);
    report.cardProfilesAfterClear = { main: await apiKeyProfiles("main", "openrouter"), cto: await apiKeyProfiles("cto", "openrouter") };
    assert.deepEqual(report.cardProfilesAfterClear, { main: [], cto: [] });

    assert.equal(cliCalls, 0, "no Shoggoth code path started the OpenClaw CLI");
    const journal = fs.readFileSync(path.join(root, "model-change-journal.json"), "utf8");
    for (const key of Object.values(KEYS)) assert.equal(journal.includes(key), false, "keys never enter the journal");
    for (const [label, ms] of Object.entries(report.timings)) assert.ok(ms < 30_000, `${label} took ${ms}ms`);
    console.log(JSON.stringify(report, null, 2));
    console.log("openclaw credential RPC real gateway: PASS");
  } catch (error) {
    console.error(JSON.stringify(report, null, 2));
    console.error(gatewayOutput.slice(-4000));
    throw error;
  } finally {
    await backend.stop().catch(() => {});
    try { process.kill(-gateway.pid, "SIGTERM"); } catch { /* already exited */ }
    await new Promise((resolve) => model.server.close(resolve));
    await sleep(500);
    try { process.kill(-gateway.pid, "SIGKILL"); } catch { /* already exited */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
