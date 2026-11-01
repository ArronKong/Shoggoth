#!/usr/bin/env node
"use strict";
// Resource-package proof, not a signed distributable App. Tests the production
// modules inside a real ASAR using Electron's packaged module resolution.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "..");
const output = path.resolve(process.argv[2] || path.join(repo, ".artifacts/chat-secret-mediation-20261029/package-proof"));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const packagedTests = ["chat-secret-mediation-unit.cjs", "desktop-secret-boundary-unit.cjs", "chat-secret-disclosure-unit.cjs",
  "chat-secret-desktop-unit.cjs", "model-secret-projection-unit.cjs", "model-secret-gateway-unit.cjs", "chat-secret-media-unit.cjs"];
async function main() {
  assert(!fs.existsSync(output), "Use a new evidence directory");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const stage = path.join(output, "source"), archive = path.join(output, "app.asar"), files = [];
  const copy = relative => {
    const source = path.join(repo, relative), stat = fs.lstatSync(source);
    assert(!stat.isSymbolicLink(), `Unexpected source link ${relative}`);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(source).sort()) copy(path.join(relative, name)); return; }
    if (!stat.isFile()) return;
    const target = path.join(stage, relative), bytes = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
  };
  for (const relative of ["app/core", "app/agent-service", "app/assets", "app/cli-runtime", "app/native-chat-ui-resources", "app/manage-ui/dist", "schemas", "package.json",
    ...packagedTests.map(name => `scripts/${name}`)]) copy(relative);
  for (const name of fs.readdirSync(path.join(repo, "app")).filter(name => /\.(js|json)$/u.test(name))) copy(`app/${name}`);
  // Node's --test file discovery bypasses Electron's ASAR virtual filesystem.
  // Load the same test files through Electron's normal module resolver instead.
  const runner = "scripts/chat-secret-packaged-runner.cjs";
  const runnerBytes = Buffer.from(`"use strict";\nfor (const name of ${JSON.stringify(packagedTests)}) require("./" + name);\n`);
  fs.writeFileSync(path.join(stage, runner), runnerBytes); files.push({ path: runner, bytes: runnerBytes.length, sha256: sha(runnerBytes), generated: true });
  const asar = await import(require.resolve("@electron/asar"));
  await asar.createPackage(stage, archive);
  for (const item of files) assert.equal(sha(asar.extractFile(archive, item.path)), item.sha256, item.path);
  // Follow the actual builder FileSets for the new executable and Runtime
  // integrations. These files live beside app.asar in production packages.
  const config = require("js-yaml").load(fs.readFileSync(path.join(repo, "electron-builder.yml"), "utf8"));
  const required = [".vendor/local-media", "resources/legal", "resources/external-plugin-adapters", "resources/external-plugin-host-patches",
    "resources/pi/shoggoth-pi-extension.mjs", "resources/pi/shoggoth-pi-secret-projection.mjs",
    "resources/opencode/shoggoth-secret-projection.mjs", "resources/deepseek-harness/shoggoth-dsh-bridge.mjs",
    "resources/deepseek-harness/shoggoth-dsh-secret-projection.mjs"];
  const resources = [], resourceRoot = path.join(output, "resources");
  const copyResource = (source, relative) => {
    const stat = fs.lstatSync(source); assert(!stat.isSymbolicLink(), `Unexpected resource link ${relative}`);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(source).sort()) {
      if (name === "__pycache__" || name.endsWith(".pyc")) continue;
      copyResource(path.join(source, name), path.join(relative, name));
    } return; }
    assert(stat.isFile()); const bytes = fs.readFileSync(source), target = path.join(resourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, stat.mode & 0o777); assert.equal(sha(fs.readFileSync(target)), sha(bytes));
    resources.push({ source: path.relative(repo, source), path: relative, bytes: bytes.length, sha256: sha(bytes) });
  };
  for (const from of required) {
    const entries = config.extraResources.filter(entry => entry.from === from); assert.equal(entries.length, 1, from);
    copyResource(path.join(repo, from), entries[0].to);
  }
  const helperManifest = JSON.parse(fs.readFileSync(path.join(resourceRoot, "local-media/manifest.json")));
  assert.equal(helperManifest.sourceSha256, sha(fs.readFileSync(path.join(repo, "resources/local-media/secret-media.swift"))));
  assert.equal(helperManifest.builderSha256, sha(fs.readFileSync(path.join(repo, "scripts/build-secret-media.cjs"))));
  assert.equal(helperManifest.sha256, sha(fs.readFileSync(path.join(resourceRoot, "local-media/shoggoth-secret-media"))));
  const helper = spawnSync(path.join(resourceRoot, "local-media/shoggoth-secret-media"), [], {
    input: '{"action":"capabilities"}\n', env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 15000 });
  assert.equal(helper.status, 0); const helperCapabilities = JSON.parse(helper.stdout); assert.equal(helperCapabilities.version, 1);
  const test = spawnSync(require("electron"), [path.join(archive, runner)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: path.join(repo, "node_modules"), TMPDIR: "/private/tmp" },
    encoding: "utf8", timeout: 60000,
  });
  fs.writeFileSync(path.join(output, "packaged-tests.log"), `${test.stdout || ""}${test.stderr || ""}`);
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
    verified: test.status === 0, boundary: "ASAR modules + compiled UI + builder-mapped secret-protection resources; existing locked Electron runtime; no signing, installation or complete distribution bundle",
    archive, archiveSha256: sha(fs.readFileSync(archive)), files, resources, helperCapabilities,
    test: { exitCode: test.status, signal: test.signal, files: packagedTests },
  }, null, 2) + "\n");
  assert.equal(test.status, 0, test.stderr || test.stdout);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(JSON.stringify({ pass: true, sourceFilesMatched: files.length, resourceFilesMatched: resources.length, archive, testExitCode: test.status }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
