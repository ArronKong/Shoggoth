"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { NativeCronStore } = require("../app/agent-service/native-cron-store");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
const { PRODUCT_CONFIRMATION_META, cronApprovalDescriptor, productConfirmationIdentity } = require("../app/agent-service/cron-approval-policy");

const now = 1_800_000_000_000, profileId = crypto.randomUUID(), key = "a".repeat(64);
const receipt = { runId: "cron-run-one", approvedAt: now };
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cron-authorization-")));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const store = new NativeCronStore({ paths, profileExists: id => id === profileId, now: () => now, ...options }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const create = () => store.createJob({ operationId: crypto.randomUUID(), name: "Task", enabled: false,
    profileId, prompt: "Check the current result", workspace: root,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now }, misfirePolicy: "latest", maxCatchUp: 1,
    overlapPolicy: "skip", threadPolicy: "continue", threadId: null, nextRunAt: null, createdAt: now });
  const update = (job, patch) => store.updateJobDerived({ operationId: crypto.randomUUID(), jobId: job.id, patch, createdAt: now });
  return { root, store, create, update, scope: job => store.authorizationScope(job.id, job.profileId, job.prompt) };
}

test("task grants persist privately across restart, preserve scheduling metadata edits and revoke on definition edits", t => {
  const f = fixture(t), job = f.create(), scope = f.scope(job);
  f.store.rememberAuthorization(scope, key, receipt);
  assert.equal(fs.statSync(f.store.authorizations.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.store.authorizations.file, "utf8").includes(job.prompt), false);
  f.store.close(); f.store.open();
  assert.equal(f.store.hasAuthorization(scope, key), true);
  f.update(job, { name: "Renamed" });
  f.store.setJobEnabledDerived({ operationId: crypto.randomUUID(), jobId: job.id, enabled: true, createdAt: now });
  assert.equal(f.store.hasAuthorization(scope, key), true);
  assert.equal(f.store.hasAuthorization(f.scope(f.create()), key), false);
  f.update(job, { prompt: "Different task" }); f.update(job, { prompt: job.prompt });
  assert.equal(f.store.hasAuthorization(scope, key), false);
  assert.ok(f.scope(job).epoch > scope.epoch);
  assert.throws(() => f.store.rememberAuthorization(scope, key, receipt), { code: "CRON_AUTHORIZATION_STALE" });
  const current = f.scope(job); f.store.rememberAuthorization(current, key, receipt);
  f.store.deleteJob({ operationId: crypto.randomUUID(), jobId: job.id, createdAt: now });
  assert.equal(f.store.authorizationMatches(current), false);
});

test("grant and definition writes fail closed without consuming or restoring a prior grant", t => {
  const f = fixture(t), job = f.create(), scope = f.scope(job);
  const write = f.store.authorizations.atomicWrite;
  f.store.authorizations.atomicWrite = () => { throw Object.assign(new Error("write failure"), { code: "EIO" }); };
  assert.throws(() => f.store.rememberAuthorization(scope, key, receipt), { code: "EIO" });
  assert.equal(f.store.hasAuthorization(scope, key), false);
  f.store.authorizations.atomicWrite = write;
  f.store.rememberAuthorization(scope, key, receipt);
  f.store.authorizations.atomicWrite = () => { throw Object.assign(new Error("revoke failure"), { code: "EIO" }); };
  assert.throws(() => f.update(job, { prompt: "Changed" }), { code: "EIO" });
  assert.equal(f.store.getJob(job.id).prompt, job.prompt);
  assert.equal(f.store.hasAuthorization(scope, key), true);
  f.store.authorizations.atomicWrite = write;
  const jobWrite = f.store.atomicWrite;
  f.store.atomicWrite = () => { throw new Error("job write failure"); };
  assert.throws(() => f.update(job, { prompt: "Changed" }), { code: "CRON_WRITE_FAILED" });
  f.store.atomicWrite = jobWrite;
  assert.equal(f.store.getJob(job.id).prompt, job.prompt);
  assert.equal(f.store.hasAuthorization(scope, key), false, "revocation wins even if the definition write failed");
  f.store.close(); f.store.open();
  assert.equal(f.store.hasAuthorization(scope, key), false);
});

test("uncertain grant commits block authorization until recovery and committed writes remain usable", t => {
  const f = fixture(t), job = f.create(), scope = f.scope(job);
  f.store.authorizations.atomicWrite = () => { throw Object.assign(new Error("uncertain"), { committedUncertain: true }); };
  assert.throws(() => f.store.rememberAuthorization(scope, key, receipt), { code: "STORE_COMMIT_UNCERTAIN" });
  assert.throws(() => f.store.hasAuthorization(scope, key), { code: "STORE_COMMIT_UNCERTAIN" });
  f.store.close(); f.store.open();
  assert.equal(f.store.hasAuthorization(scope, key), false);
  f.store.authorizations.atomicWrite = (file, bytes, options) => {
    atomicWritePrivateFile(file, bytes, options);
    throw Object.assign(new Error("committed"), { committed: true });
  };
  f.store.rememberAuthorization(scope, key, receipt);
  assert.equal(f.store.hasAuthorization(scope, key), true);
});

test("corrupt or redirected grant files are rejected without overwriting existing evidence", t => {
  const f = fixture(t), job = f.create(); f.scope(job);
  const file = f.store.authorizations.file;
  f.store.close();
  fs.writeFileSync(file, '{"version":99,"jobs":{}}\n', { mode: 0o600 });
  assert.throws(() => f.store.open(), { code: "CRON_AUTHORIZATION_CORRUPT" });
  assert.match(fs.readFileSync(file, "utf8"), /99/);
  fs.unlinkSync(file);
  const target = path.join(f.root, "outside-grants");
  fs.writeFileSync(target, '{"version":1,"jobs":{}}\n', { mode: 0o600 });
  fs.symlinkSync(target, file);
  assert.throws(() => f.store.open(), error => /UNSAFE_|CRON_AUTHORIZATION_CORRUPT/.test(error.code));
  assert.equal(fs.readFileSync(target, "utf8"), '{"version":1,"jobs":{}}\n');
});

test("remembered approvals bind operation targets, task authority, plugin revisions and do not store ordinary form answers", () => {
  const contract = { cronAuthorization: {}, profileId, bindingId: "binding", runtime: "codex", runtimeProfileId: "runtime",
    runtimeAccountId: "account", workspace: "/workspace", toolRegistryRevision: 1, toolPermissionRevision: 1,
    permissionPolicy: { sandbox: "danger-full-access", approvalPolicy: "never" } };
  const params = { serverName: "shoggoth", mode: "form", message: "Confirm action", requestedSchema: {
    type: "object", description: productConfirmationIdentity("computer_session_open", { runId: "one", allowedApplications: ["Chrome"] }),
    properties: { confirm_product_action: { type: "string", enum: ["确认执行", "取消"] } }, required: ["confirm_product_action"] } };
  const descriptor = value => cronApprovalDescriptor("mcpServer/elicitation/request", value, contract);
  const first = descriptor(params); assert.ok(first);
  const metadata = structuredClone(params);
  metadata._meta = { [PRODUCT_CONFIRMATION_META]: metadata.requestedSchema.description };
  delete metadata.requestedSchema.description;
  assert.equal(descriptor(metadata).key, first.key, "metadata transport preserves previously saved exact grants");
  const changed = structuredClone(metadata);
  changed._meta[PRODUCT_CONFIRMATION_META] = productConfirmationIdentity("computer_session_open",
    { runId: "two", allowedApplications: ["Safari"] });
  assert.notEqual(descriptor(changed).key, first.key, "operation identity in metadata participates in the grant key");
  assert.equal(descriptor({ ...metadata, _meta: {} }), null);
  assert.equal(descriptor({ ...metadata, _meta: { [PRODUCT_CONFIRMATION_META]: null } }), null);
  assert.equal(descriptor({ ...metadata, _meta: { ...metadata._meta, unrelated: true } }), null);
  assert.equal(descriptor({ ...params, _meta: changed._meta }), null, "conflicting old/new identities fail closed");
  assert.equal(descriptor({ ...metadata, _meta: undefined }), null);
  assert.equal(descriptor({ ...metadata, serverName: "external" }), null);
  const next = structuredClone(params);
  next.requestedSchema.description = productConfirmationIdentity("computer_session_open", { runId: "two", allowedApplications: ["Chrome"] });
  assert.equal(descriptor(next).key, first.key, "execution IDs are not authorization targets");
  next.requestedSchema.description = productConfirmationIdentity("computer_session_open", { runId: "two", allowedApplications: ["Safari"] });
  assert.notEqual(descriptor(next).key, first.key);
  assert.notEqual(cronApprovalDescriptor("mcpServer/elicitation/request", params, { ...contract, runtimeAccountId: "other" }).key, first.key);
  assert.equal(descriptor({ ...params, redacted: true }), null);
  assert.equal(descriptor({ ...params, serverName: "external" }), null);
  assert.equal(descriptor({ ...params, requestedSchema: { type: "object", properties: { audience: { type: "string" } } } }), null);
  const plugin = { toolName: "send", toolInput: { destination: "team" }, reason: "Confirm", authorizationIdentity: { grantEpoch: 1 },
    approvalOptions: [{ kind: "allow_once", choice: "once" }] };
  const pluginKey = cronApprovalDescriptor("shoggoth/pluginTool/requestApproval", plugin, contract).key;
  assert.notEqual(cronApprovalDescriptor("shoggoth/pluginTool/requestApproval", { ...plugin, authorizationIdentity: { grantEpoch: 2 } }, contract).key, pluginKey);
});
