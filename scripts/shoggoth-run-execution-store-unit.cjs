#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { RunExecutionStore } = require("../app/agent-service/run-execution-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-execution-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const cryptoBroker = {
    async encrypt(input) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(input) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12));
      cipher.setAuthTag(input.subarray(12, 28));
      return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]);
    },
  };
  const paths = { stateDir: root, trustedRoot: root };
  const run = { id: "run-one", profileId: "profile-one", source: "chat", sourceId: "session-one",
    workspace: "/tmp/workspace", idempotencyKey: "shoggoth:chat-send:operation-one" };
  const contract = { runId: run.id, profileId: run.profileId, source: run.source, sourceId: run.sourceId,
    workspace: run.workspace, runtime: "codex", runtimeProfileId: "native-profile",
    runtimeAccountId: "account-one", runtimeAccountGeneration: 55,
    permissionPolicy: { sandbox: "read-only", approvalPolicy: "on-request" },
    runtimeHostPermissionPolicy: { sandbox: "read-only", approvalPolicy: "on-request" },
    developerInstructions: "private instructions", bindingId: null,
    provider: { providerRef: null, providerRevision: null, credentialRef: null, credentialRevision: null, modelRef: null },
    providerFence: { profileId: run.profileId, accountId: "account-one", accountRevision: 0,
      accountFingerprint: "a".repeat(64), providerFingerprint: null, profileRouteFingerprint: "b".repeat(64) } };
  const command = { kind: "chat", runId: run.id, operationId: "operation-one", prompt: "private user prompt" };
  return { root, paths, cryptoBroker, run, contract, command, store: new RunExecutionStore({ paths, cryptoBroker }) };
}

test("encrypted execution survives a new store instance; generation is not reused; terminal removes record", async (t) => {
  const f = fixture(t);
  assert.equal(await f.store.get(f.run), null);
  assert.equal(f.store.has(f.run), false);
  await f.store.put(f.run, f.contract, f.command);
  assert.equal(f.store.has(f.run), true);
  const directory = path.join(f.root, "run-executions");
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const bytes = fs.readFileSync(file, "utf8");
  assert.equal(bytes.includes("private user prompt"), false);
  assert.equal(bytes.includes("private instructions"), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reopened = new RunExecutionStore({ paths: f.paths, cryptoBroker: f.cryptoBroker });
  const record = await reopened.get(f.run);
  assert.equal(record.command.prompt, f.command.prompt);
  assert.equal(record.contract.runtimeAccountGeneration, undefined);
  reopened.remove(f.run);
  assert.equal(await reopened.get(f.run), null);
});

test("wrong profile/account binding, tampering and symlinks fail closed", async (t) => {
  const f = fixture(t);
  await f.store.put(f.run, f.contract, f.command);
  await assert.rejects(f.store.get({ ...f.run, profileId: "another-profile" }), { code: "EXECUTION_BINDING_INVALID" });
  const directory = path.join(f.root, "run-executions");
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const envelope = JSON.parse(fs.readFileSync(file));
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[30] ^= 1;
  fs.writeFileSync(file, JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") }));
  await assert.rejects(f.store.get(f.run), { code: "EXECUTION_BINDING_INVALID" });
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.root, "outside"), file);
  await assert.rejects(f.store.get(f.run));
});

test("crypto failure and a lifecycle fence prevent any committed descriptor", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.store.put(f.run, f.contract, f.command, () => { throw new Error("closed"); }), /closed/);
  assert.equal(await f.store.get(f.run), null);
  f.cryptoBroker.encrypt = async () => { throw new Error("crypto unavailable"); };
  await assert.rejects(f.store.put(f.run, f.contract, f.command), /crypto unavailable/);
  assert.equal(await f.store.get(f.run), null);
});

test("invalid runtime and permission contracts are rejected before encryption or dispatch", async (t) => {
  const f = fixture(t);
  for (const patch of [{ runtime: "bad runtime" }, { runtimeAccountId: "../account" },
    { permissionPolicy: { approvalPolicy: "allow-anything", sandbox: "workspace-write" } },
    { runtimeHostPermissionPolicy: { approvalPolicy: "never", sandbox: "unexpected" } }]) {
    await assert.rejects(f.store.put(f.run, { ...f.contract, ...patch }, f.command), { code: "EXECUTION_BINDING_INVALID" });
    assert.equal(f.store.has(f.run), false);
  }
});


test("version-two writes freeze provider identity and the reader still recognizes legacy version-one descriptors", async t => {
  const f = fixture(t);
  await f.store.put(f.run, f.contract, f.command);
  const saved = await f.store.get(f.run);
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.contract.provider, f.contract.provider);
  assert.deepEqual(saved.contract.providerFence, f.contract.providerFence);
  const file = path.join(f.root, "run-executions", fs.readdirSync(path.join(f.root, "run-executions"))[0]);
  const legacy = structuredClone(saved);
  legacy.version = 1; delete legacy.contract.provider; delete legacy.contract.providerFence; delete legacy.contract.bindingId;
  const bytes = await f.cryptoBroker.encrypt(Buffer.from(JSON.stringify(legacy)));
  fs.writeFileSync(file, JSON.stringify({ version: 1, ciphertext: bytes.toString("base64") }));
  assert.equal((await f.store.get(f.run)).version, 1);
  await assert.rejects(f.store.put(f.run, legacy.contract, f.command), { code: "EXECUTION_BINDING_INVALID" });
});
