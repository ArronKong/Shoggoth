"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const crypto = require("node:crypto");
const {
  checkInstalledDependencies,
  checkPackagedDependencies,
  checkPackagingInputs,
  productionPackages,
} = require("./release-package-checks.cjs");

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-release-checks-"));
  try {
    const repo = path.join(scratch, "repo");
    writeJson(path.join(repo, "package-lock.json"), { packages: {
      "": { name: "fixture" },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/b": { version: "2.0.0" },
      "node_modules/a/node_modules/c": { version: "1.0.0" },
      "node_modules/c": { version: "2.0.0", dev: true },
      "node_modules/tool": { version: "1.0.0", devOptional: true },
      "node_modules/native-darwin-arm64": { version: "1.0.0", optional: true, os: ["darwin"], cpu: ["arm64"] },
      "node_modules/native-linux-x64": { version: "1.0.0", optional: true, os: ["linux"], cpu: ["x64"] },
    } });
    assert.deepEqual(productionPackages(repo, { arch: "arm64" }).map((pkg) => pkg.key), [
      "node_modules/a", "node_modules/b", "node_modules/a/node_modules/c", "node_modules/native-darwin-arm64",
    ], "dev packages and other platforms' optional packages are not shipped");

    // Preflight: the install behind electron-builder.
    assert.match(checkInstalledDependencies(repo, { arch: "arm64" })[0], /node_modules is missing/u);
    const realModules = path.join(scratch, "real-node_modules");
    fs.mkdirSync(realModules);
    fs.symlinkSync(realModules, path.join(repo, "node_modules"));
    assert.match(checkInstalledDependencies(repo, { arch: "arm64" })[0], /symlink/u,
      "a symlinked node_modules must stop the build before electron-builder drops dependencies");
    fs.unlinkSync(path.join(repo, "node_modules"));
    writeJson(path.join(repo, "node_modules/a/package.json"), { version: "1.0.0" });
    writeJson(path.join(repo, "node_modules/a/node_modules/c/package.json"), { version: "1.0.0" });
    assert.deepEqual(checkInstalledDependencies(repo, { arch: "arm64" }),
      ["node_modules/b is not installed; run `npm ci --ignore-scripts`"],
      "missing production packages are reported; a missing optional package is not");
    writeJson(path.join(repo, "node_modules/b/package.json"), { version: "2.0.1" });
    assert.match(checkInstalledDependencies(repo, { arch: "arm64" })[0], /is 2\.0\.1 but the lockfile requires 2\.0\.0/u);
    writeJson(path.join(repo, "node_modules/b/package.json"), { version: "2.0.0" });
    assert.deepEqual(checkInstalledDependencies(repo, { arch: "arm64" }), []);

    // afterPack: what the assembled App actually carries. Builder hoists the
    // nested c@1.0.0 to the top level of a production-only tree.
    const staging = path.join(scratch, "asar-staging");
    writeJson(path.join(staging, "node_modules/a/package.json"), { version: "1.0.0" });
    writeJson(path.join(staging, "node_modules/c/package.json"), { version: "1.0.0" });
    const resources = path.join(scratch, "Shoggoth.app", "Contents", "Resources");
    writeJson(path.join(resources, "app.asar.unpacked/node_modules/native-darwin-arm64/package.json"), { version: "1.0.0" });
    await asar.createPackage(staging, path.join(resources, "app.asar"));
    const appPath = path.join(scratch, "Shoggoth.app");
    assert.deepEqual(checkPackagedDependencies(appPath, { repo, arch: "arm64" }),
      ["b@2.0.0 (node_modules/b) is missing from the App"], "a dropped transitive dependency fails the build");
    // A separate App: @electron/asar caches each archive's header by path.
    writeJson(path.join(staging, "node_modules/b/package.json"), { version: "2.0.0" });
    const completeResources = path.join(scratch, "Complete.app", "Contents", "Resources");
    fs.cpSync(path.join(resources, "app.asar.unpacked"), path.join(completeResources, "app.asar.unpacked"), { recursive: true });
    await asar.createPackage(staging, path.join(completeResources, "app.asar"));
    assert.deepEqual(checkPackagedDependencies(path.join(scratch, "Complete.app"), { repo, arch: "arm64" }), []);

    // Preflight inputs, on a copy-on-write clone of the real bundled plugins.
    const inputs = path.join(scratch, "inputs");
    fs.mkdirSync(path.join(inputs, "schemas"), { recursive: true });
    fs.cpSync(path.join(__dirname, "..", "resources", "bundled-plugins"),
      path.join(inputs, "resources", "bundled-plugins"), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fs.cpSync(path.join(__dirname, "..", "resources", "external-plugin-adapters"),
      path.join(inputs, "resources", "external-plugin-adapters"), { recursive: true });
    assert.deepEqual(checkPackagingInputs(inputs), [], "the committed bundled plugins pass every packaging gate");
    fs.writeFileSync(path.join(inputs, "resources", ".env"), "PLACEHOLDER=true\n");
    assert.match(checkPackagingInputs(inputs).join("\n"), /resources: PRIVATE_KEY_MATERIAL_FOUND.*\.env.*credential file name/u);
    fs.rmSync(path.join(inputs, "resources", ".env"));
    // Exercise tampering with owned synthetic bytes in both development and
    // public exports, whose catalogs intentionally contain no third-party packages.
    const fixtureMcp = path.join(inputs, "resources/bundled-plugins/packages/packaging-fixture/.mcp.json");
    writeJson(fixtureMcp, { mcpServers: { fixture: { command: "fixture", args: [] } } });
    const bytes = fs.readFileSync(fixtureMcp);
    const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
    const files = [{ path: ".mcp.json", bytes: bytes.length, sha256: sha256(bytes), executable: false }];
    const catalogFile = path.join(inputs, "resources/bundled-plugins/catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    catalog.packages.push({ id: "packaging-fixture", sourceDigest: sha256(JSON.stringify(files)),
      fileCount: 1, bytes: bytes.length, version: "1.0.0", importStatus: "previewable", icon: null,
      displayName: "Packaging fixture", shortDescription: "Synthetic integrity input", category: "test",
      components: { skills: 0, mcp: 1, apps: 0 }, converted: { skills: 0, mcp: 1 }, unconvertedMcp: [],
      details: { longDescription: "Synthetic integrity input", developerName: "Fixture", websiteURL: null,
        prompts: [], skills: [], mcpServers: [{ name: "fixture", type: "stdio" }], connectionWarnings: [], apps: [] } });
    writeJson(catalogFile, catalog);
    assert.deepEqual(checkPackagingInputs(inputs), [], "the synthetic package has matching source integrity");
    fs.rmSync(fixtureMcp);
    assert.deepEqual(checkPackagingInputs(inputs),
      ["bundled plugin packaging-fixture fails its install integrity check (PACKAGE_CHANGED)"]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("Release package checks unit: PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
