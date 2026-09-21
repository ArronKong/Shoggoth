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

test("same RuntimeAccount shares four active slots and queues the fifth", () => {
  const { admission } = fixture();
  assert.deepEqual(admission.admit({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-a",
  }), {
    disposition: "started", reason: null, generation: 1, retryAt: null,
  });
  for (const runId of ["run-b", "run-c", "run-d"]) {
    assert.equal(admission.admit({ runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
      runId }).disposition, "started");
  }
  assert.equal(admission.admit({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-e",
  }).reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.equal(admission.release({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-a",
  }), true);
  assert.equal(admission.admit({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    runId: "run-e",
  }).disposition, "started");
  assert.equal(admission.read(NATIVE_CODEX_RUNTIME_ACCOUNT_ID).active, 4);
});

test("an explicitly lower account limit is preserved", () => {
  const { admission } = fixture({ resolveMaxActive: () => 2 });
  const runtimeAccountId = NATIVE_CODEX_RUNTIME_ACCOUNT_ID;
  assert.equal(admission.admit({ runtimeAccountId, runId: "a" }).disposition, "started");
  assert.equal(admission.admit({ runtimeAccountId, runId: "b" }).disposition, "started");
  assert.equal(admission.admit({ runtimeAccountId, runId: "c" }).reason, "RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  assert.equal(admission.read(runtimeAccountId).maxActive, 2);
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
    maxActive: 4,
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

test("credit recovery clears quota backoff without erasing a transport Retry-After", () => {
  const { admission, setNow } = fixture();
  const identity = { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, generation: 1 };
  admission.noteRateLimitBackoff({ ...identity, retryAt: 1000 });
  admission.noteRateLimitBackoff({ ...identity, retryAt: 900 });
  assert.equal(admission.read(identity.runtimeAccountId).backoffUntil, 1000);
  admission.noteBackoff({ ...identity, retryAt: 250 });
  assert.equal(admission.admit({ ...identity, runId: "queued" }).retryAt, 1000);
  admission.noteRateLimitBackoff({ ...identity, retryAt: 0 });
  assert.equal(admission.read(identity.runtimeAccountId).backoffUntil, 250);
  assert.equal(admission.admit({ ...identity, runId: "queued" }).retryAt, 250);
  setNow(250);
  assert.equal(admission.admit({ ...identity, runId: "queued" }).disposition, "started");
});

test("account mutations clear both cooldown sources and reject stale quota recovery", () => {
  const { admission } = fixture();
  const identity = { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, generation: 1 };
  admission.noteBackoff({ ...identity, retryAt: 250 });
  admission.noteRateLimitBackoff({ ...identity, retryAt: 1000 });
  admission.finishMutation(admission.beginMutation({ ...identity, operationId: "new-login" }));
  assert.equal(admission.read(identity.runtimeAccountId).backoffUntil, null);
  admission.noteRateLimitBackoff({ ...identity, generation: 2, retryAt: 2000 });
  assert.throws(() => admission.noteRateLimitBackoff({ ...identity, retryAt: 0 }),
    { code: "RUNTIME_ACCOUNT_GENERATION_STALE" });
  assert.equal(admission.read(identity.runtimeAccountId).backoffUntil, 2000);
});

test("exhausted quota rejects immediately without occupying a slot and expires at reset", () => {
  const { admission, setNow } = fixture();
  const identity = { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, generation: 1 };
  admission.noteRateLimitBackoff({ ...identity, retryAt: 1000, errorCode: "RUNTIME_QUOTA_EXHAUSTED" });
  assert.deepEqual(admission.admit({ ...identity, runId: "denied" }), {
    disposition: "rejected", reason: "RUNTIME_QUOTA_EXHAUSTED", generation: 1, retryAt: 1000,
  });
  assert.equal(admission.read(identity.runtimeAccountId).active, 0);
  setNow(1000);
  assert.equal(admission.admit({ ...identity, runId: "retry" }).disposition, "started");
  admission.release({ ...identity, runId: "retry" });
  admission.noteRateLimitBackoff({ ...identity, retryAt: 1200 });
  assert.equal(admission.admit({ ...identity, runId: "next" }).reason, "RUNTIME_ACCOUNT_BACKOFF",
    "an expired quota failure must not suppress a new transient backoff");
});

test("spending limits without a reset reject until recovery, which preserves real Retry-After", () => {
  const { admission, setNow } = fixture();
  const identity = { runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, generation: 1 };
  admission.noteRateLimitBackoff({ ...identity, retryAt: null, errorCode: "RUNTIME_SPENDING_LIMIT_REACHED" });
  assert.equal(admission.admit({ ...identity, runId: "denied" }).reason, "RUNTIME_SPENDING_LIMIT_REACHED");
  admission.noteBackoff({ ...identity, retryAt: 250 });
  admission.noteRateLimitBackoff({ ...identity, retryAt: 0 });
  assert.equal(admission.admit({ ...identity, runId: "retry" }).reason, "RUNTIME_ACCOUNT_BACKOFF");
  setNow(250);
  assert.equal(admission.admit({ ...identity, runId: "retry" }).disposition, "started");
});
