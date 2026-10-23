#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AppStateReadService } = require("../app/agent-service/app-state-read-service");
const { AppStateHostReader } = require("../app/app-state-host-reader");
const { AppStatePager, snapshot, resourceRevision } = require("../app/agent-service/app-state-projection");
const { APP_STATE_SECTIONS, validateAppStateHostResult } = require("../app/agent-service/app-state-contract");
const { normalizeConfig } = require("../app/core/config-store");
const CANARY = "fixture-private-canary";
const AUTH = { profileId: "p1" };
const query = (section, limit = 50, cursor = null) => ({ section, limit, cursor });

function fixture() {
  const profiles = [{ id: "p1", backendId: "shoggoth", agentId: "shoggoth-one", enabled: true, name: "One", defaultModel: "m1", providerRef: "provider" },
    { id: "p2", backendId: "codex", agentId: "codex-two", enabled: true, name: "Two" }];
  const jobs = Array.from({ length: 131 }, (_, index) => ({ id: `job-${index}`, profileId: index % 2 ? "p1" : "p2",
    name: `Cron ${index}`, prompt: CANARY, enabled: index !== 0, schedule: { kind: "every", everyMs: 60_000 }, nextRunAt: 10, createdAt: index, updatedAt: index }));
  const backendJobs = Array.from({ length: 151 }, (_, index) => ({ id: `hermes-agent:cron-${index}`, backendId: "hermes", agentId: "hermes-agent",
    name: `External Cron ${index}`, enabled: true, scheduleDisplay: "every minute", state: "scheduled", prompt: CANARY, lastError: CANARY }));
  const statuses = [{ id: "shoggoth", connected: true }, { id: "codex", connected: false, disabled: true },
    { id: "hermes", connected: true }, { id: "openclaw", connected: true }];
  const sharedBackend = { listAgents: async () => [{ id: "external-agent", name: "External", workspace: CANARY, apiKey: CANARY }],
    getCronJobs: async () => backendJobs, getBoards: async () => [{ id: "default", name: "External board" }],
    getTaskBoard: async options => { assert.equal(options.readOnly, true); return { columns: [{ id: "running", tasks: [{ id: "t1", title: "Task", body: CANARY }] }] }; },
    getSessionRowsSnapshot: () => ({ complete: true, rows: [{ key: "session-1", title: "External", transcript: CANARY }] }),
    getRunningWork: async () => ({ supported: true, items: [] }), getRecentCronRuns: async () => ({ runs: [] }),
    getModels: async () => assert.fail("do not use a fail-soft model read"),
    getModelCatalogSources: async () => ({ models: [{ id: "model", provider: "test", apiKey: CANARY, baseUrl: CANARY }] }),
    getSkills: async () => [{ id: "s2", name: "External", enabled: true, body: CANARY }],
    getUsageSeries: async () => ({ totals: { totalTokens: 10, totalCost: 0.1, apiKey: CANARY } }), getStatus: async () => ({ info: { version: "1" } }),
    getBackendDescriptor: () => ({ surfaces: { runtimeStatus: false } }),
  };
  const host = new AppStateHostReader({ registry: { getBackend: backendId => ({ ...sharedBackend, getCronJobs: async () => backendJobs.map(row => ({ ...row, backendId, id: `${backendId}:cron-${row.id.split(":").at(-1)}`, agentId: `${backendId}-agent` })) }) }, getStatuses: async () => statuses, now: () => 1_000 });
  const ideas = [{ id: "idea-unassigned", title: "Unassigned", body: "Note", archivedAt: null, favorite: true, revision: 1 },
    { id: "idea-assigned-saved", title: "Assigned", archivedAt: null, revision: 1 },
    { id: "idea-archived", title: "Archived", archivedAt: 10, revision: 1 }];
  const options = {
    now: () => 1_000,
    agentDefinitionStore: { get: () => ({ documents: { identity: "- Responsibilities: Test specialist\n- Private: " + CANARY } }) },
    productStore: { listAgentProfiles: () => profiles, listWorkRuns: () => [{ id: "r1", source: "cron", sourceId: "job-1", profileId: "p1", status: "waiting_input", createdAt: 1, prompt: CANARY }],
      listModelProviders: () => [{ id: "provider", name: "Provider", apiKey: CANARY, credentialRef: CANARY }] },
    cronStore: { listJobs: input => { assert.equal(input, undefined); return jobs; } },
    kanbanStore: { listBoards: () => [{ id: "b1", profileId: "p2", name: "Board", description: CANARY }],
      listCards: () => [{ id: "c1", boardId: "b1", profileId: "p2", title: "Card", body: CANARY, status: "running", archivedAt: null }], listCardRunLinks: () => [] },
    inspirationStore: { list: () => ideas }, inspirationService: { view: id => ({ ...ideas.find(row => row.id === id), status: "saved",
      latestExecution: id === "idea-assigned-saved" ? { agentId: "shoggoth-one", backendId: "shoggoth", status: "skipped", attention: { command: CANARY } } : null }),
      handle: async () => ({ enabled: true, executors: [], private: CANARY }) },
    chatSessionStore: { listSessions: () => [{ id: "session-native", profileId: "p2", title: "Native", transcript: CANARY }] },
    runtimeAccountController: { handle: async () => ({ accounts: [{ id: "account", runtime: "codex", homePath: CANARY, token: CANARY, admission: { active: 1, maxActive: 2 } }], nextCursor: null }) },
    nativeSkillStore: { list: () => ({ items: [{ id: "s1", name: "Native", enabled: true, globalEnabled: true, body: CANARY }] }) },
    skillStore: { catalog: () => ({ items: [], ineligible: [] }) },
    nativeMcpStore: { list: () => ({ revision: 1, servers: [{ id: "server", name: "MCP", enabled: true, env: { token: CANARY }, command: CANARY }] }) },
    pluginStore: { listInstallations: () => [{ installationId: "plugin", desiredState: "enabled", sourceIdentity: CANARY }], listGlobalBindings: () => [],
      getRelease: () => ({ name: "Fixture Plugin", declaredVersion: "1", components: { skills: [{ name: "disabled-skill" }], mcpServers: [{ name: "disabled-mcp", type: "stdio", env: { token: CANARY } }], hooks: [] } }),
      listBindingsForProfile: () => [], listConnections: () => [{ connectionId: "connection", installationId: "plugin", state: "ready", endpointIdentity: CANARY, principalIdentity: CANARY }] },
    usageStore: { summarize: () => ({ series: { totals: { totalTokens: 20, totalCost: 0.2, private: CANARY } } }) },
    getSettings: () => normalizeConfig({ token: CANARY, gatewayUrl: CANARY, notifications: { chat: true },
      notificationPolicy: { suppressWhileFocused: true, quietHours: { start: "22:00", end: "08:00", timezone: "Asia/Shanghai" } },
      hermesRemotes: [{ profile: "private", baseUrl: "https://private.example", token: CANARY }] }),
    getServiceStatus: () => ({ healthy: true, serviceVersion: "1", startedAt: 10, domainAvailability: { cron: { available: true }, kanban: { available: true } }, token: CANARY }),
    computerUseController: { status: async () => ({ available: true, permissions: { accessibility: false, screenRecording: false }, sessions: [] }),
      requestPermissions: () => assert.fail("global reads must not request TCC") },
    browserUseController: { status: async () => ({ available: false, reason: "BROWSER_DISABLED", sessions: [] }), create: () => assert.fail("no browser creation") },
    federationClient: { request: async (method, params) => method === "backend.status" ? { backends: statuses } : host.read(params) },
  };
  return { service: new AppStateReadService(options), host, jobs, backendJobs, profiles, statuses, options };
}

async function all(service, section, authority = AUTH) {
  const items = []; let cursor = null, first;
  do { const value = await service.get(query(section, 50, cursor), authority); first ??= value;
    assert(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024); items.push(...value.items); cursor = value.nextCursor; } while (cursor);
  return { ...first, items };
}

test("global Cron includes both native Profiles and more than 100 jobs per external backend", async () => {
  const f = fixture();
  const value = await all(f.service, "cron");
  assert.equal(value.complete, true); assert.equal(value.total, 131 + 2 * 151);
  assert.equal(value.items.filter(row => row.profileId === "p2").length, 66);
  assert.equal(value.items.find(row => row.id === "job-1").status, "waiting_input");
  assert.equal(value.summary.enabled, value.total - 1);
  assert.equal(JSON.stringify(value).includes(CANARY), false);
  assert.equal(value.summary.byAgent.find(row => row.agentId === "codex-two").total, 66);
  assert.equal(value.items.find(row => row.id === "job-1").revision, resourceRevision("cron", f.jobs[1]));
});

test("unassigned is target absence, includes archived counts, and never includes approval contents", async () => {
  const { service } = fixture(); const value = await all(service, "inspiration");
  assert.equal(value.total, 3); assert.equal(value.summary.unassigned, 1);
  assert.equal(value.summary.unassignedIncludingArchived, 2); assert.equal(value.summary.archived, 1);
  assert.equal(value.items.find(row => row.id === "idea-assigned-saved").assigned, true);
  assert.equal(JSON.stringify(value).includes(CANARY), false);
});

test("overview covers every section without bodies, secrets, credential URLs or UI access", async () => {
  const f = fixture(), value = await f.service.get(query("overview"), AUTH);
  assert.deepEqual(Object.keys(value.summary.sections).sort(), APP_STATE_SECTIONS.filter(section => section !== "overview").sort());
  assert.equal(value.items.length, 0); assert.equal(JSON.stringify(value).includes(CANARY), false);
  assert.equal(value.summary.sections.agents.summary.connectedTotal, 3);
  assert.equal(value.summary.sections.kanban.summary.cards, 3);
  assert.equal(value.summary.sections.computer.summary.permissions.accessibility, false);
  assert.equal(value.summary.sections.usage.summary.totalTokens, 40);
  assert.equal(value.summary.sections.runs.total, null, "recent external history is never a complete history total");
  for (const section of APP_STATE_SECTIONS.filter(section => section !== "overview")) {
    const detail = await all(f.service, section); assert.equal(JSON.stringify(detail).includes(CANARY), false, section);
  }
  const settings = await all(f.service, "settings"); assert.equal(settings.items[0].notificationPolicy.quietHours.enabled, true);
});

test("App host loss retains native records and reports unknown connectivity and totals", async () => {
  const f = fixture(); f.options.federationClient = { request: async () => { throw Object.assign(new Error(CANARY), { code: "APP_HOST_UNAVAILABLE" }); } };
  const service = new AppStateReadService(f.options), cron = await all(service, "cron");
  assert.equal(cron.knownTotal, 131); assert.equal(cron.total, null); assert.equal(cron.available, true);
  const agents = await all(service, "agents"); assert.equal(agents.knownTotal, 2);
  assert.equal(agents.summary.connectedTotal, null); assert(agents.items.every(row => row.connected === null));
  assert.equal(JSON.stringify(agents).includes(CANARY), false);
});

test("disconnected and failed backends are isolated, never converted to zero totals", async () => {
  const f = fixture(); f.statuses.find(row => row.id === "hermes").connected = false;
  const value = await all(f.service, "cron"); assert.equal(value.knownTotal, 131 + 151); assert.equal(value.total, null);
  assert(value.unavailableSources.some(row => row.source === "hermes" && row.code === "BACKEND_DISCONNECTED"));
});

test("pagination is immutable, principal/section bound, byte bounded and expires explicitly", async () => {
  let now = 1; const pager = new AppStatePager({ now: () => now });
  const value = snapshot("cron", Array.from({ length: 50 }, (_, id) => ({ id, name: "😀".repeat(512) })), [], {}, now);
  const first = pager.page(value, query("cron"), "p1"); assert(first.items.length < 50);
  value.items.splice(0, value.items.length); const second = pager.page({ section: "cron" }, query("cron", 50, first.nextCursor), "p1");
  assert.equal(second.knownTotal, 50);
  assert.throws(() => pager.page({ section: "cron" }, query("cron", 50, first.nextCursor), "p2"), { code: "APP_STATE_CURSOR_INVALID" });
  assert.throws(() => pager.page({ section: "agents" }, query("agents", 50, first.nextCursor), "p1"), { code: "APP_STATE_CURSOR_INVALID" });
  now += 120_001; assert.throws(() => pager.page({ section: "cron" }, query("cron", 50, first.nextCursor), "p1"), { code: "APP_STATE_CURSOR_EXPIRED" });
});

test("private host protocol rejects extra fields and wrong-section results", async () => {
  const value = await fixture().host.read(query("cron")); assert(validateAppStateHostResult(value, query("cron")));
  assert.equal(validateAppStateHostResult(value, query("agents")), false);
  const tampered = structuredClone(value); tampered.summary.token = CANARY; assert.equal(validateAppStateHostResult(tampered, query("cron")), false);
  value.items[0].token = CANARY; assert.equal(validateAppStateHostResult(value, query("cron")), false);
});


test("installed plugin and inactive components remain visible, with names and bundled library state", async () => {
  const f = fixture(); f.options.pluginStore.listInstallations = () => [{ installationId: "plugin", desiredState: "disabled", sourceIdentity: CANARY }];
  f.options.bundledPluginCatalog = { list: () => ({ items: [{ id: "bundled", installationId: "other", displayName: "Bundled", converted: { skills: 2, mcp: 1 } }] }) };
  const service = new AppStateReadService(f.options);
  const plugins = await all(service, "plugins"); assert.equal(plugins.summary.installations, 1); assert.equal(plugins.summary.library, 1);
  assert.equal(plugins.items.find(row => row.type === "installation").name, "Fixture Plugin");
  assert.equal(plugins.items.find(row => row.type === "library").installed, false);
  const skills = await all(service, "skills"); assert.equal(skills.items.find(row => row.source === "plugin").enabled, false);
  const mcp = await all(service, "mcp"); assert.equal(mcp.items.find(row => row.source === "installed_plugin").enabled, false);
  assert.equal(JSON.stringify({ plugins, skills, mcp }).includes(CANARY), false);
});

test("native role summaries never expose personal definitions to external callers", async () => {
  const { service } = fixture();
  const native = await all(service, "agents"); assert.equal(native.items.find(row => row.profileId === "p1").responsibilities, "Test specialist");
  const external = await all(service, "agents", { profileId: "p1", federationClient: true });
  assert(external.items.filter(row => row.kind === "native").every(row => row.responsibilities === null));
});

test("missing cost data cannot be reported as a complete global cost", async () => {
  const f = fixture(); f.options.usageStore.summarize = () => ({ series: { totals: { totalTokens: 20, totalCost: 0.2, missingCostEntries: 1 } } });
  const value = await all(new AppStateReadService(f.options), "usage"); assert.equal(value.summary.totalTokens, 40);
  assert.equal(value.summary.totalCost, null); assert.equal(value.summary.costAvailability, "partial");
});

test("oversized metadata and non-advancing Runtime cursors fail explicitly", async () => {
  const pager = new AppStatePager();
  assert.throws(() => pager.page(snapshot("overview", [], [], { oversized: "x".repeat(17 * 1024) }), query("overview")), { code: "APP_STATE_RESPONSE_TOO_LARGE" });
  const f = fixture(); let calls = 0;
  f.options.runtimeAccountController.handle = async () => { calls++; return { accounts: [], nextCursor: "same" }; };
  const value = await all(new AppStateReadService(f.options), "runtime_accounts");
  assert.equal(calls, 2); assert.equal(value.total, null);
});

test("real backend strict inventory methods do not turn upstream errors into empty success", async () => {
  const { HermesBackend } = require("../app/core/hermes-backend");
  const { OpenClawBackend } = require("../app/core/openclaw-backend");
  const hermes = Object.create(HermesBackend.prototype);
  hermes.dashboards = new Map([["default", { baseUrl: "http://fixture", token: CANARY }]]);
  hermes._agentIdForRoutableProfile = () => "agent"; hermes._kanbanDash = () => hermes.dashboards.get("default");
  hermes._kanbanUrl = (_, route) => route; hermes._httpGet = async () => ({ status: 503, body: CANARY });
  for (const method of ["getCronJobs", "getSkills", "getBoards"]) {
    assert.deepEqual(await hermes[method](), []); await assert.rejects(() => hermes[method]({ strict: true }));
  }
  const openclaw = Object.create(OpenClawBackend.prototype); openclaw._connect = async () => { throw new Error("fixture offline"); };
  await assert.rejects(() => openclaw.getCronJobs({ strict: true })); await assert.rejects(() => openclaw.getSkills({ strict: true }));
});

test("card revisions fence same-timestamp body changes and exclude unrelated run results", () => {
  const card = { id: "card", updatedAt: 1, bodyMeta: { sha256: "a" } };
  const revision = resourceRevision("card", card);
  assert.notEqual(resourceRevision("card", { ...card, bodyMeta: { sha256: "b" } }), revision);
  assert.equal(resourceRevision("card", { ...card, runResult: "volatile" }), revision);
});
