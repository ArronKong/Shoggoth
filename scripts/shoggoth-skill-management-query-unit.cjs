#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");
const { querySkillManagementCatalog } = require("../app/agent-service/skill-management-query");
const { AgentHarnessServiceController } = require("../app/agent-service/agent-harness-service-controller");
const { validateAgentHarnessParams, validateAgentHarnessResult } = require(
  "../app/agent-service/agent-harness-service-protocol");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");

function fixture(count = 5000) {
  const items = Array.from({ length: count }, (_, number) => ({
    id: `scale-${String(number).padStart(4, "0")}`,
    name: `scale-${String(number).padStart(4, "0")}`,
    description: `Skill ${number} searches the local fixture`,
    version: "1.0.0", source: "user", enabled: number % 2 === 0,
    contentHash: "a".repeat(64), requiredTools: [], requiredRuntimeCapabilities: [],
    sourceCompatibility: [], eligible: true, ineligibleReason: null,
  }));
  return { registryRevision: "b".repeat(64), registryVersion: 1,
    profileRevision: 1, items };
}
function request(catalog, overrides = {}) {
  return querySkillManagementCatalog({ catalog, usage: Object.assign(new Map(), { supported: true }),
    query: "", status: "", pageIndex: 0, limit: 100, expectedRevision: null, ...overrides });
}

test("5k persisted-shape catalog sends bounded first page, exact page two and tail search", () => {
  const catalog = fixture();
  const start = performance.now();
  const first = request(catalog);
  const firstMs = performance.now() - start;
  const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
  assert.equal(first.total, 5000);
  assert.equal(first.enabledCount, 2500);
  assert.equal(first.matchCount, 5000);
  assert.equal(first.items.length, 100);
  assert.ok(firstBytes < 48 * 1024, `first page must stay bounded: ${firstBytes}`);
  const second = request(catalog, { pageIndex: 1, expectedRevision: first.queryRevision });
  assert.equal(second.items[0].name, "scale-0100");
  assert.equal(second.matchCount, 5000);
  assert.equal(second.pageCount, 50);
  const last = request(catalog, { query: "scale-4999" });
  assert.deepEqual(last.items.map(item => item.name), ["scale-4999"]);
  assert.equal(last.matchCount, 1);
  assert.equal(last.total, 5000);
  assert.equal(request(catalog, { status: "on" }).matchCount, 2500);
  assert.equal(request(catalog, { status: "off" }).matchCount, 2500);
  console.log(`5k first page ${firstBytes} bytes in ${firstMs.toFixed(1)} ms`);
});

test("usage order and page revision reject stale offsets without hiding catalog counts", () => {
  const catalog = fixture(220);
  const usage = Object.assign(new Map([["scale-0219", 9], ["scale-0000", 1]]), { supported: true });
  const first = request(catalog, { usage });
  assert.equal(first.items[0].name, "scale-0219");
  assert.equal(first.usedCount, 2);
  assert.equal(first.usageSupported, true);
  assert.throws(() => request(catalog, { pageIndex: 1 }), { code: "HARNESS_REVISION_CONFLICT" });
  usage.set("scale-0218", 10);
  assert.throws(() => request(catalog, { usage, pageIndex: 1,
    expectedRevision: first.queryRevision }), { code: "HARNESS_REVISION_CONFLICT" });
  assert.throws(() => request(catalog, { query: "changed", pageIndex: 1,
    expectedRevision: first.queryRevision }), { code: "HARNESS_REVISION_CONFLICT" });
  assert.throws(() => request(catalog, { query: "\u0000" }), { code: "INVALID_PARAMS" });
});

test("all-Agent catalog keeps scoped methods, shared packages, usage, paging and revisions", () => {
  const profiles = [
    { id: "profile-a", agentId: "agent-a", backendId: "shoggoth", enabled: true },
    { id: "profile-b", agentId: "agent-b", backendId: "shoggoth", enabled: true },
    { id: "profile-archived", agentId: "archived", backendId: "shoggoth", enabled: false },
    { id: "profile-external", agentId: "external", backendId: "hermes", enabled: true },
  ];
  const catalogs = new Map(profiles.slice(0, 2).map((profile, index) => {
    const catalog = fixture(1);
    catalog.profileRevision = index + 3;
    catalog.items.push({ ...catalog.items[0], id: "builtin-help", name: "builtin-help",
      source: "builtin", enabled: index === 0 });
    return [profile.id, catalog];
  }));
  const learned = new Map(profiles.slice(0, 2).map((profile, index) => [profile.id, [{
    ...fixture(1).items[0], id: `learned-${profile.agentId}`, name: "learned-review", title: "Review method",
    source: "learned", learnedRevision: index + 5, usageCount: index === 0 ? 2 : 7,
  }]]));
  const controller = Object.create(AgentHarnessServiceController.prototype);
  controller.memoryEngine = { owner: "fixture" };
  controller.productStore = { listAgentProfiles: () => profiles,
    getAgentProfile: id => profiles.find(profile => profile.id === id) };
  controller.skillStore = { list: id => { assert.ok(catalogs.has(id)); return catalogs.get(id); },
    usage: id => ({ supported: true, skills: {
      "scale-0000": { [id]: id === "profile-a" ? 2 : 3 },
      "builtin-help": { [id]: id === "profile-a" ? 1 : 4 },
    } }) };
  controller.learnedSkillStore = { management: id => learned.get(id) };
  const request = (overrides = {}) => {
    const params = validateAgentHarnessParams("harness.skills.query", {
      profileId: null, query: "", status: "", pageIndex: 0, limit: 2, expectedRevision: null, ...overrides,
    });
    return validateAgentHarnessResult("harness.skills.query", controller.handle("harness.skills.query", params), params);
  };
  const first = request();
  assert.equal(first.total, 5);
  assert.equal(first.enabledCount, 4);
  assert.equal(first.usedCount, 5);
  const items = [...first.items];
  for (let pageIndex = 1; pageIndex < first.pageCount; pageIndex += 1) {
    items.push(...request({ pageIndex, expectedRevision: first.queryRevision }).items);
  }
  assert.equal(items.length, 5);
  assert.equal(items[0].agentId, "agent-b");
  assert.equal(items[0].usageCount, 7);
  assert.deepEqual(items[0].usageAgents, { "agent-b": 7 });
  assert.equal(items.filter(item => item.source === "user").length, 1);
  assert.deepEqual(items.filter(item => item.source === "builtin").sort((a, b) => a.agentId.localeCompare(b.agentId)).map(item =>
    [item.agentId, item.profileRevision, item.enabled, item.usageCount, item.usageAgents]),
  [["agent-a", 3, true, 1, { "agent-a": 1 }], ["agent-b", 4, false, 4, { "agent-b": 4 }]]);
  assert.deepEqual(request({ query: "learned-review", limit: 100 }).items.map(item => item.usageCount), [7, 2]);
  assert.equal(request({ profileId: "profile-a", limit: 100 }).total, 3,
    "existing per-Agent readers retain their own catalog");
  assert.equal(request({ status: "off", limit: 100 }).items[0].agentId, "agent-b");
  catalogs.get("profile-b").profileRevision += 1;
  assert.throws(() => request({ pageIndex: 1, expectedRevision: first.queryRevision }),
    { code: "HARNESS_REVISION_CONFLICT" });
  const next = request();
  learned.get("profile-b")[0].usageCount += 1;
  assert.throws(() => request({ pageIndex: 1, expectedRevision: next.queryRevision }),
    { code: "HARNESS_REVISION_CONFLICT" });
  const beforeWithdrawal = request();
  learned.set("profile-b", []);
  assert.throws(() => request({ pageIndex: 1, expectedRevision: beforeWithdrawal.queryRevision }),
    { code: "HARNESS_REVISION_CONFLICT" });
  assert.equal(request().total, 4);
  assert.throws(() => validateAgentHarnessParams("harness.skills.enable", {
    profileId: null, skillId: "builtin-help", source: "builtin", version: "1.0.0", enabled: false, expectedRevision: 3,
  }), { code: "INVALID_PARAMS" });
  profiles.length = 0;
  assert.equal(request().total, 0);
  assert.equal(request().pageCount, 1);
});

test("5k native Service→Backend→REST query stays bounded and revisioned", async () => {
  const catalog = fixture();
  const profiles = [
    { id: "profile-a", agentId: "agent-a", backendId: "shoggoth", enabled: true },
    { id: "profile-b", agentId: "agent-b", backendId: "shoggoth", enabled: true },
  ];
  const counts = new Map([["profile-a", 2], ["profile-b", 3]]);
  const controller = Object.create(AgentHarnessServiceController.prototype);
  controller.memoryEngine = { owner: "fixture" };
  controller.productStore = { getAgentProfile: id => profiles.find(profile => profile.id === id) || null,
    listAgentProfiles: () => profiles };
  controller.skillStore = { list: () => catalog,
    usage: id => ({ supported: true, skills: { "scale-4999": { [id]: counts.get(id) } } }) };
  const backend = new ShoggothBackend();
  backend._assertDomainReady = () => {};
  backend._profileForSkills = options => {
    assert.equal(options.agentId, "agent-a");
    return profiles[0];
  };
  backend._call = async (method, input) => validateAgentHarnessResult(method,
    controller.handle(method, validateAgentHarnessParams(method, input)), input);
  const legacyBackend = { id: "openclaw", getSkillsPage: AgentBackend.prototype.getSkillsPage };
  const registry = { getBackend: id => id === "shoggoth" ? backend
    : id === "openclaw" ? legacyBackend : null,
    _activeGet: id => id === "shoggoth" ? backend : id === "openclaw" ? legacyBackend : null,
    getSkillsPage: BackendRegistry.prototype.getSkillsPage,
    listSkills: async id => id === "openclaw" ? [{ name: "legacy-skill" }] : [] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-skill-page-"));
  const server = await startStaticServer(0, { registry, homeDir: root,
    userDataRoot: root });
  try {
    const request = async params => {
      const response = await fetch(`${server.url}/__api/skills?${new URLSearchParams({
        backend: "shoggoth", agentId: "agent-a", paged: "1", limit: "100", ...params,
      })}`);
      return { status: response.status, body: await response.json() };
    };
    const start = performance.now();
    const first = await request({ page: "0" });
    const elapsed = performance.now() - start;
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.page.total, 5000);
    assert.equal(first.body.page.matchCount, 5000);
    assert.equal(first.body.page.enabledCount, 2500);
    assert.equal(first.body.page.usedCount, 1);
    assert.equal(first.body.page.skills[0].name, "scale-4999");
    assert.equal(first.body.page.skills[0].usageCount, 5);
    assert.deepEqual(first.body.page.skills[0].usageAgents, { "agent-a": 2, "agent-b": 3 });
    assert.ok(first.body.page.skills.length < 100, "projection byte cap should split before 100");
    const bytes = Buffer.byteLength(JSON.stringify(first.body), "utf8");
    assert.ok(bytes < 56 * 1024, `REST page exceeded protocol cap: ${bytes}`);
    const second = await request({ page: "1", revision: first.body.page.queryRevision });
    assert.equal(second.status, 200);
    assert.equal(second.body.page.skills[0].name,
      `scale-${String(first.body.page.skills.length - 1).padStart(4, "0")}`);
    assert.equal(second.body.page.matchCount, 5000);
    const tail = await request({ page: "0", query: "scale-4999" });
    assert.deepEqual(tail.body.page.skills.map(item => item.name), ["scale-4999"]);
    assert.equal(tail.body.page.total, 5000);
    assert.equal(tail.body.page.matchCount, 1);
    const on = await request({ page: "0", status: "on" });
    assert.equal(on.body.page.matchCount, 2500);
    assert.equal((await request({ page: "0", status: "unknown" })).status, 400);
    const all = await fetch(`${server.url}/__api/skills?backend=shoggoth&paged=1`);
    assert.equal(all.status, 200);
    const allPage = (await all.json()).page;
    assert.equal(allPage.total, 5000, "shared installed packages must appear only once across Agents");
    assert.equal(allPage.skills[0].usageCount, 5);
    assert.ok(Buffer.byteLength(JSON.stringify(allPage)) < 56 * 1024);
    assert.equal((await fetch(`${server.url}/__api/skills?backend=shoggoth`)).status, 400,
      "the unpaged agent-scoped API must retain its scope requirement");
    const legacy = await fetch(`${server.url}/__api/skills?backend=openclaw`);
    assert.equal(legacy.status, 200);
    assert.deepEqual((await legacy.json()).skills, [{ name: "legacy-skill" }]);
    assert.equal((await fetch(`${server.url}/__api/skills?backend=openclaw&paged=1`)).status, 501);
    counts.set("profile-b", 4);
    assert.equal((await request({ page: "1", revision: first.body.page.queryRevision })).status, 409);
    catalog.items[0].enabled = false;
    catalog.profileRevision += 1;
    assert.equal((await request({ page: "1", revision: first.body.page.queryRevision })).status, 409);
    catalog.registryRevision = "c".repeat(64);
    assert.equal((await request({ page: "1", revision: first.body.page.queryRevision })).status, 409);
    console.log(`5k REST first page ${bytes} bytes in ${elapsed.toFixed(1)} ms, ${first.body.page.skills.length} skills`);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
