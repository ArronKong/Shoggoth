"use strict";

const assert = require("node:assert/strict");
const { planOpenClawToolGrants } = require("../app/external-plugin-openclaw-tool-policy");

const toolNames = ["mcp_server_list", "mcp_server_call"];
const agentEntries = {
  main: { name: "Main", tools: { alsoAllow: ["feishu_chat"], deny: ["mcp_server_call"],
    profile: "coding", sandbox: { tools: { allow: ["read"] } } }, identity: { emoji: "M" } },
  empty: { tools: { alsoAllow: [] } },
  inherited: { tools: { profile: "full" }, model: { primary: "test/model" } },
  limited: { tools: { allow: ["read"], deny: ["write"] } },
};
const input = { globalAlsoAllow: ["existing"], agentEntries, toolNames };
const before = JSON.stringify(input);
const operations = planOpenClawToolGrants(input);
assert.equal(JSON.stringify(input), before, "planning must not mutate the source snapshot");
assert.deepEqual(operations.map(operation => operation.path), ["tools.alsoAllow", "agents.entries"]);
assert.deepEqual(operations[0], { path: "tools.alsoAllow", value: ["existing", ...toolNames],
  expectedValue: ["existing"], replace: false });
const roster = operations[1];
assert.equal(roster.replace, true);
assert.deepEqual(roster.expectedValue, agentEntries);
assert.deepEqual(roster.value.main.tools.alsoAllow, ["feishu_chat", ...toolNames]);
assert.deepEqual(roster.value.empty.tools.alsoAllow, toolNames, "an empty Agent list still shadows global grants");
assert.deepEqual(roster.value.inherited, agentEntries.inherited, "do not create an Agent override");
assert.deepEqual(roster.value.limited, agentEntries.limited, "preserve explicit allow-only restrictions");
const expectedRoster = JSON.parse(before).agentEntries;
expectedRoster.main.tools.alsoAllow.push(...toolNames);
expectedRoster.empty.tools.alsoAllow.push(...toolNames);
assert.deepEqual(roster.value, expectedRoster, "all other policy and Agent fields must stay unchanged");
assert.deepEqual(planOpenClawToolGrants({ globalAlsoAllow: operations[0].value,
  agentEntries: roster.value, toolNames }), [], "a verified second reconciliation is idempotent");
assert.deepEqual(planOpenClawToolGrants({ toolNames }), [{ path: "tools.alsoAllow", value: toolNames,
  expectAbsent: true, replace: false }]);
assert.deepEqual(planOpenClawToolGrants({ globalAlsoAllow: [], toolNames })[0].expectedValue, []);
assert.deepEqual(planOpenClawToolGrants({ globalAlsoAllow: ["existing", "existing"], toolNames })[0].value,
  ["existing", "existing", ...toolNames], "preserve the authored existing list exactly");

const agentList = [{ id: "first", tools: { alsoAllow: ["existing"] }, name: "First" },
  { id: "second", tools: { deny: ["mcp_server_list"] } }];
const legacy = planOpenClawToolGrants({ globalAlsoAllow: toolNames, agentList, toolNames });
assert.equal(legacy.length, 1);
assert.equal(legacy[0].path, "agents.list");
assert.equal(legacy[0].replace, true);
assert.deepEqual(legacy[0].expectedValue, agentList);
assert.deepEqual(legacy[0].value[0].tools.alsoAllow, ["existing", ...toolNames]);
assert.deepEqual(legacy[0].value[1], agentList[1]);
const reordered = [...agentList].reverse();
assert.notDeepEqual(reordered, legacy[0].expectedValue, "the roster CAS must detect reordered Agent identities");
roster.expectedValue.main.tools.alsoAllow.push("caller-edit");
assert.deepEqual(agentEntries.main.tools.alsoAllow, ["feishu_chat"], "CAS expectations must be detached snapshots");

for (const patch of [
  { globalAlsoAllow: null }, { globalAlsoAllow: "mcp_server_list" }, { globalAlsoAllow: [""] },
  { globalAlsoAllow: [null] }, { globalAlsoAllow: ["bad\0name"] },
  { toolNames: [] }, { toolNames: ["*"] }, { toolNames: ["group:plugins"] },
  { toolNames: ["tool.with.path"] }, { agentEntries: null }, { agentEntries: [] },
  { agentEntries: { "bad.id": {} } }, { agentEntries: { main: { id: "other" } } },
  { agentEntries: { main: { tools: null } } },
  { agentEntries: { main: { tools: { alsoAllow: "invalid" } } } },
  { agentEntries: { main: { tools: { alsoAllow: [""] } } } },
  { agentEntries: { main: { futureField: Infinity } } },
  { agentEntries: { main: { futureField: undefined } } },
  { agentList: [null] }, { agentList: [{}] }, { agentList: [{ id: "main" }, { id: "main" }] },
  { agentList: [{ id: "main" }], agentEntries: { main: {} } },
]) assert.throws(() => planOpenClawToolGrants({ toolNames, ...patch }), /snapshot invalid/);
const sparse = new Array(1);
assert.throws(() => planOpenClawToolGrants({ globalAlsoAllow: sparse, toolNames }), /snapshot invalid/);
const accessor = { toolNames };
Object.defineProperty(accessor, "globalAlsoAllow", { enumerable: true, get() { throw Error("must not run"); } });
assert.throws(() => planOpenClawToolGrants(accessor), /snapshot invalid/);
const overCapacity = Array.from({ length: 1024 }, (_, index) => `existing_${index}`);
assert.throws(() => planOpenClawToolGrants({ globalAlsoAllow: overCapacity, toolNames }), /capacity/);

console.log("plugin-external-openclaw-tool-policy-unit: ok");
