#!/usr/bin/env node
"use strict";

// Real Electron startup and SQLite persistence in a disposable canonical home.
// No LaunchAgent, real credentials, model/provider or existing App data is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const moduleRoot = path.resolve(option("module-root") || path.join(__dirname, "../app"));

if (!process.versions.electron) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-df-"));
  const output = path.resolve(option("output-dir") || path.join(__dirname, "../.artifacts/plugin-default-startup"));
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
  try {
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    for (const generation of [0, 1]) {
      const child = spawnSync(require("electron"), [__filename, `--fixture-root=${root}`,
        `--module-root=${moduleRoot}`, `--generation=${generation}`], {
        env, encoding: "utf8", timeout: 45_000, maxBuffer: 1024 * 1024,
      });
      fs.writeFileSync(path.join(output, `generation-${generation}.log`), child.stdout + child.stderr);
      assert.equal(child.status, 0, `Electron startup failed: ${child.error || child.signal || child.stderr}`);
      assert.match(child.stdout, /DEFAULT_PLUGIN_STARTUP_OK/u);
    }
    const evidence = JSON.parse(fs.readFileSync(path.join(root, "evidence.json"), "utf8"));
    fs.writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(`PASS default plugin Electron startup, second-instance lock, install and process restart: ${output}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app } = require("electron");
  const root = option("fixture-root");
  assert(root && path.isAbsolute(root));
  const { prepareDesktopData, getBootstrappedDesktopPaths } = require(path.join(moduleRoot, "desktop-data-bootstrap"));
  const paths = prepareDesktopData(app, { userInfo: () => ({ homedir: root }) });
  if (process.argv.includes("--competing-instance")) {
    assert.equal(paths, null, "a second GUI must not acquire the current root's singleton");
    console.log("SECOND_INSTANCE_REJECTED");
  } else {
    assert(paths);
    assert.equal(getBootstrappedDesktopPaths(app), paths);
    assert.equal(prepareDesktopData(app), paths, "bootstrap is idempotent");
    assert.equal(paths.userDataRoot, path.join(root, "Library/Application Support/Shoggoth"));
    assert.equal(app.getPath("userData"), paths.userDataRoot);
    assert.equal(paths.productSchemaVersion, 15);
    app.on("window-all-closed", () => {});
    const timeout = setTimeout(() => { console.error("default plugin startup timed out"); app.exit(1); }, 35_000);
    app.whenReady().then(async () => {
      const { createAgentService, PROTOCOL_VERSION } = require(path.join(moduleRoot, "agent-service/server"));
      const { requestService, readClientToken } = require(path.join(moduleRoot, "agent-service/client"));
      const generation = Number(option("generation"));
      const safeStorage = { isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() };
      const service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false,
        parentEnv: {}, runtimeStorageHomedir: root, version: "default-plugin-startup-fixture" });
      const rpc = (method, params) => requestService(paths, { token: readClientToken(paths),
        version: PROTOCOL_VERSION, method, params });
      try {
        await service.start();
        const status = await rpc("service.status", {});
        assert.equal(status.healthy, true);
        assert.equal(status.productSchemaVersion, 15);
        assert(service.pluginStore);
        if (generation === 0) {
          const sourceRoot = path.join(root, "source");
          fs.mkdirSync(path.join(sourceRoot, "skills/fixture"), { recursive: true });
          fs.writeFileSync(path.join(sourceRoot, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "startup-fixture", description: "Local startup regression fixture",
          }));
          fs.writeFileSync(path.join(sourceRoot, "skills/fixture/SKILL.md"),
            "---\nname: fixture\ndescription: Local startup regression\n---\nRead this local fixture.\n");
          const source = { kind: "directory", path: sourceRoot };
          const preview = await rpc("plugins.install.preview", { source });
          assert.equal(preview.installable, true);
          const installed = await rpc("plugins.install", { source, previewDigest: preview.previewDigest,
            operationId: "default-startup-install", expectedRevision: preview.expectedRevision });
          fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({
            installationId: installed.installation.installationId,
            authorityIncarnation: service.pluginStore.getAuthorityIncarnation(),
          }));
          const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [__filename, `--fixture-root=${root}`,
              `--module-root=${moduleRoot}`, "--competing-instance"], {
              env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "", stderr = "";
            child.stdout.on("data", chunk => { stdout += chunk; });
            child.stderr.on("data", chunk => { stderr += chunk; });
            child.once("error", reject);
            child.once("exit", code => resolve({ code, stdout, stderr }));
          });
          assert.equal(result.code, 0, result.stderr);
          assert.match(result.stdout, /SECOND_INSTANCE_REJECTED/u);
        }
        const saved = JSON.parse(fs.readFileSync(path.join(root, "installation.json"), "utf8"));
        const page = await rpc("plugins.capabilities.list", { cursor: 0, limit: 10, catalogRevision: null });
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].installationId, saved.installationId);
        assert.equal(service.pluginStore.getAuthorityIncarnation(), saved.authorityIncarnation);
        assert.equal(fs.existsSync(paths.pluginCatalogPath), true);
        assert.equal(fs.existsSync(`${paths.userDataRoot}-plugin-v1`), false);
        assert.equal(fs.existsSync(path.join(root, "Library/Application Support/Shoggoth Agent Service/product-profile")), false);
        fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({
          moduleRoot, electron: process.versions.electron, productSchemaVersion: status.productSchemaVersion,
          defaultPlugins: true, singleInstance: true, persistedAcrossProcessRestart: generation === 1,
          environmentSwitchRequired: false, cleanExit: true,
        }));
        console.log("DEFAULT_PLUGIN_STARTUP_OK");
      } finally { await service.stop({ notify: false }); }
    }).then(() => { clearTimeout(timeout); app.quit(); }).catch(error => {
      console.error(error); clearTimeout(timeout); app.exit(1);
    });
  }
}
