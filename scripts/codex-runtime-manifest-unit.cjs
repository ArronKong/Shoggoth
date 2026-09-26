#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const manifestPath = path.join(__dirname, "..", "build", "codex-runtime-manifest.json");
const fetchRuntimePath = path.join(__dirname, "fetch-codex-runtime.mjs");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createArchive(root, entries, includeDotRoot = false) {
  const contentsDirectory = path.join(root, `archive-contents-${crypto.randomUUID()}`);
  const archivePath = path.join(root, `fixture-${crypto.randomUUID()}.tar.gz`);
  fs.mkdirSync(contentsDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(entries)) {
    const entryPath = path.join(contentsDirectory, name);
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, contents);
  }

  const tar = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", contentsDirectory, ...(includeDotRoot ? ["."] : Object.keys(entries))],
    { encoding: "utf8" },
  );
  assert.equal(tar.status, 0, `fixture tar creation failed: ${tar.stderr}`);
  return archivePath;
}

const PACKAGE_DIRECTORIES = [
  "bin",
  "codex-path",
  "codex-resources",
  "codex-resources/zsh",
  "codex-resources/zsh/bin",
];
const PACKAGE_EXECUTABLES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
];
const PACKAGE_REGULAR_FILES = ["codex-package.json"];

function packageMetadata(overrides = {}) {
  return {
    layoutVersion: 1,
    version: "0.149.0",
    target: "aarch64-apple-darwin",
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
    ...overrides,
  };
}

function packageEntries(overrides = {}) {
  return {
    "bin/codex": "fixture-codex-binary\n",
    "bin/codex-code-mode-host": "fixture-code-mode-host\n",
    "codex-package.json": `${JSON.stringify(packageMetadata())}\n`,
    "codex-path/rg": "fixture-ripgrep\n",
    "codex-resources/zsh/bin/zsh": "fixture-zsh\n",
    ...overrides,
  };
}

function createPackageArchive(root, entries = packageEntries(), includeDotRoot = false) {
  const contentsDirectory = path.join(root, `package-contents-${crypto.randomUUID()}`);
  const archivePath = path.join(root, `package-fixture-${crypto.randomUUID()}.tar.gz`);
  fs.mkdirSync(contentsDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(entries)) {
    const entryPath = path.join(contentsDirectory, name);
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, contents);
  }
  const tar = spawnSync(
    "tar",
    [
      "-czf",
      archivePath,
      "-C",
      contentsDirectory,
      ...(includeDotRoot
        ? ["."]
        : [...new Set(Object.keys(entries).map((entry) => entry.split("/")[0]))]),
    ],
    { encoding: "utf8" },
  );
  assert.equal(tar.status, 0, `package fixture tar creation failed: ${tar.stderr}`);
  return archivePath;
}

function createLinkArchive(root, linkType, linkedEntry = "bin/codex-code-mode-host") {
  const contentsDirectory = path.join(root, `link-contents-${crypto.randomUUID()}`);
  const archivePath = path.join(root, `link-fixture-${crypto.randomUUID()}.tar.gz`);
  fs.mkdirSync(contentsDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(packageEntries())) {
    if (name === linkedEntry) continue;
    const entryPath = path.join(contentsDirectory, name);
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, contents);
  }
  const archiveEntry = path.join(contentsDirectory, linkedEntry);
  fs.mkdirSync(path.dirname(archiveEntry), { recursive: true });
  let tarEntries;
  if (linkType === "symlink") {
    fs.symlinkSync("missing-link-target", archiveEntry);
    tarEntries = ["bin", "codex-package.json", "codex-path", "codex-resources"];
  } else {
    const linkSource = path.join(contentsDirectory, "link-source");
    fs.writeFileSync(linkSource, "hard-linked fixture\n");
    fs.linkSync(linkSource, archiveEntry);
    tarEntries = ["link-source", "bin", "codex-package.json", "codex-path", "codex-resources"];
  }
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", contentsDirectory, ...tarEntries], {
    encoding: "utf8",
  });
  assert.equal(tar.status, 0, `fixture tar creation failed: ${tar.stderr}`);
  const listing = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  assert.equal(listing.status, 0, `fixture tar listing failed: ${listing.stderr}`);
  assert.match(listing.stdout, linkType === "symlink" ? /^l/m : /^h/m);
  return archivePath;
}

function writeFixtureManifest(root, archivePath, overrides = {}) {
  const platform = {
    arch: "arm64",
    assetName: "codex-package-aarch64-apple-darwin.tar.gz",
    archiveUrl: "https://github.com/openai/codex/releases/download/rust-v0.149.0/codex-package-aarch64-apple-darwin.tar.gz",
    archiveSha256: sha256(archivePath),
    archiveSize: fs.statSync(archivePath).size,
    archiveEntry: "bin/codex",
    destination: ".vendor/codex/arm64/package/bin/codex",
    packageDestination: ".vendor/codex/arm64/package",
    hostDestination: ".vendor/codex/arm64/package/bin/codex-code-mode-host",
    packageEntries: {
      directories: PACKAGE_DIRECTORIES,
      executableFiles: PACKAGE_EXECUTABLES,
      regularFiles: PACKAGE_REGULAR_FILES,
    },
    ...overrides,
  };
  const manifest = {
    schemaVersion: 1,
    runtime: { name: "codex", version: "0.149.0" },
    platforms: { "darwin-arm64": platform },
  };
  const fixtureManifestPath = path.join(root, `manifest-${crypto.randomUUID()}.json`);
  fs.writeFileSync(fixtureManifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath: fixtureManifestPath };
}

function fixtureDownloader(archivePath, receivedUrls = [], receivedOptions = []) {
  return async (url, destination, options) => {
    receivedUrls.push(url);
    receivedOptions.push(options);
    await fs.promises.copyFile(archivePath, destination);
  };
}

function fakeHttpsGet(routes, requestedUrls) {
  return (url, _options, onResponse) => {
    requestedUrls.push(url.href);
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => {
      request.destroyed = true;
    };
    queueMicrotask(() => {
      const route = routes.get(url.href);
      if (!route) {
        const error = new Error(`unexpected fixture URL: ${url.origin}${url.pathname}`);
        error.code = "UNEXPECTED_FIXTURE_URL";
        request.emit("error", error);
        return;
      }
      if (route.requestError) {
        request.emit("error", route.requestError);
        return;
      }
      const response = route.responseFactory
        ? route.responseFactory()
        : Readable.from(route.body === undefined ? [] : [route.body]);
      response.statusCode = route.statusCode;
      response.headers = route.headers ?? {};
      onResponse(response);
    });
    return request;
  };
}

function fakeCurlSpawn(config, calls) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    let closed = false;

    function close(code, signal = null) {
      if (closed) return;
      closed = true;
      child.emit("close", code, signal);
    }

    child.kill = () => {
      child.killed = true;
      child.stdout.destroy();
      child.stderr.destroy();
      queueMicrotask(() => close(null, "SIGTERM"));
      return true;
    };

    queueMicrotask(() => {
      if (config.stderr) child.stderr.end(config.stderr);
      else child.stderr.end();
      if (config.spawnError) {
        child.emit("error", config.spawnError);
        return;
      }
      if (config.streamError) {
        child.stdout.write(config.partialBody ?? "partial curl body");
        queueMicrotask(() => {
          child.stdout.destroy(config.streamError);
          setImmediate(() => close(config.exitCode ?? 0));
        });
        return;
      }
      child.stdout.end(config.body ?? Buffer.alloc(0));
      setImmediate(() => close(config.exitCode ?? 0));
    });
    return child;
  };
}

async function assertRejectsWithFixture(fetchCodexRuntime, root, archivePath, overrides, pattern) {
  const repoRoot = path.join(root, `repo-${crypto.randomUUID()}`);
  fs.mkdirSync(repoRoot, { recursive: true });
  const fixture = writeFixtureManifest(root, archivePath, overrides);
  await assert.rejects(
    fetchCodexRuntime({
      manifestPath: fixture.manifestPath,
      repoRoot,
      requestedPlatform: "darwin-arm64",
      downloader: fixtureDownloader(archivePath),
    }),
    pattern,
  );
}

async function main() {
  assert.ok(fs.existsSync(manifestPath), "build/codex-runtime-manifest.json must exist");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ["platforms", "runtime", "schema", "schemaVersion"],
    "manifest must not contain unknown top-level fields",
  );
  assert.equal(manifest.schemaVersion, 1);

  assert.deepEqual(Object.keys(manifest.runtime).sort(), [
    "license",
    "name",
    "publishedAt",
    "releaseUrl",
    "tag",
    "version",
  ]);
  assert.equal(manifest.runtime.name, "codex");
  assert.equal(manifest.runtime.version, "0.149.0");
  assert.equal(manifest.runtime.tag, `rust-v${manifest.runtime.version}`);
  assert.equal(
    manifest.runtime.releaseUrl,
    `https://github.com/openai/codex/releases/tag/${manifest.runtime.tag}`,
  );
  assert.equal(manifest.runtime.publishedAt, "2026-08-20T21:04:55Z");
  assert.equal(manifest.runtime.license, "Apache-2.0");

  assert.deepEqual(Object.keys(manifest.schema).sort(), ["directory", "includeExperimental", "version"]);
  assert.equal(manifest.schema.version, manifest.runtime.version);
  assert.equal(manifest.schema.directory, `schemas/codex-app-server/${manifest.runtime.version}`);
  assert.equal(manifest.schema.includeExperimental, false);

  const expectedPlatforms = {
    "darwin-arm64": {
      arch: "arm64",
      assetName: "codex-package-aarch64-apple-darwin.tar.gz",
      archiveUrl:
        "https://releases.openai.com/codex/releases/0.149.0/codex-package-aarch64-apple-darwin.tar.gz",
      archiveSha256: "6c7589a52fe90e3742e35662115a4c55c39715601df0d41345ba8ec8f4221d4e",
      archiveSize: 110045256,
      archiveEntry: "bin/codex",
      destination: ".vendor/codex/arm64/package/bin/codex",
      packageDestination: ".vendor/codex/arm64/package",
      hostDestination: ".vendor/codex/arm64/package/bin/codex-code-mode-host",
      packageEntries: {
        directories: PACKAGE_DIRECTORIES,
        executableFiles: PACKAGE_EXECUTABLES,
        regularFiles: PACKAGE_REGULAR_FILES,
      },
    },
    "darwin-x64": {
      arch: "x64",
      assetName: "codex-package-x86_64-apple-darwin.tar.gz",
      archiveUrl:
        "https://releases.openai.com/codex/releases/0.149.0/codex-package-x86_64-apple-darwin.tar.gz",
      archiveSha256: "ba332e647cc898e3b4e86a3bc6e8db414a124eb88d8480f4707bbc66b0432f9d",
      archiveSize: 119594797,
      archiveEntry: "bin/codex",
      destination: ".vendor/codex/x64/package/bin/codex",
      packageDestination: ".vendor/codex/x64/package",
      hostDestination: ".vendor/codex/x64/package/bin/codex-code-mode-host",
      packageEntries: {
        directories: PACKAGE_DIRECTORIES,
        executableFiles: PACKAGE_EXECUTABLES,
        regularFiles: PACKAGE_REGULAR_FILES,
      },
    },
  };

  assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(expectedPlatforms).sort());

  const destinations = new Set();
  for (const [platformName, expected] of Object.entries(expectedPlatforms)) {
    const platform = manifest.platforms[platformName];
    assert.deepEqual(
      Object.keys(platform).sort(),
      Object.keys(expected).sort(),
      `${platformName}: fields must match the platform contract`,
    );

    assert.equal(typeof platform.arch, "string");
    assert.equal(typeof platform.assetName, "string");
    assert.equal(typeof platform.archiveUrl, "string");
    assert.equal(typeof platform.archiveSha256, "string");
    assert.equal(typeof platform.archiveSize, "number");
    assert.equal(typeof platform.archiveEntry, "string");
    assert.equal(typeof platform.destination, "string");
    assert.equal(typeof platform.packageDestination, "string");
    assert.equal(typeof platform.hostDestination, "string");
    assert.equal(typeof platform.packageEntries, "object");

    const archiveUrl = new URL(platform.archiveUrl);
    assert.equal(archiveUrl.protocol, "https:", `${platformName}.archiveUrl: protocol must be HTTPS`);
    assert.equal(
      archiveUrl.hostname,
      "releases.openai.com",
      `${platformName}.archiveUrl: host must be releases.openai.com`,
    );
    assert.equal(archiveUrl.port, "", `${platformName}.archiveUrl: custom ports are not allowed`);
    assert.equal(archiveUrl.search, "", `${platformName}.archiveUrl: query parameters are not allowed`);
    assert.equal(archiveUrl.hash, "", `${platformName}.archiveUrl: fragments are not allowed`);
    assert.equal(
      archiveUrl.pathname,
      `/codex/releases/${manifest.runtime.version}/${platform.assetName}`,
      `${platformName}.archiveUrl: path must identify the official release asset`,
    );

    assert.match(
      platform.archiveSha256,
      /^[0-9a-f]{64}$/,
      `${platformName}.archiveSha256: must be 64 lowercase hexadecimal characters`,
    );
    assert.ok(
      Number.isInteger(platform.archiveSize) && platform.archiveSize > 0,
      `${platformName}.archiveSize: must be a positive integer`,
    );
    assert.equal(
      platform.destination,
      `.vendor/codex/${platform.arch}/package/bin/codex`,
      `${platformName}.destination: must match the platform architecture`,
    );
    assert.equal(platform.packageDestination, `.vendor/codex/${platform.arch}/package`);
    assert.equal(
      platform.hostDestination,
      `.vendor/codex/${platform.arch}/package/bin/codex-code-mode-host`,
    );
    assert.deepEqual(Object.keys(platform.packageEntries).sort(), [
      "directories",
      "executableFiles",
      "regularFiles",
    ]);
    assert.equal(
      destinations.has(platform.destination),
      false,
      `${platformName}.destination: must be unique`,
    );
    destinations.add(platform.destination);

    assert.deepEqual(platform, expected);
  }

  const runtimeModule = await import(pathToFileURL(fetchRuntimePath).href);
  const {
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    downloadArchive,
    downloadArchiveWithCurl,
    fetchCodexRuntime,
    runTar,
    selectPlatforms,
    validateDownloadUrl,
  } = runtimeModule;
  assert.equal(DEFAULT_DOWNLOAD_TIMEOUT_MS, 120_000);
  assert.equal(typeof downloadArchive, "function", "downloadArchive must be exported");
  assert.equal(
    typeof downloadArchiveWithCurl,
    "function",
    "downloadArchiveWithCurl must be exported",
  );
  assert.equal(typeof fetchCodexRuntime, "function", "fetchCodexRuntime must be exported");
  assert.equal(typeof runTar, "function", "runTar must be exported");
  assert.equal(typeof selectPlatforms, "function", "selectPlatforms must be exported");
  assert.equal(typeof validateDownloadUrl, "function", "validateDownloadUrl must be exported");

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-unit-"));
  try {
    const goodArchive = createPackageArchive(fixtureRoot);
    const repoRoot = path.join(fixtureRoot, "success-repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const fixture = writeFixtureManifest(fixtureRoot, goodArchive);
    const receivedUrls = [];
    const receivedDownloadOptions = [];
    const [result] = await fetchCodexRuntime({
      manifestPath: fixture.manifestPath,
      repoRoot,
      requestedPlatform: "darwin-arm64",
      downloader: fixtureDownloader(goodArchive, receivedUrls, receivedDownloadOptions),
    });
    const installedPath = path.join(repoRoot, ".vendor", "codex", "arm64", "package", "bin", "codex");
    const installedHostPath = path.join(repoRoot, ".vendor", "codex", "arm64", "package", "bin", "codex-code-mode-host");
    assert.equal(fs.readFileSync(installedPath, "utf8"), "fixture-codex-binary\n");
    assert.equal(fs.readFileSync(installedHostPath, "utf8"), "fixture-code-mode-host\n");
    assert.equal(fs.statSync(installedPath).mode & 0o777, 0o755);
    assert.equal(fs.statSync(installedHostPath).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(repoRoot, ".vendor", "codex", "arm64", "package", "codex-path", "rg")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(repoRoot, ".vendor", "codex", "arm64", "package", "codex-resources", "zsh", "bin", "zsh")).mode & 0o777, 0o755);
    assert.deepEqual(receivedUrls, [fixture.manifest.platforms["darwin-arm64"].archiveUrl]);
    assert.deepEqual(receivedDownloadOptions, [
      { expectedSize: fixture.manifest.platforms["darwin-arm64"].archiveSize },
    ]);
    assert.deepEqual(result, {
      platform: "darwin-arm64",
      version: "0.149.0",
      destination: installedPath,
      hostDestination: installedHostPath,
      packageDestination: path.join(repoRoot, ".vendor", "codex", "arm64", "package"),
      archiveSha256: fixture.manifest.platforms["darwin-arm64"].archiveSha256,
    });

    const dotArchive = createPackageArchive(
      fixtureRoot,
      packageEntries({ "bin/codex": "dot-prefixed-fixture\n" }),
      true,
    );
    const dotRepoRoot = path.join(fixtureRoot, "dot-prefix-repo");
    fs.mkdirSync(dotRepoRoot, { recursive: true });
    const dotFixture = writeFixtureManifest(fixtureRoot, dotArchive);
    await fetchCodexRuntime({
      manifestPath: dotFixture.manifestPath,
      repoRoot: dotRepoRoot,
      requestedPlatform: "darwin-arm64",
      downloader: fixtureDownloader(dotArchive),
    });
    assert.equal(
      fs.readFileSync(path.join(dotRepoRoot, ".vendor", "codex", "arm64", "package", "bin", "codex"), "utf8"),
      "dot-prefixed-fixture\n",
    );

    await assertRejectsWithFixture(
      fetchCodexRuntime,
      fixtureRoot,
      goodArchive,
      { archiveSha256: "0".repeat(64) },
      /darwin-arm64.*archiveSha256/i,
    );
    await assertRejectsWithFixture(
      fetchCodexRuntime,
      fixtureRoot,
      goodArchive,
      { archiveSize: fs.statSync(goodArchive).size + 1 },
      /darwin-arm64.*archiveSize/i,
    );

    const extraEntryArchive = createPackageArchive(fixtureRoot, packageEntries({
      unexpected: "not allowed\n",
    }));
    await assertRejectsWithFixture(
      fetchCodexRuntime,
      fixtureRoot,
      extraEntryArchive,
      {},
      /darwin-arm64.*packageEntries/i,
    );
    const missingHostEntries = packageEntries();
    delete missingHostEntries["bin/codex-code-mode-host"];
    const missingHostArchive = createPackageArchive(fixtureRoot, missingHostEntries);
    await assertRejectsWithFixture(
      fetchCodexRuntime,
      fixtureRoot,
      missingHostArchive,
      {},
      /darwin-arm64.*packageEntries.*codex-code-mode-host/i,
    );
    for (const [label, metadata, pattern] of [
      ["malformed", "{not-json\n", /codex-package\.json.*valid JSON/i],
      ["version", `${JSON.stringify(packageMetadata({ version: "0.150.0" }))}\n`, /codex-package\.json.*version/i],
      ["target", `${JSON.stringify(packageMetadata({ target: "x86_64-apple-darwin" }))}\n`, /codex-package\.json.*target/i],
      ["layout", `${JSON.stringify(packageMetadata({ layoutVersion: 2 }))}\n`, /codex-package\.json.*layoutVersion/i],
      ["entrypoint", `${JSON.stringify(packageMetadata({ entrypoint: "bin/not-codex" }))}\n`, /codex-package\.json.*entrypoint/i],
      ["resources", `${JSON.stringify(packageMetadata({ resourcesDir: "other-resources" }))}\n`, /codex-package\.json.*resourcesDir/i],
      ["path", `${JSON.stringify(packageMetadata({ pathDir: "other-path" }))}\n`, /codex-package\.json.*pathDir/i],
      ["variant", `${JSON.stringify(packageMetadata({ variant: "codex-app-server" }))}\n`, /codex-package\.json.*variant/i],
    ]) {
      const invalidMetadataArchive = createPackageArchive(
        fixtureRoot,
        packageEntries({ "codex-package.json": metadata }),
      );
      await assertRejectsWithFixture(
        fetchCodexRuntime,
        fixtureRoot,
        invalidMetadataArchive,
        {},
        pattern,
      );
    }
    for (const linkType of ["symlink", "hardlink"]) {
      const linkArchive = createLinkArchive(fixtureRoot, linkType);
      await assertRejectsWithFixture(
        fetchCodexRuntime,
        fixtureRoot,
        linkArchive,
        {},
        /darwin-arm64.*packageEntries.*regular file/i,
      );
    }

    const hangingTarCalls = [];
    const hangingTarSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        hangingTarCalls.push(signal);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", null, signal));
        return true;
      };
      return child;
    };
    const tarStartedAt = Date.now();
    await assert.rejects(
      runTar(["-tzf", "fixture.tar.gz"], "darwin-arm64", "archiveEntry", true, {
        spawnImpl: hangingTarSpawn,
        timeoutMs: 10,
        terminationGraceMs: 100,
      }),
      /tar timed out/i,
    );
    assert.equal(hangingTarCalls.length, 1, "timed-out tar must be terminated exactly once");
    assert.equal(Date.now() - tarStartedAt < 500, true, "tar timeout must settle after close");

    let destinationValidationDownloads = 0;
    for (const overrides of [
      { destination: "../outside/codex" },
      { destination: ".vendor/codex/arm64/not-codex" },
      { packageDestination: "../outside/package" },
      { packageDestination: ".vendor/codex/arm64/not-package" },
      { hostDestination: ".vendor/codex/arm64/package/bin/not-host" },
      { packageEntries: { directories: [], executableFiles: [], regularFiles: [] } },
    ]) {
      const invalidFixture = writeFixtureManifest(fixtureRoot, goodArchive, overrides);
      await assert.rejects(
        fetchCodexRuntime({
          manifestPath: invalidFixture.manifestPath,
          repoRoot,
          requestedPlatform: "darwin-arm64",
          downloader: async () => {
            destinationValidationDownloads += 1;
          },
        }),
        /darwin-arm64.*(destination|packageEntries)/i,
      );
    }
    assert.equal(destinationValidationDownloads, 0, "invalid destinations must fail before download");

    const failedDownloadFixture = writeFixtureManifest(fixtureRoot, goodArchive);
    await assert.rejects(
      fetchCodexRuntime({
        manifestPath: failedDownloadFixture.manifestPath,
        repoRoot,
        requestedPlatform: "darwin-arm64",
        downloader: async () => {
          throw new Error("fixture transport failed");
        },
      }),
      /darwin-arm64.*archiveUrl.*fixture transport failed/i,
    );

    assert.deepEqual(selectPlatforms(undefined, "darwin", "arm64"), ["darwin-arm64"]);
    assert.deepEqual(selectPlatforms(undefined, "darwin", "x64"), ["darwin-x64"]);
    assert.deepEqual(selectPlatforms("all", "linux", "x64"), ["darwin-arm64", "darwin-x64"]);
    assert.throws(() => selectPlatforms(undefined, "linux", "x64"), /unsupported.*linux.*x64/i);
    assert.throws(() => selectPlatforms("linux-x64", "darwin", "arm64"), /unsupported.*linux-x64/i);

    for (const url of [
      "https://releases.openai.com/codex/releases/0.149.0/codex-fixture.tar.gz",
      "https://github.com/openai/codex/releases/download/tag/asset.tar.gz",
      "https://release-assets.githubusercontent.com/github-production-release-asset/file?sp=signed",
      "https://objects.githubusercontent.com/github-production-release-asset/file?sig=signed",
    ]) {
      assert.equal(validateDownloadUrl(url).href, new URL(url).href);
    }
    for (const url of [
      "http://github.com/openai/codex/releases/download/tag/asset.tar.gz",
      "https://evil.example/codex.tar.gz",
      "https://releases.openai.com.evil.example/codex.tar.gz",
      "https://github.com.evil.example/codex.tar.gz",
    ]) {
      assert.throws(() => validateDownloadUrl(url), /download URL/i);
    }

    const curlDownloadUrl =
      "https://releases.openai.com/codex/releases/0.149.0/codex-fixture.tar.gz";
    const curlCalls = [];
    const curlDestination = path.join(fixtureRoot, "curl-success.tar.gz");
    await downloadArchiveWithCurl(curlDownloadUrl, curlDestination, {
      expectedSize: Buffer.byteLength("curl fixture body\n"),
      spawnImpl: fakeCurlSpawn({ body: Buffer.from("curl fixture body\n") }, curlCalls),
    });
    assert.equal(fs.readFileSync(curlDestination, "utf8"), "curl fixture body\n");
    assert.equal(curlCalls.length, 1);
    const [curlCall] = curlCalls;
    assert.equal(curlCall.command, "curl");
    assert.deepEqual(curlCall.options, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(curlCall.args[0], "--disable", "--disable must be the first curl argument");
    for (const flag of ["--fail", "--silent", "--show-error", "--location"]) {
      assert.equal(curlCall.args.includes(flag), true, `curl args must include ${flag}`);
    }
    const curlArgument = (name) => curlCall.args[curlCall.args.indexOf(name) + 1];
    assert.equal(curlArgument("--connect-timeout"), "10");
    assert.equal(curlArgument("--max-time"), "300");
    assert.equal(curlArgument("--max-redirs"), "0");
    assert.equal(curlArgument("--proto"), "=https");
    assert.equal(curlArgument("--proto-redir"), "=https");
    assert.equal(curlArgument("--output"), "-");
    assert.equal(curlArgument("--url"), curlDownloadUrl);

    for (const rejectedCurlUrl of [
      "https://github.com/openai/codex/releases/download/tag/asset.tar.gz",
      "https://releases.openai.com.evil.example/codex.tar.gz",
    ]) {
      await assert.rejects(
        downloadArchiveWithCurl(rejectedCurlUrl, path.join(fixtureRoot, "rejected-curl.tar.gz"), {
          spawnImpl: () => assert.fail("curl must not spawn for rejected hosts"),
        }),
        /curl.*releases\.openai\.com/i,
      );
    }

    const oversizedCurlDestination = path.join(fixtureRoot, "curl-oversized.tar.gz");
    const oversizedCurlCalls = [];
    await assert.rejects(
      downloadArchiveWithCurl(curlDownloadUrl, oversizedCurlDestination, {
        expectedSize: 4,
        spawnImpl: fakeCurlSpawn({ body: Buffer.from("too-large") }, oversizedCurlCalls),
      }),
      /exceeded.*4 bytes/i,
    );
    assert.equal(oversizedCurlCalls[0].options.shell, false);
    assert.equal(fs.existsSync(oversizedCurlDestination), false);

    const failedCurlDestination = path.join(fixtureRoot, "curl-nonzero.tar.gz");
    await assert.rejects(
      downloadArchiveWithCurl(curlDownloadUrl, failedCurlDestination, {
        spawnImpl: fakeCurlSpawn(
          {
            body: Buffer.from("failed curl body"),
            exitCode: 22,
            stderr: "curl: URL https://releases.openai.com/file?secret-token leaked",
          },
          [],
        ),
      }),
      (error) => {
        assert.match(error.message, /curl.*status 22/i);
        assert.equal(error.message.includes("secret-token"), false);
        return true;
      },
    );
    assert.equal(fs.existsSync(failedCurlDestination), false);

    const spawnErrorDestination = path.join(fixtureRoot, "curl-spawn-error.tar.gz");
    await assert.rejects(
      downloadArchiveWithCurl(curlDownloadUrl, spawnErrorDestination, {
        spawnImpl: fakeCurlSpawn(
          { spawnError: Object.assign(new Error("curl missing"), { code: "ENOENT" }) },
          [],
        ),
      }),
      /could not start curl.*ENOENT/i,
    );
    assert.equal(fs.existsSync(spawnErrorDestination), false);

    const partialCurlDestination = path.join(fixtureRoot, "curl-partial.tar.gz");
    await assert.rejects(
      downloadArchiveWithCurl(curlDownloadUrl, partialCurlDestination, {
        spawnImpl: fakeCurlSpawn(
          { streamError: new Error("fixture curl stdout failed") },
          [],
        ),
      }),
      /fixture curl stdout failed/i,
    );
    assert.equal(fs.existsSync(partialCurlDestination), false);
    await downloadArchiveWithCurl(curlDownloadUrl, partialCurlDestination, {
      spawnImpl: fakeCurlSpawn({ body: Buffer.from("curl retry succeeded") }, []),
    });
    assert.equal(fs.readFileSync(partialCurlDestination, "utf8"), "curl retry succeeded");

    const preexistingCurlDestination = path.join(fixtureRoot, "curl-preexisting.tar.gz");
    fs.writeFileSync(preexistingCurlDestination, "keep curl destination\n");
    await assert.rejects(
      downloadArchiveWithCurl(curlDownloadUrl, preexistingCurlDestination, {
        spawnImpl: fakeCurlSpawn({ body: Buffer.from("replacement") }, []),
      }),
      /EEXIST/i,
    );
    assert.equal(fs.readFileSync(preexistingCurlDestination, "utf8"), "keep curl destination\n");

    const selectedOpenAiRepo = path.join(fixtureRoot, "selected-openai-repo");
    fs.mkdirSync(selectedOpenAiRepo, { recursive: true });
    const selectedOpenAiFixture = writeFixtureManifest(fixtureRoot, goodArchive, {
      archiveUrl: curlDownloadUrl,
    });
    const selectedTransports = { curl: 0, node: 0 };
    const selectedCurlDownloader = async (_url, destination) => {
      selectedTransports.curl += 1;
      await fs.promises.copyFile(goodArchive, destination);
    };
    const selectedNodeDownloader = async (_url, destination) => {
      selectedTransports.node += 1;
      await fs.promises.copyFile(goodArchive, destination);
    };
    await fetchCodexRuntime({
      manifestPath: selectedOpenAiFixture.manifestPath,
      repoRoot: selectedOpenAiRepo,
      requestedPlatform: "darwin-arm64",
      curlDownloader: selectedCurlDownloader,
      nodeDownloader: selectedNodeDownloader,
    });
    assert.deepEqual(selectedTransports, { curl: 1, node: 0 });

    const selectedGithubRepo = path.join(fixtureRoot, "selected-github-repo");
    fs.mkdirSync(selectedGithubRepo, { recursive: true });
    const selectedGithubFixture = writeFixtureManifest(fixtureRoot, goodArchive);
    await fetchCodexRuntime({
      manifestPath: selectedGithubFixture.manifestPath,
      repoRoot: selectedGithubRepo,
      requestedPlatform: "darwin-arm64",
      curlDownloader: selectedCurlDownloader,
      nodeDownloader: selectedNodeDownloader,
    });
    assert.deepEqual(selectedTransports, { curl: 1, node: 1 });

    const initialDownloadUrl =
      "https://github.com/openai/codex/releases/download/tag/codex-fixture.tar.gz";
    const officialAssetUrl =
      "https://release-assets.githubusercontent.com/github-production-release-asset/codex-fixture?sig=test";
    const originalHttpsGet = https.get;
    https.get = () => {
      throw new Error("native HTTPS transport must not be used by offline unit tests");
    };
    try {
      const redirectRequests = [];
      const redirectDestination = path.join(fixtureRoot, "redirect-download.tar.gz");
      await downloadArchive(initialDownloadUrl, redirectDestination, {
        httpsGet: fakeHttpsGet(
          new Map([
            [initialDownloadUrl, { statusCode: 302, headers: { location: officialAssetUrl } }],
            [officialAssetUrl, { statusCode: 200, body: Buffer.from("redirected archive\n") }],
          ]),
          redirectRequests,
        ),
      });
      assert.deepEqual(redirectRequests, [initialDownloadUrl, officialAssetUrl]);
      assert.equal(fs.readFileSync(redirectDestination, "utf8"), "redirected archive\n");

      const redirectResponseErrors = [];
      const unhandledRejections = [];
      const onUncaughtException = (error) => redirectResponseErrors.push(error);
      const onUnhandledRejection = (error) => unhandledRejections.push(error);
      process.on("uncaughtException", onUncaughtException);
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        const failingRedirectRequests = [];
        const failingRedirectDestination = path.join(
          fixtureRoot,
          "redirect-response-error.tar.gz",
        );
        await assert.rejects(
          downloadArchive(initialDownloadUrl, failingRedirectDestination, {
            httpsGet: fakeHttpsGet(
              new Map([
                [
                  initialDownloadUrl,
                  {
                    statusCode: 302,
                    headers: { location: officialAssetUrl },
                    responseFactory: () => {
                      const response = new EventEmitter();
                      response.destroy = () => {};
                      response.resume = () => {
                        queueMicrotask(() => {
                          response.emit("error", new Error("fixture redirect response failed"));
                        });
                      };
                      return response;
                    },
                  },
                ],
                [officialAssetUrl, { statusCode: 200, body: Buffer.from("must not download") }],
              ]),
              failingRedirectRequests,
            ),
          }),
          /redirect response.*failed/i,
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(redirectResponseErrors, []);
        assert.deepEqual(unhandledRejections, []);
        assert.deepEqual(failingRedirectRequests, [initialDownloadUrl]);
        assert.equal(fs.existsSync(failingRedirectDestination), false);
      } finally {
        process.off("uncaughtException", onUncaughtException);
        process.off("unhandledRejection", onUnhandledRejection);
      }

      const requestErrorDestination = path.join(fixtureRoot, "request-error.tar.gz");
      await assert.rejects(
        downloadArchive(initialDownloadUrl, requestErrorDestination, {
          httpsGet: fakeHttpsGet(
            new Map([
              [
                initialDownloadUrl,
                { requestError: Object.assign(new Error("fixture request failed"), { code: "ECONNRESET" }) },
              ],
            ]),
            [],
          ),
        }),
        /network request error.*ECONNRESET/i,
      );

      for (const [label, route, pattern] of [
        ["non-2xx", { statusCode: 503 }, /HTTP 503/i],
        ["missing-location", { statusCode: 302 }, /no location/i],
      ]) {
        const failedDestination = path.join(fixtureRoot, `${label}.tar.gz`);
        await assert.rejects(
          downloadArchive(initialDownloadUrl, failedDestination, {
            httpsGet: fakeHttpsGet(new Map([[initialDownloadUrl, route]]), []),
          }),
          pattern,
        );
        assert.equal(fs.existsSync(failedDestination), false);
      }

      const loopRequests = [];
      await assert.rejects(
        downloadArchive(initialDownloadUrl, path.join(fixtureRoot, "redirect-loop.tar.gz"), {
          maxRedirects: 1,
          httpsGet: fakeHttpsGet(
            new Map([
              [initialDownloadUrl, { statusCode: 302, headers: { location: initialDownloadUrl } }],
            ]),
            loopRequests,
          ),
        }),
        /too many.*redirects/i,
      );
      assert.deepEqual(loopRequests, [initialDownloadUrl, initialDownloadUrl]);

      let timeoutRequest;
      const timeoutDownload = downloadArchive(
        initialDownloadUrl,
        path.join(fixtureRoot, "timeout.tar.gz"),
        {
          timeoutMs: 10,
          httpsGet: () => {
            timeoutRequest = new EventEmitter();
            timeoutRequest.destroyed = false;
            timeoutRequest.destroy = () => {
              timeoutRequest.destroyed = true;
            };
            return timeoutRequest;
          },
        },
      );
      await assert.rejects(
        Promise.race([
          timeoutDownload,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("test wait expired before download timeout")), 100);
          }),
        ]),
        /download timeout/i,
      );
      assert.equal(timeoutRequest.destroyed, true);

      const partialDestination = path.join(fixtureRoot, "partial-stream.tar.gz");
      const partialRoutes = new Map([
        [
          initialDownloadUrl,
          {
            statusCode: 200,
            responseFactory: () => {
              let started = false;
              return new Readable({
                read() {
                  if (started) return;
                  started = true;
                  this.push(Buffer.from("partial"));
                  queueMicrotask(() => this.destroy(new Error("fixture response stream failed")));
                },
              });
            },
          },
        ],
      ]);
      await assert.rejects(
        downloadArchive(initialDownloadUrl, partialDestination, {
          httpsGet: fakeHttpsGet(partialRoutes, []),
        }),
        /fixture response stream failed/i,
      );
      assert.equal(fs.existsSync(partialDestination), false);
      await downloadArchive(initialDownloadUrl, partialDestination, {
        httpsGet: fakeHttpsGet(
          new Map([[initialDownloadUrl, { statusCode: 200, body: Buffer.from("retry succeeded") }]]),
          [],
        ),
      });
      assert.equal(fs.readFileSync(partialDestination, "utf8"), "retry succeeded");

      const preexistingDestination = path.join(fixtureRoot, "preexisting-download.tar.gz");
      fs.writeFileSync(preexistingDestination, "preexisting content\n");
      await assert.rejects(
        downloadArchive(initialDownloadUrl, preexistingDestination, {
          httpsGet: fakeHttpsGet(
            new Map([[initialDownloadUrl, { statusCode: 200, body: Buffer.from("replacement") }]]),
            [],
          ),
        }),
        /EEXIST/i,
      );
      assert.equal(fs.readFileSync(preexistingDestination, "utf8"), "preexisting content\n");

      const oversizedDestination = path.join(fixtureRoot, "oversized.tar.gz");
      await assert.rejects(
        downloadArchive(initialDownloadUrl, oversizedDestination, {
          expectedSize: 4,
          httpsGet: fakeHttpsGet(
            new Map([[initialDownloadUrl, { statusCode: 200, body: Buffer.from("too-large") }]]),
            [],
          ),
        }),
        /exceeded.*4 bytes/i,
      );
      assert.equal(fs.existsSync(oversizedDestination), false);

      for (const [label, redirectUrl, pattern] of [
        ["http", "http://release-assets.githubusercontent.com/codex-fixture", /HTTPS/i],
        ["evil-host", "https://evil.example/codex-fixture", /host is not allowed/i],
      ]) {
        const rejectedRequests = [];
        const rejectedDestination = path.join(fixtureRoot, `${label}-redirect-download.tar.gz`);
        await assert.rejects(
          downloadArchive(initialDownloadUrl, rejectedDestination, {
            httpsGet: fakeHttpsGet(
              new Map([
                [initialDownloadUrl, { statusCode: 302, headers: { location: redirectUrl } }],
              ]),
              rejectedRequests,
            ),
          }),
          pattern,
        );
        assert.deepEqual(rejectedRequests, [initialDownloadUrl]);
        assert.equal(fs.existsSync(rejectedDestination), false);
      }
    } finally {
      https.get = originalHttpsGet;
    }

    const preservationRepo = path.join(fixtureRoot, "preservation-repo");
    const destinationDirectory = path.join(preservationRepo, ".vendor", "codex", "arm64");
    const packagePath = path.join(destinationDirectory, "package");
    const destinationPath = path.join(packagePath, "bin", "codex");
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, "old-binary\n", { mode: 0o755 });
    fs.writeFileSync(path.join(packagePath, "old-sentinel"), "preserve-on-failure\n");
    const badFixture = writeFixtureManifest(fixtureRoot, goodArchive, {
      archiveSha256: "f".repeat(64),
    });
    await assert.rejects(
      fetchCodexRuntime({
        manifestPath: badFixture.manifestPath,
        repoRoot: preservationRepo,
        requestedPlatform: "darwin-arm64",
        downloader: fixtureDownloader(goodArchive),
      }),
      /archiveSha256/i,
    );
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "old-binary\n");
    assert.equal(fs.readFileSync(path.join(packagePath, "old-sentinel"), "utf8"), "preserve-on-failure\n");
    assert.equal(
      fs.readdirSync(destinationDirectory).some((name) => name.includes("staging") || name.includes("backup") || name.startsWith(".codex-install-")),
      false,
      "failed installs must not leave temporary files",
    );

    const replacementRepo = path.join(fixtureRoot, "replacement-repo");
    const replacementPackage = path.join(replacementRepo, ".vendor", "codex", "arm64", "package");
    fs.mkdirSync(path.join(replacementPackage, "bin"), { recursive: true });
    fs.writeFileSync(path.join(replacementPackage, "bin", "codex"), "old-binary\n");
    fs.writeFileSync(path.join(replacementPackage, "old-sentinel"), "must-disappear\n");
    const replacementFixture = writeFixtureManifest(fixtureRoot, goodArchive);
    await fetchCodexRuntime({
      manifestPath: replacementFixture.manifestPath,
      repoRoot: replacementRepo,
      requestedPlatform: "darwin-arm64",
      downloader: fixtureDownloader(goodArchive),
    });
    assert.equal(
      fs.readFileSync(path.join(replacementPackage, "bin", "codex"), "utf8"),
      "fixture-codex-binary\n",
    );
    assert.equal(fs.existsSync(path.join(replacementPackage, "old-sentinel")), false);

    const rollbackRepo = path.join(fixtureRoot, "rollback-repo");
    const rollbackPackage = path.join(rollbackRepo, ".vendor", "codex", "arm64", "package");
    fs.mkdirSync(path.join(rollbackPackage, "bin"), { recursive: true });
    fs.writeFileSync(path.join(rollbackPackage, "bin", "codex"), "rollback-old-binary\n");
    fs.writeFileSync(path.join(rollbackPackage, "old-sentinel"), "rollback-sentinel\n");
    const rollbackFixture = writeFixtureManifest(fixtureRoot, goodArchive);
    let renameCalls = 0;
    await assert.rejects(
      fetchCodexRuntime({
        manifestPath: rollbackFixture.manifestPath,
        repoRoot: rollbackRepo,
        requestedPlatform: "darwin-arm64",
        downloader: fixtureDownloader(goodArchive),
        renameImpl: async (source, destination) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error("fixture package commit rename failed");
          await fs.promises.rename(source, destination);
        },
      }),
      /commit.*rename failed/i,
    );
    assert.equal(renameCalls, 3, "failed package commit must restore the backup");
    assert.equal(
      fs.readFileSync(path.join(rollbackPackage, "bin", "codex"), "utf8"),
      "rollback-old-binary\n",
    );
    assert.equal(
      fs.readFileSync(path.join(rollbackPackage, "old-sentinel"), "utf8"),
      "rollback-sentinel\n",
    );
    assert.equal(
      fs.readdirSync(path.dirname(rollbackPackage)).some((name) => name.includes("staging") || name.includes("backup") || name.startsWith(".codex-install-")),
      false,
    );

    const combinedFailureRepo = path.join(fixtureRoot, "combined-failure-repo");
    fs.mkdirSync(combinedFailureRepo, { recursive: true });
    const combinedFailureFixture = writeFixtureManifest(fixtureRoot, goodArchive, {
      archiveSha256: "e".repeat(64),
    });
    await assert.rejects(
      fetchCodexRuntime({
        manifestPath: combinedFailureFixture.manifestPath,
        repoRoot: combinedFailureRepo,
        requestedPlatform: "darwin-arm64",
        downloader: fixtureDownloader(goodArchive),
        cleanup: async (temporaryDirectory, options) => {
          await fs.promises.rm(temporaryDirectory, options);
          throw new Error("fixture cleanup failed");
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.message, /install failed.*cleanup failed/i);
        assert.match(error.errors[0].message, /archiveSha256/i);
        assert.match(error.errors[1].message, /fixture cleanup failed/i);
        return true;
      },
    );

    const committedCleanupRepo = path.join(fixtureRoot, "committed-cleanup-repo");
    fs.mkdirSync(committedCleanupRepo, { recursive: true });
    const committedCleanupFixture = writeFixtureManifest(fixtureRoot, goodArchive);
    await assert.rejects(
      fetchCodexRuntime({
        manifestPath: committedCleanupFixture.manifestPath,
        repoRoot: committedCleanupRepo,
        requestedPlatform: "darwin-arm64",
        downloader: fixtureDownloader(goodArchive),
        cleanup: async (temporaryDirectory, options) => {
          await fs.promises.rm(temporaryDirectory, options);
          throw new Error("fixture cleanup failed after rename");
        },
      }),
      /install committed.*cleanup failed/i,
    );
    assert.equal(
      fs.readFileSync(
        path.join(committedCleanupRepo, ".vendor", "codex", "arm64", "package", "bin", "codex"),
        "utf8",
      ),
      "fixture-codex-binary\n",
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log("[codex-runtime-manifest-unit] PASS");
}

main().catch((error) => {
  console.error("[codex-runtime-manifest-unit] FAIL");
  console.error(error);
  process.exitCode = 1;
});
