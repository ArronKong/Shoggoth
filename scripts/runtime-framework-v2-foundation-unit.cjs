#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_RUNTIME_FRAMEWORK_FLAGS,
  RUNTIME_FRAMEWORK_FLAG_NAMES,
  resolveRuntimeFrameworkFlags,
} = require("../app/agent-service/runtime-framework-flags");
const {
  MAX_SELECTION_DIAGNOSTIC_CANDIDATES,
  createRuntimeSelectionDiagnostics,
  runtimeSelectionDiagnostic,
} = require("../app/agent-service/runtime-selection-diagnostics");

const tests = [];
function test(name, run) { tests.push({ name, run }); }
function decision(overrides = {}) {
  return {
    attemptId: "12345678-1234-4123-8123-123456789abc",
    currentRuntime: "codex",
    selectedRuntime: "pi",
    reasonCode: "AUTO_PRIORITY",
    candidates: [
      { runtime: "codex", supported: false, reasonCode: "MODEL_UNSUPPORTED" },
      { runtime: "pi", supported: true, reasonCode: "SUPPORTED" },
    ],
    ...overrides,
  };
}
const invalidFlags = { code: "RUNTIME_FRAMEWORK_FLAGS_INVALID", message: "Runtime framework flags are invalid" };
const invalidDiagnostic = { code: "RUNTIME_SELECTION_DIAGNOSTIC_INVALID", message: "Runtime selection diagnostic is invalid" };

test("unconfigured Service gates remain disabled until Core supplies its frozen projection", () => {
  assert.equal(RUNTIME_FRAMEWORK_FLAG_NAMES.length, 4);
  assert.ok(Object.values(resolveRuntimeFrameworkFlags()).every((value) => value === false));
  const input = { runtimeAdmissionV1: true };
  const snapshot = resolveRuntimeFrameworkFlags(input);
  input.runtimeAdmissionV1 = false;
  assert.equal(snapshot.runtimeAdmissionV1, true);
  assert.equal(snapshot.runtimeContextLifecycleV1, false, "one gate does not enable unrelated slices");
  assert.equal(snapshot.runtimeMultiBinding, false);
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => { snapshot.runtimeMultiBinding = true; }, TypeError);
  assert.deepEqual(resolveRuntimeFrameworkFlags(), DEFAULT_RUNTIME_FRAMEWORK_FLAGS);
});

test("flags reject typos, coercion, inherited/accessor/symbol configuration without echoing input", () => {
  let getterCalls = 0;
  for (const value of [
    null, [], "secret-configuration", 1,
    { runtimeAdmissionV1: "false" }, { runtimeMultiBinding: 1 },
    { runtimeSelectionShaddow: true }, { "secret-key": "secret-value" },
    Object.create({ runtimeMultiBinding: true }),
    Object.defineProperty({}, "runtimeMultiBinding", { value: true }),
    { [Symbol("secret")]: true },
    { get runtimeMultiBinding() { getterCalls += 1; return true; } },
    new Proxy({}, { ownKeys() { throw new Error("secret-proxy-error"); } }),
  ]) assert.throws(() => resolveRuntimeFrameworkFlags(value), invalidFlags);
  assert.equal(getterCalls, 0);
});

test("disabled diagnostics never inspect the attempt or call the sink", () => {
  let touched = 0;
  const poison = new Proxy({}, { getPrototypeOf() { touched += 1; throw new Error(); } });
  const diagnostics = createRuntimeSelectionDiagnostics({ emit() { touched += 1; } });
  assert.equal(diagnostics.record(poison), false);
  assert.equal(touched, 0);
  assert.equal(createRuntimeSelectionDiagnostics().record(decision()), false);
});

test("shadow emits only a detached immutable metadata record", () => {
  const events = [];
  const flags = { runtimeAdmissionV1: true };
  const diagnostics = createRuntimeSelectionDiagnostics({ enabled: flags.runtimeAdmissionV1, emit: (...args) => events.push(args) });
  flags.runtimeAdmissionV1 = false;
  const original = decision();
  assert.equal(diagnostics.record(original), true);
  original.candidates[1].supported = false;
  original.candidates.push({ runtime: "pi", supported: true, reasonCode: "SUPPORTED" });
  assert.equal(events.length, 1);
  const [name, payload] = events[0];
  assert.equal(name, "runtime.selection.shadow");
  assert.deepEqual(payload, { version: 1, mode: "shadow", ...decision() });
  assert.ok(Object.isFrozen(payload));
  assert.ok(Object.isFrozen(payload.candidates));
  assert.ok(payload.candidates.every(Object.isFrozen));
  assert.throws(() => { payload.selectedRuntime = "codex"; }, TypeError);
  assert.throws(() => { payload.candidates[0].supported = true; }, TypeError);
});

test("unknown facts produce a metadata-only no-candidate outcome", () => {
  const event = runtimeSelectionDiagnostic(decision({
    selectedRuntime: null,
    reasonCode: "NO_CANDIDATE",
    candidates: [{ runtime: "codex", supported: false, reasonCode: "FACTS_UNKNOWN" }],
  }));
  assert.equal(event.selectedRuntime, null);
  assert.equal(event.candidates[0].reasonCode, "FACTS_UNKNOWN");
});

test("free-form content, credentials and raw runtime errors never reach diagnostics", () => {
  const emitted = [];
  const diagnostics = createRuntimeSelectionDiagnostics({
    enabled: true, emit: (...args) => emitted.push(args),
  });
  const cases = [
    ...["prompt", "secret", "accessToken", "authorization", "workspace", "model", "error", "transcript"]
      .map((key) => ({ ...decision(), [key]: "private-body" })),
    decision({ attemptId: "private-body" }),
    decision({ currentRuntime: "private-body" }),
    decision({ selectedRuntime: "private-body" }),
    decision({ reasonCode: "private-body" }),
    decision({ candidates: [{ runtime: "pi", supported: true, reasonCode: "SUPPORTED", prompt: "private-body" }] }),
    decision({ candidates: [{ runtime: "private-body", supported: true, reasonCode: "SUPPORTED" }] }),
    decision({ candidates: [{ runtime: "pi", supported: true, reasonCode: "private-body" }] }),
    Object.assign(decision(), { [Symbol("secret")]: "private-body" }),
    Object.defineProperty(decision(), "secret", { value: "private-body" }),
  ];
  for (const value of cases) {
    assert.throws(() => runtimeSelectionDiagnostic(value), invalidDiagnostic);
    assert.equal(diagnostics.record(value), false);
  }
  assert.deepEqual(emitted, []);
});

test("diagnostics reject getters, serialization hooks, sparse and oversized candidates", () => {
  let getters = 0;
  const accessor = decision();
  Object.defineProperty(accessor, "reasonCode", { enumerable: true, get() { getters += 1; return "AUTO_PRIORITY"; } });
  const candidateAccessor = [{ get runtime() { getters += 1; return "pi"; }, supported: true, reasonCode: "SUPPORTED" }];
  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get() { getters += 1; return decision().candidates[1]; } });
  const sparse = [];
  sparse.length = 1;
  const hooked = decision();
  hooked.toJSON = () => { getters += 1; return "private-body"; };
  const extraArrayField = Object.assign([...decision().candidates], { secret: "private-body" });
  for (const value of [
    accessor, hooked,
    decision({ candidates: candidateAccessor }), decision({ candidates: arrayAccessor }),
    decision({ candidates: sparse }), decision({ candidates: extraArrayField }),
    decision({ candidates: Array(MAX_SELECTION_DIAGNOSTIC_CANDIDATES + 1).fill(decision().candidates[1]) }),
    new Proxy({}, { getPrototypeOf() { throw new Error("private-body"); } }),
  ]) assert.throws(() => runtimeSelectionDiagnostic(value), invalidDiagnostic);
  assert.equal(getters, 0);
});

test("malformed outcomes cannot claim an unsupported runtime was selected", () => {
  for (const value of [
    decision({ selectedRuntime: "deepseek-harness" }),
    decision({ selectedRuntime: "codex" }),
    decision({ selectedRuntime: null }),
    decision({ reasonCode: "NO_CANDIDATE" }),
    decision({ candidates: [{ runtime: "pi", supported: "true", reasonCode: "SUPPORTED" }] }),
  ]) assert.throws(() => runtimeSelectionDiagnostic(value), invalidDiagnostic);
});

test("throwing or asynchronously rejecting diagnostic sinks do not fail the caller", async () => {
  const errors = [];
  const onRejection = (error) => errors.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    const flags = { runtimeAdmissionV1: true };
    const sync = createRuntimeSelectionDiagnostics({ enabled: flags.runtimeAdmissionV1, emit() { throw new Error("private-body"); } });
    assert.equal(sync.record(decision()), false);
    const asyncSink = createRuntimeSelectionDiagnostics({ enabled: flags.runtimeAdmissionV1, emit: async () => { throw new Error("private-body"); } });
    assert.equal(asyncSink.record(decision()), true, "true means handed to the sink, not persisted");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`Runtime framework V2 foundation: ${tests.length}/${tests.length} passed (fixture evidence).`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
