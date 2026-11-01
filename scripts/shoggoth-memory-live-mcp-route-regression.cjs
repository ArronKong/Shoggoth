"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { createAgentService } = require("../app/agent-service/server");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { FakeHost } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { isolatedEnv } = require("./runtime-v2-live-acceptance.cjs");
const { writeLiveMcpLauncher } = require("./shoggoth-memory-repair-live-worker.cjs");

// This relay fixture also runs on Linux CI. Linux ps comm is a short name,
// while the macOS product inspector expects an absolute executable path.
// Read the live kernel process data rather than replacing identity checks.
const processInspection = process.platform === "linux" ? {
  getProcessIdentity(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
    assert.match(fields[19], /^\d+$/u);
    return `linux:${pid}:${fields[19]}`;
  },
  getProcessLink(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
    return { ppid: Number(fields[1]), executable: fs.realpathSync(`/proc/${pid}/exe`),
      command: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim() };
  },
} : {};

function peer(child) {
  const pending = new Map();
  const reader = readline.createInterface({ input: child.stdout });
  reader.on("line", line => {
    const message = JSON.parse(line), request = pending.get(message.id);
    if (request) { pending.delete(message.id); request.resolve(message); }
  });
  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture response timeout")); }, 10000);
        pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); } });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() { reader.close(); },
  };
}

for (const protectedHome of [false, true]) test(`memory acceptance uses the actual consumed gate relay with ${protectedHome ? "protected Runtime" : "original"} HOME`, { timeout: 30000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgmemlive-")); fs.chmodSync(root, 0o700);
  const paths = resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) });
  const executable = fs.realpathSync(process.execPath), helper = path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs");
  fs.writeFileSync(path.join(root, "worker.json"), JSON.stringify({ root, suite: "repair" }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "mcp-key.bin"), crypto.randomBytes(32), { mode: 0o600 });
  const helperCommand = writeLiveMcpLauncher(root), nativeHome = protectedHome ? path.join(root, "private-runtime-home") : root;
  if (protectedHome) fs.mkdirSync(nativeHome, { mode: 0o700 });
  const issuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: helperCommand }, bootstrapPath: helper,
    ...processInspection });
  const host = new FakeHost([]), children = [];
  const service = createAgentService({ paths, runtimeStorageHomedir: root, parentEnv: isolatedEnv(root),
    version: "memory-route-fixture", prewarmMcpAuth: false, runtimeMcpGateIssuer: issuer,
    runtimePool: { async get() { return host; }, async stop() {}, async stopAll() {} },
    // Deliberately incompatible with the fixture helper's local crypto path:
    // a fallback to local auth cannot accidentally make this test pass.
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    memoryCore: true, memoryCoreConfig: { memory: { search: { provider: "none" } },
      plugins: { entries: { "active-memory": { enabled: false } } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } },
  });
  let client;
  const launch = descriptor => {
    const child = spawn(descriptor.command, descriptor.args, { cwd: root,
      env: { ...isolatedEnv(root), HOME: nativeHome, ...Object.fromEntries(descriptor.env.map(item => [item.name, item.value])) },
      stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    children.push({ child, closed }); return { child, closed };
  };
  try {
    await service.start();
    const profile = service.productStore.listAgentProfiles()[0], workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
    const session = service.chatSessionStore.createSession({ operationId: crypto.randomUUID(), profileId: profile.id, workspace, createdAt: Date.now() });
    const fact = "The isolated relay fixture prefers blue tomatoes.";
    // Keep this compatibility relay test on a native Run. The explicit
    // "Remember:" grammar is now completed by the host and is tested separately.
    const ack = await service.workRunCoordinator.send({ operationId: crypto.randomUUID(), sessionKey: session.sessionKey, prompt: `Please remember this fact for future conversations: ${fact}` });
    await service.workRunCoordinator.waitForIdle(ack.run.id);
    assert.equal(service.workRunCoordinator.getRun(ack.run.id).status, "running");
    const descriptor = issuer.createMcpServer({ runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      parentPid: process.pid, parentExecutable: executable, executionRunId: ack.run.id });
    const first = launch(descriptor); client = peer(first.child);
    const initialized = await client.request(0, "initialize", { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { roots: {} }, clientInfo: { name: "opencode-shaped-fixture", version: "1" } });
    assert.equal(initialized.result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);
    const gatePath = descriptor.env.find(item => item.name === "SHOGGOTH_RUNTIME_MCP_GATE_FILE").value;
    assert.equal(fs.existsSync(gatePath), false, "the Service must consume the real gate");
    const saved = await client.request(1, "tools/call", { name: "memory_save", arguments: {
      source: "chat", sourceId: session.sessionKey, expectedRevision: service.memoryStore.getRevision(profile.id),
      content: fact, scope: "agent", classification: "explicit", sourceQuote: fact,
    } });
    assert.equal(saved.result?.isError, false, JSON.stringify(saved));
    assert.equal(service.memoryStore.list(profile.id, { status: "active" }).some(item => item.content === fact), true);
    await service.workRunCoordinator.abort({ operationId: crypto.randomUUID(), sessionKey: session.sessionKey, runId: ack.run.id });
    const late = await client.request(2, "tools/call", { name: "app_status", arguments: {} });
    assert.equal(late.result?.isError === true || !!late.error, true, "terminal Run authority cannot be reused");
    first.child.stdin.end(); assert.deepEqual(await first.closed, { code: 0, signal: null });
    const repeated = launch(descriptor); repeated.child.stdin.end();
    assert.equal((await repeated.closed).code, 1, "a consumed gate cannot fall back to local auth");
    const evidence = fs.readFileSync(path.join(root, "mcp-fixture-io.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(evidence.some(item => item.route === "runtime-gate-relay"));
    assert.ok(evidence.some(item => item.toolName === "memory_save" && item.isError === false));
    assert.ok(evidence.some(item => item.method === "startup-error" && item.codes.includes("RUNTIME_MCP_GATE_MISSING")));
    assert.equal(evidence.some(item => item.method === "elicitation/create" || item.route === "local-auth"), false);
  } finally {
    client?.close();
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(item => item.closed));
    await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true });
  }
});
