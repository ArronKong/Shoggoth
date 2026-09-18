#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  validateRuntimeAccount,
} = require("../app/agent-service/runtime-account");
const {
  LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
  NATIVE_BACKEND_RUNTIMES,
  runtimeAccountForLegacyProfile,
} = require("../app/agent-service/runtime-account-migration");

const tests = [];

function test(name, action) {
  tests.push({ name, action });
}

function profile(id, overrides = {}) {
  return {
    id,
    backendId: "shoggoth",
    runtime: "codex",
    runtimeProfileId: `${id}-runtime-v1`,
    providerRef: null,
    isDefault: false,
    ...overrides,
  };
}

function expectMigrationError(action, code) {
  assert.throws(action, (error) => error?.code === code);
}

test("保留的默认 Shoggoth Profile 映射到内部 Codex 固定账号", () => {
  const template = DEFAULT_RUNTIME_ACCOUNTS.find(
    (account) => account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  );
  const before = structuredClone(template);
  const migrated = runtimeAccountForLegacyProfile(profile(
    LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
    { providerRef: "provider-one", isDefault: true },
  ));
  assert.equal(migrated.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.deepEqual(migrated.account, template);
  assert.notEqual(migrated.account, template);
  assert.equal(Object.isFrozen(migrated.account), true);
  assert.deepEqual(template, before);
});

test("六个匹配的原生 Backend 始终映射到各自固定账号", () => {
  for (const [backendId, runtime] of Object.entries(NATIVE_BACKEND_RUNTIMES)) {
    for (const providerRef of [null, "provider-one"]) {
      const migrated = runtimeAccountForLegacyProfile(profile(
        `profile-${backendId}-${providerRef || "native"}`,
        { backendId, runtime, providerRef },
      ));
      assert.equal(migrated.runtimeAccountId, DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND[backendId]);
      assert.equal(migrated.account.kind, "native-user");
      assert.equal(migrated.account.runtime, runtime);
      assert.equal(migrated.account.providerRef, null);
      assert.deepEqual(validateRuntimeAccount(migrated.account), migrated.account);
    }
  }
});

test("所有 managed Codex Profile 归并内部账号且 Provider 保持 Profile 维度", () => {
  const first = profile("profile-managed-one", { providerRef: "provider-one" });
  const again = { ...first, name: "Mutable display name is irrelevant" };
  const providerChanged = { ...first, providerRef: "provider-two" };
  const second = profile("profile-managed-two", { providerRef: "provider-one" });
  const migrated = runtimeAccountForLegacyProfile(first);
  assert.deepEqual(runtimeAccountForLegacyProfile(again), migrated);
  assert.equal(runtimeAccountForLegacyProfile(providerChanged).runtimeAccountId, migrated.runtimeAccountId);
  assert.equal(runtimeAccountForLegacyProfile(second).runtimeAccountId, migrated.runtimeAccountId);
  assert.equal(migrated.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(migrated.account.providerRef, null);
  assert.equal(migrated.account.isDefault, true);
});

test("旧版允许的长或特殊 Profile ID 通过 hash 安全迁移", () => {
  for (const id of ["x".repeat(129), "legacy profile/带空格/😀"]) {
    const input = profile(id, {
      backendId: "future-backend",
      runtime: "future-runtime",
      runtimeProfileId: "legacy-runtime-profile",
    });
    const migrated = runtimeAccountForLegacyProfile(input);
    assert.match(migrated.runtimeAccountId, /^legacy-managed-[a-f0-9]{64}-v1$/u);
    assert.deepEqual(runtimeAccountForLegacyProfile(input), migrated);
    assert.deepEqual(validateRuntimeAccount(migrated.account), migrated.account);
  }
  const firstSurrogate = runtimeAccountForLegacyProfile(profile("p\ud800", {
    backendId: "future-backend",
    runtime: "future-runtime",
    runtimeProfileId: "legacy-runtime-profile-a",
  }));
  const secondSurrogate = runtimeAccountForLegacyProfile(profile("p\ud801", {
    backendId: "future-backend",
    runtime: "future-runtime",
    runtimeProfileId: "legacy-runtime-profile-b",
  }));
  assert.notEqual(firstSurrogate.runtimeAccountId, secondSurrogate.runtimeAccountId);
});

test("相同 Profile ID 切换 Runtime 时派生不同的不可变账号身份", () => {
  const codex = runtimeAccountForLegacyProfile(profile("profile-runtime-switch", {
    providerRef: "provider-one",
  }));
  const future = runtimeAccountForLegacyProfile(profile("profile-runtime-switch", {
    backendId: "future-backend",
    runtime: "future-runtime",
  }));
  assert.notEqual(codex.runtimeAccountId, future.runtimeAccountId);
  assert.equal(codex.account.runtime, "codex");
  assert.equal(future.account.runtime, "future-runtime");
});

test("未来 Runtime 合成为独立 managed 账号", () => {
  const migrated = runtimeAccountForLegacyProfile(profile("profile-future", {
    backendId: "future-backend",
    runtime: "future-runtime",
  }));
  assert.equal(migrated.account.runtime, "future-runtime");
  assert.equal(migrated.account.kind, "shoggoth-managed");
  assert.equal(migrated.account.providerRef, null);
  assert.deepEqual(validateRuntimeAccount(migrated.account), migrated.account);
});

test("原生 Backend/runtime 不一致时 fail closed", () => {
  expectMigrationError(
    () => runtimeAccountForLegacyProfile(profile("profile-bad-native", {
      backendId: "grok-build",
      runtime: "codex",
    })),
    "RUNTIME_ACCOUNT_MIGRATION_BACKEND_RUNTIME_MISMATCH",
  );
});

test("默认 Profile 身份不一致时 fail closed", () => {
  for (const overrides of [
    { backendId: "codex", isDefault: true },
    { runtime: "future-runtime", isDefault: true },
    { isDefault: false },
  ]) {
    expectMigrationError(
      () => runtimeAccountForLegacyProfile(profile(
        LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
        overrides,
      )),
      "RUNTIME_ACCOUNT_MIGRATION_DEFAULT_PROFILE_CONFLICT",
    );
  }
  expectMigrationError(
    () => runtimeAccountForLegacyProfile(profile("other-default", { isDefault: true })),
    "RUNTIME_ACCOUNT_MIGRATION_DEFAULT_PROFILE_CONFLICT",
  );
});

test("原生 Provider 保持 Profile 维度，未知非 Codex managed Provider 仍拒绝", () => {
  const native = runtimeAccountForLegacyProfile(profile("profile-grok-provider", {
    backendId: "grok-build",
    runtime: "grok-build",
    providerRef: "provider-one",
  }));
  assert.equal(native.runtimeAccountId, DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND["grok-build"]);
  assert.equal(native.account.providerRef, null);
  expectMigrationError(
    () => runtimeAccountForLegacyProfile(profile("profile-future-provider", {
      backendId: "future-backend",
      runtime: "future-runtime",
      providerRef: "provider-one",
    })),
    "RUNTIME_ACCOUNT_MIGRATION_PROVIDER_UNSUPPORTED",
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
  process.stderr.write(`FAIL runtime account migration (${passed}/${tests.length})\n`);
} else {
  process.stdout.write(`PASS runtime account migration (${passed}/${tests.length})\n`);
}
