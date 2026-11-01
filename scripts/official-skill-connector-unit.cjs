"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
const { OfficialSkillConnectorController } = require("../app/agent-service/official-skill-connector-controller");
const { prepareOfficialFixture } = require("./fixtures/official-skill-connector-fixture.cjs");
const dto = require("../app/core/official-skill-connector-dto");

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-official-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const skills = new NativeSkillStore({ paths }); skills.open(["profile-a"]);
  const servers = new Map(), secretValues = new Map(), closed = [], revoked = [];
  const store = {
    revision: 0, getPrivate: id => servers.get(id) || null,
    register({ server, expectedRevision }) { assert.equal(expectedRevision, this.revision); servers.set(server.id, structuredClone(server)); this.revision++; },
    update({ id, patch, expectedRevision }) { assert.equal(expectedRevision, this.revision); Object.assign(servers.get(id), structuredClone(patch)); this.revision++; },
    setStatus(id, status, lastCheck) { const server = servers.get(id); server.status = status; server.lastCheck = lastCheck; this.revision++; },
    remove({ id, expectedRevision }) { assert.equal(expectedRevision, this.revision); servers.delete(id); this.revision++; },
  };
  let accountResult = { state: "signedOut", verificationUrl: null, qrCode: null, userCode: null, userName: null, errorCode: null };
  const mcp = { store, mutate: async action => action(), invalidate() {}, revokeRuns: id => revoked.push(id), oauth: { cancelServer() {} },
    manager: { closeServer: async id => closed.push(id), callTool: async (_id, _name, _args, { assertCurrent }) => { assertCurrent(); return { content: [{ type: "text", text: JSON.stringify(accountResult) }] }; } },
    secrets: { remove: async id => secretValues.delete(id) },
    verify: async id => store.setStatus(id, "ready", { toolCount: 2 }),
  };
  const providers = Object.fromEntries(dto.OFFICIAL_SKILL_IDS.map(id => [id, { name: id, version: "1.0.0", requiredFields: id === "weread" ? ["env:WEREAD_API_KEY"] : [] }]));
  const make = () => new OfficialSkillConnectorController({ paths, skillStore: skills, mcpController: mcp, providers, prepare: prepareOfficialFixture, ...options });
  const controller = make(); controller.open();
  t.after(async () => { await controller.close(); skills.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const change = (action, id = "weread", revision = controller.status(id).revision) => controller.handle(`connector.official.${action}`, { id, expectedRevision: revision });
  return { root, paths, skills, servers, secretValues, mcp, controller, make, change, closed, revoked,
    account: action => controller.handle("connector.official.account", { id: "weread", expectedRevision: controller.status("weread").revision, action }),
    setAccount: result => { accountResult = result; } };
}

test("explicit install registers exact Skills and an unconfigured MCP; remove revokes and deletes only owned state", async t => {
  const f = fixture(t); assert.equal(f.controller.handle("connector.official.status", {}).items.length, dto.OFFICIAL_SKILL_IDS.length);
  assert.equal(f.skills.registry.packages.length, 0);
  const installed = await f.change("install");
  assert.equal(installed.state, "installed"); assert.equal(installed.skillCount, 1);
  const server = f.servers.get(installed.serverId); assert.equal(server.status, "needsSetup");
  assert.deepEqual(server.setup.requiredFields, ["env:WEREAD_API_KEY"]);
  assert.deepEqual(f.skills.listGlobalEnabled()[0].requiredTools, ["mcp_server_list", "mcp_server_tools", "mcp_server_call"]);
  const unrelated = path.join(f.root, "user-cli"); fs.writeFileSync(unrelated, "preserve");
  const skill = f.skills.registry.packages[0]; f.skills.setProfileSkill({ profileId: "profile-a", skillId: skill.id, source: "user", version: skill.version, enabled: true, expectedRevision: f.skills.list("profile-a").profileRevision });
  f.secretValues.set(installed.serverId, "private-canary");
  const removed = await f.change("remove"); assert.equal(removed.state, "notInstalled");
  assert.equal(f.servers.size, 0); assert.equal(f.secretValues.size, 0); assert.equal(f.skills.registry.packages.length, 0);
  assert.ok(f.closed.includes(installed.serverId)); assert.ok(f.revoked.includes(installed.serverId));
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve");
});

test("repair preserves private account home, MCP credentials, server identity and per-agent availability", async t => {
  const f = fixture(t); const installed = await f.change("install");
  const item = f.controller.records.get("weread").installation, root = f.controller._root("weread", item);
  const account = path.join(root, "home", "account.json"); fs.writeFileSync(account, "private-account-canary", { mode: 0o600 });
  const server = f.servers.get(installed.serverId); server.secretRef = `mcp-connector:${installed.serverId}`;
  server.setup.configuredFields = ["env:WEREAD_API_KEY"]; server.disabledProfileIds = ["profile-a"];
  f.secretValues.set(installed.serverId, "private-key-canary");
  fs.unlinkSync(path.join(root, "payload.txt")); assert.equal(f.controller.status("weread").state, "failed");
  const repaired = await f.change("install"); assert.equal(repaired.state, "installed"); assert.equal(repaired.serverId, installed.serverId);
  assert.equal(fs.readFileSync(account, "utf8"), "private-account-canary"); assert.equal(f.secretValues.get(installed.serverId), "private-key-canary");
  assert.deepEqual(f.servers.get(installed.serverId).disabledProfileIds, ["profile-a"]);
  assert.equal(f.servers.get(installed.serverId).status, "ready");
});

test("same-name imported Skills are never adopted or removed", async t => {
  const f = fixture(t), source = path.join(f.root, "user-skill"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: official-weread\ndescription: User skill\n---\nPreserve.\n");
  f.skills.installFromDirectory({ sourcePath: source, operationId: "manual", expectedRevision: f.skills.revision, globalEnabled: true });
  const before = JSON.stringify(f.skills.registry.packages);
  await assert.rejects(f.change("install"), { code: "OFFICIAL_SKILL_CONFLICT" });
  await f.change("remove"); assert.equal(JSON.stringify(f.skills.registry.packages), before);
});

test("only explicit repair reconnects a disabled or restored registration", async t => {
  const f = fixture(t); const installed = await f.change("install");
  const server = f.servers.get(installed.serverId); server.enabled = false; server.status = "disabled"; server.disabledProfileIds = ["profile-a"];
  assert.equal(f.controller.status("weread").state, "installed"); assert.equal(server.enabled, false);
  const repaired = await f.change("install"); assert.equal(repaired.state, "installed"); assert.ok(repaired.revision > installed.revision);
  assert.equal(server.enabled, true); assert.equal(server.status, "needsSetup"); assert.deepEqual(server.disabledProfileIds, ["profile-a"]);
});

test("a relocated host executable requires explicit repair without blocking unrelated providers", async t => {
  const f = fixture(t); const installed = await f.change("install");
  const record = f.controller.records.get("weread"), server = f.servers.get(installed.serverId);
  record.installation.transport.command = "/old-installation/Shoggoth";
  server.transport.command = "/old-installation/Shoggoth";
  f.controller._write("weread", {}); await f.controller.close();
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status("weread").errorCode, "OFFICIAL_SKILL_INCOMPLETE");
  assert.equal(restarted.status("fliggy").state, "notInstalled");
  const repaired = await restarted.handle("connector.official.install", { id: "weread", expectedRevision: restarted.status("weread").revision });
  assert.equal(repaired.state, "installed"); assert.equal(f.servers.get(installed.serverId).transport.command, process.execPath);
});

test("altered payload, altered transport and symlinks cannot grant removal authority", async t => {
  const f = fixture(t); const installed = await f.change("install"), root = f.controller._root("weread");
  fs.appendFileSync(path.join(root, "payload.txt"), "modified");
  await assert.rejects(f.change("remove"), { code: "OFFICIAL_SKILL_OWNERSHIP_CONFLICT" });
  assert.equal(f.skills.registry.packages.length, 1); assert.ok(f.servers.has(installed.serverId));
  fs.writeFileSync(path.join(root, "payload.txt"), "official fixture payload");
  const server = f.servers.get(installed.serverId), transport = server.transport; server.transport = { ...transport, args: ["unowned"] };
  await assert.rejects(f.change("remove"), { code: "OFFICIAL_SKILL_OWNERSHIP_CONFLICT" }); server.transport = transport;
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.symlinkSync(outside, path.join(root, "injected"));
  await assert.rejects(f.change("remove"), { code: "OFFICIAL_SKILL_OWNERSHIP_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
});

test("CAS, duplicate operations and shutdown fence installs; restart does not replay downloads", async t => {
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { prepare: ({ signal }) => new Promise((_, reject) => { entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }) });
  const work = f.change("install"); const rejected = assert.rejects(work, { code: "OFFICIAL_SKILL_INTERRUPTED" }); await began;
  assert.throws(() => f.change("install"), { code: "OFFICIAL_SKILL_BUSY" });
  await f.controller.close(); await rejected;
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status("weread").errorCode, "OFFICIAL_SKILL_INTERRUPTED");
  assert.throws(() => restarted.handle("connector.official.remove", { id: "weread", expectedRevision: 0 }), { code: "OFFICIAL_SKILL_REVISION_CONFLICT" });
  await restarted.handle("connector.official.remove", { id: "weread", expectedRevision: restarted.status("weread").revision });
  assert.equal(f.skills.registry.packages.length, 0);
});

test("account output is strictly validated, official URL scoped and separated from installation", async t => {
  const f = fixture(t); await f.change("install");
  assert.equal((await f.account("status")).state, "signedOut"); assert.equal(f.controller.status("weread").state, "installed");
  f.setAccount({ state: "authorizing", verificationUrl: "https://weread.qq.com/r/weread-skills", qrCode: null, userCode: "safe-code", userName: null, errorCode: null });
  assert.equal((await f.account("start")).verificationUrl, "https://weread.qq.com/r/weread-skills");
  f.setAccount({ state: "ready", verificationUrl: "https://weread.qq.com.attacker.invalid/auth", qrCode: null, userCode: null, userName: "user", errorCode: null });
  await assert.rejects(f.account("status"));
  f.setAccount({ state: "ready", verificationUrl: null, qrCode: null, userCode: null, userName: "user", errorCode: null, token: "private-canary" });
  await assert.rejects(f.account("status"));
});

test("corrupt ownership records block mutations without adopting installed files", async t => {
  const f = fixture(t); await f.change("install"); await f.controller.close();
  fs.writeFileSync(f.controller.recordPath, JSON.stringify({ schemaVersion: 1, items: [{ id: "weread", installation: { id: "../../outside" } }] }), { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status("weread").canRemove, false);
  assert.throws(() => restarted.handle("connector.official.remove", { id: "weread", expectedRevision: 0 }), { code: "OFFICIAL_SKILL_STATE_UNAVAILABLE" });
  assert.equal(f.skills.registry.packages.length, 1);
});

test("public DTO rejects extra input and never exposes raw provider errors", () => {
  assert.throws(() => dto.validateOfficialSkillParams("connector.official.install", { id: "weread", expectedRevision: 0, command: "anything" }));
  assert.throws(() => dto.validateOfficialSkillParams("connector.official.account", { id: "weread", expectedRevision: 0, action: "pay" }));
  assert.throws(() => dto.validateOfficialSkillParams("connector.official.account", { id: "weread", expectedRevision: 0, action: "start", code: "unneeded" }));
  assert.equal(dto.validOfficialVerificationUrl("alipay", "https://u.alipay.cn/safe"), true);
  assert.equal(dto.validOfficialVerificationUrl("alipay", "https://u.alipay.cn.attacker.invalid"), false);
  assert.equal(dto.validOfficialVerificationUrl("shop", "https://accounts.shop.app/device?user_code=ABC123"), true);
  assert.equal(dto.validOfficialVerificationUrl("shop", "https://accounts.shop.app.attacker.invalid/device"), false);
  assert.equal(JSON.stringify(dto.officialSkillPublicError(Error("private-canary"))).includes("private-canary"), false);
});

test("existing five-provider records gain uninstalled Shop, DoorDash and Quark without changing ownership or reconnecting", async t => {
  const f = fixture(t); const installed = await f.change("install"); await f.controller.close();
  const stored = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  stored.items = stored.items.filter(item => !["shop", "doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(item.id));
  assert.equal(stored.items.length, 5);
  const original = JSON.stringify(stored); fs.writeFileSync(f.controller.recordPath, original, { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status("weread").serverId, installed.serverId);
  assert.equal(restarted.status("weread").state, "installed");
  assert.equal(restarted.status("shop").state, "notInstalled");
  assert.equal(restarted.status("doordash").state, "notInstalled");
  assert.equal(restarted.status("quark-drive").state, "notInstalled");
  assert.equal(fs.readFileSync(f.controller.recordPath, "utf8"), original, "reading legacy records never rewrites them");
  await restarted.handle("connector.official.install", { id: "shop", expectedRevision: 0 });
  const expanded = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  assert.deepEqual(expanded.items.filter(item => !["shop", "doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(item.id)), stored.items);
});

test("the six-provider catalog gains DoorDash and Quark without rewriting existing account or ownership records", async t => {
  const f = fixture(t); const installed = await f.change("install"); await f.controller.close();
  const stored = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  stored.items = stored.items.filter(item => !["doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(item.id));
  assert.equal(stored.items.length, 6);
  const original = JSON.stringify(stored); fs.writeFileSync(f.controller.recordPath, original, { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status("weread").serverId, installed.serverId);
  assert.equal(restarted.status("weread").state, "installed");
  assert.equal(restarted.status("doordash").state, "notInstalled");
  assert.equal(restarted.status("quark-drive").state, "notInstalled");
  assert.equal(fs.readFileSync(f.controller.recordPath, "utf8"), original);
  await restarted.handle("connector.official.install", { id: "doordash", expectedRevision: 0 });
  const expanded = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  assert.deepEqual(expanded.items.filter(item => !["doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(item.id)), stored.items);
});

test("the seven-provider catalog preserves Alipay installation, private home, credentials and access while adding uninstalled Quark", async t => {
  const f = fixture(t); const installed = await f.change("install", "alipay");
  const accountPath = path.join(f.controller._root("alipay"), "home", "account.json");
  fs.writeFileSync(accountPath, "private-account-canary", { mode: 0o600 });
  const server = f.servers.get(installed.serverId);
  server.secretRef = `mcp-connector:${installed.serverId}`; server.disabledProfileIds = ["profile-a"];
  f.secretValues.set(installed.serverId, "private-key-canary");
  await f.controller.close();
  const stored = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  stored.items = stored.items.filter(item => !["quark-drive", "rollinggo-hotel", "baidu-maps"].includes(item.id));
  assert.equal(stored.items.length, 7);
  const original = JSON.stringify(stored); fs.writeFileSync(f.controller.recordPath, original, { mode: 0o600 });
  let probes = 0, accountCalls = 0;
  f.mcp.verify = async () => { probes++; };
  const callTool = f.mcp.manager.callTool;
  f.mcp.manager.callTool = async (...args) => { accountCalls++; return callTool(...args); };
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.deepEqual(restarted.status("alipay"), installed);
  assert.equal(restarted.status("quark-drive").state, "notInstalled");
  assert.equal(fs.readFileSync(f.controller.recordPath, "utf8"), original);
  assert.equal(probes, 0); assert.equal(accountCalls, 0, "migration does not reconnect or authorize accounts");
  assert.equal((await restarted.handle("connector.official.account", { id: "alipay", expectedRevision: installed.revision, action: "status" })).state, "signedOut");
  await restarted.handle("connector.official.install", { id: "quark-drive", expectedRevision: 0 });
  const expanded = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  assert.deepEqual(expanded.items.map(item => item.id), dto.OFFICIAL_SKILL_IDS);
  assert.deepEqual(expanded.items.filter(item => !["quark-drive", "rollinggo-hotel", "baidu-maps"].includes(item.id)), stored.items);
  assert.equal(fs.readFileSync(accountPath, "utf8"), "private-account-canary");
  assert.equal(server.secretRef, `mcp-connector:${installed.serverId}`);
  assert.deepEqual(server.disabledProfileIds, ["profile-a"]);
  assert.equal(f.secretValues.get(installed.serverId), "private-key-canary");
});

for (const omitted of [["shop", "doordash"], ["doordash"], []]) test(`previously accepted Quark catalog without ${omitted.join("/") || "any original provider"} remains readable after adding RollingGo`, async t => {
  const f = fixture(t); const installed = await f.change("install"); await f.controller.close();
  const stored = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  stored.items = stored.items.filter(item => ![...omitted, "rollinggo-hotel", "baidu-maps"].includes(item.id));
  const original = JSON.stringify(stored); fs.writeFileSync(f.controller.recordPath, original, { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.deepEqual(restarted.status("weread"), installed);
  assert.equal(restarted.status("rollinggo-hotel").state, "notInstalled");
  assert.equal(fs.readFileSync(f.controller.recordPath, "utf8"), original);
});

for (const corruption of ["missing-provider", "duplicate-provider", "unknown-provider", "schema-version"]) test(`an invalid catalog (${corruption}) cannot be mistaken for an additive migration`, async t => {
  const f = fixture(t); await f.change("install"); await f.controller.close();
  const stored = JSON.parse(fs.readFileSync(f.controller.recordPath, "utf8"));
  if (corruption === "missing-provider") stored.items = stored.items.filter(item => item.id !== "fliggy");
  if (corruption === "duplicate-provider") stored.items.push(stored.items[0]);
  if (corruption === "unknown-provider") stored.items[0].id = "unknown";
  if (corruption === "schema-version") stored.schemaVersion = 2;
  const original = JSON.stringify(stored); fs.writeFileSync(f.controller.recordPath, original, { mode: 0o600 });
  const restarted = f.make(); restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.status("alipay").errorCode, "OFFICIAL_SKILL_STATE_UNAVAILABLE");
  assert.throws(() => restarted.handle("connector.official.install", { id: "alipay", expectedRevision: 0 }), { code: "OFFICIAL_SKILL_STATE_UNAVAILABLE" });
  assert.equal(fs.readFileSync(f.controller.recordPath, "utf8"), original);
});
