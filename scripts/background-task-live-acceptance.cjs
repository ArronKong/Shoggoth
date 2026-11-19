#!/usr/bin/env node
"use strict";

// Explicit live acceptance for native background tasks. A new isolated state
// directory runs the real Service, ShoggothBackend, proxy and management UI.
// The built-in Codex Agent uses the user's own Codex login (~/.codex); an
// optional Pi binding on the same Agent uses ~/.pi. Chats are driven from the
// browser like a user would. Nothing outside the temporary state is changed,
// except the Codex/Pi sessions their own CLIs record.
// Usage: node scripts/background-task-live-acceptance.cjs --live [--pi] [port]
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID, NATIVE_PI_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require("../app/core/device-auth");
const { startStaticServer } = require("../app/static-server");

async function main() {
  if (!process.argv.includes("--live")) throw new Error("Pass --live only for an explicitly authorized acceptance run");
  const withPi = process.argv.includes("--pi");
  const port = Number(process.argv.find(value => /^\d+$/u.test(value)) || 61810);
  const root = fs.mkdtempSync("/private/tmp/sgbg-");
  const cleanup = [];
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.env.TMPDIR = root;
    await serve({ root, port, withPi, cleanup });
    await stopped;
  } finally {
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { console.error(error); process.exitCode = 1; }
    }
    fs.rmSync(root, { recursive: true, force: true });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function serve({ root, port, withPi, cleanup }) {
  const { makeSafeStorage } = require("./group-collaboration-live-worker.cjs");
  const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
  const repoRoot = fs.realpathSync(path.join(__dirname, ".."));
  const key = require("node:crypto").randomBytes(32);
  cleanup.push(() => key.fill(0));
  fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { flag: "wx", mode: 0o600 });
  const bootstrap = path.join(root, "mcp-bootstrap.cjs");
  const helper = require.resolve("./fixtures/background-task-live-mcp.cjs");
  fs.writeFileSync(bootstrap, `require(${JSON.stringify(helper)})(__dirname).catch(e => {
    process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "BACKGROUND_LIVE_MCP_FAILED") + "\\n");
    process.exitCode = 1;
  });\n`, { flag: "wx", mode: 0o600 });
  const mcpHelperLaunch = { command: fs.realpathSync(process.execPath), argsPrefix: [bootstrap] };
  const paths = resolveServicePaths({ homeDir: root });
  const accounts = [NATIVE_CODEX_RUNTIME_ACCOUNT_ID, ...(withPi ? [NATIVE_PI_RUNTIME_ACCOUNT_ID] : [])];
  const service = createAgentService({ paths, repoRoot, version: "background-live", builtinCliProfiles: true,
    builtinCliInstalledAccountIds: accounts, prewarmMcpAuth: false,
    parentEnv: { ...process.env, HOME: os.homedir(), TMPDIR: root },
    safeStorage: makeSafeStorage(key), mcpHelperLaunch,
    runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch, bootstrapPath: bootstrap }) });
  cleanup.push(() => service.stop({ notify: false }));
  await service.start();
  if (withPi && !await service.mcpProductToolController.workspaceExecutionService.verify()) {
    throw new Error(`Workspace sandbox self-test failed with ${process.execPath}. Run this acceptance with a Node installation that passes workspace execution verification.`);
  }
  const config = service.nativeRuntimeConfig.read();
  // Same defaults as a new App install (config-store).
  service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true, runtimeMultiBinding: true } });
  const codex = service.productStore.listAgentProfiles().find(profile => profile.runtimeAccountId === NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  if (!codex) throw new Error("The built-in Codex Agent was not created; check the Codex CLI installation");
  if (withPi && !service.productStore.getAgentRuntimeBindings(codex.id).bindings.some(binding => binding.runtime === "pi")) {
    service.productStore.addAgentRuntimeBinding(codex.id, { runtime: "pi", runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID },
      { operationId: "live-add-pi" });
  }

  const registry = new BackendRegistry();
  // The App's own CLI scan (ui-entry.js): native accounts need their executable paths.
  const getRuntimeCliAuth = () => require("../app/runtime-cli-auth").createRuntimeCliAuth({ paths, parentEnv: process.env,
    homedir: os.homedir, repoRoot, executablePath: process.execPath, packaged: false,
    resourcesPath: process.resourcesPath });
  const backend = new ShoggothBackend({ paths, runtimeCliAuth: getRuntimeCliAuth(), getRuntimeCliAuth,
    getNativeRuntimeConfig: () => ({ ...service.nativeRuntimeConfig.read() }) });
  registry.register(backend); registry.setInspirationOwner(backend); registry.setChatSecretOwner(backend);
  cleanup.push(() => backend.stop());
  if ((await registry.start()).get(backend.id) !== true) throw new Error("Backend did not start");
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
  });
  wss.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "live" } }));
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()); if (frame.type !== "req") return;
      const payload = frame.method === "connect" ? { type: "hello-ok", protocol: 1, server: { version: "2026.8.1" },
        features: { methods: [], events: [] }, auth: { role: "operator", scopes: [] }, policy: { maxPayload: 65536, maxBufferedBytes: 262144 } }
        : frame.method === "sessions.list" ? { ts: Date.now(), path: "/", count: 0, defaults: {}, sessions: [] }
        : frame.method === "agents.list" ? { agents: [] } : frame.method === "models.list" ? { models: [] } : {};
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => `ws://127.0.0.1:${upstream.address().port}`,
    registry, workAdmissionGate: createWorkAdmissionGate() });
  cleanup.push(() => proxy.close());
  const identity = generateIdentity();
  const staticServer = await startStaticServer(port, { registry, chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1",
    homeDir: root, userDataRoot: path.join(root, "desktop-assets"),
    authResolver: { resolveConnectAuth: () => ({ ...identity, token: "background-live", scopes: DEFAULT_OPERATOR_SCOPES }), storeDeviceToken() {} } });
  cleanup.push(() => staticServer.close());
  console.log(JSON.stringify({ url: `${staticServer.url}/#/chat`, root, agentId: codex.agentId, profileId: codex.id }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
