#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  RuntimeSessionOwnershipStore,
} = require(path.join(ROOT, "app", "agent-service", "runtime-session-ownership-store.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-session-ownership-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  let now = 10;
  return {
    paths,
    tick(value = 1) { now += value; return now; },
    open() { return new RuntimeSessionOwnershipStore({ paths, now: () => now }).open(); },
  };
}

function binding(runtimeAccountId = "native-codex-default-v1", runtimeProfileId = "profile-a") {
  return { runtime: "codex", runtimeProfileId, runtimeAccountId };
}

function claimInput(overrides = {}) {
  const selected = binding();
  return {
    runtimeAccountId: selected.runtimeAccountId,
    runtime: selected.runtime,
    runtimeProfileId: selected.runtimeProfileId,
    sessionId: "shared-looking-session",
    profileId: "agent-a",
    workspace: "/tmp/workspace-a",
    ...overrides,
  };
}

test("同一 RuntimeAccount 的 session 不能跨 Profile 抢占", () => {
  const ctx = fixture();
  const store = ctx.open();
  const first = store.claim(claimInput());
  assert.equal(first.status, "active");
  assert.deepEqual(store.claim(claimInput()), first);
  assert.throws(
    () => store.claim(claimInput({ runtimeProfileId: "profile-b", profileId: "agent-b" })),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CONFLICT",
  );
  assert.deepEqual(store.assertOwned({
    binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session",
  }), first);
  assert.throws(
    () => store.assertOwned({
      binding: binding("native-codex-default-v1", "profile-b"),
      profileId: "agent-b",
      sessionId: "shared-looking-session",
    }),
    (error) => error.code === "RUNTIME_SESSION_NOT_OWNED",
  );
  store.close();
});

test("不同 RuntimeAccount 可安全使用相同原生 session ID", () => {
  const ctx = fixture();
  const store = ctx.open();
  store.claim(claimInput());
  const otherBinding = binding("shoggoth-internal-codex-default-v1", "profile-b");
  const other = store.claim(claimInput({
    runtimeAccountId: otherBinding.runtimeAccountId,
    runtimeProfileId: otherBinding.runtimeProfileId,
    profileId: "agent-b",
    workspace: "/tmp/workspace-b",
  }));
  assert.equal(other.sessionId, "shared-looking-session");
  assert.equal(store.listOwned({ binding: binding(), profileId: "agent-a" }).length, 1);
  assert.deepEqual(
    store.listOwned({ binding: otherBinding, profileId: "agent-b" }),
    [other],
  );
  store.close();
});

test("workspace alias 只可匹配已固定的 canonical ownership，持久化身份不变", () => {
  const ctx = fixture();
  const root = fs.realpathSync(path.dirname(ctx.paths.stateDir));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const canonical = fs.realpathSync(workspace);
  const alias = path.join(root, "workspace-alias");
  fs.symlinkSync(canonical, alias);
  let store = ctx.open();
  const first = store.claim(claimInput({ workspace: canonical }));
  const query = {
    binding: binding(), profileId: "agent-a", sessionId: first.sessionId, workspace: alias,
  };
  assert.deepEqual(store.assertOwned(query), first);
  assert.deepEqual(store.readRecord(query), first);
  assert.deepEqual(store.claim(claimInput({ workspace: alias })), first);
  assert.equal(store.touch(query).workspace, canonical);
  assert.equal(store.mark({ ...query, status: "archived" }).workspace, canonical);
  store.close();
  store = ctx.open();
  assert.equal(store.assertOwned(query).workspace, canonical);
  assert.equal(store.assertOwned(query).status, "archived");
  assert.throws(() => store.assertOwned({ ...query, profileId: "agent-b" }),
    (error) => error.code === "RUNTIME_SESSION_NOT_OWNED");
  assert.throws(() => store.claim(claimInput({ workspace: alias, profileId: "agent-b" })),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CONFLICT");
  store.close();
});

test("workspace alias 改指其他目录或失效时，不能改写已固定的 ownership", () => {
  const ctx = fixture();
  const root = fs.realpathSync(path.dirname(ctx.paths.stateDir));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const alias = path.join(root, "alias");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.symlinkSync(first, alias);
  const store = ctx.open();
  store.claim(claimInput({ workspace: first }));
  store.claim(claimInput({ sessionId: "legacy-alias-session", workspace: alias }));
  const query = {
    binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session", workspace: alias,
  };
  assert.equal(store.assertOwned(query).workspace, first);
  fs.unlinkSync(alias);
  fs.symlinkSync(second, alias);
  assert.throws(() => store.assertOwned({
    ...query, sessionId: "legacy-alias-session", workspace: second,
  }), (error) => error.code === "RUNTIME_SESSION_NOT_OWNED");
  for (const rejected of [alias, second, null]) {
    assert.throws(() => store.assertOwned({ ...query, workspace: rejected }),
      (error) => error.code === "RUNTIME_SESSION_NOT_OWNED");
    assert.throws(() => store.readRecord({ ...query, workspace: rejected }),
      (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CONFLICT");
    assert.throws(() => store.claim(claimInput({ workspace: rejected })),
      (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CONFLICT");
  }
  fs.unlinkSync(alias);
  fs.symlinkSync(alias, alias);
  assert.throws(() => store.assertOwned(query),
    (error) => error.code === "RUNTIME_SESSION_NOT_OWNED");
  assert.equal(store.assertOwned({ ...query, workspace: first }).workspace, first);
  store.close();
});

test("ownership 持久化、touch 和 archive/delete 状态 fail closed", () => {
  const ctx = fixture();
  let store = ctx.open();
  store.claim(claimInput());
  ctx.tick();
  const touched = store.touch({
    binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session",
  });
  assert.equal(touched.lastSeenAt, 11);
  ctx.tick();
  const archived = store.mark({
    binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session",
    status: "archived",
  });
  assert.equal(archived.status, "archived");
  store.close();

  store = ctx.open();
  assert.deepEqual(store.assertOwned({
    binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session",
  }), archived);
  ctx.tick();
  store.mark({
    binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session",
    status: "deleted",
  });
  assert.throws(
    () => store.assertOwned({
      binding: binding(), profileId: "agent-a", sessionId: "shared-looking-session",
    }),
    (error) => error.code === "RUNTIME_SESSION_NOT_OWNED",
  );
  assert.throws(
    () => store.claim(claimInput()),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_DELETED",
  );
  store.close();

});

test("legacy migration marker 与 deleted ownership 原子持久化且重启幂等", () => {
  const ctx = fixture();
  let store = ctx.open();
  store.claim(claimInput());
  const input = {
    binding: binding(),
    sessionId: "shared-looking-session",
    profileId: "agent-a",
    workspace: "/tmp/workspace-a",
    createdAt: 10,
    lastSeenAt: 10,
    migrationId: "a".repeat(64),
    sessionKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    chatSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    legacyHomeId: `legacy-home-${"c".repeat(64)}-v1`,
    transcriptRevision: 2,
  };
  const marker = store.recordLegacyMigration(input);
  assert.deepEqual(marker, {
    migrationId: input.migrationId,
    sessionKey: input.sessionKey,
    chatSessionId: input.chatSessionId,
    profileId: input.profileId,
    legacyHomeId: input.legacyHomeId,
    legacyRuntimeSessionId: input.sessionId,
    transcriptRevision: input.transcriptRevision,
    migratedAt: 10,
  });
  assert.equal(store.readRecord(input).status, "deleted");
  store.close();

  ctx.tick();
  store = ctx.open();
  assert.deepEqual(store.readLegacyMigration(input), marker);
  assert.deepEqual(store.recordLegacyMigration(input), marker);
  assert.throws(
    () => store.recordLegacyMigration({
      ...input,
      legacyHomeId: `legacy-home-${"d".repeat(64)}-v1`,
    }),
    (error) => error.code === "RUNTIME_SESSION_MIGRATION_CONFLICT",
  );
  assert.throws(
    () => store.claim(claimInput()),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_DELETED",
  );
  store.close();

  const payload = JSON.parse(fs.readFileSync(ctx.paths.runtimeSessionOwnershipPath, "utf8"));
  const [migrationKey] = Object.keys(payload.legacyMigrations);
  payload.legacyMigrations[migrationKey].legacyHomeId = "/tmp/arbitrary-legacy-home";
  fs.writeFileSync(
    ctx.paths.runtimeSessionOwnershipPath,
    JSON.stringify(payload),
    { mode: 0o600 },
  );
  assert.throws(
    () => ctx.open(),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CORRUPT",
  );
});

test("损坏的 key 与 symlink store 都不能被接受", () => {
  const corrupt = fixture();
  let store = corrupt.open();
  store.claim(claimInput());
  store.close();
  const payload = JSON.parse(fs.readFileSync(corrupt.paths.runtimeSessionOwnershipPath, "utf8"));
  const [key] = Object.keys(payload.records);
  payload.records[`${key[0] === "0" ? "1" : "0"}${key.slice(1)}`] = payload.records[key];
  delete payload.records[key];
  fs.writeFileSync(corrupt.paths.runtimeSessionOwnershipPath, JSON.stringify(payload), { mode: 0o600 });
  assert.throws(
    () => corrupt.open(),
    (error) => error.code === "RUNTIME_SESSION_OWNERSHIP_CORRUPT",
  );

  const linked = fixture();
  fs.mkdirSync(linked.paths.runtimeSessionOwnershipDir, { recursive: true, mode: 0o700 });
  const victim = path.join(path.dirname(linked.paths.stateDir), "victim.json");
  fs.writeFileSync(victim, "{}", { mode: 0o600 });
  fs.symlinkSync(victim, linked.paths.runtimeSessionOwnershipPath);
  assert.throws(() => linked.open(), (error) => String(error.code).startsWith("UNSAFE_"));
  assert.equal(fs.readFileSync(victim, "utf8"), "{}");
});

for (const { name, fn } of tests) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`PASS runtime session ownership (${tests.length}/${tests.length})`);
