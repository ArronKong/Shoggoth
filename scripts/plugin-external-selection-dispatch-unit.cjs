#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const { sqliteNativeBinding } = require("../app/agent-service/sqlite-native-binding");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { ExternalPluginSelectionDispatch, PREPARED_TTL_MS,
  validEnvelope, validExecutionIdentity } = require("../app/agent-service/external-plugin-selection-dispatch");

const credential = Buffer.alloc(32, 17).toString("base64url"); // synthetic adapter credential
const subject = { backendId: "openclaw", instanceId: "isolated-openclaw",
  agentId: "agent-a", sessionId: "physical-session-a" };
const identity = { ...subject, runId: "actual-run-a" };
const hermesSubject = { backendId: "hermes", instanceId: "isolated-hermes",
  agentId: "agent-h", sessionId: "physical-session-h" };
const hermesIdentity = { ...hermesSubject, taskId: "task-h", turnId: "turn-h" };

async function crashChild() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data);
  const store = new PluginStore({ paths: input.paths }).open();
  const dispatch = new ExternalPluginSelectionDispatch({ paths: input.paths, store,
    authorizeAdapter: async (_backend, token) => token === credential }).open();
  const prepared = dispatch.prepare(input.request);
  await dispatch.bind({ credentialToken: credential, envelope: prepared.envelope, identity: input.identity });
  process.stdout.write("BOUND_AND_DURABLE\n");
  setInterval(() => {}, 1000);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-selection-dispatch-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), userDataRoot: temp,
    profileRoot: path.join(temp, "profile"), cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  let store, dispatch;
  let child;
  try {
    store = new PluginStore({ paths }).open();
    const source = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    const installer = new PluginPackageInstaller({ store });
    const preview = installer.preview(source);
    const installed = installer.install({ sourcePath: source, previewDigest: preview.contentDigest,
      operationId: "selection-install", expectedRevision: 0 });
    let active = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    let clock = 1_000_000;
    let authorized = true;
    let slowAuthorization = null;
    const authorizeAdapter = async (_backend, token) => {
      if (slowAuthorization) await slowAuthorization;
      return authorized && token === credential;
    };
    const open = () => new ExternalPluginSelectionDispatch({ paths, store,
      authorizeAdapter, now: () => clock }).open();
    dispatch = open();
    const request = (operationId, target = subject) => ({ subject: target, operationId,
      requiredAdapterId: target.backendId === "hermes" ? "shoggoth_shared_capabilities"
        : "shoggoth-shared-capabilities", adapterGeneration: "host-generated-registration-a",
      pluginSelection: [{ installationId: active.installationId, revision: active.revision }] });

    const prepared = dispatch.prepare(request("send-a"));
    assert(validEnvelope(prepared.envelope));
    assert.equal(prepared.receipt.state, "prepared");
    assert.equal(prepared.receipt.identity, null);
    const reordered = Object.fromEntries(Object.entries(subject).reverse());
    assert.deepEqual(dispatch.prepare(request("send-a", reordered)), prepared);
    assert.throws(() => dispatch.prepare({ ...request("send-a"), adapterGeneration: "other" }),
      { code: "EXTERNAL_PLUGIN_SELECTION_CONFLICT" });
    assert.throws(() => dispatch.prepare({ ...request("extra"), pluginSelection: [] }),
      { code: "PLUGIN_SELECTION_INVALID" });
    assert.equal(validEnvelope({ ...prepared.envelope, arbitrary: true }), false);
    assert.equal(validExecutionIdentity({ ...identity, toolCallId: "not-a-turn-identity" }), false);

    for (const bad of [
      { credentialToken: "invalid", envelope: prepared.envelope, identity },
      { credentialToken: credential, envelope: { ...prepared.envelope, selectionDigest: "a".repeat(64) }, identity },
      { credentialToken: credential, envelope: prepared.envelope, identity: { ...identity, sessionId: "other-session" } },
      { credentialToken: credential, envelope: { ...prepared.envelope, adapterGeneration: "forged" }, identity },
    ]) await assert.rejects(dispatch.bind(bad), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    authorized = false;
    await assert.rejects(dispatch.bind({ credentialToken: credential, envelope: prepared.envelope, identity }),
      { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    authorized = true;
    const bound = await dispatch.bind({ credentialToken: credential, envelope: prepared.envelope, identity });
    assert.equal(bound.receipt.state, "bound");
    assert.deepEqual(bound.receipt.identity, identity);
    assert.equal(bound.selectedPlugins.length, 1);
    assert.equal(bound.selectedPlugins[0].packageName, "project-assistant");
    assert.equal(Object.hasOwn(bound, "credentialToken"), false);
    assert.deepEqual(await dispatch.bind({ credentialToken: credential, envelope: prepared.envelope,
      identity: Object.fromEntries(Object.entries(identity).reverse()) }), bound);
    await assert.rejects(dispatch.bind({ credentialToken: credential, envelope: prepared.envelope,
      identity: { ...identity, runId: "other-real-run" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.deepEqual(dispatch.assertBound({ envelope: prepared.envelope, identity }), bound.selectedPlugins);
    assert.deepEqual(dispatch.getExecutionSelection({ envelope: prepared.envelope, identity }).selectedPlugins, bound.selectedPlugins);
    assert.throws(() => dispatch.getExecutionSelection({ identity }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.throws(() => dispatch.getExecutionSelection({ identity: { ...identity,
      instanceId: "another-plugin-facade-instance" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.equal(dispatch.getExecutionSelection({ identity: { ...identity, runId: "ordinary-unselected-run" } }), null);
    const duplicateExecution = dispatch.prepare(request("duplicate-execution"));
    await assert.rejects(dispatch.bind({ credentialToken: credential,
      envelope: duplicateExecution.envelope, identity }), { code: "EXTERNAL_PLUGIN_SELECTION_CONFLICT" });

    const h = dispatch.prepare(request("send-h", hermesSubject));
    const hBound = await dispatch.bind({ credentialToken: credential, envelope: h.envelope, identity: hermesIdentity });
    assert.deepEqual(hBound.receipt.identity, hermesIdentity);
    assert.throws(() => dispatch.assertBound({ envelope: h.envelope,
      identity: { ...hermesIdentity, turnId: "neighbor-turn" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });

    // Revocation during asynchronous adapter verification cannot bind a stale snapshot.
    const raced = dispatch.prepare(request("raced"));
    let release;
    slowAuthorization = new Promise(resolve => { release = resolve; });
    const binding = dispatch.bind({ credentialToken: credential, envelope: raced.envelope,
      identity: { ...identity, runId: "raced-run" } });
    active = store.setInstallationDesiredState({ installationId: active.installationId,
      desiredState: "disabled", expectedRevision: active.revision });
    release();
    await assert.rejects(binding, { code: "PLUGIN_SELECTION_STALE" });
    slowAuthorization = null;
    assert.throws(() => dispatch.assertBound({ envelope: prepared.envelope, identity }),
      { code: "PLUGIN_SELECTION_STALE" });
    assert.equal((await dispatch.finish({ credentialToken: credential, envelope: prepared.envelope, identity })).state,
      "completed", "revocation must not prevent matching Host termination");
    assert.equal((await dispatch.finish({ credentialToken: credential, envelope: prepared.envelope, identity })).state,
      "completed", "termination retry is observation, never another execution");
    active = store.setInstallationDesiredState({ installationId: active.installationId,
      desiredState: "enabled", expectedRevision: active.revision });

    // The authority must snapshot caller-owned objects before an async Host
    // lookup. Changing them during that lookup cannot move the selection.
    const immutable = dispatch.prepare(request("immutable-await"));
    const mutableEnvelope = { ...immutable.envelope };
    const mutableIdentity = { ...identity, runId: "immutable-real-run" };
    let releaseMutable;
    slowAuthorization = new Promise(resolve => { releaseMutable = resolve; });
    const immutableBind = dispatch.bind({ credentialToken: credential,
      envelope: mutableEnvelope, identity: mutableIdentity });
    mutableEnvelope.operationId = "substituted-operation";
    mutableIdentity.sessionId = "substituted-session";
    mutableIdentity.runId = "substituted-run";
    releaseMutable();
    const immutableBound = await immutableBind;
    assert.deepEqual(immutableBound.envelope, immutable.envelope);
    assert.deepEqual(immutableBound.receipt.identity, { ...identity, runId: "immutable-real-run" });
    const finishEnvelope = { ...immutable.envelope };
    const finishIdentity = { ...immutableBound.receipt.identity };
    slowAuthorization = new Promise(resolve => { releaseMutable = resolve; });
    const immutableFinish = dispatch.finish({ credentialToken: credential,
      envelope: finishEnvelope, identity: finishIdentity });
    finishEnvelope.dispatchRef = "substituted-reference";
    finishIdentity.runId = "substituted-run";
    releaseMutable();
    assert.equal((await immutableFinish).state, "completed");
    slowAuthorization = null;
    const reusedCompleted = dispatch.prepare(request("reuse-completed-execution"));
    await assert.rejects(dispatch.bind({ credentialToken: credential,
      envelope: reusedCompleted.envelope, identity: immutableBound.receipt.identity }), { code: "EXTERNAL_PLUGIN_SELECTION_CONFLICT" });
    assert.throws(() => dispatch.getExecutionSelection({ identity: immutableBound.receipt.identity }),
      { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });

    // A derived resolved cache cannot override the actual PluginStore rows
    // whose digest was just verified. Corrupt only this fixture's own cache.
    const cached = dispatch.prepare(request("damaged-resolved-cache"));
    const nativeBinding = sqliteNativeBinding();
    const cacheDb = new Database(dispatch.path, nativeBinding ? { nativeBinding } : undefined);
    try {
      const row = cacheDb.prepare("SELECT resolved_json FROM external_selection_dispatches WHERE dispatch_ref = ?")
        .get(cached.envelope.dispatchRef);
      const corrupted = JSON.parse(row.resolved_json);
      corrupted[0].packageName = "different-cached-package";
      cacheDb.prepare("UPDATE external_selection_dispatches SET resolved_json = ? WHERE dispatch_ref = ?")
        .run(JSON.stringify(corrupted), cached.envelope.dispatchRef);
    } finally { cacheDb.close(); }
    const cachedIdentity = { ...identity, runId: "cached-real-run" };
    const cacheBound = await dispatch.bind({ credentialToken: credential,
      envelope: cached.envelope, identity: cachedIdentity });
    assert.equal(cacheBound.selectedPlugins[0].packageName, "project-assistant");
    assert.deepEqual(dispatch.assertBound({ envelope: cached.envelope, identity: cachedIdentity }), cacheBound.selectedPlugins);

    const expired = dispatch.prepare(request("expired"));
    clock += PREPARED_TTL_MS;
    await assert.rejects(dispatch.bind({ credentialToken: credential, envelope: expired.envelope,
      identity: { ...identity, runId: "expired-run" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.equal(dispatch.get({ subject, operationId: "expired" }).state, "expired");
    const canceled = dispatch.prepare(request("canceled"));
    assert.equal(dispatch.cancel({ subject, operationId: "canceled" }).state, "canceled");
    await assert.rejects(dispatch.bind({ credentialToken: credential, envelope: canceled.envelope,
      identity: { ...identity, runId: "canceled-run" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.equal(dispatch.get({ subject: { ...subject, sessionId: "other-session" }, operationId: "canceled" }), null);

    const pending = dispatch.prepare(request("restart-pending"));
    dispatch.close();
    dispatch = open();
    assert.equal((await dispatch.finish({ credentialToken: credential,
      envelope: immutable.envelope, identity: immutableBound.receipt.identity })).state,
    "completed", "lost completion ACK must remain observable after restart");
    assert.equal(dispatch.get({ subject, operationId: "restart-pending" }).state, "outcome_unknown");
    assert.equal(dispatch.prepare(request("restart-pending")).envelope.dispatchRef, pending.envelope.dispatchRef);
    await assert.rejects(dispatch.bind({ credentialToken: credential, envelope: pending.envelope,
      identity: { ...identity, runId: "restart-run" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });

    // A separate process is killed only after bind returned its durable receipt.
    dispatch.close();
    dispatch = null;
    store.close();
    store = null;
    child = spawn(process.execPath, [__filename, "--crash-child"], { stdio: ["pipe", "pipe", "pipe"] });
    const crashIdentity = { ...identity, runId: "actual-crash-run" };
    child.stdin.end(JSON.stringify({ paths, request: request("crash-bound"), identity: crashIdentity }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("crash child did not bind")), 15_000);
      let output = "";
      child.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes("BOUND_AND_DURABLE")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`crash child exited ${code}`)); });
    });
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exit;
    child = null;
    store = new PluginStore({ paths }).open();
    dispatch = open();
    const recovered = dispatch.get({ subject, operationId: "crash-bound" });
    assert.equal(recovered.state, "outcome_unknown");
    assert.deepEqual(recovered.identity, crashIdentity);
    assert.throws(() => dispatch.assertBound({ envelope: dispatch.prepare(request("crash-bound")).envelope, identity: crashIdentity }),
      { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.equal(fs.statSync(dispatch.path).mode & 0o777, 0o600);
    console.log("external plugin selection dispatch: PASS (real PluginStore, revocation, identities, SIGKILL recovery; zero remote calls)");
  } finally {
    child?.kill("SIGKILL");
    dispatch?.close();
    store?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--crash-child") crashChild().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
else main().catch(error => { console.error(error); process.exitCode = 1; });
