"use strict";
// Pinned owned OpenClaw + production adapter + real Service/federation, using
// only a loopback model and a synthetic native command. No installed data edits.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { ExternalModelProjection } = require("../app/agent-service/external-model-projection");
const { ensureCredential } = require("../app/agent-service/external-host-pairing");
const { createManagedPluginHostRuntimeManager, snapshotRuntimeTree } = require("../app/managed-plugin-host-runtime");
const { createManagedOpenClawHostSupervisor } = require("../app/managed-openclaw-host-supervisor");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createAuthResolver } = require("../app/core/device-auth");
const { createFederationHostServer } = require("../app/federation-host-server");
const pins = require("../app/managed-openclaw-runtime-pins.json");
const repo = path.resolve(__dirname, ".."), source = "/opt/homebrew/lib/node_modules/openclaw";
const node = process.env.SHOGGOTH_TEST_OPENCLAW_NODE || path.join(require("node:os").homedir(), ".local/share/node/v24.21.0/bin/node");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw Error(label + " did not settle within the fixture deadline");
}
function stream(res, tool) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const deltas = tool ? [{ role: "assistant", tool_calls: [{ index: 0, id: "native-once", type: "function",
    function: { name: "exec", arguments: JSON.stringify(tool) } }] }] : [{ role: "assistant", content: "Saved operation complete." }];
  for (const delta of deltas) res.write(`data: ${JSON.stringify({ id: "secret-fixture", object: "chat.completion.chunk", created: 1,
    model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "secret-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-openclaw-secret-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "service"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const stateDir = path.join(root, "app-state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text).reverse(),
    decryptString: bytes => Buffer.from(bytes).reverse().toString() };
  const cryptoBroker = { encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() };
  const secrets = new TemporarySecretStore({ paths, cryptoBroker });
  let originalMode = false;
  const originalPayloads = [];
  const diagnostics = [], projection = new ModelSecretProjection({ secrets });
  const project = projection.project.bind(projection);
  projection.project = async (...args) => { try {
    if (originalMode) { originalPayloads.push(structuredClone(args[1])); throw Object.assign(Error("synthetic masking failure"), { code: "SECRET_MEDIA_UNAVAILABLE" }); }
    return await project(...args); }
    catch (error) { diagnostics.push({ boundary: "payload", code: error.code || "UNKNOWN" }); throw error; } };
  const handle = ExternalModelProjection.prototype.handle;
  ExternalModelProjection.prototype.handle = async function (...args) { try { return await handle.apply(this, args); }
    catch (error) { diagnostics.push({ boundary: "identity", method: args[0], code: error.code || "UNKNOWN" }); throw error; } };
  const gateway = new ModelSecretGateway({ projection });
  const calls = []; let providerError, noTool = false, followup = false, service, supervisor, manager, registry, federation, verified = false;
  const outputSecret = "NativeOpenClawFixture987";
  const model = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions"); let raw = ""; for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw); calls.push(body);
      if (!originalMode) assert(!raw.includes(outputSecret), "native tool result reached the provider");
      if (originalMode) { assert(raw.includes(outputSecret)); assert.deepEqual(body, originalPayloads.at(-1)); }
      if (!originalMode && !raw.includes("session-b-public")) assert(!raw.includes("123456"), "input credential reached the provider");
      const hasToolResult = body.messages.some(message => message.role === "tool");
      if (hasToolResult) { assert(raw.includes("Public receipt: receipt-17")); followup = true; }
      const execute = !noTool && !hasToolResult;
      if (execute) assert(body.tools.some(tool => tool.function?.name === "exec"), "real native exec tool must be offered");
      stream(res, execute ? { command: `${JSON.stringify(node)} fixture.cjs`, timeoutSeconds: 10 } : null);
    } catch (error) { providerError = error; res.writeHead(500); res.end("local fixture rejected request"); }
  });
  try {
    await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
    service = createAgentService({ paths, safeStorage, temporarySecrets: secrets, modelSecretGateway: gateway,
      prewarmMcpAuth: false, parentEnv: {}, version: "secret-openclaw-fixture", repoRoot: repo });
    await service.start(); ensureCredential(paths, "openclaw");
    supervisor = createManagedOpenClawHostSupervisor({ stateDir, serviceUserDataRoot: paths.userDataRoot,
      adapterResourcesRoot: path.join(repo, "resources/external-plugin-adapters"),
      getGatewayConfiguration: () => ({ models: { mode: "replace", providers: { probe: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: "synthetic-provider-auth", api: "openai-completions", agentRuntime: { id: "openclaw" },
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
        agents: { defaults: { model: { primary: "probe/fixture" } } },
        tools: { profile: "minimal", alsoAllow: ["exec"], exec: { host: "gateway", security: "full", ask: "off" } } }) });
    const previous = process.env.SHOGGOTH_OPENCLAW_SECRET_CANDIDATE_STATE;
    if (previous) { assert(/^\/private\/tmp\/sg-openclaw-secret-[A-Za-z0-9]+\/app-state$/u.test(previous)); assert.equal(fs.realpathSync(previous), previous); }
    manager = createManagedPluginHostRuntimeManager({ stateDir: previous || stateDir, resourcesRoot: path.join(repo, "resources/external-plugin-host-patches"),
      inputPins: pins, activationAuthority: supervisor.activationAuthority, stageTimeoutMs: 60000 });
    console.log(JSON.stringify({ phase: "preparing", root }));
    const candidate = previous ? manager.getCandidate("openclaw")
      : await manager.prepareCandidate({ backendId: "openclaw", sourceRoot: source, interpreterPath: node, architecture: "arm64" });
    assert.equal(candidate.runtimeTreeSha256, pins.hosts.openclaw.outputTreeSha256);
    assert.equal(snapshotRuntimeTree(candidate.runtimeRoot, { immutable: true }).sha256, candidate.runtimeTreeSha256);
    console.log(JSON.stringify({ phase: "prepared", candidateId: candidate.candidateId }));
    await manager.activateCandidate({ backendId: "openclaw", candidateId: candidate.candidateId, operationId: "secret-start" });
    const execution = supervisor.getExecution();
    fs.writeFileSync(path.join(execution.workspace, "fixture.cjs"), `const fs=require('fs');fs.appendFileSync('count','1');console.log('password: ${outputSecret}');console.log('Public receipt: receipt-17');`);
    const backend = new OpenClawBackend({ getUpstreamUrl: () => supervisor.getEndpoint()?.url,
      getOrigin: () => "http://127.0.0.1", getManagedExecution: () => supervisor.getExecution(),
      authResolver: createAuthResolver({ getConfig: () => ({ gatewayUrl: supervisor.getEndpoint()?.url, token: supervisor.getEndpoint()?.token }),
        credentialsDir: path.join(root, "backend-credentials"), operatorIdentityDir: path.join(root, "backend-identity"),
        get localGatewayConfigPath() { return supervisor.getExecution()?.configPath; } }) });
    registry = new BackendRegistry(); registry.register(backend); await registry.start("openclaw");
    federation = createFederationHostServer({ paths, registry }); await federation.start();
    const failures = [];
    const observe = async () => { await backend._connect(); backend._ws.on("message", bytes => {
      const frame = JSON.parse(bytes);
      if (frame.type === "event" && frame.event === "chat" && frame.payload?.state === "error") failures.push(frame.payload);
    }); };
    await observe();
    const send = async (sessionKey, message, expected = "Saved operation complete.") => {
      const before = (await backend.request("chat.history", { sessionKey, limit: 100 })).messages || [];
      const start = failures.length;
      await backend.request("chat.send", { sessionKey, message, idempotencyKey: crypto.randomUUID() });
      await until(async () => {
        if (providerError) throw providerError;
        let history;
        try { history = (await backend.request("chat.history", { sessionKey, limit: 100 })).messages || []; }
        catch (error) {
          // The pinned native store can invalidate a read during first-session
          // publication. Retry only this read inside the original deadline;
          // chat.send and completed tools are never replayed.
          if (error.code === "UNAVAILABLE" && error.message === "Session access facts are unavailable; retry after session storage is ready.") return false;
          throw error;
        }
        const descriptor = JSON.parse(fs.readFileSync(path.join(supervisor.getStatus().dataRoot, "managed-control.json")));
        const status = await supervisor.request("gateway.shoggoth.managed.status", { version: 1, operationId: "secret-observe",
          controlToken: descriptor.controlToken, nonce: descriptor.nonce, generation: supervisor.getStatus().generation, deadlineAt: Date.now() + 10000 });
        const completed = expected === "SECRET_MODEL_PROJECTION_UNAVAILABLE"
          ? failures.slice(start).some(event => event.sessionKey === sessionKey && event.errorMessage === expected)
          : history.length > before.length && JSON.stringify(history.slice(before.length)).includes(expected);
        if (expected !== "SECRET_MODEL_PROJECTION_UNAVAILABLE" && failures.slice(start).some(event => event.sessionKey === sessionKey)) {
          throw Error(`Unexpected OpenClaw failure: ${JSON.stringify(diagnostics)}`);
        }
        return completed && status.snapshot.idle;
      }, "OpenClaw turn");
    };
    const sessionA = "agent:main:secret-session-a";
    await send(sessionA, "Run the local fixture once. password: 123456");
    assert(followup); assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    noTool = true;
    await send(sessionA, "Report the saved result without repeating the command.");
    for (let generation = 1; generation <= 2; generation++) {
      const saved = (await backend.request("chat.history", { sessionKey: sessionA, limit: 100 })).messages;
      await registry.stop();
      await supervisor.stopOwned({ operationId: `secret-restart-stop-${generation}`, timeoutMs: 30000 });
      await manager.activateCandidate({ backendId: "openclaw", candidateId: candidate.candidateId, operationId: `secret-restart-${generation}` });
      registry.register(backend); await registry.start("openclaw"); await observe();
      assert.deepEqual((await backend.request("chat.history", { sessionKey: sessionA, limit: 100 })).messages, saved,
        "restart must retain existing chat records");
      await send(sessionA, "Continue from the saved result; do not execute the command again.");
      assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    }
    await send("agent:main:secret-session-b", "session-b-public: 123456");
    assert(calls.some(body => JSON.stringify(body).includes("session-b-public: 123456")));
    const beforeOriginal = calls.length; originalMode = true;
    await send(sessionA, "Report the saved result without repeating any command.");
    assert.equal(calls.length, beforeOriginal + 1);
    assert.equal(originalPayloads.length, 1); originalMode = false;
    assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    const before = calls.length; await gateway.close();
    await send(sessionA, "Do not send this request when protection is unavailable.", "SECRET_MODEL_PROJECTION_UNAVAILABLE");
    assert.equal(calls.length, before); assert.equal(fs.readFileSync(path.join(execution.workspace, "count"), "utf8"), "1");
    const runtimeLog = fs.readFileSync(path.join(supervisor.getStatus().dataRoot, "gateway.log"), "utf8");
    assert(!runtimeLog.includes("[empty-error-retry]"), "local protection failures must not retry a model turn");
    verified = true;
    console.log(JSON.stringify({ verified, silentOriginalFallbackOnce: true, version: pins.hosts.openclaw.hostVersion, modelRequests: calls.length,
      nativeExecutions: 1, followup: true, restarts: 2, resumed: true, separateScopes: true, failureProviderCalls: 0, evidence: root }));
  } finally {
    ExternalModelProjection.prototype.handle = handle;
    fs.writeFileSync(path.join(root, "projection-diagnostics.json"), JSON.stringify(diagnostics, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, "synthetic-model-requests.json"), JSON.stringify(calls, null, 2), { mode: 0o600 });
    await federation?.stop(); await registry?.stop();
    if (supervisor?.getStatus().ownership === "managed") await supervisor.stopOwned({ operationId: "secret-stop", timeoutMs: 30000 });
    await service?.stop(); await gateway.close();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    if (!verified) console.error(JSON.stringify({ retainedFailure: root, providerCalls: calls.length }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
