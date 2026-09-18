#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND,
  RUNTIME_ACCOUNT_FIELDS,
  RUNTIME_ACCOUNT_SCHEMA,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  assertRuntimeAccountMatchesProfile,
  cloneRuntimeAccount,
  freezeRuntimeAccount,
  normalizeLegacyRuntimeAccount,
  runtimeAccountMatchesProfile,
  validateRuntimeAccount,
} = require("../app/agent-service/runtime-account");

const tests = [];

function test(name, action) {
  tests.push({ name, action });
}

function defaultAccount(id) {
  return DEFAULT_RUNTIME_ACCOUNTS.find((account) => account.id === id);
}

function expectInvalid(value) {
  assert.throws(
    () => validateRuntimeAccount(value),
    (error) => error?.code === "RUNTIME_ACCOUNT_INVALID",
  );
}

test("固定七个默认账号覆盖内置 Codex 与六个原生 Runtime", () => {
  assert.deepEqual(DEFAULT_RUNTIME_ACCOUNTS.map((account) => account.id), [
    "shoggoth-internal-codex-default-v1",
    "native-codex-default-v1",
    "native-grok-build-default-v1",
    "native-antigravity-default-v1",
    "native-pi-default-v1",
    "native-claude-code-default-v1",
    "native-deepseek-harness-default-v1",
  ]);
  assert.deepEqual(DEFAULT_RUNTIME_ACCOUNTS.map((account) => account.runtime), [
    "codex", "codex", "grok-build", "antigravity", "pi", "claude-code",
    "deepseek-harness",
  ]);
  assert.equal(DEFAULT_RUNTIME_ACCOUNTS.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(DEFAULT_RUNTIME_ACCOUNTS), true);
  assert.equal(new Set(DEFAULT_RUNTIME_ACCOUNTS.map((account) => account.id)).size, 7);
});

test("Backend 映射到稳定且存在的默认 RuntimeAccount", () => {
  assert.deepEqual(DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND, {
    shoggoth: "shoggoth-internal-codex-default-v1",
    codex: "native-codex-default-v1",
    "grok-build": "native-grok-build-default-v1",
    antigravity: "native-antigravity-default-v1",
    pi: "native-pi-default-v1",
    "claude-code": "native-claude-code-default-v1",
    "deepseek-harness": "native-deepseek-harness-default-v1",
  });
  assert.equal(Object.isFrozen(DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND), true);
  const ids = new Set(DEFAULT_RUNTIME_ACCOUNTS.map((account) => account.id));
  assert.equal(Object.values(DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND).every((id) => ids.has(id)), true);
});

test("schema 常量不可变且每个默认账号都严格 round-trip", () => {
  assert.equal(Object.isFrozen(RUNTIME_ACCOUNT_SCHEMA), true);
  assert.equal(Object.isFrozen(RUNTIME_ACCOUNT_SCHEMA.fields), true);
  assert.deepEqual(RUNTIME_ACCOUNT_SCHEMA.fields, RUNTIME_ACCOUNT_FIELDS);
  assert.deepEqual(RUNTIME_ACCOUNT_SCHEMA.builtInRuntimes, [
    "codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness",
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(RUNTIME_ACCOUNT_SCHEMA, "runtimes"), false);
  for (const account of DEFAULT_RUNTIME_ACCOUNTS) {
    assert.deepEqual(validateRuntimeAccount(account), account);
    assert.notEqual(validateRuntimeAccount(account), account);
  }
});

test("clone 与 freeze 返回隔离副本且不修改输入", () => {
  const source = {
    ...defaultAccount(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID),
    createdAt: 10,
    updatedAt: 20,
  };
  const cloned = cloneRuntimeAccount(source);
  const frozen = freezeRuntimeAccount(source);
  assert.deepEqual(cloned, source);
  assert.deepEqual(frozen, source);
  assert.notEqual(cloned, source);
  assert.notEqual(frozen, source);
  assert.equal(Object.isFrozen(cloned), false);
  assert.equal(Object.isFrozen(frozen), true);
  cloned.updatedAt = 21;
  assert.equal(source.updatedAt, 20);
});

test("拒绝非 plain object、缺失字段、未知字段和非 data property", () => {
  const valid = cloneRuntimeAccount(DEFAULT_RUNTIME_ACCOUNTS[0]);
  expectInvalid(null);
  expectInvalid([]);
  expectInvalid(Object.assign(Object.create(null), valid));
  expectInvalid(Object.assign(new (class RuntimeAccount {})(), valid));
  const missing = { ...valid };
  delete missing.runtime;
  expectInvalid(missing);
  expectInvalid({ ...valid, token: "must-not-be-accepted" });
  const symbol = { ...valid, [Symbol("hidden")]: true };
  expectInvalid(symbol);
  const hidden = { ...valid };
  Object.defineProperty(hidden, "runtime", { value: "codex", enumerable: false });
  expectInvalid(hidden);
  const accessor = { ...valid };
  Object.defineProperty(accessor, "runtime", { get: () => "codex", enumerable: true });
  expectInvalid(accessor);
});

test("拒绝非法标量、枚举和时间戳", () => {
  const valid = cloneRuntimeAccount(DEFAULT_RUNTIME_ACCOUNTS[0]);
  const invalidPatches = [
    { id: "bad id" },
    { id: `a${"b".repeat(128)}` },
    { runtime: "Future-Runtime" },
    { runtime: "9future-runtime" },
    { runtime: `a${"b".repeat(64)}` },
    { kind: "shared-user" },
    { installationKind: "downloaded" },
    { homeKind: "arbitrary-path" },
    { providerRef: "bad provider" },
    { providerRef: "provider:credential" },
    { isDefault: 1 },
    { createdAt: -1 },
    { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: 20, updatedAt: 10 },
  ];
  for (const patch of invalidPatches) expectInvalid({ ...valid, ...patch });
});

test("native-user 只允许固定 system/system-default 账号且禁止 providerRef", () => {
  const native = cloneRuntimeAccount(DEFAULT_RUNTIME_ACCOUNTS[1]);
  expectInvalid({ ...native, id: "custom-native-account", isDefault: false });
  expectInvalid({ ...native, installationKind: "bundled" });
  expectInvalid({ ...native, homeKind: "managed-shared" });
  expectInvalid({ ...native, providerRef: "provider-one" });
  expectInvalid({ ...native, isDefault: false });
});

test("shoggoth-managed 只允许 bundled/managed-shared，providerRef 必须留空", () => {
  const managed = cloneRuntimeAccount(DEFAULT_RUNTIME_ACCOUNTS[0]);
  expectInvalid({ ...managed, runtime: "grok-build" });
  expectInvalid({ ...managed, installationKind: "system" });
  expectInvalid({ ...managed, homeKind: "system-default" });
  expectInvalid({ ...managed, id: "custom-managed", isDefault: true });
  expectInvalid({
    ...managed,
    id: "managed-provider-one-v1",
    providerRef: "provider-one",
    isDefault: false,
  });
});

test("旧 RuntimeAccount providerRef 只在迁移入口归一化且不修改输入", () => {
  const legacy = {
    ...cloneRuntimeAccount(DEFAULT_RUNTIME_ACCOUNTS[0]),
    providerRef: "provider-one",
  };
  assert.deepEqual(normalizeLegacyRuntimeAccount(legacy), {
    ...legacy,
    providerRef: null,
  });
  assert.equal(legacy.providerRef, "provider-one");
});

test("非默认 managed 账号兼容格式合法的未来 Runtime，但 Provider 仍仅属于 Codex", () => {
  const managed = cloneRuntimeAccount(DEFAULT_RUNTIME_ACCOUNTS[0]);
  const future = {
    ...managed,
    id: "managed-future-runtime-v1",
    runtime: "future-runtime",
    isDefault: false,
  };
  assert.deepEqual(validateRuntimeAccount(future), future);
  expectInvalid({ ...future, providerRef: "provider-one" });
  assert.equal(runtimeAccountMatchesProfile(future, {
    id: "future-profile",
    runtime: "future-runtime",
  }), true);
});

test("Profile 与 RuntimeAccount runtime 相同才兼容", () => {
  const codex = DEFAULT_RUNTIME_ACCOUNTS[0];
  const profile = { id: "profile-one", runtime: "codex" };
  assert.equal(runtimeAccountMatchesProfile(codex, profile), true);
  assert.equal(assertRuntimeAccountMatchesProfile(codex, profile), true);
  assert.equal(runtimeAccountMatchesProfile(codex, { ...profile, runtime: "pi" }), false);
  assert.throws(
    () => assertRuntimeAccountMatchesProfile(codex, { ...profile, runtime: "pi" }),
    (error) => error?.code === "RUNTIME_ACCOUNT_PROFILE_MISMATCH",
  );
  assert.throws(
    () => runtimeAccountMatchesProfile(codex, { id: "profile-one" }),
    (error) => error?.code === "RUNTIME_ACCOUNT_PROFILE_INVALID",
  );
});

let passed = 0;
for (const { name, action } of tests) {
  try {
    action();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  process.stderr.write(`FAIL runtime account model (${passed}/${tests.length})\n`);
} else {
  process.stdout.write(`PASS runtime account model (${passed}/${tests.length})\n`);
}
