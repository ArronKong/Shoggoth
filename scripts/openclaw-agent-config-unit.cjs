#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  OpenClawAgentConfigError,
  readCanonicalAgentEntries,
  writeCanonicalAgentEntries,
  migrateLegacyAgentListToEntries,
  readDefaultModelPolicyAllow,
  updateDefaultModelPolicyAllow,
  readAgentModelPolicyAllow,
  updateAgentModelPolicyAllow,
} = require("../app/core/openclaw-agent-config");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function expectConfigError(fn, code) {
  assert.throws(fn, (error) => error instanceof OpenClawAgentConfigError && error.code === code);
}

test("读取 canonical agents.entries 并投影为带 id 的统一数组", () => {
  const config = {
    agents: {
      entries: {
        main: { name: "Main", model: "openai/gpt-5" },
        coder: { name: "Coder", workspace: "/tmp/coder" },
      },
    },
  };

  assert.deepEqual(readCanonicalAgentEntries(config), [
    { id: "main", name: "Main", model: "openai/gpt-5" },
    { id: "coder", name: "Coder", workspace: "/tmp/coder" },
  ]);
  assert.equal(Object.hasOwn(config.agents.entries.main, "id"), false);
});

test("canonical reader 不会把 legacy agents.list 当成 entries", () => {
  expectConfigError(
    () => readCanonicalAgentEntries({ agents: { list: [{ id: "main", name: "Main" }] } }),
    "legacy_agent_list_requires_migration",
  );
});

test("统一数组写回 canonical entries 并移除 legacy list", () => {
  const config = {
    agents: {
      defaults: { models: { "openai/gpt-5": { alias: "fast" } } },
      list: [{ id: "stale", name: "Stale" }],
      ownership: "explicit",
    },
    untouched: { value: true },
  };
  const next = writeCanonicalAgentEntries(config, [
    { id: "main", name: "Main", nested: { enabled: true } },
    { id: "coder", name: "Coder" },
  ]);

  assert.deepEqual(next.agents.entries, {
    main: { name: "Main", nested: { enabled: true } },
    coder: { name: "Coder" },
  });
  assert.equal(Object.hasOwn(next.agents, "list"), false);
  assert.deepEqual(next.agents.defaults.models, { "openai/gpt-5": { alias: "fast" } });
  assert.deepEqual(config.agents.list, [{ id: "stale", name: "Stale" }]);
});

test("writer 对重复 agent id fail-closed", () => {
  expectConfigError(
    () => writeCanonicalAgentEntries({}, [{ id: "main" }, { id: "main", name: "duplicate" }]),
    "duplicate_agent_id",
  );
});

test("canonical entries 显式为空时 fail-closed", () => {
  expectConfigError(
    () => readCanonicalAgentEntries({ agents: { entries: {} } }),
    "empty_agent_entries",
  );
  expectConfigError(
    () => writeCanonicalAgentEntries({}, []),
    "empty_agent_entries",
  );
});

test("legacy list 显式迁移后只保留 canonical entries", () => {
  const config = {
    agents: {
      defaults: { workspace: "/tmp/default" },
      list: [
        { id: "main", name: "Main" },
        { id: "coder", model: { primary: "openai/gpt-5" } },
      ],
    },
  };
  const next = migrateLegacyAgentListToEntries(config);

  assert.deepEqual(next.agents.entries, {
    main: { name: "Main" },
    coder: { model: { primary: "openai/gpt-5" } },
  });
  assert.equal(Object.hasOwn(next.agents, "list"), false);
  assert.deepEqual(next.agents.defaults, { workspace: "/tmp/default" });
  assert.equal(Object.hasOwn(config.agents, "list"), true);
});

test("legacy migration 拒绝重复和空 agent id", () => {
  expectConfigError(
    () => migrateLegacyAgentListToEntries({ agents: { list: [{ id: "main" }, { id: "main" }] } }),
    "duplicate_agent_id",
  );
  expectConfigError(
    () => migrateLegacyAgentListToEntries({ agents: { list: [{ id: "" }] } }),
    "invalid_agent_id",
  );
  expectConfigError(
    () => migrateLegacyAgentListToEntries({ agents: { list: [{ id: " Main " }] } }),
    "invalid_agent_id",
  );
});

test("defaults modelPolicy.allow 是唯一 allowlist，models 只保留 alias/settings", () => {
  const aliases = {
    "openai/gpt-5": { alias: "fast", params: { temperature: 0.2 } },
    "anthropic/claude": {},
  };
  const config = { agents: { defaults: { models: aliases } } };

  assert.equal(readDefaultModelPolicyAllow(config), undefined);

  const next = updateDefaultModelPolicyAllow(config, ["openai/gpt-5", "anthropic/*"]);
  assert.deepEqual(readDefaultModelPolicyAllow(next), ["openai/gpt-5", "anthropic/*"]);
  assert.deepEqual(next.agents.defaults.models, aliases);
  assert.equal(readDefaultModelPolicyAllow(config), undefined);
});

test("per-agent modelPolicy.allow 独立更新并保留 agent models alias", () => {
  const config = {
    agents: {
      defaults: { modelPolicy: { allow: ["default/model"] } },
      entries: {
        main: {
          models: { "openai/gpt-5": { alias: "fast" } },
          modelPolicy: { allow: ["old/model"] },
        },
      },
    },
  };
  assert.deepEqual(readAgentModelPolicyAllow(config, "main"), ["old/model"]);

  const next = updateAgentModelPolicyAllow(config, "main", ["openai/gpt-5"]);
  assert.deepEqual(readAgentModelPolicyAllow(next, "main"), ["openai/gpt-5"]);
  assert.deepEqual(next.agents.entries.main.models, { "openai/gpt-5": { alias: "fast" } });
  assert.deepEqual(readDefaultModelPolicyAllow(next), ["default/model"]);
});

test("传 undefined 只删除 allow，不把 aliases 提升为 allowlist", () => {
  const config = {
    agents: {
      defaults: {
        models: { "openai/gpt-5": { alias: "fast" } },
        modelPolicy: { allow: ["openai/gpt-5"] },
      },
      entries: {
        main: { modelPolicy: { allow: ["openai/gpt-5"] } },
      },
    },
  };
  const withoutDefault = updateDefaultModelPolicyAllow(config, undefined);
  const withoutAgent = updateAgentModelPolicyAllow(withoutDefault, "main", undefined);

  assert.equal(readDefaultModelPolicyAllow(withoutAgent), undefined);
  assert.equal(readAgentModelPolicyAllow(withoutAgent, "main"), undefined);
  assert.deepEqual(withoutAgent.agents.defaults.models, { "openai/gpt-5": { alias: "fast" } });
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const passed = tests.length - failed;
console.log(`RESULT ${passed}/${tests.length} pass`);
if (failed > 0) process.exit(1);
