#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app/agent-service/paths"));
const {
  LOCAL_CRYPTO_KEY_BYTES,
  createLocalFileSafeStorage,
  localCryptoKeyPath,
} = require(path.join(ROOT, "app/agent-service/local-file-safe-storage"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths(prefix = "shoggoth-local-crypto-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

function deterministicRandom(keyByte = 0x11) {
  let nonce = 0x30;
  return (bytes) => {
    if (bytes === LOCAL_CRYPTO_KEY_BYTES) return Buffer.alloc(bytes, keyByte);
    nonce += 1;
    return Buffer.alloc(bytes, nonce);
  };
}

test("本地签名加密创建 0600 单链接主密钥并完成 AES-GCM roundtrip", () => {
  const paths = fixturePaths();
  const storage = createLocalFileSafeStorage({ paths, randomBytes: deterministicRandom() });
  const ciphertext = storage.encryptString("shoggoth-local-secret");
  assert.equal(ciphertext.includes(Buffer.from("shoggoth-local-secret", "utf8")), false);
  assert.equal(storage.decryptString(ciphertext), "shoggoth-local-secret");

  const keyStat = fs.lstatSync(localCryptoKeyPath(paths));
  assert.equal(keyStat.isFile(), true);
  assert.equal(keyStat.isSymbolicLink(), false);
  assert.equal(keyStat.size, LOCAL_CRYPTO_KEY_BYTES);
  assert.equal(keyStat.nlink, 1);
  assert.equal(keyStat.mode & 0o777, 0o600);
  storage.close();
});

test("同一明文每次使用新 nonce，重开 worker 后沿用同一主密钥", () => {
  const paths = fixturePaths();
  const first = createLocalFileSafeStorage({ paths, randomBytes: deterministicRandom(0x21) });
  const ciphertextA = first.encryptString("same-plaintext");
  const ciphertextB = first.encryptString("same-plaintext");
  assert.equal(ciphertextA.equals(ciphertextB), false);
  first.close();

  const reopened = createLocalFileSafeStorage({
    paths,
    randomBytes() { throw new Error("existing key decrypt must not request randomness"); },
  });
  assert.equal(reopened.decryptString(ciphertextA), "same-plaintext");
  reopened.close();
});

test("篡改、截断与错误主密钥全部 fail closed", () => {
  const paths = fixturePaths();
  const storage = createLocalFileSafeStorage({ paths, randomBytes: deterministicRandom(0x31) });
  const ciphertext = storage.encryptString("authenticated-payload");

  const tampered = Buffer.from(ciphertext);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => storage.decryptString(tampered));
  assert.throws(() => storage.decryptString(ciphertext.subarray(0, 20)));

  const otherPaths = fixturePaths();
  const other = createLocalFileSafeStorage({
    paths: otherPaths,
    randomBytes: deterministicRandom(0x41),
  });
  assert.throws(() => other.decryptString(ciphertext));
  storage.close();
  other.close();
});

test("密钥权限过宽、hardlink 与 symlink 均拒绝，且不会改写 symlink 目标", () => {
  const permissionPaths = fixturePaths();
  createLocalFileSafeStorage({
    paths: permissionPaths,
    randomBytes: deterministicRandom(0x51),
  }).close();
  fs.chmodSync(localCryptoKeyPath(permissionPaths), 0o644);
  assert.throws(() => createLocalFileSafeStorage({
    paths: permissionPaths,
    randomBytes: deterministicRandom(0x52),
  }));

  const hardlinkPaths = fixturePaths();
  createLocalFileSafeStorage({
    paths: hardlinkPaths,
    randomBytes: deterministicRandom(0x61),
  }).close();
  fs.linkSync(localCryptoKeyPath(hardlinkPaths), `${localCryptoKeyPath(hardlinkPaths)}.link`);
  assert.throws(() => createLocalFileSafeStorage({
    paths: hardlinkPaths,
    randomBytes: deterministicRandom(0x62),
  }));

  const symlinkPaths = fixturePaths();
  const keyPath = localCryptoKeyPath(symlinkPaths);
  createLocalFileSafeStorage({
    paths: symlinkPaths,
    randomBytes: deterministicRandom(0x71),
  }).close();
  const victim = path.join(symlinkPaths.stateDir, "victim.bin");
  const victimBytes = Buffer.from("do-not-overwrite", "utf8");
  fs.writeFileSync(victim, victimBytes, { mode: 0o600 });
  fs.unlinkSync(keyPath);
  fs.symlinkSync(victim, keyPath);
  assert.throws(() => createLocalFileSafeStorage({
    paths: symlinkPaths,
    randomBytes: deterministicRandom(0x72),
  }));
  assert.deepEqual(fs.readFileSync(victim), victimBytes);
});

test("close 后立即清零可用状态并拒绝继续加解密", () => {
  const paths = fixturePaths();
  const storage = createLocalFileSafeStorage({ paths, randomBytes: deterministicRandom(0x81) });
  const ciphertext = storage.encryptString("close-probe");
  storage.close();
  assert.equal(storage.isEncryptionAvailable(), false);
  assert.throws(() => storage.encryptString("closed"));
  assert.throws(() => storage.decryptString(ciphertext));
});

(async () => {
  for (const entry of tests) {
    await entry.fn();
    process.stdout.write(`PASS ${entry.name}\n`);
  }
  process.stdout.write(`${tests.length} local file safeStorage checks passed.\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
