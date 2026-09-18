#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
let EncryptedSecretStore;
let MAX_ENCRYPTED_SECRET_FILE_BYTES;
let validateContainer;
let moduleLoadError = null;
try {
  ({ EncryptedSecretStore, MAX_ENCRYPTED_SECRET_FILE_BYTES, validateContainer } = require(path.join(
    ROOT, "app", "agent-service", "encrypted-secret-store.js",
  )));
} catch (error) {
  moduleLoadError = error;
}
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("EncryptedSecretStore 模块可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof EncryptedSecretStore, "function");
});

function fixturePaths(prefix = "shoggoth-secret-store-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

function xorCipher(value) {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0xa5;
  return bytes;
}

function fakeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => xorCipher(value),
    decryptString: (bytes) => xorCipher(Buffer.from(bytes)).toString("utf8"),
    ...overrides,
  };
}

function openStore(paths, options = {}) {
  const store = new EncryptedSecretStore({ paths, safeStorage: fakeSafeStorage(), ...options });
  store.ready = store.open();
  return store;
}

function mode(target) { return fs.statSync(target).mode & 0o777; }

test("paths 固定 encrypted-secrets.json，容器只含版本/revision/kind/base64 密文且权限私有", async () => {
  const paths = fixturePaths();
  assert.equal(paths.encryptedSecretsPath, path.join(paths.stateDir, "encrypted-secrets.json"));
  const canary = "custom-provider-secret-canary-0123456789";
  const store = openStore(paths);
  const result = await store.put("credential-openrouter", canary, { kind: "openrouter" });
  assert.deepEqual(result, { credentialRef: "credential-openrouter", kind: "openrouter", revision: 1 });
  const container = JSON.parse(fs.readFileSync(paths.encryptedSecretsPath, "utf8"));
  assert.deepEqual(Object.keys(container), ["version", "revision", "credentials"]);
  assert.equal(container.version, 1);
  assert.equal(container.revision, 1);
  assert.deepEqual(Object.keys(container.credentials["credential-openrouter"]), ["kind", "ciphertext"]);
  assert.equal(container.credentials["credential-openrouter"].kind, "openrouter");
  assert.match(container.credentials["credential-openrouter"].ciphertext, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(canary), false);
  assert.equal(mode(paths.stateDir), 0o700);
  assert.equal(mode(paths.encryptedSecretsPath), 0o600);
  await store.close();
});

test("restart、rotation、delete 保持密文容器 revision 单调且 matcher cache 随 close 清理", async () => {
  const paths = fixturePaths();
  const first = openStore(paths);
  await first.put("credential-a", "secret-value-a-0001", { kind: "custom-responses" });
  await first.put("credential-a", "secret-value-a-0002", { kind: "custom-responses" });
  await first.put("credential-b", "secret-value-b-0001", { kind: "ollama" });
  assert.equal(await first.get("credential-a"), "secret-value-a-0002");
  assert.deepEqual(first.listMetadata(), [
    { credentialRef: "credential-a", kind: "custom-responses" },
    { credentialRef: "credential-b", kind: "ollama" },
  ]);
  await first.close();

  const second = openStore(paths);
  await second.ready;
  assert.equal(await second.get("credential-a"), "secret-value-a-0002");
  assert.equal(await second.delete("credential-a"), true);
  assert.equal(await second.delete("credential-missing"), false);
  assert.equal(await second.get("credential-a"), null);
  assert.equal(await second.get("credential-b"), "secret-value-b-0001");
  await second.close();
  const container = JSON.parse(fs.readFileSync(paths.encryptedSecretsPath, "utf8"));
  assert.equal(container.revision, 4);
  assert.deepEqual(Object.keys(container.credentials), ["credential-b"]);
  const disk = JSON.stringify(container);
  assert.equal(disk.includes("secret-value-a"), false);
  assert.equal(disk.includes("secret-value-b"), false);
});

test("matchesPlaintext 动态匹配当前密文，restart/rotation/delete 生效且 locked fail closed", async () => {
  const paths = fixturePaths();
  const first = openStore(paths);
  const oldValue = "ordinary-dynamic-canary-one";
  const newValue = "ordinary-dynamic-canary-two";
  await first.put("credential-dynamic", oldValue, { kind: "openrouter" });
  assert.equal(first.matchesPlaintext(`prefix-${oldValue}-suffix`), true);
  assert.equal(first.matchesPlaintext("ordinary-safe-provider-name"), false);
  await first.close();

  const second = openStore(paths);
  await second.ready;
  assert.equal(second.matchesPlaintext(oldValue), true);
  await second.put("credential-dynamic", newValue, { kind: "openrouter" });
  assert.equal(second.matchesPlaintext(oldValue), false);
  assert.equal(second.matchesPlaintext(`prefix-${newValue}-suffix`), true);
  await second.delete("credential-dynamic");
  assert.equal(second.matchesPlaintext(newValue), false);
  await second.close();

  const lockedPaths = fixturePaths("shoggoth-secret-matcher-locked-");
  const unlocked = openStore(lockedPaths);
  await unlocked.put("credential-locked-match", oldValue, { kind: "openrouter" });
  await unlocked.close();
  const locked = new EncryptedSecretStore({
    paths: lockedPaths,
    safeStorage: fakeSafeStorage({ decryptString() { throw new Error(oldValue); } }),
  });
  await locked.open();
  assert.throws(
    () => locked.matchesPlaintext("ordinary-safe-provider-name"),
    (error) => error.code === "credentials_locked"
      && error.message === "credentials_locked"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(oldValue),
  );
  await locked.close();
});

test("withPlaintextMatcher 使用 open 期 cache，操作结束后 escaped matcher 立即失效", async () => {
  const paths = fixturePaths("shoggoth-secret-match-session-");
  let decryptCalls = 0;
  const storage = fakeSafeStorage({
    decryptString(bytes) {
      decryptCalls += 1;
      return xorCipher(Buffer.from(bytes)).toString("utf8");
    },
  });
  const writer = openStore(paths, { safeStorage: storage });
  await writer.put("credential-session-a", "ordinary-session-secret-a", { kind: "openrouter" });
  await writer.put("credential-session-b", "ordinary-session-secret-b", { kind: "custom-responses" });
  await writer.close();
  const store = openStore(paths, { safeStorage: storage });
  await store.ready;
  let escapedMatcher;
  const matched = store.withPlaintextMatcher((matches) => {
    escapedMatcher = matches;
    for (let index = 0; index < 100; index += 1) {
      assert.equal(matches(`ordinary-safe-${index}`), false);
    }
    return matches("prefix-ordinary-session-secret-b-suffix");
  });
  assert.equal(matched, true);
  assert.equal(decryptCalls, 2);
  assert.throws(
    () => escapedMatcher("ordinary-session-secret-a"),
    (error) => error.code === "SECRET_MATCHER_CLOSED",
  );
  await store.close();
});

test("safeStorage unavailable/decrypt failure 固定返回 credentials_locked，不崩溃且不泄露值", async () => {
  const paths = fixturePaths();
  const canary = "locked-secret-canary-00000001";
  const first = openStore(paths);
  await first.put("credential-locked", canary, { kind: "openrouter" });
  await first.close();

  const locked = new EncryptedSecretStore({
    paths,
    safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
  });
  await locked.open();
  await assert.rejects(
    locked.get("credential-locked"),
    (error) => error.code === "credentials_locked"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  await assert.rejects(
    locked.put("credential-new", canary, { kind: "openrouter" }),
    (error) => error.code === "credentials_locked"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  assert.deepEqual(locked.listMetadata(), [{ credentialRef: "credential-locked", kind: "openrouter" }]);
  await locked.close();

  const broken = new EncryptedSecretStore({
    paths,
    safeStorage: fakeSafeStorage({ decryptString() { throw new Error(canary); } }),
  });
  await broken.open();
  await assert.rejects(
    broken.get("credential-locked"),
    (error) => error.code === "credentials_locked"
      && error.message === "credentials_locked"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  await broken.close();
  assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(canary), false);
});

test("只允许进程级 Provider secret，拒绝 ChatGPT account auth 与 AWS secret", async () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  for (const kind of ["chatgpt", "amazon-bedrock", "account-auth", "aws-secret"]) {
    await assert.rejects(
      store.put(`credential-${kind}`, "forbidden-secret-canary-0001", { kind }),
      (error) => error.code === "SECRET_KIND_FORBIDDEN"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("forbidden-secret-canary-0001"),
    );
  }
  for (const kind of ["openai-api-key", "openrouter", "ollama", "lmstudio", "custom-responses"]) {
    assert.equal((await store.put(`credential-${kind}`, `allowed-${kind}-secret-0001`, { kind })).kind, kind);
  }
  await store.close();
  const disk = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
  assert.equal(disk.includes("forbidden-secret-canary"), false);
  assert.equal(disk.includes("allowed-openrouter-secret"), false);
});

test("并发 put 严格串行，revision 单调且所有成功项都进入最终原子容器", async () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => store.put(
    `credential-concurrent-${index}`,
    `concurrent-secret-${String(index).padStart(2, "0")}-00000000`,
    { kind: "custom-responses" },
  )));
  assert.deepEqual(results.map((result) => result.revision), Array.from({ length: 24 }, (_, index) => index + 1));
  const container = JSON.parse(fs.readFileSync(paths.encryptedSecretsPath, "utf8"));
  assert.equal(container.revision, 24);
  assert.equal(Object.keys(container.credentials).length, 24);
  for (let index = 0; index < 24; index += 1) {
    assert.equal(await store.get(`credential-concurrent-${index}`), `concurrent-secret-${String(index).padStart(2, "0")}-00000000`);
  }
  await store.close();
});

test("短写会完整循环，写入按 file fsync→rename→dir fsync 顺序提交", async () => {
  const paths = fixturePaths();
  const order = [];
  const partialFs = Object.create(fs);
  partialFs.writeSync = (fd, bytes, offset, length, position) => fs.writeSync(
    fd, bytes, offset, Math.min(length, 7), position,
  );
  partialFs.fsyncSync = (fd) => {
    order.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    return fs.fsyncSync(fd);
  };
  partialFs.renameSync = (source, target) => {
    order.push("rename");
    return fs.renameSync(source, target);
  };
  const store = openStore(paths, { fs: partialFs });
  await store.put("credential-partial", "partial-secret-canary-0000001", { kind: "openrouter" });
  assert.deepEqual(order.slice(-3), ["file", "rename", "directory"]);
  assert.equal(await store.get("credential-partial"), "partial-secret-canary-0000001");
  await store.close();
});

test("rename 失败保留旧容器，错误与 temp 都不泄露 plaintext", async () => {
  const paths = fixturePaths();
  let failRename = false;
  const renameFs = Object.create(fs);
  renameFs.renameSync = (source, target) => {
    if (failRename) throw Object.assign(new Error("rename fixture failed"), { code: "EIO" });
    return fs.renameSync(source, target);
  };
  const store = openStore(paths, { fs: renameFs });
  await store.put("credential-atomic", "atomic-old-secret-00000001", { kind: "openrouter" });
  const before = fs.readFileSync(paths.encryptedSecretsPath);
  failRename = true;
  const canary = "atomic-new-secret-00000002";
  await assert.rejects(
    store.put("credential-atomic", canary, { kind: "openrouter" }),
    (error) => error.code === "SECRET_WRITE_FAILED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  assert.deepEqual(fs.readFileSync(paths.encryptedSecretsPath), before);
  assert.equal(fs.existsSync(`${paths.encryptedSecretsPath}.tmp`), false);
  assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8").includes(canary), false);
  await store.close();
});

test("首次写 rename 后 dir fsync 失败会删除新文件并持久化 rollback", async () => {
  const paths = fixturePaths("shoggoth-secret-first-dir-fsync-");
  let failCommitFsync = true;
  const faultFs = Object.create(fs);
  faultFs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && failCommitFsync) {
      failCommitFsync = false;
      throw Object.assign(new Error("first commit dir fsync failed"), { code: "EIO" });
    }
    return fs.fsyncSync(fd);
  };
  const store = openStore(paths, { fs: faultFs });
  await assert.rejects(
    store.put("credential-first-fsync", "ordinary-first-fsync-canary", { kind: "openrouter" }),
    (error) => error.code === "SECRET_WRITE_FAILED",
  );
  assert.equal(fs.existsSync(paths.encryptedSecretsPath), false);
  assert.deepEqual(
    fs.readdirSync(paths.stateDir).filter((name) => name.includes("encrypted-secrets.json")),
    [],
  );
  assert.equal((await store.put(
    "credential-first-fsync", "ordinary-first-fsync-retry", { kind: "openrouter" },
  )).revision, 1);
  await store.close();
});

test("替换写 rename 后 dir fsync 失败会恢复旧 inode/revision 并清理 backup", async () => {
  const paths = fixturePaths("shoggoth-secret-replace-dir-fsync-");
  let failCommitFsync = false;
  const faultFs = Object.create(fs);
  faultFs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && failCommitFsync) {
      failCommitFsync = false;
      throw Object.assign(new Error("replace commit dir fsync failed"), { code: "EIO" });
    }
    return fs.fsyncSync(fd);
  };
  const store = openStore(paths, { fs: faultFs });
  await store.put("credential-replace-fsync", "ordinary-replace-old", { kind: "openrouter" });
  const before = fs.readFileSync(paths.encryptedSecretsPath);
  const beforeIno = fs.statSync(paths.encryptedSecretsPath).ino;
  failCommitFsync = true;
  await assert.rejects(
    store.put("credential-replace-fsync", "ordinary-replace-new", { kind: "openrouter" }),
    (error) => error.code === "SECRET_WRITE_FAILED",
  );
  assert.deepEqual(fs.readFileSync(paths.encryptedSecretsPath), before);
  assert.equal(fs.statSync(paths.encryptedSecretsPath).ino, beforeIno);
  assert.equal(await store.get("credential-replace-fsync"), "ordinary-replace-old");
  assert.deepEqual(
    fs.readdirSync(paths.stateDir).filter((name) => name.includes(".backup-")),
    [],
  );
  await store.close();
});

test("dir fsync 后 rollback 也失败时抛 committed-uncertain aggregate 并锁定 Store 保留证据", async () => {
  const paths = fixturePaths("shoggoth-secret-rollback-failure-");
  let injectFailure = false;
  const canary = "ordinary-rollback-uncertain-canary";
  const faultFs = Object.create(fs);
  faultFs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && injectFailure) {
      injectFailure = false;
      throw Object.assign(new Error("commit fsync failed"), { code: "EIO" });
    }
    return fs.fsyncSync(fd);
  };
  faultFs.renameSync = (source, target) => {
    if (source.includes(".backup-") && target === paths.encryptedSecretsPath) {
      throw Object.assign(new Error("rollback rename failed"), { code: "EIO" });
    }
    return fs.renameSync(source, target);
  };
  const store = openStore(paths, { fs: faultFs });
  await store.put("credential-uncertain", "ordinary-rollback-old", { kind: "openrouter" });
  injectFailure = true;
  await assert.rejects(
    store.put("credential-uncertain", canary, { kind: "openrouter" }),
    (error) => error instanceof AggregateError
      && error.code === "SECRET_COMMIT_UNCERTAIN"
      && error.committedUncertain === true
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  assert.equal(fs.existsSync(`${paths.encryptedSecretsPath}.tmp`), false);
  assert.equal(fs.readdirSync(paths.stateDir).filter((name) => name.includes(".backup-")).length, 1);
  for (const action of [
    () => store.matchesPlaintext("ordinary-safe-name"),
    () => store.listMetadata(),
    () => store.get("credential-uncertain"),
    () => store.put("credential-after-uncertain", "ordinary-after-uncertain", { kind: "openrouter" }),
    () => store.delete("credential-uncertain"),
  ]) assert.throws(action, (error) => error.code === "credentials_locked");
  await store.close();

  const reopened = new EncryptedSecretStore({ paths, safeStorage: fakeSafeStorage() });
  reopened.open();
  assert.throws(
    () => reopened.listMetadata(),
    (error) => error.code === "credentials_locked",
  );
  await reopened.close();
});

test("真实子进程在 target→backup hardlink 后崩溃，next open 窄恢复旧 inode 并可继续写", async () => {
  const paths = fixturePaths("shoggoth-secret-hardlink-crash-");
  const first = openStore(paths);
  await first.put("credential-crash", "ordinary-hardlink-old", { kind: "openrouter" });
  await first.close();
  const beforeIno = fs.statSync(paths.encryptedSecretsPath).ino;
  const helper = `
    const fs = require("node:fs");
    const { atomicWritePrivateFile } = require(${JSON.stringify(path.join(ROOT, "app", "agent-service", "private-file.js"))});
    const target = ${JSON.stringify(paths.encryptedSecretsPath)};
    const wrapped = Object.create(fs);
    wrapped.linkSync = (source, backup) => { fs.linkSync(source, backup); process.exit(91); };
    atomicWritePrivateFile(target, ${JSON.stringify('{"crash":"new"}\n')}, {
      fs: wrapped,
      trustedRoot: ${JSON.stringify(paths.trustedRoot)},
    });
  `;
  const crashed = spawnSync(process.execPath, ["-e", helper], { encoding: "utf8", timeout: 5_000 });
  assert.equal(crashed.status, 91, crashed.stderr);
  const crashNames = fs.readdirSync(paths.stateDir);
  assert.equal(crashNames.filter((name) => name.includes(".backup-")).length, 1);
  assert.equal(fs.statSync(paths.encryptedSecretsPath).nlink, 2);
  assert.equal(fs.existsSync(`${paths.encryptedSecretsPath}.tmp`), true);

  const recovered = openStore(paths);
  assert.equal(fs.statSync(paths.encryptedSecretsPath).ino, beforeIno);
  assert.equal(fs.statSync(paths.encryptedSecretsPath).nlink, 1);
  assert.equal(await recovered.get("credential-crash"), "ordinary-hardlink-old");
  assert.equal(fs.readdirSync(paths.stateDir).some((name) => name.includes(".backup-")), false);
  assert.equal(fs.existsSync(`${paths.encryptedSecretsPath}.tmp`), false);
  assert.equal((await recovered.put(
    "credential-after-crash", "ordinary-hardlink-after", { kind: "openrouter" },
  )).revision, 2);
  await recovered.close();
});

test("无 backup 的私有单 link 固定 temp 在 next open 前按未提交事务清理", async () => {
  const paths = fixturePaths("shoggoth-secret-orphan-temp-");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const tempPath = `${paths.encryptedSecretsPath}.tmp`;
  const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  fs.writeFileSync(fd, '{"partial":"uncommitted"}\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  const recovered = openStore(paths);
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal((await recovered.put(
    "credential-after-orphan", "ordinary-after-orphan", { kind: "openrouter" },
  )).revision, 1);
  await recovered.close();
});

test("密文容器 read/schema 共用 16MiB hard gate，接近边界合法而超界拒绝", async () => {
  assert.equal(MAX_ENCRYPTED_SECRET_FILE_BYTES, 16 * 1024 * 1024);
  const ciphertext = Buffer.alloc(64 * 1024, 0xa7).toString("base64");
  const containerWith = (count) => {
    const credentials = {};
    for (let index = 0; index < count; index += 1) {
      credentials[`credential-boundary-${index}`] = { kind: "openrouter", ciphertext };
    }
    return { version: 1, revision: count, credentials };
  };
  const within = containerWith(191);
  const withinBytes = Buffer.from(`${JSON.stringify(within)}\n`);
  assert.equal(withinBytes.length <= MAX_ENCRYPTED_SECRET_FILE_BYTES, true);
  assert.equal(Object.keys(validateContainer(within).credentials).length, 191);
  const paths = fixturePaths("shoggoth-secret-capacity-read-");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.encryptedSecretsPath, withinBytes, { mode: 0o600 });
  const reopened = openStore(paths);
  assert.equal(reopened.listMetadata().length, 191);
  await reopened.close();

  const oversized = containerWith(192);
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(oversized)}\n`) > MAX_ENCRYPTED_SECRET_FILE_BYTES,
    true,
  );
  assert.throws(
    () => validateContainer(oversized),
    (error) => error.code === "SECRET_STORE_CAPACITY",
  );
});

test("当前进程 serialize 后写前精确 hard gate，超限失败保留旧文件与内存 revision", async () => {
  const paths = fixturePaths("shoggoth-secret-capacity-write-");
  const hugeSafeStorage = fakeSafeStorage({
    encryptString(value) {
      return Buffer.alloc(6 * 1024 * 1024, value.charCodeAt(0));
    },
  });
  const store = openStore(paths, { safeStorage: hugeSafeStorage });
  assert.equal((await store.put(
    "credential-capacity-a", "ordinary-capacity-a", { kind: "openrouter" },
  )).revision, 1);
  const before = fs.readFileSync(paths.encryptedSecretsPath);
  const canary = "ordinary-capacity-b";
  await assert.rejects(
    store.put("credential-capacity-b", canary, { kind: "openrouter" }),
    (error) => error.code === "SECRET_STORE_CAPACITY"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  assert.deepEqual(fs.readFileSync(paths.encryptedSecretsPath), before);
  assert.deepEqual(store.listMetadata(), [
    { credentialRef: "credential-capacity-a", kind: "openrouter" },
  ]);
  assert.equal(fs.readdirSync(paths.stateDir).some((name) => name.includes(".tmp")), false);
  await store.close();
});

test("final/temp symlink、hardlink、非普通文件与过宽权限均 fail closed", async () => {
  const finalCases = ["symlink", "hardlink", "directory", "permissions"];
  for (const kind of finalCases) {
    const paths = fixturePaths(`shoggoth-secret-final-${kind}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const victim = path.join(path.dirname(paths.stateDir), `victim-${kind}`);
    fs.writeFileSync(victim, "victim-secret-evidence", { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(victim, paths.encryptedSecretsPath);
    else if (kind === "hardlink") fs.linkSync(victim, paths.encryptedSecretsPath);
    else if (kind === "directory") fs.mkdirSync(paths.encryptedSecretsPath, { mode: 0o700 });
    else fs.writeFileSync(paths.encryptedSecretsPath, "{}", { mode: 0o644 });
    await assert.rejects(
      openStore(paths).ready,
      (error) => ["UNSAFE_SYMLINK", "UNSAFE_HARDLINK", "UNSAFE_PATH", "UNSAFE_PERMISSIONS"].includes(error.code),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "victim-secret-evidence");
  }

  for (const kind of ["symlink", "hardlink", "directory"]) {
    const paths = fixturePaths(`shoggoth-secret-temp-${kind}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const victim = path.join(path.dirname(paths.stateDir), `temp-victim-${kind}`);
    fs.writeFileSync(victim, "temp-victim-evidence", { mode: 0o600 });
    const temp = `${paths.encryptedSecretsPath}.tmp`;
    if (kind === "symlink") fs.symlinkSync(victim, temp);
    else if (kind === "hardlink") fs.linkSync(victim, temp);
    else fs.mkdirSync(temp, { mode: 0o700 });
    await assert.rejects(
      openStore(paths).ready,
      (error) => ["UNSAFE_SYMLINK", "UNSAFE_HARDLINK", "UNSAFE_PATH"].includes(error.code),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "temp-victim-evidence");
  }
});

test("父路径 symlink 与 uid 不符均在读取/写入前拒绝", async () => {
  const linkedPaths = fixturePaths("shoggoth-secret-parent-link-");
  const realState = path.join(path.dirname(linkedPaths.stateDir), "real-state");
  fs.mkdirSync(realState, { mode: 0o700 });
  fs.symlinkSync(realState, linkedPaths.stateDir);
  await assert.rejects(
    openStore(linkedPaths).ready,
    (error) => error.code === "UNSAFE_SYMLINK",
  );

  if (typeof process.getuid !== "function") return;
  const ownerPaths = fixturePaths("shoggoth-secret-owner-");
  const first = openStore(ownerPaths);
  await first.put("credential-owner", "owner-secret-canary-0000001", { kind: "openrouter" });
  await first.close();
      const ownerFs = Object.create(fs);
      ownerFs.lstatSync = (target) => {
        const stat = fs.lstatSync(target);
        if (target !== ownerPaths.encryptedSecretsPath) return stat;
        return new Proxy(stat, {
          get(original, property) {
            if (property === "uid") return process.getuid() + 1;
            const value = Reflect.get(original, property, original);
            return typeof value === "function" ? value.bind(original) : value;
          },
        });
      };
      await assert.rejects(
        openStore(ownerPaths, { fs: ownerFs }).ready,
        (error) => error.code === "UNSAFE_OWNER",
      );
});

test("损坏/未知字段/非规范 base64 容器拒绝且不重写证据", async () => {
  const invalidContainers = [
    { version: 2, revision: 0, credentials: {} },
    { version: 1, revision: -1, credentials: {} },
    { version: 1, revision: 0, credentials: {}, extra: true },
    { version: 1, revision: 1, credentials: { "credential-x": { kind: "openrouter", ciphertext: "***" } } },
    { version: 1, revision: 1, credentials: { "credential-x": { kind: "chatgpt", ciphertext: "YWJj" } } },
    { version: 1, revision: 1, credentials: { "credential-x": { kind: "openrouter", ciphertext: "YWJj", extra: true } } },
  ];
  for (const [index, container] of invalidContainers.entries()) {
    const paths = fixturePaths(`shoggoth-secret-corrupt-${index}-`);
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const evidence = `${JSON.stringify(container)}\n`;
    fs.writeFileSync(paths.encryptedSecretsPath, evidence, { mode: 0o600 });
    await assert.rejects(
      openStore(paths).ready,
      (error) => error.code === "SECRET_STORE_CORRUPT",
    );
    assert.equal(fs.readFileSync(paths.encryptedSecretsPath, "utf8"), evidence);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`PASS codex secret store unit (${tests.length})`);
})();
