"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

function item(id = "memory-1") {
  return { id, profileId: "profile-1", scope: "user", type: "semantic",
    content: "用户偏好中文交流", sourceRefs: ["event-1", "run-1"], confidence: 1,
    sensitivity: "normal", status: "active", validFrom: 1, validUntil: null,
    supersedes: null, createdAt: 1, updatedAt: 1 };
}

function faultedFs(mode) {
  let armed = false;
  let failed = false;
  return {
    fs: {
      ...fs,
      writeSync(fd, buffer, offset, length, position) {
        if (mode === "partial-write" && armed && !failed) {
          failed = true;
          fs.writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
          throw new Error("injected partial journal write");
        }
        return fs.writeSync(fd, buffer, offset, length, position);
      },
      fsyncSync(fd) {
        fs.fsyncSync(fd);
        if (mode === "after-fsync" && armed && !failed) {
          failed = true;
          throw new Error("injected error after durable journal fsync");
        }
      },
      closeSync(fd) {
        fs.closeSync(fd);
        if (mode === "after-close" && armed && !failed) {
          failed = true;
          throw new Error("injected error after journal close");
        }
      },
    },
    arm() { armed = true; },
    disarm() { armed = false; },
    didFail() { return failed; },
  };
}

for (const mode of ["after-fsync", "partial-write", "after-close"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-memory-journal-"));
  fs.chmodSync(root, 0o700);
  const paths = { agentsDir: path.join(root, "agents"), trustedRoot: root };
  const fault = faultedFs(mode);
  const store = new MemoryStore({ paths, fs: fault.fs });
  try {
    store.open();
    assert.equal(store.getRevision("profile-1"), 0);
    fault.arm();
    assert.throws(() => store.upsert(item()), (error) =>
      error.code === "MEMORY_COMMIT_UNCERTAIN" && error.committedUncertain === true);
    assert.equal(fault.didFail(), true);
    fault.disarm();
    // No read may observe the stale cached revision and no retry may append
    // a duplicate seq before journal replay has established the outcome.
    assert.throws(() => store.getRevision("profile-1"), { code: "MEMORY_COMMIT_UNCERTAIN" });
    assert.throws(() => store.get("profile-1", "memory-1"), { code: "MEMORY_COMMIT_UNCERTAIN" });
    assert.throws(() => store.upsert(item()), { code: "MEMORY_COMMIT_UNCERTAIN" });
    store.forgetProfile("profile-1");
    assert.throws(() => store.getRevision("profile-1"), { code: "MEMORY_COMMIT_UNCERTAIN" },
      "dropping a Profile cache must not clear its uncertain commit");
    assert.equal(store.getRevision("healthy-profile"), 0);
    store.close(); store.open();
    assert.equal(store.getRevision("profile-1"), mode === "partial-write" ? 0 : 1);
    if (mode === "partial-write") assert.equal(store.get("profile-1", "memory-1"), null);
    store.upsert(item());
    assert.equal(store.getRevision("profile-1"), 1);
    assert.deepEqual(store.get("profile-1", "memory-1"), item());
    store.close(); store.open();
    assert.equal(store.getRevision("profile-1"), 1);
    const log = path.join(paths.agentsDir, "profile-1", "memory", "events.jsonl");
    assert.equal(fs.readFileSync(log, "utf8").trimEnd().split("\n").length, 1,
      "verified replay and retry must leave exactly one journal sequence");
    console.log(`PASS MemoryStore ${mode} uncertainty requires verified replay`);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-memory-corrupt-journal-"));
  fs.chmodSync(root, 0o700);
  const paths = { agentsDir: path.join(root, "agents"), trustedRoot: root };
  const fault = faultedFs("after-fsync");
  const store = new MemoryStore({ paths, fs: fault.fs });
  try {
    store.open(); store.getRevision("profile-1"); fault.arm();
    assert.throws(() => store.upsert(item()), { code: "MEMORY_COMMIT_UNCERTAIN" });
    fault.disarm();
    const log = path.join(paths.agentsDir, "profile-1", "memory", "events.jsonl");
    fs.appendFileSync(log, '{"invalid":true}\n');
    store.close(); store.open();
    assert.throws(() => store.getRevision("profile-1"), { code: "MEMORY_LOG_CORRUPT" },
      "a complete but invalid journal row must not be treated as an incomplete tail");
    console.log("PASS complete corrupt journal line fails closed after uncertain append");
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const value = memoryFixture();
  try {
    const saved = value.engine.propose({ profileId: "profile-1", scope: "user", type: "semantic",
      content: "用户偏好中文交流", sourceRefs: ["event-1", "run-1"], classification: "explicit" });
    const fault = faultedFs("partial-write");
    value.store.fs = fault.fs;
    fault.arm();
    assert.throws(() => value.engine.delete({ profileId: "profile-1", id: saved.id,
      reason: "forgotten", operationId: "forget-after-intent" }),
    { code: "MEMORY_COMMIT_UNCERTAIN" });
    fault.disarm();
    assert.throws(() => value.store.get("profile-1", saved.id),
      { code: "MEMORY_COMMIT_UNCERTAIN" });
    value.close();
    value.definitions.open(); value.store.open(); value.engine.open(["profile-1"]);
    assert.equal(value.store.get("profile-1", saved.id).status, "deleted",
      "the durable withdrawal intent must finish deletion after journal replay");
    assert.equal(value.engine.search({ profileId: "profile-1", query: "中文交流" }).items.length, 0);
    console.log("PASS forgotten intent survives uncertain primary journal append");
  } finally { value.cleanup(); }
}

console.log("PASS MemoryStore journal append uncertainty regression");
