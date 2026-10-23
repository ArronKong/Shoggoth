"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  ANTIGRAVITY_ACP_SERVER_VERSION,
  antigravityAcpInstallState,
  installAntigravityAcpServer,
  resolveAntigravityAcpServer,
  verifyAntigravityAcpServer,
} = require("../app/agent-service/antigravity-acp-distribution");

// The pinned archive is 112 MB. Tests fake the downloaded bytes and code signature
// through injected fs/execFile/identity readers so no network or Google binary is needed.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-dist-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, dir: path.join(paths.stateDir, "runtime-bin", "antigravity-acp", ANTIGRAVITY_ACP_SERVER_VERSION) };
}

test("resolution reports missing, then rejects an incomplete or unsafe tree", (t) => {
  const f = fixture(t);
  assert.throws(() => resolveAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64" }),
    { code: "ANTIGRAVITY_ACP_NOT_INSTALLED" });
  assert.throws(() => resolveAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "x64" }),
    { code: "ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED" });
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.dir, "agy_acp_server.par"), "short", { mode: 0o755 });
  assert.throws(() => resolveAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64" }),
    { code: "ANTIGRAVITY_ACP_INTEGRITY_FAILED" }, "a wrong-size server is never trusted");
  fs.rmSync(path.join(f.dir, "agy_acp_server.par"));
  fs.symlinkSync("/bin/sh", path.join(f.dir, "agy_acp_server.par"));
  assert.throws(() => resolveAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64" }),
    { code: "ANTIGRAVITY_ACP_INTEGRITY_FAILED" }, "a symlinked server is never trusted");
});

test("install state distinguishes missing, unsupported and corrupt installs", async (t) => {
  const f = fixture(t);
  assert.equal((await antigravityAcpInstallState({ paths: f.paths, platform: "darwin", arch: "arm64" })).state, "missing");
  assert.equal((await antigravityAcpInstallState({ paths: f.paths, platform: "linux", arch: "arm64" })).state, "unsupported");
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.dir, "agy_acp_server.par"), "short", { mode: 0o755 });
  assert.equal((await antigravityAcpInstallState({ paths: f.paths, platform: "darwin", arch: "arm64" })).state, "corrupt");
});

test("a failed download leaves no staging directory and reports a safe code", async (t) => {
  const f = fixture(t);
  const calls = [];
  await assert.rejects(installAntigravityAcpServer({
    paths: f.paths, platform: "darwin", arch: "arm64",
    parentEnv: { HTTPS_PROXY: "http://127.0.0.1:7897", SECRET_TOKEN: "must-not-leak" },
    execFile: (command, args, options, callback) => { calls.push({ command, args, options }); callback(new Error("offline")); },
  }), { code: "ANTIGRAVITY_ACP_DOWNLOAD_FAILED" });
  assert.equal(calls[0].command, "/usr/bin/curl");
  assert.ok(calls[0].args.includes("--proto") && calls[0].args.includes("=https"));
  assert.equal(calls[0].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(calls[0].options.env.SECRET_TOKEN, undefined, "only proxy variables reach curl");
  const root = path.dirname(f.dir);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".staging-")), []);
});

test("a downloaded archive with the wrong hash is rejected before extraction", async (t) => {
  const f = fixture(t);
  const commands = [];
  await assert.rejects(installAntigravityAcpServer({
    paths: f.paths, platform: "darwin", arch: "arm64",
    execFile: (command, args, options, callback) => {
      commands.push(command);
      if (command === "/usr/bin/curl") fs.writeFileSync(args[args.indexOf("--output") + 1], "tampered");
      callback(null);
    },
  }), { code: "ANTIGRAVITY_ACP_INTEGRITY_FAILED" });
  assert.deepEqual(commands, ["/usr/bin/curl"], "ditto must not run on an unverified archive");
  assert.equal(fs.existsSync(f.dir), false);
});

test("installing the real Google archive extracts, verifies and is idempotent (opt-in)", { skip: !process.env.SHOGGOTH_AGY_ACP_ARCHIVE }, async (t) => {
  const f = fixture(t);
  const { execFile } = require("node:child_process");
  let downloads = 0;
  const fakeCurl = (command, args, options, callback) => {
    if (command !== "/usr/bin/curl") return execFile(command, args, options, callback);
    downloads += 1;
    fs.copyFileSync(process.env.SHOGGOTH_AGY_ACP_ARCHIVE, args[args.indexOf("--output") + 1]);
    return callback(null);
  };
  const installed = await installAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64", execFile: fakeCurl });
  assert.equal(installed.serverPath, path.join(f.dir, "agy_acp_server.par"));
  assert.equal(fs.statSync(installed.harnessPath).mode & 0o777, 0o755);
  assert.equal((await antigravityAcpInstallState({ paths: f.paths, platform: "darwin", arch: "arm64" })).state, "installed");
  await installAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64", execFile: fakeCurl });
  assert.equal(downloads, 1, "a verified install is reused without downloading again");
});

test("the real Google build verifies when present locally (opt-in)", { skip: !process.env.SHOGGOTH_AGY_ACP_SERVER_DIR }, async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  for (const name of ["agy_acp_server.par", "localharness_external"]) {
    fs.copyFileSync(path.join(process.env.SHOGGOTH_AGY_ACP_SERVER_DIR, name), path.join(f.dir, name));
    fs.chmodSync(path.join(f.dir, name), 0o755);
  }
  const verified = await verifyAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64" });
  assert.equal(verified.version, ANTIGRAVITY_ACP_SERVER_VERSION);
  const harness = path.join(f.dir, "localharness_external");
  const bytes = fs.readFileSync(harness);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(harness, bytes, { mode: 0o755 });
  await assert.rejects(verifyAntigravityAcpServer({ paths: f.paths, platform: "darwin", arch: "arm64" }),
    { code: "ANTIGRAVITY_ACP_INTEGRITY_FAILED" }, "a modified harness must be rejected");
});

test("the installed server is never copied into authority backups or upgrade snapshots", (t) => {
  const { createAuthorityBackup, verifyAuthorityBackup } = require("../app/agent-service/authority-backup");
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-backup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "data", "shoggoth-core"),
    profileRoot: path.join(root, "data", "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const server = path.join(paths.stateDir, "runtime-bin", "antigravity-acp", ANTIGRAVITY_ACP_SERVER_VERSION);
  fs.mkdirSync(server, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(server, "agy_acp_server.par"), "binary", { mode: 0o755 });
  fs.writeFileSync(path.join(paths.stateDir, "chat-sessions.json"), "{}\n", { mode: 0o600 });
  createAuthorityBackup({ paths, backupId: "acp-server-excluded" });
  const files = verifyAuthorityBackup({ paths, backupId: "acp-server-excluded" }).manifest.entries.map((entry) => entry.path);
  assert.ok(files.includes("chat-sessions.json"));
  assert.equal(files.some((entry) => entry.startsWith("runtime-bin")), false);
});
