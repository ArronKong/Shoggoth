"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { AgentFileStore, fileIdFor, filesRoot, sha256, readWorkspaceOutput } = require("../app/agent-service/agent-file-store");
const { filename } = require("../app/agent-service/agent-file-protocol");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-files-")));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const roster = new Map(["owner-a", "owner-b"].map(id => [id, { id, enabled: true }]));
  const store = new AgentFileStore({ paths, productStore: { getAgentProfile: id => roster.get(id) } });
  store.open();
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, roster };
}

const bytes = Buffer.from("Agent private deliverable");
const source = { kind: "chat", runId: "run-a", sourceId: "session-a", sessionKey: "session-a" };
const saveParams = { profileId: "owner-a", operationId: "operation-a", name: "报告.txt",
  mimeType: "text/plain", source, sizeBytes: bytes.length, sha256: sha256(bytes), read: async () => bytes };
const listParams = { profileId: "owner-a", runId: null, sessionKey: null, cursor: 0, limit: 20, includeMissing: true };

test("files use stable IDs and isolated real payloads across concurrent saves, rename, restart and deletion", async t => {
  const { paths, store, roster } = fixture(t);
  const [{ file }, replay] = await Promise.all([store.save(saveParams), store.save(saveParams)]);
  assert.deepEqual(replay.file, file);
  assert.equal(file.fileId, fileIdFor("owner-a", "operation-a"));
  const target = store.get(file).path;
  assert.equal(path.dirname(path.dirname(target)), filesRoot(paths, "owner-a"));
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(store.list({ ...listParams, runId: "run-b" }).items, []);
  assert.deepEqual(store.list({ ...listParams, sessionKey: "session-a" }).items, [file]);
  assert.throws(() => store.get({ ...file, profileId: "owner-b" }), { code: "AGENT_FILE_NOT_FOUND" });
  assert.throws(() => store.save({ ...saveParams, name: "不同文件.txt" }), { code: "AGENT_FILE_CONFLICT" });

  const mutation = { profileId: file.profileId, fileId: file.fileId, name: "成品.txt", expectedRevision: 1 };
  const renamed = store.rename(mutation).file;
  assert.deepEqual(store.rename(mutation).file, renamed);
  assert.equal(renamed.fileId, file.fileId);
  assert.equal(renamed.revision, 2);
  assert.equal(fs.existsSync(target), false);
  const currentPath = store.get(file).path;
  assert.equal(path.basename(currentPath), renamed.name);
  assert.deepEqual(fs.readFileSync(currentPath), bytes);
  assert.throws(() => store.delete({ ...mutation, expectedRevision: 1 }), { code: "AGENT_FILE_CONFLICT" });

  await store.close();
  store.open();
  roster.get("owner-a").enabled = false;
  assert.throws(() => store.get(file), { code: "AGENT_FILE_NOT_FOUND" });
  roster.get("owner-a").enabled = true;
  assert.deepEqual(store.get(file).file, renamed);
  const deleted = store.delete({ ...mutation, expectedRevision: 2 }).file;
  assert.equal(deleted.status, "deleted");
  assert.equal(fs.existsSync(currentPath), false);
  assert.deepEqual(store.list(listParams).items, []);
  assert.deepEqual(store.get(file), { file: deleted, path: null });
  const retry = await store.save({ ...saveParams, read: async () => assert.fail("deleted data cannot be republished by replay") });
  assert.equal(retry.file.status, "deleted");
});

test("restart completes a rename after the file move and keeps missing files visible", async t => {
  const { store } = fixture(t);
  const { file } = await store.save(saveParams);
  const target = store.get(file).path;
  await store.close();
  const index = path.join(path.dirname(target), ".shoggoth-file.json");
  const pending = JSON.parse(fs.readFileSync(index));
  pending.pendingName = "Moved.txt";
  fs.writeFileSync(index, JSON.stringify(pending));
  fs.writeFileSync(`${index}.tmp`, "interrupted metadata write", { mode: 0o600 });
  const destination = path.join(path.dirname(target), pending.pendingName);
  fs.renameSync(target, destination);
  store.open();
  assert.equal(store.get(file).file.revision, 2);
  assert.equal(store.get(file).path, destination);
  assert.equal(fs.existsSync(`${index}.tmp`), false);
  fs.unlinkSync(destination);
  assert.equal(store.list(listParams).items[0].status, "missing");
  assert.deepEqual(store.list({ ...listParams, includeMissing: false }).items, []);
  assert.equal(store.delete({ ...file, expectedRevision: 2 }).file.status, "deleted");
});

test("workspace proof rejects path traversal, aliases, other Agents, and Service authority", async t => {
  const { root, paths, store } = fixture(t);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "result.txt"), bytes);
  fs.symlinkSync(path.join(workspace, "result.txt"), path.join(workspace, "alias.txt"));
  const read = (relativePath, cwd = workspace) => readWorkspaceOutput(paths, { profileId: "owner-a", workspace: cwd, relativePath });
  assert.deepEqual(await read("result.txt"), bytes);
  for (const relative of ["../secret", "/result.txt", "alias.txt", "a/../result.txt"]) {
    await assert.rejects(read(relative), { code: "AGENT_FILE_INVALID" });
  }
  await store.save(saveParams);
  const file = store.list(listParams).items[0];
  const target = store.get(file).path;
  await assert.rejects(read(path.basename(target), path.dirname(target)), { code: "AGENT_FILE_INVALID" });
  const ownerB = path.join(paths.defaultWorkspaceDir, "owner-b");
  fs.mkdirSync(ownerB, { recursive: true });
  fs.writeFileSync(path.join(ownerB, "result.txt"), bytes);
  await assert.rejects(read("result.txt", ownerB), { code: "AGENT_FILE_INVALID" });
  for (const name of ["../outside.txt", ".hidden", "a/b.txt", "a:b", "x".repeat(201)]) {
    assert.throws(() => filename(name), { code: "AGENT_FILE_INVALID" });
  }
});
