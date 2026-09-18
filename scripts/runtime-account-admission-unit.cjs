"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RuntimeAccountAdmission } = require("../app/agent-service/runtime-account-admission");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");

function fixture(options = {}) {
  let now = 100;
  const accounts = new Map(DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]));
  const admission = new RuntimeAccountAdmission({
    runtimeAccountLookup: (id) => accounts.get(id) || null,
    resolveMaxActive: options.resolveMaxActive,
    now: () => now,
  });
  return { admission, setNow: (value) => { now = value; } };
}

test("same RuntimeAccount shares a conservative active limit", () => {
  const { admission } = fixture();
  assert.deepEqual(admission.admit({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-a",
  }), {
    disposition: "started", reason: null, generation: 1, retryAt: null,
  });
  assert.equal(admission.admit({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-b",
  }).reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.equal(admission.release({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-a",
  }), true);
  assert.equal(admission.admit({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-b",
  }).disposition, "started");
});

test("mutation fences active work and advances account generation", () => {
  const { admission } = fixture();
  const account = NATIVE_CODEX_RUNTIME_ACCOUNT_ID;
  const mutation = admission.beginMutation({ runtimeAccountId: account, operationId: "login-1" });
  assert.equal(admission.admit({ runtimeAccountId: account, runId: "run-a" }).reason,
    "RUNTIME_ACCOUNT_MUTATION_BUSY");
  assert.equal(admission.finishMutation(mutation), 2);
  const started = admission.admit({ runtimeAccountId: account, runId: "run-a" });
  assert.equal(started.generation, 2);
  assert.throws(
    () => admission.beginMutation({ runtimeAccountId: account, operationId: "logout-1" }),
    { code: "RUNTIME_ACCOUNT_ACTIVE" },
  );
  assert.throws(
    () => admission.assertGeneration({ runtimeAccountId: account, generation: 1 }),
    { code: "RUNTIME_ACCOUNT_GENERATION_STALE" },
  );
});

test("Retry-After backoff is account-wide and expires against the injected clock", () => {
  const { admission, setNow } = fixture();
  const account = NATIVE_CODEX_RUNTIME_ACCOUNT_ID;
  admission.noteBackoff({ runtimeAccountId: account, retryAt: 250 });
  assert.deepEqual(admission.read(account), {
    runtimeAccountId: account,
    generation: 1,
    active: 0,
    maxActive: 1,
    mutationActive: false,
    backoffUntil: 250,
  });
  assert.equal(admission.admit({ runtimeAccountId: account, runId: "run-a" }).retryAt, 250);
  setNow(250);
  assert.equal(admission.admit({ runtimeAccountId: account, runId: "run-a" }).disposition,
    "started");
});

test("unknown accounts and invalid limit resolvers fail closed", () => {
  const { admission } = fixture();
  assert.throws(
    () => admission.read("missing-account"),
    { code: "RUNTIME_ACCOUNT_NOT_FOUND" },
  );
  const invalid = fixture({ resolveMaxActive: () => 0 }).admission;
  assert.throws(
    () => invalid.read(NATIVE_CODEX_RUNTIME_ACCOUNT_ID),
    { code: "RUNTIME_ACCOUNT_ADMISSION_LIMIT_INVALID" },
  );
});
