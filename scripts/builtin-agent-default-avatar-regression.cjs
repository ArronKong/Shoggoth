#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { BUILTIN_CLI_AGENT_PROFILES, ensureBuiltinCliAgentProfiles } = require("../app/agent-service/builtin-cli-profiles");
const { BuiltinAgentState } = require("../app/agent-service/builtin-agent-state");
const { assignBuiltinAgentAvatar } = require("../app/agent-service/builtin-agent-avatars");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("../app/agent-service/runtime-account");
const { startStaticServer } = require("../app/static-server");
const builtin = require("../app/assets/agent-avatars/builtin/manifest.json");
const library = require("../app/assets/agent-avatars/manifest.json");

const assetDir = path.resolve(__dirname, "../app/assets/agent-avatars");
const spec = (runtime) => BUILTIN_CLI_AGENT_PROFILES.find(profile => profile.runtime === runtime);
const entryFor = (profileId) => builtin.entries.find(entry => entry.profileId === profileId);
const reservedBytes = (entry) => fs.readFileSync(path.join(assetDir, "builtin", entry.file));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5ZkAAAAASUVORK5CYII=", "base64");

function fixture(t, installed = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgav-")));
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "data"),
    trustedRoot: root, cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const f = { paths, installed, service: null, http: null };
  f.avatarFile = (entry) => path.join(paths.userDataRoot, "agent-avatars", entry.agentId + ".jpg");
  f.start = async () => {
    f.service = createAgentService({ paths, version: "builtin-default-avatars", builtinCliProfiles: true,
      builtinCliInstalledAccountIds: f.installed });
    await f.service.start();
    if (!f.http) f.http = await startStaticServer(0, { homeDir: root, userDataRoot: paths.userDataRoot });
  };
  f.call = (method, params) => requestService(paths, { method, params, version: PROTOCOL_VERSION,
    token: readClientToken(paths) }, { timeoutMs: 20_000 });
  f.ensure = () => f.call("agent.builtin.ensure", {
    runtimeAccountIds: Object.values(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME), locale: "zh-CN",
  });
  f.readAvatar = async (agentId) => {
    const response = await fetch(`${f.http.url}/avatar/${agentId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    return Buffer.from(await response.arrayBuffer());
  };
  t.after(async () => {
    await f.http?.close();
    await f.service?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

function assertRandomAvatar(f, agentId, bytes) {
  assert.equal(builtin.entries.some(entry => reservedBytes(entry).equals(bytes)), false,
    "reserved first-creation images must never be reused by a new Agent");
  const selections = JSON.parse(fs.readFileSync(path.join(f.paths.userDataRoot,
    "agent-avatars/.default-selections.json"), "utf8"));
  assert.ok(library.entries.some(entry => entry.file === selections.assignments[agentId]));
}

test("fresh startup assigns all seven exact reserved images before any avatar request", async t => {
  const f = fixture(t, Object.values(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME));
  await f.start();
  assert.equal(f.service.productStore.listAgentProfiles().length, 7);
  for (const entry of builtin.entries) {
    const profile = f.service.productStore.getAgentProfile(entry.profileId);
    assert.equal(profile.agentId, entry.agentId);
    assert.deepEqual(fs.readFileSync(f.avatarFile(entry)), reservedBytes(entry), "assignment happens at creation");
    assert.deepEqual(await f.readAvatar(entry.agentId), reservedBytes(entry));
  }
  await f.service.stop();
  await f.start();
  assert.deepEqual((await f.ensure()).createdProfileIds, []);
  for (const entry of builtin.entries) assert.deepEqual(await f.readAvatar(entry.agentId), reservedBytes(entry));
});

test("CLIs installed or connected later receive their reserved images through an already running avatar server", async t => {
  const f = fixture(t);
  await f.start();
  const main = entryFor(DEFAULT_AGENT_PROFILE_ID);
  assert.deepEqual(await f.readAvatar(main.agentId), reservedBytes(main));
  for (const entry of builtin.entries.filter(entry => entry.profileId !== DEFAULT_AGENT_PROFILE_ID)) {
    assert.equal(fs.existsSync(f.avatarFile(entry)), false, "uninstalled CLI gets no avatar reservation");
  }
  // A stale preview may already have selected an ordinary image for this ID.
  const codex = entryFor(spec("codex").id);
  assertRandomAvatar(f, codex.agentId, await f.readAvatar(codex.agentId));
  f.installed.push(...Object.values(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME));
  assert.equal((await f.ensure()).createdProfileIds.length, 6);
  for (const entry of builtin.entries) assert.deepEqual(await f.readAvatar(entry.agentId), reservedBytes(entry));
  const selections = JSON.parse(fs.readFileSync(path.join(f.paths.userDataRoot,
    "agent-avatars/.default-selections.json"), "utf8"));
  assert.equal(selections.assignments[codex.agentId], undefined, "reserved image releases the earlier random selection");
});

test("delete, restart and create an Agent with the same name uses the random library; archive restore retains the old identity", async t => {
  const grok = spec("grok-build");
  const f = fixture(t, [DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[grok.runtime]]);
  await f.start();
  const original = f.service.productStore.getAgentProfile(grok.id);
  const archived = await f.call("agent.archive", { operationId: "archive-grok", profileId: grok.id,
    expectedUpdatedAt: original.updatedAt, createdAt: Date.now() });
  assert.equal(archived.profile.enabled, false);
  await f.service.stop();
  await f.start();
  assert.deepEqual((await f.ensure()).createdProfileIds, []);
  assert.equal(f.service.productStore.getAgentProfile(grok.id).enabled, false);
  const replacement = await f.call("agent.create", { operationId: "new-grok", backendId: "shoggoth",
    name: "Grok", defaultCwd: null, createdAt: Date.now() });
  assert.notEqual(replacement.profile.agentId, grok.agentId);
  assertRandomAvatar(f, replacement.profile.agentId, await f.readAvatar(replacement.profile.agentId));
  await f.call("agent.update", { operationId: "rename-new-grok", profileId: replacement.profile.id,
    name: "Grok replacement", defaultCwd: null, expectedUpdatedAt: replacement.profile.updatedAt, createdAt: Date.now() });
  const restored = await f.call("agent.restore", { operationId: "restore-grok", profileId: grok.id,
    expectedUpdatedAt: f.service.productStore.getAgentProfile(grok.id).updatedAt, createdAt: Date.now() });
  assert.equal(restored.profile.enabled, true);
  assert.deepEqual(await f.readAvatar(grok.agentId), reservedBytes(entryFor(grok.id)));
});

test("custom uploads keep priority and removing them after restart does not reassign a reserved image", async t => {
  const codex = spec("codex");
  const f = fixture(t, [DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[codex.runtime]]);
  await f.start();
  const entries = [entryFor(DEFAULT_AGENT_PROFILE_ID), entryFor(codex.id)];
  for (const entry of entries) {
    const response = await fetch(`${f.http.url}/avatar/${entry.agentId}`, { method: "PUT", body: png });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(f.avatarFile(entry)), false, "custom upload replaces the reserved JPEG");
  }
  await f.service.stop();
  await f.start();
  await f.ensure();
  for (const entry of entries) {
    const response = await fetch(`${f.http.url}/avatar/${entry.agentId}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    fs.unlinkSync(path.join(f.paths.userDataRoot, "agent-avatars", entry.agentId + ".png"));
    assertRandomAvatar(f, entry.agentId, await f.readAvatar(entry.agentId));
  }
});

test("an existing installation keeps its current default selections without receiving the new reserved images", async t => {
  const codex = spec("codex");
  const f = fixture(t, [DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[codex.runtime]]);
  const store = new JsonlProductStore({ paths: f.paths }).open();
  const state = new BuiltinAgentState({ paths: f.paths });
  state.open();
  ensureBuiltinCliAgentProfiles(store, new Set(f.installed), state);
  store.close();
  f.http = await startStaticServer(0, { homeDir: f.paths.homeDir, userDataRoot: f.paths.userDataRoot });
  const entries = [entryFor(DEFAULT_AGENT_PROFILE_ID), entryFor(codex.id)];
  const previous = await Promise.all(entries.map(entry => f.readAvatar(entry.agentId)));
  await f.start();
  await f.ensure();
  for (let index = 0; index < entries.length; index += 1) {
    assert.equal(fs.existsSync(f.avatarFile(entries[index])), false);
    assert.deepEqual(await f.readAvatar(entries[index].agentId), previous[index]);
    assertRandomAvatar(f, entries[index].agentId, previous[index]);
  }
});

test("reserved avatar publication preserves existing and legacy custom images and rejects an unsafe directory", t => {
  const f = fixture(t);
  const entry = entryFor(spec("pi").id);
  const profile = { id: entry.profileId, agentId: entry.agentId, backendId: "shoggoth" };
  const avatarDir = path.dirname(f.avatarFile(entry));
  fs.mkdirSync(avatarDir, { recursive: true, mode: 0o700 });
  const custom = path.join(avatarDir, entry.agentId + ".png");
  fs.writeFileSync(custom, png);
  assert.equal(assignBuiltinAgentAvatar(profile, f.paths), false);
  assert.deepEqual(fs.readFileSync(custom), png);
  fs.unlinkSync(custom);
  const legacyDir = path.join(f.paths.homeDir, ".openclaw/desktop/agent-avatars");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, entry.agentId + ".png"), png);
  assert.equal(assignBuiltinAgentAvatar(profile, f.paths), false);
  fs.unlinkSync(path.join(legacyDir, entry.agentId + ".png"));
  fs.rmdirSync(avatarDir);
  fs.symlinkSync(legacyDir, avatarDir);
  assert.throws(() => assignBuiltinAgentAvatar(profile, f.paths), { code: "UNSAFE_SYMLINK" });
  assert.equal(fs.readdirSync(legacyDir).length, 0, "unsafe target receives no image");
});
