"use strict";
// Exact managed Hermes source/dependency closure, production Service, adapter,
// federation and backend. All model traffic and native commands are synthetic.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { ensureCredential } = require("../app/agent-service/external-host-pairing");
const { createManagedPluginHostRuntimeManager, snapshotRuntimeTree } = require("../app/managed-plugin-host-runtime");
const { createManagedHermesHostSupervisor } = require("../app/managed-hermes-host-supervisor");
const { HermesBackend } = require("../app/core/hermes-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createFederationHostServer } = require("../app/federation-host-server");
const { ExternalModelProjection } = require("../app/agent-service/external-model-projection");
const pins = require("../app/managed-hermes-runtime-pins.json");
const repo = path.resolve(__dirname, ".."), input = process.env.SHOGGOTH_HERMES_SECRET_TEST_INPUT || "/private/tmp/sg-hermes-secret-input-v1";
const summary = "The local command completed exactly once. Its public receipt is receipt-17. The password was handled locally and must remain hidden. Use the saved result for later replies. Do not run the command again. The conversation concerns verification of a local synthetic fixture. Nothing is pending from the completed command. Preserve the saved history and user instructions when continuing. ".repeat(4);
function reply(res, body, tool) {
  const content = body.tools?.length ? "Saved operation complete." : summary;
  const message = tool ? { role: "assistant", content: "", tool_calls: [{ id: "native-once", type: "function",
    function: { name: "terminal", arguments: JSON.stringify(tool) } }] } : { role: "assistant", content };
  const result = { id: "secret-hermes", object: "chat.completion", created: 1, model: "fixture",
    choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 250, completion_tokens: 100, total_tokens: 350 } };
  res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
  if (!body.stream) return res.end(JSON.stringify(result));
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : message;
  for (const [value, finish] of [[delta, null], [{}, result.choices[0].finish_reason]]) res.write(`data: ${JSON.stringify({
    id: result.id, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }],
  })}\n\n`);
  res.end("data: [DONE]\n\n");
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " did not settle within 45 seconds")), 45000); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-hermes-secret-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "service"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const stateDir = path.join(root, "app-state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text).reverse(),
    decryptString: bytes => Buffer.from(bytes).reverse().toString() };
  const secrets = new TemporarySecretStore({ paths, cryptoBroker: {
    encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse(),
  } });
  const gateway = new ModelSecretGateway({ projection: new ModelSecretProjection({ secrets }) });
  let originalMode = false;
  const originalPayloads = [], project = gateway.projection.project.bind(gateway.projection);
  gateway.projection.project = (...args) => {
    if (originalMode) { originalPayloads.push(structuredClone(args[1])); throw Object.assign(Error("synthetic masking failure"), { code: "SECRET_MEDIA_UNAVAILABLE" }); }
    return project(...args);
  };
  const calls = [], outputSecret = "NativeHermesFixture987";
  const projectionEvents = [], ownerEvents = [], originalProjection = ExternalModelProjection.prototype.handle;
  const originalOwner = HermesBackend.prototype.resolveModelProjectionSession;
  HermesBackend.prototype.resolveModelProjectionSession = async function (input) {
    const result = await originalOwner.call(this, input);
    ownerEvents.push({ input, result, complete: this._sessionRowsComplete,
      profiles: [...this.profileById.entries()], agents: this.getAgents().map(agent => ({ id: agent.id, enabled: agent.enabled })),
      sessions: this.sessionRows.map(row => Object.fromEntries(["key", "sessionId", "agentId", "backendId", "kind", "archived", "groupId", "parentSessionKey", "source"].map(key => [key, row[key]]))),
      runtimeSessions: [...this.gwRuntimeByKey].map(([key, value]) => ({ key, profile: value.profile, runtimeId: value.runtimeId, storedId: value.storedId, generation: value.generation,
        socketGeneration: this.gwSockets.get(value.profile)?.generation })) });
    return result;
  };
  ExternalModelProjection.prototype.handle = async function (method, params) {
    const event = { method, outcome: "pending" }; projectionEvents.push(event);
    try { const result = await originalProjection.call(this, method, params); event.outcome = "ok"; return result; }
    catch (error) { event.outcome = "error"; event.code = error?.code || "unknown"; throw error; }
  };
  let providerError, noTool = false, followup = false, service, supervisor, registry, federation, verified = false;
  const model = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] })); }
      // Native model discovery also probes optional local-server protocols.
      if (req.method === "GET") { res.writeHead(404); return res.end("unsupported local discovery endpoint"); }
      if (req.method === "POST" && req.url === "/api/show") {
        let probe = ""; for await (const bytes of req) probe += bytes;
        const info = JSON.parse(probe); assert(!info.messages && !info.prompt && !info.input);
        res.writeHead(404); return res.end("not an Ollama server");
      }
      assert.equal(req.url, "/v1/chat/completions"); let raw = ""; for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw); calls.push(body);
      if (!originalMode) assert(!raw.includes(outputSecret), "native result reached the model");
      if (originalMode) assert.deepEqual(Object.fromEntries(Object.keys(originalPayloads.at(-1)).map(key => [key, body[key]])), originalPayloads.at(-1));
      if (!originalMode && !raw.includes("session-b-public")) assert(!raw.includes("123456"), "input credential reached the model");
      const result = body.messages.some(message => message.role === "tool");
      if (result) { assert(raw.includes("Public receipt: receipt-17")); followup = true; }
      const execute = !noTool && !result && body.tools?.length;
      if (execute) assert(body.tools.some(tool => tool.function?.name === "terminal"), "native terminal must be present");
      reply(res, body, execute ? { command: `${JSON.stringify(process.execPath)} fixture.cjs`, timeout: 10 } : null);
    } catch (error) { providerError = error; res.writeHead(500); res.end("synthetic model rejected request"); }
  });
  try {
    await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
    service = createAgentService({ paths, safeStorage, temporarySecrets: secrets, modelSecretGateway: gateway,
      prewarmMcpAuth: false, parentEnv: {}, version: "secret-hermes-fixture", repoRoot: repo });
    await service.start(); ensureCredential(paths, "hermes");
    supervisor = createManagedHermesHostSupervisor({ stateDir, serviceUserDataRoot: paths.userDataRoot,
      adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"),
      getHermesConfiguration: () => ({ model: { default: "fixture", provider: "custom", base_url: `http://127.0.0.1:${model.address().port}/v1`,
        api_key: "synthetic-provider-auth", api_mode: "chat_completions", context_length: 128000 },
        auxiliary: { title_generation: { enabled: false } } }) });
    const previous = process.env.SHOGGOTH_HERMES_SECRET_CANDIDATE_STATE;
    if (previous) { assert(/^\/private\/tmp\/sg-hermes-secret-[A-Za-z0-9]+\/app-state$/u.test(previous)); assert.equal(fs.realpathSync(previous), previous); }
    const manager = createManagedPluginHostRuntimeManager({ stateDir: previous || stateDir, resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"),
      inputPins: pins, activationAuthority: supervisor.activationAuthority, stageTimeoutMs: 60000 });
    console.log(JSON.stringify({ phase: "preparing", root }));
    const candidate = previous ? manager.getCandidate("hermes") : await manager.prepareCandidate({ backendId: "hermes", sourceRoot: input,
      interpreterPath: path.join(input, "venv/bin/python"), architecture: "arm64" });
    assert.equal(candidate.runtimeTreeSha256, pins.hosts.hermes.outputTreeSha256);
    assert.equal(snapshotRuntimeTree(candidate.runtimeRoot, { immutable: true }).sha256, candidate.runtimeTreeSha256);
    console.log(JSON.stringify({ phase: "prepared", candidateId: candidate.candidateId }));
    await manager.activateCandidate({ backendId: "hermes", candidateId: candidate.candidateId, operationId: "secret-start" });
    const execution = supervisor.getExecution();
    fs.writeFileSync(path.join(execution.workspace, "fixture.cjs"), `const fs=require('fs');fs.appendFileSync('count','1');console.log('password: ${outputSecret}');console.log('Public receipt: receipt-17');`);
    const backend = new HermesBackend({ getManagedExecution: () => supervisor.getExecution(),
      getManagedEndpoint: () => supervisor.getEndpoint(), getConfig: () => ({}) });
    registry = new BackendRegistry(); registry.register(backend);
    assert.equal((await registry.start("hermes")).get("hermes"), true, "production Hermes backend must be connected");
    federation = createFederationHostServer({ paths, registry }); await federation.start();
    const send = async (sessionKey, message, fail = false) => {
      let final = "", error;
      await bounded(backend.sendMessage(sessionKey, message, crypto.randomUUID(), {
        final: text => { final = text; }, error: value => { error = value; },
      }).catch(value => { error = value; }), "Hermes turn");
      if (providerError) throw providerError;
      if (fail) assert(error, "unavailable protection must produce a terminal error");
      else { assert(!error, String(error?.message || error)); assert(final.includes("Saved operation complete."), "normal completion must be delivered"); }
    };
    const sessionA = await backend.createSession("hermes-default", { model: "fixture", provider: "custom", acpProviderRef: "custom", workspace: execution.workspace });
    await send(sessionA, "Run the local fixture once. password: 123456");
    assert(followup); assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    console.log(JSON.stringify({ phase: "native-complete", modelRequests: calls.length }));
    noTool = true;
    await send(sessionA, "Report the saved result without repeating the command.");
    console.log(JSON.stringify({ phase: "continued", modelRequests: calls.length }));
    const history = await backend.getHistory(sessionA);
    const persistedHistory = await backend._readHistoricalMessageResponse(sessionA);
    // The live UI adds transient model/usage decorations. Compare the complete
    // durable native records as well as every displayed identity/content field.
    const displayed = message => { const { model, usage, ...durable } = message; return durable; };
    for (let generation = 1; generation <= 2; generation++) {
      await registry.stop(); await supervisor.stopOwned({ operationId: `secret-stop-${generation}`, timeoutMs: 30000 });
      await manager.activateCandidate({ backendId: "hermes", candidateId: candidate.candidateId, operationId: `secret-restart-${generation}` });
      registry.register(backend); assert.equal((await registry.start("hermes")).get("hermes"), true);
      const restored = await backend.getHistory(sessionA);
      const persisted = await backend._readHistoricalMessageResponse(sessionA);
      assert.deepEqual(persisted.messages.slice(0, persistedHistory.messages.length), persistedHistory.messages,
        "all persisted native history fields must remain intact");
      assert.deepEqual(restored.messages.slice(0, history.messages.length).map(displayed), history.messages.map(displayed),
        "displayed history identities, timestamps and contents must remain intact");
      await send(sessionA, "Continue using the saved result without repeating the command.");
      assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
      console.log(JSON.stringify({ phase: "restarted", generation, modelRequests: calls.length }));
    }
    const beforeSummary = calls.length;
    await bounded(backend.compactSession(sessionA), "Hermes manual compression");
    if (providerError) throw providerError;
    assert(calls.length > beforeSummary, "native summarization must make an actual protected model request");
    const sessionB = await backend.createSession("hermes-default", { model: "fixture", provider: "custom", acpProviderRef: "custom", workspace: execution.workspace });
    await send(sessionB, "session-b-public: 123456");
    assert(calls.some(body => JSON.stringify(body).includes("session-b-public: 123456")));
    const beforeOriginal = calls.length; originalMode = true;
    await send(sessionA, "Report the saved result without repeating any command.");
    assert.equal(calls.length, beforeOriginal + 1);
    assert.equal(originalPayloads.length, 1); originalMode = false;
    assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    const before = calls.length; await gateway.close();
    const beforeBindings = projectionEvents.filter(event => event.method === "mcp.external.model.bind").length;
    await send(sessionA, "Do not send while protection is unavailable.", true);
    assert.equal(projectionEvents.filter(event => event.method === "mcp.external.model.bind").length - beforeBindings, 1,
      "local projection failure must not trigger automatic native retries");
    assert.equal(calls.length, before); assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    verified = true;
    console.log(JSON.stringify({ verified, silentOriginalFallbackOnce: true, nativeExecutions: 1, restarts: 2, modelRequests: calls.length,
      followup: true, summary: true, separateScopes: true, failureProviderCalls: 0, evidence: root }));
  } catch (error) {
    console.error(JSON.stringify({ phase: "failed", code: error?.code, message: error?.message, providerCalls: calls.length }));
    throw error;
  } finally {
    ExternalModelProjection.prototype.handle = originalProjection;
    HermesBackend.prototype.resolveModelProjectionSession = originalOwner;
    fs.writeFileSync(path.join(root, "projection-diagnostics.json"), JSON.stringify(projectionEvents, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, "owner-diagnostics.json"), JSON.stringify(ownerEvents, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, "synthetic-model-requests.json"), JSON.stringify(calls, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: "cleanup-federation" }));
    await bounded(Promise.resolve(federation?.stop()), "fixture federation cleanup");
    console.log(JSON.stringify({ phase: "cleanup-registry" }));
    await bounded(Promise.resolve(registry?.stop()), "fixture registry cleanup");
    console.log(JSON.stringify({ phase: "cleanup-supervisor" }));
    if (supervisor?.getStatus().ownership === "managed") await supervisor.stopOwned({ operationId: "secret-final-stop", timeoutMs: 30000 });
    console.log(JSON.stringify({ phase: "cleanup-service" }));
    await bounded(Promise.resolve(service?.stop()), "fixture service cleanup");
    await gateway.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    if (!verified) console.error(JSON.stringify({ retainedFailure: root, providerCalls: calls.length }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
