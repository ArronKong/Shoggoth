"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginRemoteGitFetcher, identifyRemoteGitSource } = require("../app/agent-service/plugin-remote-git-fetcher");

const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgrg-"));
const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
const store = new PluginStore({ paths }).open();
const localRepo = path.join(root, "fixture-repository");
const log = path.join(root, "git-calls.jsonl");
const pidLog = path.join(root, "pid.json");
const hardLimitLog = path.join(root, "hard-limit.json");
const fakeGit = path.join(root, "fixture-git");
const fetchers = [];
let phase = "setup";
const environment = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(...args) {
  const result = spawnSync("/usr/bin/git", ["-C", localRepo, ...args], { env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function commit(message) {
  git("add", "--all");
  git("-c", "user.name=Local Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}
function countFetches() {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.args.includes("fetch")).length : 0;
}
function createFetcher(options = {}) {
  const fetcher = new PluginRemoteGitFetcher({ paths, gitExecutable: fakeGit, ...options });
  fetchers.push(fetcher); return fetcher;
}
const stagingEmpty = () => assert.deepEqual(fs.readdirSync(paths.pluginStagingDir), []);
async function main() {
  try {
    fs.mkdirSync(localRepo, { mode: 0o700 });
    git("init", "-q");
    for (const name of ["package", "package-other", "[literal]"]) {
      fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), path.join(localRepo, name), { recursive: true });
    }
    fs.chmodSync(path.join(localRepo, "package/bin/issue-fixture"), 0o700);
    const fixedCommit = commit("safe immutable fixture");
    // This executable is trusted test DI. It records the production worker's
    // exact argv/env, then replaces the HTTPS URL with a local repository only
    // for this fixture. Production never enables the file transport.
    fs.writeFileSync(fakeGit, `#!${process.execPath}\n${String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const repo = args[args.indexOf("-C") + 1];
const log = `}${JSON.stringify(log)}${String.raw`;
fs.appendFileSync(log, JSON.stringify({ args, env: process.env }) + "\n");
if (args.includes("fetch")) {
  const url = args[args.length - 2];
  if (url.endsWith("/slow.git")) {
    process.on("SIGTERM", () => {});
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(`}${JSON.stringify(pidLog)}${String.raw`, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000); return;
  }
  if (url.endsWith("/noisy.git")) { process.stderr.write("x".repeat(128 * 1024)); setInterval(() => {}, 1000); return; }
  if (url.endsWith("/large.git")) {
    let index = 0; setInterval(() => fs.writeFileSync(path.join(repo, ".git", "large-" + index++), Buffer.alloc(32 * 1024)), 10); return;
  }
  if (url.endsWith("/hard-limit.git")) {
    process.on("SIGXFSZ", () => {});
    const file = path.join(repo, ".git", "oversized");
    let code = null;
    try { fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024)); }
    catch (error) { code = error.code; }
    fs.writeFileSync(`}${JSON.stringify(hardLimitLog)}${String.raw`, JSON.stringify({ code, size: fs.statSync(file).size }));
    process.exit(79);
  }
  args[args.length - 2] = `}${JSON.stringify(localRepo)}${String.raw`;
  args.unshift("-c", "protocol.file.allow=always");
}
const result = spawnSync("/usr/bin/git", args, { env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" }, encoding: null });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status === null ? 1 : result.status);
`}`, { mode: 0o700 });
    const input = { repositoryUrl: "https://fixture.invalid/project.git", commit: fixedCommit, subdir: "package" };
    const identity = identifyRemoteGitSource(input);
    assert.equal(identity.sourceIdentity, `remote-git:${input.repositoryUrl}#${fixedCommit}:package`);
    for (const unsafe of [
      { repositoryUrl: "http://fixture.invalid/project.git" },
      { repositoryUrl: "https://token@fixture.invalid/project.git" },
      { repositoryUrl: "https://fixture.invalid/project.git?token=secret" },
      { repositoryUrl: "https://fixture.invalid/project.git#main" },
      { repositoryUrl: "file:///tmp/repository" }, { commit: "HEAD" }, { commit: undefined },
      { subdir: "../escape" }, { subdir: "--output=escaped.zip" }, { subdir: "package//bad" },
    ]) assert.throws(() => identifyRemoteGitSource({ ...input, ...unsafe }), { code: "GIT_SOURCE_INVALID" });
    const fetcher = createFetcher();
    phase = "preview and install";
    const installer = new PluginPackageInstaller({ store, remoteGitFetcher: fetcher });
    const saved = Object.fromEntries(["GIT_CONFIG_COUNT", "HTTP_PROXY", "GIT_SSH_COMMAND", "NODE_OPTIONS"].map(key => [key, process.env[key]]));
    let preview;
    try {
      Object.assign(process.env, { GIT_CONFIG_COUNT: "900", HTTP_PROXY: "http://must-not-use.invalid",
        GIT_SSH_COMMAND: "touch MUST_NOT_EXECUTE", NODE_OPTIONS: "--require /must/not/load" });
      preview = await installer.previewRemoteGit(input);
    } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    assert.equal(preview.installable, true);
    assert.equal(preview.sourceIdentity, identity.sourceIdentity);
    assert.equal(preview.sourceIdentity.includes(paths.pluginStagingDir), false);
    stagingEmpty();
    const again = await installer.previewRemoteGit(input);
    assert.equal(again.contentDigest, preview.contentDigest);
    assert.equal(again.sourceIdentity, preview.sourceIdentity);
    assert.equal(installer.previewGit({ repositoryPath: localRepo, commit: fixedCommit, subdir: "package" }).contentDigest, preview.contentDigest);
    const installationInput = { ...input, previewDigest: preview.contentDigest, operationId: "remote-install", expectedRevision: 0 };
    const installed = await installer.installRemoteGit(installationInput);
    assert.equal(installed.desiredState, "disabled");
    assert.equal(installed.sourceIdentity, identity.sourceIdentity);
    assert.equal(fs.statSync(path.join(paths.pluginPackagesDir, installed.releaseDigest, "bin/issue-fixture")).mode & 0o777, 0o700);
    const beforeReplay = countFetches();
    assert.deepEqual(await installer.installRemoteGit(installationInput), installed);
    assert.equal(countFetches(), beforeReplay, "completed operation replay cannot perform another network fetch");
    await assert.rejects(installer.installRemoteGit({ ...installationInput, previewDigest: "b".repeat(64) }), { code: "REVISION_CONFLICT" });
    stagingEmpty();
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const call of calls) {
      for (const key of ["HTTP_PROXY", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) {
        assert.equal(Object.hasOwn(call.env, key), false, `${key} must not reach Git`);
      }
      assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(call.env.GIT_ALLOW_PROTOCOL, "https");
      for (const option of ["core.hooksPath=/dev/null", "credential.helper=", "http.followRedirects=false",
        "protocol.allow=never", "protocol.https.allow=always", "fetch.recurseSubmodules=false", "core.fsmonitor=false"]) {
        assert(call.args.includes(option));
      }
      assert.equal(call.args.includes("checkout"), false);
      assert.equal(call.args.includes("clone"), false);
      if (call.args.includes("fetch")) {
        assert(call.args.includes("--depth=1")); assert(call.args.includes("--no-tags"));
        assert.equal(call.args.at(-1), fixedCommit);
      }
    }

    const escapedArchive = path.join(root, "escaped.zip");
    phase = "archive validation";
    assert.throws(() => installer.previewGit({ repositoryPath: localRepo, commit: fixedCommit,
      subdir: `--output=${escapedArchive}` }), { code: "GIT_SOURCE_INVALID" });
    assert.equal(fs.existsSync(escapedArchive), false, "subdir cannot inject Git archive options");
    assert.equal(installer.previewGit({ repositoryPath: localRepo, commit: fixedCommit, subdir: "[literal]" }).installable, true);
    assert.throws(() => installer.previewGit({ repositoryPath: localRepo, commit: fixedCommit, subdir: "pack*" }), { code: "GIT_SOURCE_INVALID" });
    fs.symlinkSync("../../external", path.join(localRepo, "package/unsafe"));
    const symlinkCommit = commit("unsafe symlink");
    await assert.rejects(installer.previewRemoteGit({ ...input, commit: symlinkCommit }), { code: "GIT_SOURCE_INVALID" });
    fs.unlinkSync(path.join(localRepo, "package/unsafe"));
    fs.writeFileSync(path.join(localRepo, "package/lfs-pointer"), "version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 123\n");
    const lfsCommit = commit("unhydrated LFS");
    await assert.rejects(installer.previewRemoteGit({ ...input, commit: lfsCommit }), { code: "GIT_SOURCE_INVALID" });
    stagingEmpty();

    const alias = { ...input, repositoryUrl: "https://fixture.invalid/alias.git" };
    phase = "crash recovery";
    const crashing = new PluginPackageInstaller({ store, remoteGitFetcher: fetcher,
      onPhase: phase => { if (phase === "published") throw Object.assign(new Error("fixture crash"), { code: "PLUGIN_SIMULATED_CRASH" }); } });
    const crashInput = { ...alias, previewDigest: preview.contentDigest, expectedRevision: 0, operationId: "remote-crash" };
    await assert.rejects(crashing.installRemoteGit(crashInput), { code: "PLUGIN_SIMULATED_CRASH" });
    assert.equal(store.getOperation(crashInput.operationId).phase, "created");
    assert.equal((await installer.installRemoteGit(crashInput)).desiredState, "disabled");
    assert.equal(store.getOperation(crashInput.operationId).phase, "completed");
    stagingEmpty();

    const slow = createFetcher({ timeoutMs: 150, killGraceMs: 30 });
    phase = "timeout";
    await assert.rejects(slow.fetch({ ...input, repositoryUrl: "https://fixture.invalid/slow.git" }), { code: "GIT_REMOTE_TIMEOUT" });
    for (const pid of JSON.parse(fs.readFileSync(pidLog, "utf8"))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    stagingEmpty();
    const noisy = createFetcher({ maxLogBytes: 1024 });
    phase = "log limit";
    await assert.rejects(noisy.fetch({ ...input, repositoryUrl: "https://fixture.invalid/noisy.git" }), { code: "GIT_REMOTE_LOG_LIMIT" });
    stagingEmpty();
    const large = createFetcher({ maxRepositoryBytes: 128 * 1024, pollMs: 5 });
    phase = "disk limit";
    await assert.rejects(large.fetch({ ...input, repositoryUrl: "https://fixture.invalid/large.git" }), { code: "GIT_REMOTE_TOO_LARGE" });
    stagingEmpty();
    await assert.rejects(large.fetch({ ...input, repositoryUrl: "https://fixture.invalid/hard-limit.git" }), error =>
      ["GIT_REMOTE_TOO_LARGE", "GIT_REMOTE_FAILED"].includes(error.code));
    const hardLimit = JSON.parse(fs.readFileSync(hardLimitLog, "utf8"));
    assert.equal(hardLimit.code, "EFBIG", "kernel per-file limit must reject the oversized write");
    assert(hardLimit.size <= 128 * 1024);
    stagingEmpty();
    const abort = new AbortController();
    phase = "abort and close";
    const cancelable = fetcher.fetch({ ...input, repositoryUrl: "https://fixture.invalid/slow.git" }, { signal: abort.signal });
    const rejected = assert.rejects(cancelable, { code: "GIT_REMOTE_CANCELLED" });
    setTimeout(() => abort.abort(), 100);
    await rejected;
    stagingEmpty();
    const closing = fetcher.fetch({ ...input, repositoryUrl: "https://fixture.invalid/slow.git" });
    const closeRejected = assert.rejects(closing, { code: "GIT_REMOTE_CANCELLED" });
    await fetcher.close(); await closeRejected;
    stagingEmpty();
    console.log("plugin remote fixed Git intake/isolation/archive/limits/abort/receipt fixture: PASS");
  } finally {
    for (const fetcher of fetchers) await fetcher.close();
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`Fixture phase: ${phase}`, error); process.exitCode = 1; });
