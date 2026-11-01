"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { prepareOfficialFixture } = require("./fixtures/official-skill-connector-fixture.cjs");
const { OFFICIAL_SKILL_IDS, validateOfficialSkillResult } = require("../app/core/official-skill-connector-dto");
const { McpExternalToolService } = require("../app/agent-service/mcp-external-tool-service");

async function main() {
  let accountState = "signedOut";
  const invocations = [], closed = [];
  const manager = { open() {}, setOAuth() {}, close() {}, closeServer(id) { closed.push(id); },
    async probe() { return this.listTools(); },
    async listTools() { return [{ name: "account_status", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]; },
    async callTool(id, name, args, scope) {
      scope.assertCurrent(); invocations.push({ id, name, args });
      if (name === "account_bind") accountState = "ready";
      if (name === "account_logout") accountState = "signedOut";
      return { content: [{ type: "text", text: JSON.stringify({ state: name === "account_start" ? "authorizing" : accountState,
        verificationUrl: name === "account_start" ? id.startsWith("official-quark-drive-") ? "https://pan.quark.cn/agent-oauth?fixture=service" : id.startsWith("official-rollinggo-hotel-") ? "https://api.rollinggo.store/s/fixture-service" : "https://weread.qq.com/r/weread-skills" : null,
        qrCode: null, userCode: null, userName: accountState === "ready" ? "Fixture account" : null, errorCode: null }) }] };
    } };
  const f = await startInspirationFixture({ isolatedHome: true, codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL: "1" },
    serviceOptions: { autoSparkNotes: false, officialSkillOptions: { prepare: prepareOfficialFixture }, nativeMcpClientManager: manager,
      setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} } });
  let external;
  const rest = async (endpoint, body, { origin = f.url, expected = 200, base = "official" } = {}) => {
    const response = await fetch(`${f.url}/__api/connectors/${base}/${endpoint}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { value = { error: text }; }
    assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  try {
    let catalog = await rest("status"); validateOfficialSkillResult("connector.official.status", catalog);
    assert.deepEqual(catalog.items.map(item => item.id), OFFICIAL_SKILL_IDS);
    assert.equal(catalog.items.every(item => item.state === "notInstalled"), true);
    await rest("install", { id: "weread", expectedRevision: 0 }, { origin: "https://untrusted.invalid", expected: 403 });
    await rest("install", { id: "weread", expectedRevision: 0, command: "arbitrary" }, { expected: 400 });
    await rest("status?path=outside", undefined, { expected: 400 });
    await assert.rejects(f.ipc("connector.official.install", { id: "weread", expectedRevision: 0, path: "/outside" }), { code: "OFFICIAL_SKILL_INVALID_ARGUMENT" });
    const installed = [];
    const legacyIds = OFFICIAL_SKILL_IDS.filter(id => !["doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(id));
    for (const id of legacyIds) {
      const state = await rest("install", { id, expectedRevision: 0 });
      assert.equal(state.state, "installed"); assert.equal(state.skillCount, 1); installed.push(state);
      assert.deepEqual((await f.backend.connectorRequest("connector.official.status", {})).items.find(item => item.id === id), state);
    }
    const controller = f.service.officialSkillConnectorController;
    await controller.close();
    const legacy = JSON.parse(fs.readFileSync(controller.recordPath, "utf8"));
    legacy.items = legacy.items.filter(item => legacyIds.includes(item.id));
    const original = JSON.stringify(legacy); fs.writeFileSync(controller.recordPath, original, { mode: 0o600 });
    controller.open();
    const upgraded = await rest("status");
    assert.deepEqual(upgraded.items.filter(item => legacyIds.includes(item.id)), installed);
    assert.ok(upgraded.items.filter(item => !legacyIds.includes(item.id)).every(item => item.state === "notInstalled"));
    assert.equal(fs.readFileSync(controller.recordPath, "utf8"), original, "reading the old catalog never rewrites ownership");
    assert.equal(invocations.length, 0, "migration never invokes an account or payment tool");
    const alipay = installed.find(item => item.id === "alipay");
    assert.equal((await rest("account", { id: "alipay", expectedRevision: alipay.revision, action: "status" })).state, "signedOut");
    for (const id of OFFICIAL_SKILL_IDS.filter(id => !legacyIds.includes(id))) {
      const state = await rest("install", { id, expectedRevision: 0 });
      assert.equal(state.state, "installed"); assert.equal(state.skillCount, 1); installed.push(state);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(controller.recordPath, "utf8")).items.filter(item => legacyIds.includes(item.id)), legacy.items);
    const weread = installed.find(item => item.id === "weread");
    assert.equal(f.service.nativeMcpStore.get(weread.serverId).status, "needsSetup");
    const profileId = f.service.productStore.listAgentProfiles()[0].id;
    const skills = await f.ipc("harness.skills.query", { profileId, query: "Official fixture", status: "on", pageIndex: 0, limit: 100, expectedRevision: null });
    assert.equal(skills.items.length, OFFICIAL_SKILL_IDS.length);
    external = new McpExternalToolService({ paths: f.paths, connector: f.service.mcpConnectorController,
      approvalBroker: { close() {} }, authorize: () => true, getPermissionProfile: () => ({ id: profileId, enabled: true }),
      getSubjects: async () => ({ items: [{ backendId: "openclaw", agentId: "fixture", enabled: true, connected: true }], unavailableBackends: [] }),
      getNativeSkillStore: () => f.service.nativeSkillStore });
    const identity = { backendId: "openclaw", instanceId: "official-fixture", agentId: "fixture", sessionId: "official-session", runId: "official-run", toolCallId: "search" };
    const shared = (name, args, toolCallId) => external.handle("mcp.external.tool", { credentialToken: "fixture", identity: { ...identity, toolCallId }, name, arguments: args });
    const found = await shared("shoggoth_capability_search", { query: "official fixture" }, "search");
    const discovered = [...found.items]; let page = found;
    while (page.nextCursor !== null) {
      page = await shared("shoggoth_capability_search", { query: "official fixture", cursor: page.nextCursor, revision: found.revision }, `search-${page.nextCursor}`);
      discovered.push(...page.items);
    }
    assert.equal(found.total, OFFICIAL_SKILL_IDS.length);
    assert.equal(discovered.length, OFFICIAL_SKILL_IDS.length); assert.equal(discovered.every(item => item.eligible), true);
    const skill = await shared("shoggoth_skill_read", { skillId: "official-weread" }, "read"); assert.ok(skill.content.includes(weread.serverId));
    const account = action => rest("account", { id: "weread", expectedRevision: weread.revision, action });
    assert.equal((await account("status")).state, "signedOut");
    assert.equal((await account("start")).state, "authorizing");
    assert.equal((await rest("account", { id: "weread", expectedRevision: weread.revision, action: "bind", code: "fixture-code" })).state, "ready");
    assert.equal((await account("logout")).state, "signedOut");
    const quark = installed.find(item => item.id === "quark-drive");
    const quarkAccount = (action, code) => rest("account", { id: "quark-drive", expectedRevision: quark.revision, action, ...(code ? { code } : {}) });
    assert.equal((await quarkAccount("status")).state, "signedOut");
    const quarkStarted = await quarkAccount("start"); assert.equal(quarkStarted.state, "authorizing");
    assert.equal(new URL(quarkStarted.verificationUrl).origin, "https://pan.quark.cn");
    assert.equal((await quarkAccount("bind", "fixture-quark-code")).state, "ready");
    assert.equal((await quarkAccount("logout")).state, "signedOut");
    const rollinggo = installed.find(item => item.id === "rollinggo-hotel");
    const rollinggoServer = f.service.nativeMcpStore.get(rollinggo.serverId);
    assert.deepEqual(rollinggoServer.setup.requiredFields, []);
    const rollinggoAccount = action => rest("account", { id: "rollinggo-hotel", expectedRevision: rollinggo.revision, action });
    assert.equal((await rollinggoAccount("status")).state, "signedOut");
    assert.equal(new URL((await rollinggoAccount("start")).verificationUrl).origin, "https://api.rollinggo.store");
    await rest("account", { id: "weread", expectedRevision: weread.revision, action: "pay" }, { expected: 400 });
    await rest("account", { id: "weread", expectedRevision: 0, action: "status" }, { expected: 409 });
    const canary = "isolated-provider-secret-canary";
    await f.backend.connectorRequest("connector.mcp.credentials.update", { id: weread.serverId,
      expectedRevision: f.service.nativeMcpStore.revision, fields: { env: { WEREAD_API_KEY: canary } } });
    assert.equal(fs.readFileSync(f.paths.nativeMcpRegistryPath, "utf8").includes(canary), false);
    assert.equal(fs.readFileSync(f.service.officialSkillConnectorController.recordPath, "utf8").includes(canary), false);
    assert.equal(JSON.stringify(await rest("status")).includes(canary), false);
    for (const item of installed) {
      await rest("remove", { id: item.id, expectedRevision: 0 }, { expected: 409 });
      const removed = await rest("remove", { id: item.id, expectedRevision: item.revision }); assert.equal(removed.state, "notInstalled");
      assert.equal(f.service.nativeMcpStore.get(item.serverId), null);
    }
    assert.equal(f.service.nativeSkillStore.listGlobalEnabled().some(skill => skill.id.startsWith("official-")), false);
    await assert.rejects(shared("shoggoth_skill_read", { skillId: "official-weread" }, "removed"), { code: "SKILL_NOT_ENABLED" });
    assert.equal(invocations.every(item => /^account_(status|start|bind|logout)$/u.test(item.name)), true);
    assert.ok(closed.length >= OFFICIAL_SKILL_IDS.length);
    console.log(JSON.stringify({ outcome: "PASS", providers: OFFICIAL_SKILL_IDS.length, serviceRestBackendIpc: true, exactDtoAndOrigin: true,
      skillDiscoveryNativeAndExternal: true, accountActions: true, encryptedMcpCredentialPath: true, removal: true,
      legacyCatalogUpgrade: true, isolatedHome: f.paths.homeDir === f.root, realAccountAuthorization: false, businessCalls: false }));
  } finally { external?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
