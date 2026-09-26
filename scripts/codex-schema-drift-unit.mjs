#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  parseCliArgs,
  runCodexSchema,
} from "./generate-codex-app-server-schema.mjs";

const VERSION = "0.149.0";
const GENERATOR_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "generate-codex-app-server-schema.mjs");

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function writeManifest(repoRoot, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    runtime: { name: "codex", version: VERSION },
    schema: {
      version: VERSION,
      directory: `schemas/codex-app-server/${VERSION}`,
      includeExperimental: false,
      ...overrides.schema,
    },
    platforms: {
      "darwin-arm64": {
        arch: "arm64",
        destination: ".vendor/codex/arm64/package/bin/codex",
      },
    },
  };
  const manifestPath = path.join(repoRoot, "build", "codex-runtime-manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function writeRuntime(repoRoot, {
  version = VERSION,
  failGeneration = false,
  hangGeneration = false,
  replaceSchemaWithSymlink = false,
  writeReservedManifest = false,
  createEmptyDirectory = false,
  forkInheritedGrandchild = false,
  floodOutput = false,
} = {}) {
  const runtimePath = path.join(repoRoot, ".vendor", "codex", "arm64", "package", "bin", "codex");
  const logPath = path.join(repoRoot, "runtime-calls.jsonl");
  const grandchildPidPath = path.join(repoRoot, "grandchild.pid");
  const externalSchema = path.join(repoRoot, "external-schema");
  if (replaceSchemaWithSymlink) {
    fs.mkdirSync(path.join(externalSchema, "json"), { recursive: true });
    fs.mkdirSync(path.join(externalSchema, "typescript"), { recursive: true });
    fs.writeFileSync(path.join(externalSchema, "json", "schema.json"), '{"external":true}\n');
    fs.writeFileSync(path.join(externalSchema, "typescript", "index.ts"), "export type External = true;\n");
    fs.writeFileSync(path.join(externalSchema, "sentinel.txt"), "do not move\n");
  }
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, codexHome: process.env.CODEX_HOME, codexHomeMode: fs.statSync(process.env.CODEX_HOME).mode & 0o777, envKeys: Object.keys(process.env).sort() }) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`codex-cli ${version}\n`)});
  process.exit(0);
}
if (${JSON.stringify(failGeneration)}) {
  process.stderr.write("fixture failure\\n");
  process.exit(17);
}
if (${JSON.stringify(hangGeneration)}) setInterval(() => {}, 1000);
const outIndex = args.indexOf("--out");
if (outIndex < 0 || !args[outIndex + 1]) process.exit(18);
const out = args[outIndex + 1];
if (${JSON.stringify(forkInheritedGrandchild)}) {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
  fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
  if (${JSON.stringify(floodOutput)}) process.stdout.write("x".repeat(70 * 1024));
  setInterval(() => {}, 1000);
}
if (${JSON.stringify(replaceSchemaWithSymlink)}) {
  const schemaRoot = path.dirname(out);
  if (args[1] === "generate-json-schema") {
    fs.rmSync(schemaRoot, { recursive: true, force: true });
    fs.symlinkSync(${JSON.stringify(externalSchema)}, schemaRoot);
  }
  process.exit(0);
}
fs.mkdirSync(out, { recursive: true });
if (${JSON.stringify(writeReservedManifest)}) {
  fs.writeFileSync(path.join(path.dirname(out), "schema-manifest.json"), "fixture-owned manifest\\n");
}
if (args[1] === "generate-json-schema") {
  fs.writeFileSync(path.join(out, "schema.json"), '{"title":"Fixture"}\\n');
} else if (args[1] === "generate-ts") {
  fs.mkdirSync(path.join(out, "nested"), { recursive: true });
  fs.writeFileSync(path.join(out, "nested", "index.ts"), "export type Fixture = string;\\n");
} else {
  process.exit(19);
}
if (${JSON.stringify(createEmptyDirectory)}) {
  fs.mkdirSync(path.join(out, "empty", "nested"), { recursive: true });
}
`;
  fs.writeFileSync(runtimePath, source, { mode: 0o755 });
  return { runtimePath, logPath, grandchildPidPath };
}

function createFixture(options = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-unit-"));
  fs.mkdirSync(path.join(repoRoot, "schemas", "codex-app-server"), { recursive: true });
  const manifestPath = writeManifest(repoRoot, options.manifest ?? {});
  const runtime = writeRuntime(repoRoot, options.runtime ?? {});
  return {
    repoRoot,
    manifestPath,
    ...runtime,
    target: path.join(repoRoot, "schemas", "codex-app-server", VERSION),
  };
}

function calls(fixture) {
  if (!fs.existsSync(fixture.logPath)) return [];
  return fs.readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function residueNames(fixture) {
  const parent = path.dirname(fixture.target);
  return fs.readdirSync(parent).filter((name) => name.includes("staging") || name.includes("backup"));
}

async function rejectMessage(promise, pattern) {
  let received;
  try {
    await promise;
  } catch (error) {
    received = error;
  }
  assert.ok(received, "expected operation to reject");
  assert.match(received.message, pattern);
  return received.message;
}

function killRecordedProcess(pidPath) {
  if (!fs.existsSync(pidPath)) return;
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function assertProcessExited(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} remained alive after process-tree termination`);
}

async function main() {
  assert.deepEqual(parseCliArgs([]), { mode: "check" });
  assert.deepEqual(parseCliArgs(["--mode", "write", "--platform", "darwin-arm64"]), {
    mode: "write",
    platform: "darwin-arm64",
  });
  for (const args of [
    ["--wat"],
    ["--mode"],
    ["--mode", "write", "--mode", "check"],
    ["--mode", "unsafe"],
    ["--platform", "linux-x64"],
  ]) {
    assert.throws(() => parseCliArgs(args), /argument|mode|platform/i);
  }

  const fixture = createFixture();
  try {
    const writeResult = await runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
    });
    assert.equal(writeResult.mode, "write");
    assert.equal(writeResult.version, VERSION);
    assert.equal(writeResult.directory, `schemas/codex-app-server/${VERSION}`);
    assert.equal(writeResult.fileCount, 2);
    assert.match(writeResult.digest, /^[a-f0-9]{64}$/);

    const runtimeCalls = calls(fixture);
    assert.deepEqual(runtimeCalls.map((call) => call.args.slice(0, 2)), [
      ["--version"],
      ["app-server", "generate-json-schema"],
      ["app-server", "generate-ts"],
    ]);
    assert.ok(runtimeCalls.every((call) => !call.args.includes("--experimental")));
    assert.ok(runtimeCalls.every((call) => call.codexHome.includes("staging")));
    assert.notEqual(runtimeCalls[0].codexHome, process.env.CODEX_HOME);
    assert.ok(runtimeCalls.every((call) => call.codexHomeMode === 0o700));
    assert.deepEqual(runtimeCalls[0].envKeys, runtimeCalls[1].envKeys);
    assert.ok(runtimeCalls[0].envKeys.includes("CODEX_HOME"));
    assert.ok(!runtimeCalls[0].envKeys.some((key) => /TOKEN|SECRET|API_KEY|AWS_|OPENAI/i.test(key)));

    const manifestPath = path.join(fixture.target, "schema-manifest.json");
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    const schemaManifest = JSON.parse(manifestText);
    assert.equal(manifestText, `${JSON.stringify(schemaManifest, null, 2)}\n`);
    assert.ok(!manifestText.includes(fixture.repoRoot));
    assert.deepEqual(schemaManifest, {
      schemaVersion: 1,
      codexVersion: VERSION,
      includeExperimental: false,
      generators: {
        json: ["app-server", "generate-json-schema"],
        typescript: ["app-server", "generate-ts"],
      },
      files: {
        "json/schema.json": {
          sha256: sha256('{"title":"Fixture"}\n'),
          size: Buffer.byteLength('{"title":"Fixture"}\n'),
        },
        "typescript/nested/index.ts": {
          sha256: sha256("export type Fixture = string;\n"),
          size: Buffer.byteLength("export type Fixture = string;\n"),
        },
      },
    });
    assert.equal(writeResult.digest, sha256(manifestText));
    assert.deepEqual(residueNames(fixture), []);

    const cli = spawnSync(process.execPath, [
      GENERATOR_PATH,
      "--mode", "check",
      "--platform", "darwin-arm64",
      "--manifest", fixture.manifestPath,
      "--repo-root", fixture.repoRoot,
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), { ...writeResult, mode: "check" });

    const checkResult = await runCodexSchema({
      mode: "check",
      platform: "darwin-arm64",
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
    });
    assert.equal(checkResult.mode, "check");
    assert.equal(checkResult.digest, writeResult.digest);
    assert.deepEqual(residueNames(fixture), []);

    const jsonPath = path.join(fixture.target, "json", "schema.json");
    fs.writeFileSync(jsonPath, "tampered\n");
    const tampered = fs.readFileSync(jsonPath, "utf8");
    await rejectMessage(runCodexSchema({ mode: "check", platform: "darwin-arm64", manifestPath: fixture.manifestPath, repoRoot: fixture.repoRoot }), /modified: json\/schema\.json/);
    assert.equal(fs.readFileSync(jsonPath, "utf8"), tampered, "check must not repair a modified target");

    await runCodexSchema({ mode: "write", platform: "darwin-arm64", manifestPath: fixture.manifestPath, repoRoot: fixture.repoRoot });
    const extraPath = path.join(fixture.target, "json", "extra.json");
    fs.writeFileSync(extraPath, "{}\n");
    await rejectMessage(runCodexSchema({ mode: "check", platform: "darwin-arm64", manifestPath: fixture.manifestPath, repoRoot: fixture.repoRoot }), /added: json\/extra\.json/);
    assert.ok(fs.existsSync(extraPath));

    await runCodexSchema({ mode: "write", platform: "darwin-arm64", manifestPath: fixture.manifestPath, repoRoot: fixture.repoRoot });
    fs.unlinkSync(jsonPath);
    await rejectMessage(runCodexSchema({ mode: "check", platform: "darwin-arm64", manifestPath: fixture.manifestPath, repoRoot: fixture.repoRoot }), /deleted: json\/schema\.json/);
    assert.ok(!fs.existsSync(jsonPath));
    assert.deepEqual(residueNames(fixture), []);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }

  const invalidCases = [
    { options: { runtime: { version: "9.9.9" } }, pattern: /runtime version/i },
    { options: { manifest: { schema: { includeExperimental: true } } }, pattern: /includeExperimental/i },
    { options: { manifest: { schema: { directory: "../escaped" } } }, pattern: /schema directory/i },
  ];
  for (const testCase of invalidCases) {
    const item = createFixture(testCase.options);
    try {
      await rejectMessage(runCodexSchema({ mode: "write", platform: "darwin-arm64", manifestPath: item.manifestPath, repoRoot: item.repoRoot }), testCase.pattern);
      assert.ok(!fs.existsSync(item.target));
      assert.deepEqual(residueNames(item), []);
    } finally {
      fs.rmSync(item.repoRoot, { recursive: true, force: true });
    }
  }

  const symlinkFixture = createFixture();
  try {
    const realRuntime = `${symlinkFixture.runtimePath}.real`;
    fs.renameSync(symlinkFixture.runtimePath, realRuntime);
    fs.symlinkSync(realRuntime, symlinkFixture.runtimePath);
    await rejectMessage(runCodexSchema({ mode: "write", platform: "darwin-arm64", manifestPath: symlinkFixture.manifestPath, repoRoot: symlinkFixture.repoRoot }), /symlink|regular file/i);
  } finally {
    fs.rmSync(symlinkFixture.repoRoot, { recursive: true, force: true });
  }

  const failureFixture = createFixture({ runtime: { failGeneration: true } });
  try {
    fs.mkdirSync(failureFixture.target, { recursive: true });
    const marker = path.join(failureFixture.target, "old.txt");
    fs.writeFileSync(marker, "keep me\n");
    await rejectMessage(runCodexSchema({ mode: "write", platform: "darwin-arm64", manifestPath: failureFixture.manifestPath, repoRoot: failureFixture.repoRoot }), /generator command failed/i);
    assert.equal(fs.readFileSync(marker, "utf8"), "keep me\n");
    assert.deepEqual(residueNames(failureFixture), []);
  } finally {
    fs.rmSync(failureFixture.repoRoot, { recursive: true, force: true });
  }

  const outputLimitFixture = createFixture({
    runtime: { forkInheritedGrandchild: true, floodOutput: true },
  });
  try {
    fs.mkdirSync(outputLimitFixture.target, { recursive: true });
    const marker = path.join(outputLimitFixture.target, "old.txt");
    fs.writeFileSync(marker, "keep after output limit\n");
    const startedAt = Date.now();
    const safetyKill = setTimeout(() => killRecordedProcess(outputLimitFixture.grandchildPidPath), 7_000);
    try {
      await rejectMessage(runCodexSchema({
        mode: "write",
        platform: "darwin-arm64",
        manifestPath: outputLimitFixture.manifestPath,
        repoRoot: outputLimitFixture.repoRoot,
        timeoutMs: 5_000,
      }), /generator command failed.*output exceeded safe limit/i);
    } finally {
      clearTimeout(safetyKill);
    }
    assert.ok(Date.now() - startedAt < 4_000, "output-limit termination must not wait for the safety kill");
    const grandchildPid = Number(fs.readFileSync(outputLimitFixture.grandchildPidPath, "utf8"));
    await assertProcessExited(grandchildPid);
    assert.equal(fs.readFileSync(marker, "utf8"), "keep after output limit\n");
    assert.deepEqual(residueNames(outputLimitFixture), []);
  } finally {
    killRecordedProcess(outputLimitFixture.grandchildPidPath);
    fs.rmSync(outputLimitFixture.repoRoot, { recursive: true, force: true });
  }

  const timeoutFixture = createFixture({ runtime: { forkInheritedGrandchild: true } });
  try {
    fs.mkdirSync(timeoutFixture.target, { recursive: true });
    const marker = path.join(timeoutFixture.target, "old.txt");
    fs.writeFileSync(marker, "keep after timeout\n");
    const startedAt = Date.now();
    const safetyKill = setTimeout(() => killRecordedProcess(timeoutFixture.grandchildPidPath), 7_000);
    try {
      await rejectMessage(runCodexSchema({
        mode: "write",
        platform: "darwin-arm64",
        manifestPath: timeoutFixture.manifestPath,
        repoRoot: timeoutFixture.repoRoot,
        timeoutMs: 1_500,
      }), /generator command failed.*timed out/i);
    } finally {
      clearTimeout(safetyKill);
    }
    assert.ok(Date.now() - startedAt < 4_000, "timeout termination must not wait for the safety kill");
    const grandchildPid = Number(fs.readFileSync(timeoutFixture.grandchildPidPath, "utf8"));
    await assertProcessExited(grandchildPid);
    assert.equal(fs.readFileSync(marker, "utf8"), "keep after timeout\n");
    assert.deepEqual(residueNames(timeoutFixture), []);
  } finally {
    killRecordedProcess(timeoutFixture.grandchildPidPath);
    fs.rmSync(timeoutFixture.repoRoot, { recursive: true, force: true });
  }

  const reservedFixture = createFixture({ runtime: { writeReservedManifest: true } });
  try {
    await rejectMessage(runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: reservedFixture.manifestPath,
      repoRoot: reservedFixture.repoRoot,
    }), /reserved output: schema-manifest\.json/i);
    assert.ok(!fs.existsSync(reservedFixture.target));
    assert.deepEqual(residueNames(reservedFixture), []);
  } finally {
    fs.rmSync(reservedFixture.repoRoot, { recursive: true, force: true });
  }

  const generatedEmptyFixture = createFixture({ runtime: { createEmptyDirectory: true } });
  try {
    await rejectMessage(runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: generatedEmptyFixture.manifestPath,
      repoRoot: generatedEmptyFixture.repoRoot,
    }), /invalid: json\/empty\/nested\/ \(empty directory\)/i);
    assert.ok(!fs.existsSync(generatedEmptyFixture.target));
    assert.deepEqual(residueNames(generatedEmptyFixture), []);
  } finally {
    fs.rmSync(generatedEmptyFixture.repoRoot, { recursive: true, force: true });
  }

  const targetEmptyFixture = createFixture();
  try {
    await runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: targetEmptyFixture.manifestPath,
      repoRoot: targetEmptyFixture.repoRoot,
    });
    const emptyDirectory = path.join(targetEmptyFixture.target, "unexpected", "nested");
    fs.mkdirSync(emptyDirectory, { recursive: true });
    await rejectMessage(runCodexSchema({
      mode: "check",
      platform: "darwin-arm64",
      manifestPath: targetEmptyFixture.manifestPath,
      repoRoot: targetEmptyFixture.repoRoot,
    }), /schema drift detected[\s\S]*invalid: unexpected\/nested\/ \(empty directory\)/i);
    assert.ok(fs.statSync(emptyDirectory).isDirectory(), "check must preserve unexpected empty directories");
    assert.deepEqual(residueNames(targetEmptyFixture), []);
  } finally {
    fs.rmSync(targetEmptyFixture.repoRoot, { recursive: true, force: true });
  }

  const rootSymlinkFixture = createFixture({ runtime: { replaceSchemaWithSymlink: true } });
  try {
    fs.mkdirSync(rootSymlinkFixture.target, { recursive: true });
    const oldMarker = path.join(rootSymlinkFixture.target, "old.txt");
    fs.writeFileSync(oldMarker, "keep old target\n");
    const externalMarker = path.join(rootSymlinkFixture.repoRoot, "external-schema", "sentinel.txt");
    await rejectMessage(runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: rootSymlinkFixture.manifestPath,
      repoRoot: rootSymlinkFixture.repoRoot,
    }), /generated output root.*symlink|generated output root.*directory/i);
    assert.equal(fs.readFileSync(oldMarker, "utf8"), "keep old target\n");
    assert.equal(fs.readFileSync(externalMarker, "utf8"), "do not move\n");
    assert.ok(fs.lstatSync(path.dirname(externalMarker)).isDirectory());
    assert.deepEqual(residueNames(rootSymlinkFixture), []);
  } finally {
    fs.rmSync(rootSymlinkFixture.repoRoot, { recursive: true, force: true });
  }

  const replaceFixture = createFixture();
  try {
    fs.mkdirSync(replaceFixture.target, { recursive: true });
    fs.writeFileSync(path.join(replaceFixture.target, "old.txt"), "old\n");
    await runCodexSchema({ mode: "write", platform: "darwin-arm64", manifestPath: replaceFixture.manifestPath, repoRoot: replaceFixture.repoRoot });
    assert.ok(!fs.existsSync(path.join(replaceFixture.target, "old.txt")));
    assert.ok(fs.existsSync(path.join(replaceFixture.target, "schema-manifest.json")));
    assert.deepEqual(residueNames(replaceFixture), []);
  } finally {
    fs.rmSync(replaceFixture.repoRoot, { recursive: true, force: true });
  }

  const rollbackFixture = createFixture();
  try {
    fs.mkdirSync(rollbackFixture.target, { recursive: true });
    const marker = path.join(rollbackFixture.target, "old.txt");
    fs.writeFileSync(marker, "restore me\n");
    let renameCount = 0;
    const injectedRename = async (source, destination) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error("injected second rename failure");
      await fs.promises.rename(source, destination);
    };
    await rejectMessage(runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: rollbackFixture.manifestPath,
      repoRoot: rollbackFixture.repoRoot,
      rename: injectedRename,
    }), /injected second rename failure/);
    assert.equal(renameCount, 3, "failed replacement must rename the backup back into place");
    assert.equal(fs.readFileSync(marker, "utf8"), "restore me\n");
    assert.deepEqual(residueNames(rollbackFixture), []);
  } finally {
    fs.rmSync(rollbackFixture.repoRoot, { recursive: true, force: true });
  }

  const cleanupFixture = createFixture();
  try {
    fs.mkdirSync(cleanupFixture.target, { recursive: true });
    fs.writeFileSync(path.join(cleanupFixture.target, "old.txt"), "old\n");
    await rejectMessage(runCodexSchema({
      mode: "write",
      platform: "darwin-arm64",
      manifestPath: cleanupFixture.manifestPath,
      repoRoot: cleanupFixture.repoRoot,
      remove: async () => { throw new Error("injected cleanup failure"); },
    }), /new schema committed but backup cleanup failed/);
    assert.ok(fs.existsSync(path.join(cleanupFixture.target, "schema-manifest.json")));
    assert.ok(residueNames(cleanupFixture).some((name) => name.includes("backup")));
    assert.ok(!residueNames(cleanupFixture).some((name) => name.includes("staging")));
  } finally {
    fs.rmSync(cleanupFixture.repoRoot, { recursive: true, force: true });
  }

  console.log("codex schema drift unit tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
