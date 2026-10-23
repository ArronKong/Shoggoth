"use strict";

// Isolated regression for custom Hermes routing and OpenClaw catalog publication races.
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { WebSocketServer } = require("ws");
const { HermesBackend } = require("../app/core/hermes-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { generateIdentity, DEFAULT_OPERATOR_SCOPES } = require("../app/core/device-auth");
const { resolveOpenclawBin, resolveOpenclawProgram } = require("../app/cli-runtime/openclaw");
const { createOpenClawLocalRuntimeScope } = require("../app/core/openclaw-local-runtime-scope");
const { resolveManagedOpenClawProductInputs } = require("../app/managed-openclaw-product-inputs");

const MODEL = "mimo-v2.6-flash";
const CATALOG_CHANGED = "Model catalog changed while preparing this result. Retry the request.";

async function fakeGateway(kind, handler) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new Set();
  const frames = [];
  const wss = new WebSocketServer({ server });
  wss.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const send = value => socket.send(JSON.stringify(value));
    if (kind === "openclaw") send({ type: "event", event: "connect.challenge", payload: { nonce: "isolated-catalog-nonce" } });
    socket.on("message", bytes => {
      const frame = JSON.parse(String(bytes));
      frames.push(frame);
      const reply = result => send(kind === "openclaw"
        ? { type: "res", id: frame.id, ok: true, payload: result }
        : { jsonrpc: "2.0", id: frame.id, result });
      const reject = error => send(kind === "openclaw"
        ? { type: "res", id: frame.id, ok: false, error }
        : { jsonrpc: "2.0", id: frame.id, error });
      if (kind === "openclaw" && frame.method === "connect") {
        reply({ type: "hello-ok", protocol: 4, server: { version: "2026.9.5", connId: "fixture" }, features: { methods: ["config.get", "models.list"], events: [], capabilities: [] }, auth: { role: "operator", scopes: DEFAULT_OPERATOR_SCOPES }, policy: { maxPayload: 100000, maxBufferedBytes: 200000 } });
        return;
      }
      const emit = (type, sessionId, payload) => send({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } });
      handler(frame, reply, reject, emit);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { frames, port: server.address().port, async close() {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}

async function hermesFixture(handler) {
  let created = 0;
  const gateway = await fakeGateway("hermes", (frame, reply, reject, emit) => {
    if (handler) return handler(frame, reply, reject, emit);
    if (frame.method === "session.create") {
      created += 1;
      reply({ session_id: `runtime-${created}`, stored_session_id: `stored-${created}`, info: { lazy: true } });
    } else if (frame.method === "session.resume") reply({ session_id: "resumed", resumed: frame.params.session_id });
    else if (frame.method === "config.set") reply({ value: frame.params.value });
    else reply({});
  });
  const backend = new HermesBackend();
  backend.profileById.set("hermes-fixture", "fixture");
  backend.dashboards.set("fixture", { baseUrl: `http://127.0.0.1:${gateway.port}`, token: "isolated-token" });
  return { backend, gateway, async close() { await backend.stop(); await gateway.close(); } };
}

test("Hermes Gateway create honors the catalog's named custom provider despite a builtin slug collision", async () => {
  const fixture = await hermesFixture();
  try {
    fixture.backend.modelChoices = [{ id: MODEL, provider: "xiaomi", acpProviderRef: "custom:xiaomi" }];
    await fixture.backend.createSession("hermes-fixture", { model: MODEL, provider: "xiaomi" });
    const create = fixture.gateway.frames.find(frame => frame.method === "session.create");
    assert.equal(create.params.provider, "custom:xiaomi");
    assert.equal(create.params.model, MODEL);
    assert.equal(fixture.gateway.frames.some(frame => frame.method === "prompt.submit"), false);
  } finally { await fixture.close(); }
});

for (const action of ["send", "switch"]) test(`Hermes repairs a persisted bare custom provider before ${action} without replacing history`, async () => {
  let repaired = false;
  const fixture = await hermesFixture((frame, reply, reject, emit) => {
    if (frame.method === "session.resume") reply({ session_id: "legacy-runtime", resumed: "old-session", info: { lazy: true, model: MODEL, provider: "xiaomi" } });
    else if (frame.method === "process.list" && !repaired) reject({ code: 5032, message: "No usable credentials found for provider 'xiaomi'. Set XIAOMI_API_KEY." });
    else if (frame.method === "config.set") {
      assert.equal(frame.params.value, `${MODEL} --provider custom:xiaomi --session`);
      repaired = true; reply({ value: MODEL });
    } else if (frame.method === "prompt.submit") {
      reply({});
      setImmediate(() => emit("message.complete", "legacy-runtime", { text: "Recovered reply", status: "complete", usage: {} }));
    } else reply({ processes: [] });
  });
  try {
    fixture.backend.modelChoices = [{ id: MODEL, provider: "xiaomi", acpProviderRef: "custom:xiaomi" }];
    fixture.backend._modelCatalogProfileSnapshots.set("fixture", { choices: fixture.backend.modelChoices });
    if (action === "switch") await fixture.backend.setSessionModel("agent:hermes-fixture:old-session", { model: MODEL, provider: "xiaomi" });
    else {
      const errors = [], replies = [];
      await fixture.backend.sendMessage("agent:hermes-fixture:old-session", "Original prompt", "legacy-turn", {
        error: text => errors.push(text), final: text => replies.push(text),
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(replies, ["Recovered reply"]);
      assert.equal(repaired, true, "the original user prompt must not precede recovery");
      assert.equal(fixture.gateway.frames.filter(frame => frame.method === "prompt.submit").length, 1);
    }
    assert.equal(repaired, true);
    assert.equal(fixture.gateway.frames.some(frame => ["session.create", "session.close", "session.delete"].includes(frame.method)), false);
    assert.equal(fixture.backend.gwRuntimeByKey.get("agent:hermes-fixture:old-session").storedId, "old-session");
  } finally { await fixture.close(); }
});

test("Hermes never repairs another profile's provider or an unrelated agent error", async () => {
  for (const foreignProfile of [false, true]) {
    const fixture = await hermesFixture((frame, reply, reject) => {
      if (frame.method === "session.resume") reply({ session_id: "legacy-runtime", resumed: "old-session", info: { lazy: true, model: MODEL, provider: "xiaomi" } });
      else if (frame.method === "process.list") reject({ code: 5032, message: foreignProfile
        ? "No usable credentials found for provider 'xiaomi'. Set XIAOMI_API_KEY." : "SQLite database is locked" });
      else reply({});
    });
    try {
      const choices = [{ id: MODEL, provider: "xiaomi", acpProviderRef: "custom:xiaomi" }];
      fixture.backend.modelChoices = choices;
      fixture.backend._modelCatalogProfileSnapshots.set(foreignProfile ? "another-profile" : "fixture", { choices });
      await assert.rejects(fixture.backend.setSessionModel("agent:hermes-fixture:old-session", { model: MODEL, provider: "xiaomi" }));
      assert.equal(fixture.gateway.frames.some(frame => frame.method === "config.set"), false);
    } finally { await fixture.close(); }
  }
});

test("OpenClaw shares only an in-flight config read, with a bounded cold-read budget and independent results", async () => {
  const backend = new OpenClawBackend({ authResolver: {} });
  let resolveRead, reads = 0, budget;
  const pendingReads = [];
  backend._connect = async () => {};
  backend.request = async (method, _params, timeout) => {
    assert.equal(method, "config.get");
    budget = timeout;
    reads += 1;
    return new Promise(resolve => { resolveRead = resolve; pendingReads.push(resolve); });
  };
  try {
    const one = backend._configSnapshot(), two = backend._configSnapshot();
    const snapshots = Promise.all([one, two]);
    await new Promise(resolve => setImmediate(resolve));
    const concurrentReads = reads;
    for (const resolve of pendingReads) resolve({ hash: "first", parsed: { models: { providers: {} } } });
    const [a, b] = await snapshots;
    assert.equal(concurrentReads, 1);
    assert.equal(budget, 30000);
    a.parsed.models.providers.changed = {};
    assert.deepEqual(b.parsed.models.providers, {});
    const third = backend._configSnapshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2, "completed reads are never a cache for the next operation");
    resolveRead({ hash: "fresh", parsed: {} });
    assert.equal((await third).hash, "fresh");
  } finally { await backend.stop(); }
});

test("OpenClaw honors its rootless Node launcher for CLI, SDK and helper execution even with a conflicting PATH", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-rootless-cli-")));
  try {
    const bin = path.join(root, ".local/bin/openclaw"), interpreter = path.join(root, "supported/node");
    const entry = path.join(root, "runtime/openclaw.mjs"), foreign = path.join(root, "global");
    for (const dir of [path.dirname(bin), path.dirname(interpreter), path.dirname(entry), foreign]) fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(process.execPath, interpreter);
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}));");
    fs.chmodSync(entry, 0o700);
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${interpreter}' '${entry}' "$@"\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(foreign, "openclaw"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
    const selected = resolveOpenclawBin({ home: root, env: { PATH: foreign } });
    assert.equal(selected, bin);
    assert.deepEqual(resolveOpenclawProgram(selected), { entryPath: entry, interpreterPath: fs.realpathSync(process.execPath) });
    const scope = createOpenClawLocalRuntimeScope({ resolveLegacyBin: () => selected });
    const cli = scope.cli(["models", "auth", "list", "--json"]);
    const observed = JSON.parse(execFileSync(cli.file, cli.args, { env: cli.env, encoding: "utf8" }));
    assert.equal(observed.node, fs.realpathSync(process.execPath));
    assert.deepEqual(observed.args, ["models", "auth", "list", "--json"]);
    assert.equal(scope.node([]).file, fs.realpathSync(process.execPath));
    assert.equal(scope.sdkPath(), path.join(root, "runtime/dist/plugin-sdk/agent-runtime.js"));
    const pinnedNode = path.join(root, ".local/share/node", `v${require("../app/managed-openclaw-runtime-pins.json").hosts.openclaw.interpreter.version}`, "bin/node");
    fs.mkdirSync(path.dirname(pinnedNode), { recursive: true });
    fs.symlinkSync(process.execPath, pinnedNode);
    assert.equal(resolveManagedOpenClawProductInputs({ openclawBin: bin, homeDir: root, runtimePath: "", architecture: "arm64" }).sourceRoot, path.dirname(entry));
    assert.equal(resolveOpenclawBin({ home: root, env: { OPENCLAW_BIN: "explicit-cli", PATH: foreign } }), "explicit-cli");
    fs.unlinkSync(bin);
    assert.equal(resolveOpenclawBin({ home: root, env: { PATH: foreign } }), path.join(foreign, "openclaw"));
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${interpreter}' '${entry}' "$@"; touch '${root}/must-not-run'\n`);
    assert.equal(resolveOpenclawProgram(bin).interpreterPath, undefined);
    assert.equal(fs.existsSync(path.join(root, "must-not-run")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("OpenClaw rejects config results retired by a connection change and does not join the retired read", async () => {
  const backend = new OpenClawBackend({ authResolver: {} });
  const pending = [];
  backend._connect = async () => {};
  backend.request = () => new Promise(resolve => pending.push(resolve));
  try {
    const old = backend._configSnapshot();
    const rejected = assert.rejects(old, /connection changed/u);
    await new Promise(resolve => setImmediate(resolve));
    backend._connectionGeneration += 1;
    const current = backend._configSnapshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 2);
    pending[0]({ hash: "old", parsed: {} });
    await rejected;
    pending[1]({ hash: "current", parsed: {} });
    assert.equal((await current).hash, "current");
  } finally { await backend.stop(); }
});

test("Hermes Gateway model switch honors explicit inherited custom identity before sending config.set", async () => {
  const fixture = await hermesFixture();
  try {
    await fixture.backend.setSessionModel("agent:hermes-fixture:old-session", {
      model: MODEL, provider: "xiaomi", acpProviderRef: "custom:xiaomi",
    });
    const set = fixture.gateway.frames.find(frame => frame.method === "config.set");
    assert.equal(set.params.value, `${MODEL} --provider custom:xiaomi --session`);
    assert.equal(fixture.gateway.frames.some(frame => frame.method === "prompt.submit"), false);
  } finally { await fixture.close(); }
});

test("Hermes Gateway model switch can resolve custom identity from its catalog without a renderer hint", async () => {
  const fixture = await hermesFixture();
  try {
    fixture.backend.modelChoices = [{ id: MODEL, provider: "xiaomi", acpProviderRef: "custom:xiaomi" }];
    await fixture.backend.setSessionModel("agent:hermes-fixture:old-session", { model: MODEL, provider: "xiaomi" });
    assert.equal(fixture.gateway.frames.find(frame => frame.method === "config.set").params.value,
      `${MODEL} --provider custom:xiaomi --session`);
  } finally { await fixture.close(); }
});

test("Hermes builtin providers remain builtin without a custom catalog identity", async () => {
  const fixture = await hermesFixture();
  try {
    fixture.backend.modelChoices = [{ id: MODEL, provider: "xiaomi" }];
    await fixture.backend.createSession("hermes-fixture", { model: MODEL, provider: "xiaomi" });
    assert.equal(fixture.gateway.frames.find(frame => frame.method === "session.create").params.provider, "xiaomi");
  } finally { await fixture.close(); }
});

test("Hermes catalogs accepting canonical custom slugs never prepend custom twice", async () => {
  const backend = new HermesBackend();
  backend.dashboards.set("fixture", { baseUrl: "http://127.0.0.1:1", token: "isolated-token" });
  backend._dashGet = async () => ({ status: 200, body: JSON.stringify({ providers: [
    { slug: "custom:xiaomi", is_user_defined: true, source: "user-config", models: [MODEL] },
  ] }) });
  await backend.refreshModelChoices({ fresh: true, requireComplete: true });
  assert.equal(backend.getModelChoices()[0].acpProviderRef, "custom:xiaomi");
  assert.equal(backend._acpModelRef(MODEL, "custom:xiaomi"), `custom:xiaomi:${MODEL}`);
});

async function openclawFixture(failures, { onFailure = null } = {}) {
  let configReads = 0, modelReads = 0;
  let backend;
  const gateway = await fakeGateway("openclaw", (frame, reply, reject) => {
    if (frame.method === "config.get") {
      configReads += 1;
      reply({ hash: `config-${configReads}`, parsed: { models: { providers: { alpha: {
        baseUrl: "http://127.0.0.1:1/v1", models: [{ id: `configured-${configReads}` }],
      } } } } });
    } else if (frame.method === "models.list") {
      modelReads += 1;
      const failure = failures(modelReads);
      if (failure) { onFailure?.(backend); reject(failure); }
      else reply({ models: [{ id: `runtime-${modelReads}`, provider: "alpha" }] });
    } else reject({ code: "FORBIDDEN", message: "Fixture accepts read-only methods" });
  });
  backend = new OpenClawBackend({
    getUpstreamUrl: () => `ws://127.0.0.1:${gateway.port}`,
    authResolver: {
      resolveConnectAuthAsync: async () => ({ ...generateIdentity(), token: "isolated-token", scopes: DEFAULT_OPERATOR_SCOPES }),
      storeDeviceToken() {}, clearDeviceToken() {},
    },
  });
  return { backend, gateway, counts: () => ({ configReads, modelReads }),
    async close() { await backend.stop(); await gateway.close(); } };
}

const publicationRace = () => ({ code: "UNAVAILABLE", message: CATALOG_CHANGED, retryable: true, retryAfterMs: 0 });

test("OpenClaw rereads config and catalog after explicit retryable publication races and never dispatches a write", async () => {
  const fixture = await openclawFixture(read => read < 3 ? publicationRace() : null);
  try {
    const result = await fixture.backend.getModelCatalogSources();
    assert.deepEqual(fixture.counts(), { configReads: 3, modelReads: 3 });
    assert.equal(result.config[0].id, "configured-3");
    assert.equal(result.runtime[0].id, "runtime-3");
    assert.equal(fixture.gateway.frames.every(frame => ["connect", "config.get", "models.list"].includes(frame.method)), true);
    for (const frame of fixture.gateway.frames.filter(frame => frame.method === "models.list")) {
      assert.equal(frame.params.view, "all");
      assert.equal(frame.params.refresh, undefined);
    }
  } finally { await fixture.close(); }
});

test("OpenClaw keeps publication retries bounded and does not fall back to a cached catalog", async () => {
  const fixture = await openclawFixture(publicationRace);
  try {
    await assert.rejects(fixture.backend.getModelCatalogSources(), error => {
      assert.equal(error.code, "ERR_MODEL_CATALOG_RUNTIME");
      assert.equal(error.cause.code, "UNAVAILABLE");
      assert.equal(error.cause.retryable, true);
      return true;
    });
    assert.deepEqual(fixture.counts(), { configReads: 3, modelReads: 3 });
  } finally { await fixture.close(); }
});

for (const failure of [
  { code: "UNAVAILABLE", message: CATALOG_CHANGED, retryable: false },
  { code: "UNAVAILABLE", message: "Provider temporarily unavailable", retryable: true },
  { code: "FORBIDDEN", message: CATALOG_CHANGED, retryable: true },
]) test(`OpenClaw refuses catalog retry for ${failure.code}/${failure.retryable}/${failure.message}`, async () => {
  const fixture = await openclawFixture(() => failure);
  try {
    await assert.rejects(fixture.backend.getModelCatalogSources(), { code: "ERR_MODEL_CATALOG_RUNTIME" });
    assert.deepEqual(fixture.counts(), { configReads: 1, modelReads: 1 });
  } finally { await fixture.close(); }
});

test("OpenClaw does not retry a catalog race across a changed connection generation", async () => {
  const fixture = await openclawFixture(publicationRace, { onFailure: backend => { backend._connectionGeneration += 1; } });
  try {
    await assert.rejects(fixture.backend.getModelCatalogSources(), { code: "ERR_MODEL_CATALOG_RUNTIME" });
    assert.deepEqual(fixture.counts(), { configReads: 1, modelReads: 1 });
  } finally { await fixture.close(); }
});
