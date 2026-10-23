"use strict";
const { digest, fail, object } = require("./hook-contract");
const FACT_KEYS = new Set(["status", "success", "isError", "exitCode", "code", "id", "operationId", "artifactId", "callId"]);
function businessStatus(result, depth = 0) {
  if (result?.isError === true || result?.success === false || ["failed", "error", "canceled", "cancelled", "interrupted", "skipped"].includes(result?.status)
    || typeof result?.exitCode === "number" && result.exitCode !== 0) return "failed";
  if (["unknown", "needs_verification", "outcome_unknown"].includes(result?.status) || result?.sideEffect === "unknown"
    || result?.retryAllowed === false && result?.businessOperation !== undefined || result?.hookDisposition === "result_withheld") return "unknown";
  if (depth < 3) {
    for (const nested of [result?.structuredContent, result?.result]) {
      if (object(nested)) { const status = businessStatus(nested, depth + 1); if (status !== "completed") return status; }
    }
  }
  return "completed";
}
function assertFacts(original, result) {
  const walk = (before, after) => {
    if (!before || typeof before !== "object") return;
    for (const [key, value] of Object.entries(before)) {
      if (FACT_KEYS.has(key) && (!after || !Object.hasOwn(after, key) || digest(value) !== digest(after[key]))) fail("HOOK_RESULT_FACT_CHANGED");
      if (value && typeof value === "object") walk(value, after?.[key]);
    }
  };
  walk(original, result);
}
class HookToolExecution {
  #tokens = new WeakMap();
  constructor({ service, getExecutionPolicy = () => null, assertWorkspaceWriter = () => fail("HOOK_WRITE_FORBIDDEN") }) {
    this.service = service; this.getExecutionPolicy = getExecutionPolicy; this.assertWorkspaceWriter = assertWorkspaceWriter;
  }
  async before({ run, profile, tool, args, scope, callId, validateArguments }) {
    if (!scope || scope.runId !== run.id || run.profileId !== profile.id || !scope.assertCurrent
      || typeof validateArguments !== "function") fail("HOOK_AUTHORITY_INVALID");
    scope.assertCurrent();
    const snapshot = this.service.store.snapshotForRun(run.id);
    if (!snapshot) fail("HOOK_SNAPSHOT_REQUIRED");
    const event = this.service.event(snapshot, run, "tool.before",
      "tool-before:" + run.id + ":" + callId, { arguments: args }, tool, callId);
    const context = { signal: scope.signal, assertCurrent: scope.assertCurrent };
    const verdict = await this.service.runner.before(snapshot, event, context);
    if (verdict.decision === "block") fail("HOOK_BLOCKED", verdict.reason || "Hook 已阻止此操作");
    if (validateArguments(verdict.arguments) !== true) fail("HOOK_ARGUMENTS_INVALID");
    const entries = this.service.store.select(snapshot, event);
    const authorizationIdentity = { hookDigest: digest(entries.map(({ definition, sourceFile, ...entry }) => entry)) };
    const token = Object.freeze({});
    this.#tokens.set(token, { snapshot, event, context, run, profile, tool, scope, entries,
      arguments: verdict.arguments, argumentDigest: verdict.argumentDigest, verdict, callId, authorizationIdentity });
    this.assertCurrent(token);
    return { token, arguments: verdict.arguments, changed: verdict.changed,
      requiresApproval: verdict.decision === "require_approval", reason: verdict.reason, authorizationIdentity };
  }
  assertCurrent(token) {
    const record = this.#tokens.get(token); if (!record) fail("HOOK_AUTHORITY_INVALID");
    record.scope.assertCurrent();
    if (this.service.productStore.getAgentProfile(record.profile.id)?.enabled !== true) fail("HOOK_REVOKED");
    for (const entry of record.entries) this.service.store.assertCurrent(record.snapshot, entry);
    return record;
  }
  async approve(token) {
    const record = this.assertCurrent(token);
    if (!this.service.requestApproval) fail("HOOK_APPROVAL_UNAVAILABLE");
    const approval = await this.service.requestApproval({ runId: record.run.id, profileId: record.profile.id,
      toolName: record.tool.name, arguments: record.arguments, reason: record.verdict.reason,
      authorizationIdentity: record.authorizationIdentity,
      signal: record.scope.signal, assertCurrent: () => this.assertCurrent(token) });
    this.assertCurrent(token);
    if (approval?.approved !== true) fail("HOOK_APPROVAL_DENIED");
    record.approved = true; return true;
  }
  markApproved(token) { this.assertCurrent(token).approved = true; }
  async after(token, original) {
    const record = this.#tokens.get(token);
    if (!record) fail("HOOK_AUTHORITY_INVALID");
    const withheld = code => ({ hookDisposition: "result_withheld", businessOperation: "already_executed",
      toolCallId: record.callId, originalResultDigest: digest(original ?? null), retryAllowed: false, errorCode: code });
    try { this.assertCurrent(token); }
    catch (error) { return withheld(error.code || "HOOK_REVOKED"); }
    const { snapshot, run, tool, callId } = record;
    if (record.verdict.decision === "require_approval" && !record.approved) fail("HOOK_APPROVAL_REQUIRED");
    const event = this.service.event(snapshot, run, "tool.after", "tool-after:" + run.id + ":" + callId,
      { result: original, status: businessStatus(original) }, tool, callId);
    const context = { ...record.context, assertCurrent: () => this.assertCurrent(token),
      assertWritable: () => {
        const policy = this.getExecutionPolicy(run.id);
        if (!policy || policy.sandbox === "read-only" || !run.workspace) fail("HOOK_WRITE_FORBIDDEN");
        this.assertWorkspaceWriter(run.id, run.workspace);
      } };
    let actionStatus = null;
    try { if (event.payload.status === "completed") await this.service.runner.dispatch(snapshot, event, "action", context); }
    catch (error) { actionStatus = error.code || "HOOK_ACTION_FAILED"; }
    this.service.observe(snapshot, event);
    const resultEvent = this.service.event(snapshot, run, "tool.result.transform",
      "tool-result:" + run.id + ":" + callId, { result: original }, tool, callId);
    let result;
    try { result = await this.service.runner.transformResult(snapshot, resultEvent, context); assertFacts(original, result); }
    catch (error) {
      // The business operation may already have succeeded. Withhold the body
      // on mandatory transform failure and explicitly forbid an automatic retry.
      return withheld(error.code || "HOOK_RESULT_TRANSFORM_FAILED");
    }
    if (actionStatus) {
      const metadata = { actionStatus, businessOperation: "already_executed", toolCallId: callId,
        originalResultDigest: digest(original), retryAllowed: false };
      return object(result) ? { ...result, _meta: { ...(object(result._meta) ? result._meta : {}), shoggothHooks: metadata } }
        : { result, shoggothHooks: metadata };
    }
    return result;
  }
  async execute(input, action) {
    const prepared = await this.before(input);
    if (prepared.requiresApproval) await this.approve(prepared.token);
    this.assertCurrent(prepared.token);
    let result;
    try { result = await action(prepared.arguments, prepared); }
    catch (error) {
      const record = this.#tokens.get(prepared.token);
      this.service.observe(record.snapshot, this.service.event(record.snapshot, input.run, "tool.after",
        "tool-after:" + input.run.id + ":" + input.callId, { status: "failed" }, input.tool, input.callId));
      throw error;
    }
    return this.after(prepared.token, result);
  }
}
module.exports = { HookToolExecution, assertHookResultFacts: assertFacts };
