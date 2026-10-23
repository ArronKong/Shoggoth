import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const bundle = await build({ entryPoints: [path.join(root, "app/manage-ui/src/lib/chatAgentRoster.ts")],
  bundle: true, write: false, platform: "node", format: "esm" });
const { updateChatAgentRoster: update, isChatAgentListed: listed } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { AgentBackend } = require(path.join(root, "app/core/agent-backend.js"));
const { BackendRegistry } = require(path.join(root, "app/core/backend-registry.js"));
const { HermesBackend } = require(path.join(root, "app/core/hermes-backend.js"));
const { ShoggothBackend } = require(path.join(root, "app/core/shoggoth-backend.js"));
const backends = ["openclaw", "hermes", "shoggoth"];
const agents = [
  { id: "main", name: "Main" },
  { id: "hermes-main", backendId: "hermes" },
  { id: "shoggoth-main", backendId: "shoggoth" },
];
const full = () => update(new Map(), { agents }, backends);

test("confirmed membership filters retained sessions on all three backends without mutating them", () => {
  const sessions = backends.flatMap((backendId, i) => [
    Object.freeze({ backendId, agentId: agents[i].id }),
    Object.freeze({ backendId, agentId: `removed-${backendId}` }),
  ]);
  const before = JSON.stringify(sessions);
  const visible = sessions.filter(row => listed(full(), row.backendId, row.agentId));
  assert.deepEqual(visible.map(row => row.agentId), agents.map(row => row.id));
  assert.equal(JSON.stringify(sessions), before);
});
test("no successful roster yet preserves cached entries", () => {
  assert.equal(listed(new Map(), "openclaw", "qa-agent-913"), true);
});
test("an authoritative empty partition means no Agents, including after a previous full roster", () => {
  const result = update(full(), { agents: [] }, backends);
  for (let i = 0; i < backends.length; i++) assert.equal(listed(result, backends[i], agents[i].id), false);
});
test("failed/malformed reads cannot turn into confirmed deletion", () => {
  const previous = full();
  for (const payload of [null, {}, { agents: null }, { agents: [{}] }, { agents: [], degradedBackends: "openclaw" }]) {
    assert.throws(() => update(previous, payload, backends), /Invalid Agent roster/);
    assert.equal(listed(previous, "openclaw", "main"), true);
  }
});
test("degraded partitions retain known members and do not resurrect known ghosts", () => {
  const next = update(full(), { agents: [agents[2]], degradedBackends: ["openclaw", "hermes"] }, backends);
  assert.equal(listed(next, "openclaw", "main"), true);
  assert.equal(listed(next, "openclaw", "qa-agent-913"), false);
  assert.equal(listed(next, "hermes", "hermes-main"), true);
  assert.equal(listed(next, "shoggoth", "removed-shoggoth"), false);
});
test("partial startup remains unknown until recovery confirms the roster", () => {
  const partial = update(new Map(), { agents: [agents[2]], degradedBackends: ["openclaw", "hermes"] }, backends);
  assert.equal(listed(partial, "openclaw", "qa-agent-913"), true);
  assert.equal(listed(partial, "hermes", "hermes-main"), true);
  const recovered = update(partial, { agents }, backends);
  assert.equal(listed(recovered, "openclaw", "qa-agent-913"), false);
});
test("a newly discovered member is admitted during partial startup, without dropping earlier members", () => {
  const next = update(full(), { agents: [{ id: "hermes-new", backendId: "hermes" }], degradedBackends: ["hermes"] }, backends);
  assert.equal(listed(next, "hermes", "hermes-new"), true);
  assert.equal(listed(next, "hermes", "hermes-main"), true);
  assert.equal(listed(next, "openclaw", "main"), false);
});
test("explicit backend ownership supports arbitrary plug-in ids and preserves route ids", () => {
  const result = update(new Map(), { agents: [{ id: "route-main", backendId: "custom" }] }, ["custom", "openclaw"]);
  assert.equal(listed(result, "custom", "route-main"), true);
  assert.equal(listed(result, "custom", "main"), false);
  assert.equal(listed(result, "openclaw", "route-main"), false);
});
test("registry isolates thrown and malformed snapshots, preserves successful empty rosters, and stamps ownership", () => {
  class Fixture extends AgentBackend {
    constructor(id, snapshot) { super(); this._id = id; this.snapshot = snapshot; }
    get id() { return this._id; }
    getAgentsSnapshot() { if (this.snapshot instanceof Error) throw this.snapshot; return this.snapshot; }
  }
  const registry = new BackendRegistry();
  for (const [id, snapshot] of [
    ["good", { agents: [{ id: "worker", backendId: "wrong" }], complete: true }],
    ["empty", { agents: [], complete: true }], ["starting", { agents: [], complete: false }],
    ["broken", Error("unavailable")], ["malformed", { agents: [{}] }],
  ]) registry.register(new Fixture(id, snapshot));
  assert.deepEqual(registry.aggregateAgentSnapshot(), {
    agents: [{ id: "worker", backendId: "good" }], incompleteBackends: ["starting", "broken", "malformed"],
  });
});
for (const [name, Backend, flag] of [["Hermes", HermesBackend, "_sessionRowsComplete"], ["Shoggoth", ShoggothBackend, "_complete"]]) {
  test(`${name} publishes partial/complete roster authority with its discovery state`, () => {
    const backend = { getAgents: () => agents, [flag]: false };
    assert.deepEqual(Backend.prototype.getAgentsSnapshot.call(backend), { agents, complete: false });
    backend[flag] = true;
    assert.deepEqual(Backend.prototype.getAgentsSnapshot.call(backend), { agents, complete: true });
  });
}
