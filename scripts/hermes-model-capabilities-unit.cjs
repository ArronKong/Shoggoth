"use strict";

// Public catalog -> session controls, entirely in-memory. No user configuration,
// native session, credential, or provider request is read or written.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HermesBackend } = require("../app/core/hermes-backend");
const { computeCatalogRevision } = require("../app/core/model-catalog-revision");

const model = "mimo-v2.6-pro";
const levels = ["none", "high"];
const custom = { slug: "custom:xiaomi", name: "xiaomi1", source: "user-config", is_user_defined: true,
  api_url: "https://token-plan-cn.xiaomimimo.com/v1", api_mode: "codex_responses", models: [model], capabilities: { [model]: { reasoning: true } } };
const builtin = { slug: "xiaomi", name: "Xiaomi MiMo", models: [model, "mimo-v2-flash"] };

async function fixture(providers = [builtin, custom]) {
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local" }) });
  backend._hermesHomeForProfile = profile => path.join(os.tmpdir(), `absent-hermes-fixture-${process.pid}`, profile);
  const key = "agent:hermes-default:stored";
  const dash = { baseUrl: "http://fixture.invalid", token: "fixture" };
  backend.profileById.set("hermes-default", "default");
  backend.dashboards.set("default", dash);
  backend._dashGet = async () => ({ status: 200, body: JSON.stringify({ providers }) });
  await backend.refreshModelChoices();
  const calls = [];
  let effort = "xhigh";
  const sock = { generation: 1, request: async (method, params) => {
    calls.push({ method, ...params });
    if (method === "config.get") return { value: effort };
    if (method === "config.set") {
      if (params.key === "reasoning") effort = params.value;
      return { value: params.key === "model" ? params.value.split(" ")[0] : params.value };
    }
    throw Error(`Unexpected ${method}`);
  } };
  const mapping = { profile: "default", runtimeId: "runtime", storedId: "stored", generation: 1, resumed: true, agentBuilt: true };
  backend.gwRuntimeByKey.set(key, mapping);
  backend.gwSockets.set("default", sock);
  backend._gwSocket = () => sock;
  backend.sessionRows = [{ key, agentId: "hermes-default", model, modelProvider: custom.slug }];
  backend._gwApplySessionInfo(key, { model, provider: custom.slug, reasoning_effort: effort });
  return { backend, key, sock, mapping, calls, get effort() { return effort; }, set effort(value) { effort = value; } };
}

test("catalog keeps builtin/custom identity, configured name, profile and supported efforts", async () => {
  const { backend } = await fixture();
  const models = await backend.getModels();
  const row = models.find(row => row.provider === custom.slug);
  assert.equal(row.providerName, "xiaomi1");
  assert.equal(row.acpProviderRef, "custom:xiaomi");
  assert.deepEqual(row.thinkingOptions, levels);
  assert.deepEqual(row.modelScopes, ["default"]);
  assert.equal(models.filter(row => row.id === model).length, 2);
  assert.deepEqual(models.find(row => row.id === model && row.provider === "xiaomi").thinkingOptions, []);
  assert.equal(backend.getChatCapabilities("hermes-default").modelScope, "default");
  assert.equal(computeCatalogRevision({ runtime: [row] }) === computeCatalogRevision({ runtime: [{ ...row, providerName: "Renamed" }] }), false);
  assert.equal(JSON.stringify(models).includes("xiaomimimo.com"), false, "endpoint URL is not a public model field");
});

test("same model on another route keeps its own declared effort and non-reasoning policy", async () => {
  const { backend } = await fixture([custom,
    { ...custom, slug: "custom:xiaomi-chat", api_mode: "chat_completions" },
    { slug: "other", models: [model], capabilities: { [model]: { reasoning: true, supported_efforts: ["low", "high", "max"] } } },
    { slug: "plain", models: [model], capabilities: { [model]: { reasoning: false } } },
    { ...custom, slug: "lookalike", api_url: "https://xiaomimimo.com.example.invalid/v1" },
  ]);
  const rows = await backend.getModels();
  assert.deepEqual(rows.find(row => row.provider === "other").thinkingOptions, ["low", "high", "max"]);
  assert.deepEqual(rows.find(row => row.provider === "plain").thinkingOptions, []);
  assert.deepEqual(rows.find(row => row.provider === "custom:xiaomi-chat").thinkingOptions, []);
  assert.deepEqual(rows.find(row => row.provider === "lookalike").thinkingOptions, [], "a lookalike endpoint inherits no vendor policy");
  assert.equal(backend._modelThinkingOptions(model, undefined, "default"), undefined, "ambiguous routes are not guessed");
});

test("new MiMo models stay discoverable without inheriting a guessed effort list", async () => {
  const future = "mimo-future-fixture";
  const f = await fixture([{ ...custom, models: [model, future] }]);
  const models = await f.backend.getModels();
  assert.deepEqual(models.find(row => row.id === model).thinkingOptions, levels);
  assert.deepEqual(models.find(row => row.id === future).thinkingOptions, []);
  assert.equal(models.find(row => row.id === future).thinkingDefault, undefined);
});

test("explicit runtime capabilities can expand both existing and new MiMo models", async () => {
  const future = "mimo-future-fixture";
  const f = await fixture();
  const expanded = ["none", "low", "medium", "high", "xhigh", "max"];
  f.backend._dashGet = async () => ({ status: 200, body: JSON.stringify({ providers: [{ ...custom,
    models: [model, future], capabilities: {
      [model]: { reasoning: true, supported_efforts: expanded },
      [future]: { reasoning: true, supported_efforts: ["low", "high", "max"] },
    },
  }] }) });
  await f.backend.refreshModelChoices();
  const models = await f.backend.getModels();
  assert.deepEqual(models.find(row => row.id === model).thinkingOptions, expanded);
  assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, expanded, "open session controls refresh with the catalog");
  assert.deepEqual(models.find(row => row.id === future).thinkingOptions, ["low", "high", "max"]);
  await f.backend.setSessionThinking(f.key, { level: "max" });
  assert.equal(f.effort, "max", "explicit capability overrides the legacy fallback and allows selection");
});

test("a Hermes Profile reads its exact aggregator's efforts and ignores stale, remote, or differently routed declarations", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-effort-catalog-"));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  fs.mkdirSync(path.join(home, "cache"));
  const cache = path.join(home, "cache", "reasoning_caps.json");
  const routerModel = "deepseek/deepseek-v4.1-flash";
  const entry = (efforts, secondsAgo = 0) => ({ ts: Date.now() / 1000 - secondsAgo,
    caps: { [routerModel]: { supports_reasoning: true, supported_efforts: efforts, mandatory: true } } });
  const data = (age = 0) => ({
    "https://openrouter.ai/api/v1/models": entry(["max", "low", "none", "high"], age),
    "https://inference-api.nousresearch.com/v1/models": entry(["medium", "none"]),
  });
  fs.writeFileSync(cache, JSON.stringify(data()), { mode: 0o644 });
  const f = await fixture([]);
  f.backend._hermesHomeForProfile = profile => profile === "default" ? home : path.join(home, "other");
  f.backend._dashGet = async () => ({ status: 200, body: JSON.stringify({ providers: [
    { slug: "openrouter", models: [routerModel] },
    { slug: "nous", models: [routerModel] },
    { slug: "custom:relay", api_url: "https://relay.invalid/api/v1", models: [routerModel] },
    { slug: "zai", models: ["glm-5.3", "glm-5.2"] },
    { slug: "deepseek", models: ["deepseek-v4-flash"] },
    { slug: "openai-codex", models: ["gpt-6.1-sol", "gpt-unlisted"] },
  ] }) });
  f.backend.dashboards.set("other", { baseUrl: "http://other.fixture.invalid", token: "other" });
  f.backend._gwApplySessionInfo(f.key, { model: routerModel, provider: "openrouter" });
  await f.backend.refreshModelChoices();
  assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, ["low", "high", "max"]);
  assert.deepEqual(f.backend._modelThinkingOptions(routerModel, "nous", "default"), ["medium"]);
  assert.deepEqual(f.backend._modelThinkingOptions(routerModel, "openrouter", "other"), []);
  assert.deepEqual(f.backend._modelThinkingOptions(routerModel, "custom:relay", "default"), []);
  assert.deepEqual(f.backend._modelThinkingOptions("glm-5.3", "zai", "default"), ["none", "low", "medium", "high", "max"]);
  assert.deepEqual(f.backend._modelThinkingOptions("deepseek-v4-flash", "deepseek", "default"), ["none", "low", "high", "max"]);
  assert.deepEqual(f.backend._modelThinkingOptions("gpt-6.1-sol", "openai-codex", "default"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(f.backend._modelThinkingOptions("gpt-unlisted", "openai-codex", "default"), []);
  await f.backend.setSessionThinking(f.key, { level: "max" });
  assert.equal(f.calls.at(-1).value, "max");
  fs.chmodSync(cache, 0o666);
  await f.backend.refreshModelChoices();
  assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, [], "other users cannot write the catalog");
  fs.chmodSync(cache, 0o644);
  fs.writeFileSync(cache, JSON.stringify(data(86_401)));
  await f.backend.refreshModelChoices();
  assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, []);
  fs.writeFileSync(cache, JSON.stringify(data()));
  f.backend._getConfig = () => ({ hermesMode: "remote" });
  await f.backend.refreshModelChoices();
  assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, []);
});

test("an explicit empty capability is never replaced with the legacy MiMo fallback", async () => {
  const f = await fixture([{ ...custom, capabilities: { [model]: { reasoning: true, supported_efforts: [] } } }]);
  assert.deepEqual((await f.backend.getModels())[0].thinkingOptions, []);
});

test("other providers never turn a reasoning boolean, a missing catalog or an ambiguous route into eight efforts", async () => {
  const f = await fixture([
    { slug: "boolean-only", models: [model], capabilities: { [model]: { reasoning: true } } },
    { slug: "undeclared", models: [model] },
    { slug: "declared", models: [model], capabilities: { [model]: { supported_efforts: ["low", "high", "max"] } } },
  ]);
  for (const provider of ["boolean-only", "undeclared", "missing"]) {
    f.backend._gwApplySessionInfo(f.key, { model, provider, reasoning_effort: "xhigh" });
    assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, []);
    await assert.rejects(f.backend.setSessionThinking(f.key, { level: "high" }), /明确数据/u);
    await f.backend._gwNormalizeThinking(f.key, f.mapping, f.sock);
  }
  assert.deepEqual(f.calls, [], "unknown policy never rewrites an existing session's effort");
  const row = { model, agentId: "hermes-default" };
  f.backend._applyModelThinkingToRow(row);
  assert.deepEqual(row.thinkingOptions, [], "ambiguous model identity cannot borrow another provider's effort list");
});

test("switching from a high-effort model preserves the selected custom provider and normalizes effort", async () => {
  const f = await fixture();
  f.backend._gwApplySessionInfo(f.key, { model: "codex-model", provider: "openai-codex", reasoning_effort: "xhigh" });
  await f.backend.setSessionModel(f.key, { model, provider: custom.slug });
  assert.match(f.calls[0].value, /--provider custom:xiaomi --session$/u);
  assert.equal(f.effort, "high");
  assert.equal(f.backend.sessionRows[0].thinkingLevel, "high");
  assert.deepEqual(f.backend.sessionRows[0].thinkingOptions, levels);
  assert(f.calls.every(row => row.session_id === "runtime"), "no profile/global setting writes");
});

for (const [requested, effective] of [["xhigh", "high"], ["max", "high"], ["ultra", "high"], ["minimal", "high"], ["none", "none"], ["low", "high"]]) {
  test(`resumed session reads actual ${requested} and uses ${effective}`, async () => {
    const f = await fixture(); f.effort = requested;
    await f.backend._gwNormalizeThinking(f.key, f.mapping, f.sock);
    assert.equal(f.effort, effective);
    assert.equal(f.calls[0].method, "config.get");
    assert.equal(f.calls.filter(row => row.method === "config.set").length, requested === effective ? 0 : 1);
  });
}

test("explicit unsupported effort is rejected before a configuration write", async () => {
  const f = await fixture();
  await assert.rejects(f.backend.setSessionThinking(f.key, { level: "xhigh" }), /不支持思考档/u);
  assert.deepEqual(f.calls, []);
  await f.backend.setSessionThinking(f.key, { level: "none" });
  assert.equal(f.effort, "none");
});

test("legacy generic custom identity uses only unambiguous policy", async () => {
  const f = await fixture();
  f.backend._gwApplySessionInfo(f.key, { model, provider: "custom", reasoning_effort: "max" });
  await f.backend._gwNormalizeThinking(f.key, f.mapping, f.sock);
  assert.equal(f.effort, "high");
});

test("a connection, model or effort change while reading effort prevents a write", async () => {
  for (const change of [f => f.backend._lifecycleGeneration++, f => f.backend._gwApplySessionInfo(f.key, { model: "other" }),
    f => f.backend._gwApplySessionInfo(f.key, { reasoning_effort: "low" })]) {
    const f = await fixture();
    f.sock.request = async (method) => { assert.equal(method, "config.get"); change(f); return { value: "xhigh" }; };
    await assert.rejects(f.backend._gwNormalizeThinking(f.key, f.mapping, f.sock), /设置已变化/u);
  }
});

test("effective supported effort replaces a stale session display without a write", async () => {
  const f = await fixture(); f.effort = "high";
  await f.backend._gwNormalizeThinking(f.key, f.mapping, f.sock);
  assert.equal(f.backend.sessionRows[0].thinkingLevel, "high");
  assert.equal(f.calls.filter(row => row.method === "config.set").length, 0);
});

test("another profile's model does not enter this Agent's model scope", async () => {
  const f = await fixture();
  f.backend.profileById.set("hermes-other", "other");
  const otherDash = { baseUrl: "http://other.fixture.invalid", token: "other" };
  f.backend.dashboards.set("other", otherDash);
  f.backend._dashGet = async dash => ({ status: 200, body: JSON.stringify({ providers: dash === otherDash
    ? [{ slug: "other-only", models: ["other-model"] }] : [custom] }) });
  await f.backend.refreshModelChoices();
  const rows = await f.backend.getModels();
  assert.deepEqual(rows.filter(row => row.modelScopes.includes("default")).map(row => row.id), [model]);
});

test("request errors supersede the generic no-response text and persist typed causes", async () => {
  const f = await fixture();
  for (const [error, surface, expected] of [
    ["HTTP 400: Param Incorrect", "format_error", "思考档位"],
    ["reasoning_effort must be one of none, low, medium or high", "format_error", "不支持所选思考档位"],
    ["Unsupported model mimo-v2-flash", "model_not_found", "不支持所选模型"],
  ]) {
    let message;
    const at = Date.now();
    f.backend.transcripts.set(f.key, [{ role: "user", timestamp: at, content: [] }]);
    f.backend._gwComplete(f.key, "runtime", { sessionKey: f.key, userTimestamp: at, hooks: { error: value => { message = value; } }, observers: new Set() },
      { status: "error", text: "Your request was not processed.", error, error_surface: { code: surface } });
    assert(message.includes(expected));
    const record = [...f.backend.gwChatFailures.values()].at(-1);
    assert(!JSON.stringify(record).includes(error));
  }
});
