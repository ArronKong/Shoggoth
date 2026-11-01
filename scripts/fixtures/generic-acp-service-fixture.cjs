"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const repo = path.resolve(__dirname, "../.."), core = path.join(repo, "app/agent-service");
const { createAgentService } = require(path.join(core, "server"));
const { resolveServicePaths } = require(path.join(core, "paths"));
const { RuntimeExtensionCatalog } = require(path.join(core, "runtime-extension-manifest"));
const { requestService, readClientToken } = require(path.join(core, "client"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(core, "service-protocol-version"));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(15); }
  throw Error(label);
}
function sourceFingerprint() {
  const entries = [];
  const addTree = (directory, relative) => { for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), child = path.join(relative, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) addTree(file, child); else if (stat.isFile()) entries.push({ path: child, sha256: fileHash(file) });
    else throw Error("Source tree may not contain links");
  } };
  for (const directory of ["app/agent-service", "app/core", "schemas"]) addTree(path.join(repo, directory), directory);
  for (const name of fs.readdirSync(path.join(repo, "app")).sort()) if (/\.(?:js|json)$/u.test(name)) entries.push({ path: `app/${name}`, sha256: fileHash(path.join(repo, "app", name)) });
  return { digest: hash(JSON.stringify(entries)), entries };
}
async function createFixture({ root, agents = 2, beforeStart } = {}) {
  assert([1, 2].includes(agents));
  if (!root) { root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-acp-service-soak-")); fs.chmodSync(root, 0o700); }
  assert(root.startsWith("/private/tmp/sg-acp-") && fs.realpathSync(root) === root); assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const home = path.join(root, "home"); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = resolveServicePaths({ homeDir: home }), script = path.join(root, "peer.cjs"), peerSource = path.join(__dirname, "generic-acp-service-peer.cjs");
  if (!fs.existsSync(script)) { fs.copyFileSync(peerSource, script, fs.constants.COPYFILE_EXCL); fs.chmodSync(script, 0o600); }
  assert.equal(fileHash(script), fileHash(peerSource), "A retained fixture belongs to one frozen peer version");
  const commandNode = fs.realpathSync(process.execPath), runtime = "ext-service-soak", accountId = `extension-${runtime}`;
  const catalog = new RuntimeExtensionCatalog(paths);
  if (!fs.existsSync(catalog.file)) {
    const manifest = { version: 1, runtime, transport: "acp", command: commandNode, args: [script],
      files: [commandNode, script].map(file => ({ path: file, sha256: fileHash(file) })), endpoint: null, credentialRef: null };
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
    catalog.install({ manifest, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  }
  let nativeAcquireAttempts = 0;
  const service = createAgentService({ paths, prewarmMcpAuth: false, runtimeStorageHomedir: () => home,
    parentEnv: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root }, mcpHelperLaunch: { command: commandNode, argsPrefix: [] },
    runtimePool: { get() { nativeAcquireAttempts++; throw Error("Native runtime forbidden in Generic ACP stress proof"); }, async stopAll() {}, async stop() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  await beforeStart?.(service); await service.start();
  const fixtureFile = path.join(root, "fixture.json"); let metadata;
  if (fs.existsSync(fixtureFile)) { metadata = JSON.parse(fs.readFileSync(fixtureFile, "utf8")); assert.equal(metadata.agents, agents); }
  else {
    const base = { ...service.productStore.listAgentProfiles()[0] }; for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
    service.productStore.putAgentProfile({ ...base, enabled: false });
    const profiles = [], chats = [], workspaces = [];
    for (let index = 0; index < agents; index++) {
      const account = index ? `${accountId}-${index}` : accountId;
      if (index) service.productStore.putRuntimeAccount({ ...service.productStore.getRuntimeAccount(accountId), id: account, isDefault: false });
      const workspace = path.join(root, `workspace-${index}`); fs.mkdirSync(workspace, { mode: 0o700 }); workspaces.push(workspace);
      const profile = service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(), agentId: `shoggoth-acp-soak-${index}`,
        name: `Controlled ACP ${index}`, runtime, runtimeProfileId: `soak-profile-${index}`, runtimeAccountId: account,
        isDefault: false, enabled: true, defaultModel: null, defaultCwd: workspace,
        permissionPolicy: { sandbox: "danger-full-access", approvalPolicy: "on-request" } });
      service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name }); service.memoryStore.ensureProfile(profile.id);
      const chat = service.chatSessionStore.createSession({ operationId: `soak-create-${index}`, profileId: profile.id, workspace, createdAt: Date.now() });
      profiles.push(profile.id); chats.push(chat.sessionKey);
    }
    metadata = { version: 1, agents, profiles, chats, workspaces, commandNode, peerSha256: fileHash(script) };
    fs.writeFileSync(fixtureFile, JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  const profiles = metadata.profiles.map(id => service.productStore.getAgentProfile(id)), chats = metadata.chats.map(key => service.chatSessionStore.getSession(key));
  const auditRows = () => { const file = path.join(root, "peer-audit.jsonl"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; };
  const rpc = (method, params = {}) => requestService(paths, { token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method, params }, { timeoutMs: 15000 });
  const ownedHosts = new Set();
  const collectOwnedHosts = () => { for (const facade of service.workRunCoordinator.hostObservers.keys()) ownedHosts.add(facade.host || facade); return [...ownedHosts]; };
  const send = async (index, token, flags = "", operationId = `send-${token}`) => {
    const input = { operationId, sessionKey: chats[index].sessionKey, prompt: `[ACP_PROBE:${token}] ${flags} controlled task`, createdAt: Date.now() };
    const ack = await rpc("chat.send", input);
    const run = await until(() => { collectOwnedHosts(); const current = service.productStore.getWorkRun(ack.run.id); return !["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(current.status) && current; }, `Generic ACP ${token} terminal`, 20000);
    return { run, input };
  };
  const resourceSnapshot = () => ({ ownedHosts: collectOwnedHosts().length, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
    handles: process._getActiveHandles().map(handle => handle.constructor?.name || "Unknown"),
    listeningServerHandles: process._getActiveHandles().filter(handle => handle.constructor?.name === "Server" && handle.listening === true).length,
    coordinator: service.workRunCoordinator.state === "closed" ? { state: "closed" } : service.workRunCoordinator.getMemoryStats(),
    registry: service.runtimeManager.statistics(), nativeAcquireAttempts });
  const closeAndObserve = async () => {
    await service.stop({ notify: false });
    await until(() => auditRows().filter(row => row.kind === "started").every(row => { try { process.kill(row.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }), "all controlled ACP children stopped", 5000);
    assert.equal(fs.existsSync(paths.socketPath), false); assert.equal(nativeAcquireAttempts, 0);
    await until(() => !process._getActiveHandles().some(handle => handle.constructor?.name === "ChildProcess"), "closed child handles drained", 5000);
    const after = resourceSnapshot(); assert.equal(after.registry.hosts, 0); assert.equal(after.listeningServerHandles, 0); return after;
  };
  return { root, home, paths, metadata, profiles, chats, service, commandNode, runtime, script, auditRows, rpc, send, ownedHosts, collectOwnedHosts, resourceSnapshot, closeAndObserve };
}
module.exports = { createFixture, sourceFingerprint, fileHash, hash, until, pause };
