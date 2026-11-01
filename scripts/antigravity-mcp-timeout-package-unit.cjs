"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { resolveAntigravityMcpTimeoutBootstrap, readBootstrap } = require("../app/agent-service/antigravity-mcp-timeout-bootstrap");
const { packagedAntigravityMcpTimeoutManifest } = require("./antigravity-mcp-timeout-package.cjs");
const repo = path.resolve(__dirname, ".."), vendor = path.join(repo, ".vendor/antigravity-mcp-timeout");
const fixture = t => {
  const root = fs.mkdtempSync("/private/tmp/agy-timeout-package-"), app = path.join(root, "Fixture.app");
  const directory = path.join(app, "Contents/Resources/antigravity-mcp-timeout");
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  for (const file of ["harness-bootstrap", "manifest.json"]) fs.copyFileSync(path.join(vendor, file), path.join(directory, file));
  const executable = path.join(directory, "harness-bootstrap"), manifestPath = path.join(directory, "manifest.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { app, directory, executable, manifestPath };
};

test("Antigravity timeout helper is built and included in both packaging routes", () => {
  const pkg = require("../package.json"), yaml = require("js-yaml");
  assert.match(pkg.scripts["prepare:runtimes"], /build:antigravity-mcp-timeout/u);
  assert.match(pkg.scripts["prepare:runtimes:arm64"], /build:antigravity-mcp-timeout/u);
  const config = yaml.load(fs.readFileSync(path.join(repo, "electron-builder.yml"), "utf8"));
  assert.deepEqual(config.extraResources.filter(item => item.to === "antigravity-mcp-timeout"),
    [{ from: ".vendor/antigravity-mcp-timeout", to: "antigravity-mcp-timeout" }]);
  assert.equal(readBootstrap(vendor).executable, path.join(vendor, "harness-bootstrap"));
});

test("packaged resolver uses only its own resource directory and rejects missing resources", t => {
  const f = fixture(t);
  assert.equal(resolveAntigravityMcpTimeoutBootstrap({ resourcesPath: path.dirname(f.directory) }), f.executable);
  fs.renameSync(f.directory, `${f.directory}.missing`);
  assert.throws(() => resolveAntigravityMcpTimeoutBootstrap({ resourcesPath: path.dirname(f.directory) }), { code: "ANTIGRAVITY_MCP_TIMEOUT_UNAVAILABLE" });
});

test("tampered helpers, symlinks and unsupported architectures fail closed", t => {
  const f = fixture(t), bytes = fs.readFileSync(f.executable);
  bytes[bytes.length - 1] ^= 1; fs.writeFileSync(f.executable, bytes);
  assert.throws(() => readBootstrap(f.directory));
  fs.copyFileSync(path.join(vendor, "harness-bootstrap"), f.executable);
  assert.throws(() => readBootstrap(f.directory, "riscv64"));
  fs.renameSync(f.manifestPath, `${f.manifestPath}.real`);
  fs.symlinkSync(`${f.manifestPath}.real`, f.manifestPath);
  assert.throws(() => readBootstrap(f.directory));
});

test("nested signing reseals only the output hash and preserves source/build identity", t => {
  const f = fixture(t), before = JSON.parse(fs.readFileSync(f.manifestPath));
  assert.equal(packagedAntigravityMcpTimeoutManifest(f.app), f.executable);
  execFileSync("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--identifier", "shoggoth.agy-timeout.fixture", "--sign", "-", f.executable], { stdio: "pipe" });
  assert.throws(() => packagedAntigravityMcpTimeoutManifest(f.app));
  assert.equal(packagedAntigravityMcpTimeoutManifest(f.app, true), f.executable);
  const after = JSON.parse(fs.readFileSync(f.manifestPath));
  assert.notEqual(after.sha256, before.sha256);
  assert.deepEqual({ ...after, sha256: before.sha256 }, before);
  assert.equal(resolveAntigravityMcpTimeoutBootstrap({ directory: f.directory }), f.executable);
  after.sourceSha256 = "a".repeat(64); fs.writeFileSync(f.manifestPath, JSON.stringify(after));
  assert.throws(() => packagedAntigravityMcpTimeoutManifest(f.app, true));
});
