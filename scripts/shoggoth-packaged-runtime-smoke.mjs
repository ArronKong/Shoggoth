#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const configuredArtifactRoot = process.env.SHOGGOTH_SMOKE_DIST_DIR;
if (configuredArtifactRoot !== undefined
  && (!path.isAbsolute(configuredArtifactRoot)
    || configuredArtifactRoot.includes("\0")
    || !configuredArtifactRoot.isWellFormed())) {
  throw new Error("SHOGGOTH_SMOKE_DIST_DIR must be a well-formed absolute path");
}
const ARTIFACT_ROOT = configuredArtifactRoot === undefined
  ? path.join(REPO_ROOT, "dist")
  : path.normalize(configuredArtifactRoot);
const require = createRequire(import.meta.url);
const { extractFile: extractAsarFile, listPackage: listAsarFiles } = require("@electron/asar");
const yauzl = require("yauzl");
const OUTPUT_LIMIT = 512 * 1024;
// Rosetta 首次冷启动可能需要几十秒；保持有界，但不要把冷启动误判为 runtime 失败。
const TIMEOUT_MS = 90_000;
const EXPECTED_DIRECTORIES = ["bin", "codex-path", "codex-resources", "codex-resources/zsh", "codex-resources/zsh/bin"];
const EXPECTED_FILES = ["bin/codex", "bin/codex-code-mode-host", "codex-package.json", "codex-path/rg", "codex-resources/zsh/bin/zsh"];
const MACHO_MAGIC = new Set([
  "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
  "feedface", "cefaedfe", "feedfacf", "cffaedfe",
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (name, previous, chunk) => {
      const next = previous + chunk.toString("utf8");
      if (Buffer.byteLength(next) > (options.outputLimit ?? OUTPUT_LIMIT)) {
        child.kill("SIGKILL");
        finish(new Error(`${name} exceeded output limit`));
      }
      return next;
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${path.basename(command)} timed out`));
    }, options.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout = append("stdout", stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append("stderr", stderr, chunk); });
    child.once("error", finish);
    child.once("close", (code, signal) => finish(undefined, { code, signal, stdout, stderr }));
  });
}

async function verifyPackagedRunAsNode(appPath, electronExecutable) {
  const canonicalAppPath = await realpath(appPath);
  const resourcesPath = path.join(canonicalAppPath, "Contents", "Resources");
  const canonicalExecutable = path.join(canonicalAppPath, "Contents", "MacOS", "Shoggoth");
  const bootstrapPath = path.join(resourcesPath, "app.asar", "app", "bootstrap.js");
  const relayPath = path.join(resourcesPath, "app.asar", "app", "runtime-mcp-relay.js");
  const agentServicePath = path.join(resourcesPath, "app.asar", "app", "agent-service.js");
  const agentServiceServerPath = path.join(
    resourcesPath, "app.asar", "app", "agent-service", "server.js",
  );
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-run-as-node-"));
  await chmod(scratchPath, 0o700);
  try {
    const probe = await runCaptured(electronExecutable, ["-e", `
      "use strict";
      const { execFileSync } = require("node:child_process");
      (async () => {
        const relay = require(${JSON.stringify(relayPath)});
        const agentService = require(${JSON.stringify(agentServicePath)});
        const agentServiceServer = require(${JSON.stringify(agentServiceServerPath)});
        await new Promise((resolve) => setTimeout(resolve, 750));
        const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
          encoding: "utf8", maxBuffer: 1024 * 1024,
        }).split("\\n").map((line) => /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/u.exec(line))
          .filter(Boolean).map((match) => ({
            pid: Number(match[1]), ppid: Number(match[2]), command: match[3],
          }));
        const descendants = [];
        const pending = [process.pid];
        while (pending.length > 0) {
          const parentPid = pending.shift();
          for (const row of rows) {
            if (row.ppid !== parentPid || descendants.some((item) => item.pid === row.pid)) continue;
            descendants.push(row);
            pending.push(row.pid);
          }
        }
        process.stdout.write(JSON.stringify({
          execPath: process.execPath,
          resourcesPath: process.resourcesPath,
          nodeVersion: process.versions.node,
          electronVersion: process.versions.electron,
          bootstrapResolved: require.resolve(${JSON.stringify(bootstrapPath)}),
          relayResolved: require.resolve(${JSON.stringify(relayPath)}),
          relayStartType: typeof relay.startRuntimeMcpRelay,
          agentServiceResolved: require.resolve(${JSON.stringify(agentServicePath)}),
          agentServiceStartType: typeof agentService.startAgentServiceProcess,
          agentServiceServerResolved: require.resolve(${JSON.stringify(agentServiceServerPath)}),
          agentServiceCreateType: typeof agentServiceServer.createAgentService,
          forbiddenDescendants: descendants.filter(({ command }) => (
            /--type=gpu-process|network\\.mojom\\.NetworkService|Network Service/u.test(command)
          )),
        }));
      })().catch((error) => {
        process.stderr.write(String(error?.stack || error));
        process.exitCode = 1;
      });
    `], {
      cwd: scratchPath,
      timeoutMs: TIMEOUT_MS,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        HOME: scratchPath,
        PATH: "/usr/bin:/bin",
        TMPDIR: scratchPath,
      },
    });
    assert.equal(probe.code, 0, `${appPath} RunAsNode probe failed: ${probe.stderr}`);
    const result = JSON.parse(probe.stdout);
    assert.equal(result.execPath, canonicalExecutable);
    assert.equal(result.resourcesPath, resourcesPath);
    assert.match(result.nodeVersion, /^\d+\.\d+\.\d+$/u);
    assert.match(result.electronVersion, /^\d+\.\d+\.\d+$/u);
    assert.equal(result.bootstrapResolved, bootstrapPath);
    assert.equal(result.relayResolved, relayPath);
    assert.equal(result.relayStartType, "function");
    assert.equal(result.agentServiceResolved, agentServicePath);
    assert.equal(result.agentServiceStartType, "function");
    assert.equal(result.agentServiceServerResolved, agentServiceServerPath);
    assert.equal(result.agentServiceCreateType, "function");
    assert.deepEqual(result.forbiddenDescendants, [],
      "RunAsNode must not start GPU or Network Service child processes");
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function verifyPackagedService(appPath) {
  const canonicalAppPath = await realpath(appPath);
  const resourcesPath = path.join(canonicalAppPath, "Contents", "Resources");
  const appRoot = path.join(resourcesPath, "app.asar", "app");
  // A short, canonical root also keeps the macOS Unix socket under its byte limit.
  const scratchPath = await realpath(await mkdtemp(path.join(tmpdir(), "sg-svc-")));
  await chmod(scratchPath, 0o700);
  try {
    const probe = await runCaptured(path.join(canonicalAppPath, "Contents", "MacOS", "Shoggoth"), ["-e", `
      const assert = require("node:assert/strict");
      const path = require("node:path");
      const crypto = require("node:crypto");
      const appRoot = ${JSON.stringify(appRoot)};
      const { createAgentService, PROTOCOL_VERSION } = require(path.join(appRoot, "agent-service/server.js"));
      const { resolveServicePaths } = require(path.join(appRoot, "agent-service/paths.js"));
      const { requestService, readClientToken } = require(path.join(appRoot, "agent-service/client.js"));
      const { DEFAULT_AGENT_PROFILE_ID: profileId } = require(path.join(appRoot, "agent-service/product-store.js"));
      const { CHUNK_BYTES } = require(path.join(appRoot, "agent-service/inspiration-media.js"));
      const root = ${JSON.stringify(scratchPath)};
      const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
        profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
      // Synthetic data only. Never unlock the real user's keychain or launch a model.
      const safeStorage = { isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() };
      const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(),
        token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
      (async () => {
        let session;
        let idea;
        const image = Buffer.alloc(CHUNK_BYTES + 31, 42);
        Buffer.from("89504e470d0a1a0a", "hex").copy(image);
        const voice = Buffer.alloc(80); voice.write("RIFF"); voice.write("WAVE", 8);
        const media = [
          { data: image, attachment: { id: crypto.randomUUID(), name: "packaged-note.png", mimeType: "image/png", size: image.length } },
          { data: voice, attachment: { id: crypto.randomUUID(), name: "packaged-voice.wav", mimeType: "audio/wav", size: voice.length } },
        ];
        for (let generation = 0; generation < 2; generation++) {
          const service = createAgentService({ paths, safeStorage, prewarmMcpAuth: true,
            packaged: true, resourcesPath: ${JSON.stringify(resourcesPath)}, parentEnv: {},
            runtimeStorageHomedir: root, version: "packaged-service-smoke" });
          try {
            await service.start();
            let status;
            for (let attempt = 0; attempt < 100; attempt++) {
              status = await ipc("service.status", {});
              if (!status.pendingCommandsLocked && !status.mcpCredentialsLocked) break;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(status.healthy, true);
            assert.equal(status.pendingCommandsLocked, false);
            assert.equal(status.mcpCredentialsLocked, false);
            if (generation === 0) {
              session = service.chatSessionStore.listSessions()[0];
              assert.ok(session, "default chat session must exist");
              service.transcriptStore.appendEvent({ profileId, sessionId: session.id,
                id: "packaged-chat-event", kind: "user", content: { text: "Packaged chat history survives restart" } });
              for (const item of media) {
                for (let offset = 0; offset < item.data.length; offset += CHUNK_BYTES) {
                  await ipc("inspiration.media.write", { attachment: item.attachment, offset,
                    content: item.data.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
                }
              }
              idea = (await ipc("inspiration.create", { operationId: "packaged-idea",
                body: "Packaged SQLite persistence regression", attachments: media.map(item => item.attachment) })).idea;
            }
            const sessions = await ipc("chat.session.list", {
              profileId, cursor: null, limit: 10, includeArchived: false });
            assert.ok(sessions.sessions.some(item => item.sessionKey === session.sessionKey));
            const transcript = await ipc("harness.transcript.events", {
              profileId, sessionId: session.id, cursor: 0, limit: 10 });
            assert.ok(JSON.stringify(transcript).includes("Packaged chat history survives restart"));
            const history = await ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 10 });
            assert.ok(JSON.stringify(history.messages).includes("Packaged chat history survives restart"));
            const saved = await ipc("inspiration.get", { id: idea.id });
            assert.equal(saved.idea.body, idea.body);
            assert.deepEqual(saved.idea.attachments, media.map(item => item.attachment));
            for (const item of media) {
              const chunks = [];
              for (let offset = 0; offset < item.data.length; offset += CHUNK_BYTES) {
                const chunk = await ipc("inspiration.media.read", { id: item.attachment.id, offset });
                assert.deepEqual(chunk.attachment, item.attachment);
                chunks.push(Buffer.from(chunk.content, "base64"));
              }
              assert.deepEqual(Buffer.concat(chunks), item.data, "packaged media survives Service restart byte for byte");
            }
            const search = await ipc("inspiration.list", { query: "SQLite", filter: "all", cursor: null, limit: 10 });
            assert.deepEqual(search.items.map(item => item.id), [idea.id]);
          } finally { await service.stop({ notify: false }); }
        }
        process.stdout.write("PACKAGED_SERVICE_PERSISTENCE_OK");
      })().catch(error => { process.stderr.write(String(error?.stack || error)); process.exitCode = 1; });
    `], {
      cwd: scratchPath,
      env: { ELECTRON_RUN_AS_NODE: "1", HOME: scratchPath, PATH: "/usr/bin:/bin", TMPDIR: scratchPath },
    });
    assert.equal(probe.code, 0, `packaged Agent Service startup/persistence failed: ${probe.stderr}`);
    assert.ok(probe.stdout.includes("PACKAGED_SERVICE_PERSISTENCE_OK"));
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function listPackage(root) {
  const directories = [];
  const files = [];
  async function visit(current, relative = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      const entryStat = await lstat(entryPath);
      assert.equal(entryStat.isSymbolicLink(), false, `${entryRelative} must not be a symlink`);
      if (entryStat.isDirectory()) {
        directories.push(entryRelative);
        await visit(entryPath, entryRelative);
      } else {
        assert.equal(entryStat.isFile(), true, `${entryRelative} must be a regular file`);
        assert.equal(entryStat.nlink, 1, `${entryRelative} must not be hard linked`);
        files.push(entryRelative);
      }
    }
  }
  await visit(root);
  return { directories: directories.sort(), files: files.sort() };
}

async function verifyPackage(packageRoot, expected) {
  const packageStat = await lstat(packageRoot);
  assert.equal(packageStat.isDirectory(), true);
  assert.equal(packageStat.isSymbolicLink(), false);
  assert.deepEqual(await listPackage(packageRoot), {
    directories: [...EXPECTED_DIRECTORIES].sort(),
    files: [...EXPECTED_FILES].sort(),
  });
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "codex-package.json"), "utf8"));
  assert.deepEqual(metadata, {
    layoutVersion: 1,
    version: "0.149.0",
    target: expected.target,
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  });
  for (const executable of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/zsh/bin/zsh"]) {
    const executableStat = await stat(path.join(packageRoot, executable));
    assert.equal((executableStat.mode & 0o111) !== 0, true, `${executable} must be executable`);
  }
}

async function sha256(target) {
  return crypto.createHash("sha256").update(await readFile(target)).digest("hex");
}

function normalizeThinMachOLinkeditSize(binary) {
  const magic = binary.subarray(0, 4).toString("hex");
  const littleEndian = magic === "cffaedfe";
  if (!littleEndian && magic !== "feedfacf") return binary;
  const readU32 = littleEndian
    ? (offset) => binary.readUInt32LE(offset)
    : (offset) => binary.readUInt32BE(offset);
  const commandCount = readU32(16);
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > binary.length) throw new Error("truncated Mach-O load commands");
    const command = readU32(offset);
    const commandSize = readU32(offset + 4);
    if (commandSize < 8 || offset + commandSize > binary.length) {
      throw new Error("invalid Mach-O load command size");
    }
    if (command === 0x19 && commandSize >= 72) {
      const segment = binary.subarray(offset + 8, offset + 24)
        .toString("ascii").replace(/\0+$/u, "");
      if (segment === "__LINKEDIT") {
        // codesign grows/shrinks both the virtual and physical link-edit
        // extents to fit its signature superblob.
        binary.fill(0, offset + 32, offset + 40);
        binary.fill(0, offset + 48, offset + 56);
      }
    }
    offset += commandSize;
  }
  return binary;
}

async function unsignedMachOIdentity(target) {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-unsigned-macho-"));
  await chmod(scratchPath, 0o700);
  const copyPath = path.join(scratchPath, "binary");
  try {
    // The package can be nearly 1 GiB. macOS cp -c uses clonefile so
    // signature normalization does not require another full physical copy.
    const cloned = await runCaptured("/bin/cp", ["-c", target, copyPath]);
    assert.equal(cloned.code, 0, `${target} could not be cloned for signature normalization`);
    const removed = await runCaptured("/usr/bin/codesign", ["--remove-signature", copyPath]);
    assert.equal(removed.code, 0, `${target} signature could not be normalized`);
    const binary = normalizeThinMachOLinkeditSize(await readFile(copyPath));
    return {
      size: binary.length,
      sha256: crypto.createHash("sha256").update(binary).digest("hex"),
    };
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function isMachO(target) {
  const handle = await open(target, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return bytesRead === magic.length && MACHO_MAGIC.has(magic.toString("hex"));
  } finally {
    await handle.close();
  }
}

async function listPhysicalFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const entryStat = await lstat(target);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) await visit(target);
      else if (entryStat.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function verifyEveryMachOSigned(appPath) {
  let count = 0;
  for (const target of await listPhysicalFiles(appPath)) {
    if (!await isMachO(target)) continue;
    count += 1;
    const verified = await runCaptured("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", target]);
    assert.equal(verified.code, 0, `unsigned or invalid Mach-O: ${path.relative(appPath, target)}`);
  }
  assert.equal(count > 10, true, "packaged App did not expose the expected Mach-O surface");
  return count;
}

async function verifyPackagedCua(appPath, archivePath, electronExecutable, expected) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const manifest = JSON.parse(await readFile(path.join(resourcesPath, "cua-driver", "manifest.json"), "utf8"));
  const sourceManifest = JSON.parse(await readFile(
    path.join(REPO_ROOT, "build", "cua-driver-manifest.json"), "utf8",
  ));
  assert.deepEqual(manifest, sourceManifest);
  assert.equal(manifest.version, "0.22.0");
  assert.equal(manifest.contractVersion, "0.7.0");
  const binary = path.join(resourcesPath, "cua-driver", "cua-driver");
  const sourceBinary = path.join(REPO_ROOT, ".vendor", "cua", "package", "cua-driver");
  assert.equal((await stat(sourceBinary)).size, manifest.binarySizeBytes);
  assert.equal(await sha256(sourceBinary), manifest.binarySha256);
  const packagedIdentity = { size: (await stat(binary)).size, sha256: await sha256(binary) };
  const sourceIdentity = { size: manifest.binarySizeBytes, sha256: manifest.binarySha256 };
  if (!Object.is(packagedIdentity.size, sourceIdentity.size)
    || packagedIdentity.sha256 !== sourceIdentity.sha256) {
    // App-level signing intentionally replaces nested signatures. Normalize
    // both Mach-O files so supply-chain verification compares executable code,
    // not the mutable code-signature blob.
    assert.deepEqual(
      await unsignedMachOIdentity(binary),
      await unsignedMachOIdentity(sourceBinary),
    );
  }
  const architectures = await runCaptured("/usr/bin/lipo", ["-archs", binary]);
  assert.equal(architectures.code, 0);
  assert.deepEqual(architectures.stdout.trim().split(/\s+/u).sort(), ["arm64", "x86_64"]);

  const nativePackages = [
    `@trycua/cua-driver-darwin-${expected.arch}`,
    `@ubjs/node-darwin-${expected.arch}`,
  ];
  assert.equal(JSON.parse(extractAsarFile(
    archivePath, "node_modules/@trycua/cua-driver/package.json",
  ).toString("utf8")).version, "0.22.0");
  for (const packageName of nativePackages) {
    const metadata = JSON.parse(extractAsarFile(
      archivePath, `node_modules/${packageName}/package.json`,
    ).toString("utf8"));
    assert.deepEqual(metadata.os, ["darwin"]);
    assert.deepEqual(metadata.cpu, [expected.arch]);
  }
  const unpacked = path.join(resourcesPath, "app.asar.unpacked", "node_modules");
  for (const nested of [
    path.join(unpacked, "@trycua", "cua-driver", "node_modules"),
    path.join(unpacked, "@ubjs", "node", "node_modules"),
  ]) await assert.rejects(access(nested), (error) => error?.code === "ENOENT");
  await access(path.join(unpacked, `@trycua/cua-driver-darwin-${expected.arch}`, "cua_driver_node_runtime.node"));
  await access(path.join(unpacked, `@trycua/cua-driver-darwin-${expected.arch}`, "libcua_driver_sdk.dylib"));
  await access(path.join(unpacked, `@ubjs/node-darwin-${expected.arch}`,
    `uniffi-runtime-napi.darwin-${expected.arch}.node`));

  for (const legalName of [
    "SHOGGOTH-LICENSE.txt", "ELECTRON-LICENSE.txt", "LICENSES.chromium.html", "CODEX-LICENSE.txt", "CODEX-NOTICE.txt",
    "MPL-2.0.txt", "RUNTIME-LICENSE-SOURCES.md",
    "LICENSE-SHA256SUMS", "third-party-index.json", "CUA-LICENSE.md", "CUA-NOTICE.md",
    "THIRD-PARTY-NOTICES.md", "release-sbom.cdx.json",
  ]) await access(path.join(resourcesPath, "legal", legalName));
  const sbom = JSON.parse(await readFile(path.join(resourcesPath, "legal", "release-sbom.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.components.some((component) => (
    component.name === `@trycua/cua-driver-darwin-${expected.arch}`
  )), true);

  const sdkEntry = path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@trycua", "cua-driver", "dist", "index.js");
  const sdkProbe = await runCaptured(electronExecutable, ["-e", `
    const { pathToFileURL } = require("node:url");
    (async () => {
      const sdk = await import(pathToFileURL(${JSON.stringify(sdkEntry)}).href);
      const status = await Promise.resolve(sdk.currentMacOsPermissionStatus());
      process.stdout.write(JSON.stringify({
        loaded: typeof sdk.CuaDriver?.createPrivateWorker === "function",
        accessibility: status?.accessibility === true,
        screenRecording: status?.screenRecording === true,
      }));
    })().catch((error) => { process.stderr.write(String(error?.message || error)); process.exitCode = 1; });
  `], {
    timeoutMs: TIMEOUT_MS,
    env: {
      ELECTRON_RUN_AS_NODE: "1", HOME: tmpdir(), PATH: process.env.PATH ?? "", TMPDIR: tmpdir(),
    },
  });
  assert.equal(sdkProbe.code, 0, `packaged Cua SDK load failed: ${sdkProbe.stderr}`);
  assert.equal(JSON.parse(sdkProbe.stdout).loaded, true);
}

function verifyClaudeExcluded(archivePath) {
  assert.equal(listAsarFiles(archivePath).some((file) =>
    /node_modules[/\\]@anthropic-ai[/\\]claude-agent-sdk/.test(file)), false,
  "Claude Agent SDK must not be redistributed while its terms are unresolved");
  const policy = JSON.parse(extractAsarFile(archivePath, "app/release-policy.json"));
  assert.ok(policy.disabledRuntimes.includes("claude-code"));
  const pkg = JSON.parse(extractAsarFile(archivePath, "package.json"));
  assert.equal(pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"], undefined);
}

async function verifyPackagedPiExtension(appPath, electronExecutable) {
  const extensionPath = path.join(
    appPath, "Contents", "Resources", "pi", "shoggoth-pi-extension.mjs",
  );
  await access(extensionPath);
  const probe = await runCaptured(electronExecutable, ["-e", `
    const { pathToFileURL } = require("node:url");
    import(pathToFileURL(${JSON.stringify(extensionPath)}).href).then((extension) => {
      process.stdout.write(typeof extension.default);
    }).catch((error) => {
      process.stderr.write(String(error?.stack || error));
      process.exitCode = 1;
    });
  `], {
    timeoutMs: TIMEOUT_MS,
    env: {
      ELECTRON_RUN_AS_NODE: "1", HOME: tmpdir(), PATH: "/usr/bin:/bin", TMPDIR: tmpdir(),
    },
  });
  assert.equal(probe.code, 0, `packaged Pi extension load failed: ${probe.stderr}`);
  assert.equal(probe.stdout, "function");
}

async function verifyPackagedDeepSeekHarnessBridge(appPath, electronExecutable) {
  const bridgePath = path.join(
    appPath, "Contents", "Resources", "deepseek-harness", "shoggoth-dsh-bridge.mjs",
  );
  await access(bridgePath);
  const probe = await runCaptured(electronExecutable, ["--check", bridgePath], {
    timeoutMs: TIMEOUT_MS,
    env: {
      ELECTRON_RUN_AS_NODE: "1", HOME: tmpdir(), PATH: "/usr/bin:/bin", TMPDIR: tmpdir(),
    },
  });
  assert.equal(probe.code, 0, `packaged DeepSeek Harness Bridge check failed: ${probe.stderr}`);
}

async function verifySourceContract(onlyArch = null) {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies?.["electron-updater"], "6.8.9");
  assert.equal(packageJson.repository?.url, "https://github.com/ArronKong/Shoggoth.git");
  assert.equal(
    packageJson.scripts?.dist,
    "npm run build:manage && npm run prepare:runtimes && npm run release:metadata && electron-builder --mac",
    "dist must build the Manage UI before packaging",
  );
  const agentService = require(path.join(REPO_ROOT, "app", "agent-service.js"));
  const agentServiceServer = require(path.join(REPO_ROOT, "app", "agent-service", "server.js"));
  assert.equal(typeof agentService.startAgentServiceProcess, "function");
  assert.equal(typeof agentServiceServer.createAgentService, "function");
  const builder = await readFile(path.join(REPO_ROOT, "electron-builder.yml"), "utf8");
  assert.match(builder, /files:[\s\S]*\n\s*- schemas\/\*\*\/\*/);
  const builderConfig = require("js-yaml").load(builder);
  assert.ok(builderConfig.files.includes("!node_modules/@anthropic-ai/claude-agent-sdk*/**/*"));
  assert.ok(builderConfig.files.includes("node_modules/electron-updater/**/*"));
  assert.deepEqual(builderConfig.publish, {
    provider: "github", owner: "ArronKong", repo: "Shoggoth", releaseType: "draft",
  });
  assert.ok(builderConfig.extraResources.some((resource) => (
    resource.from === ".vendor/codex/${arch}/package" && resource.to === "codex/package"
  )), "extraResources must include the architecture-specific Codex package");
  assert.match(builder, /from: \.vendor\/cua\/node-modules\/\$\{arch\}\/node_modules/u);
  assert.match(builder, /from: \.vendor\/cua\/package\s*\n\s*to: cua-driver/u);
  assert.match(builder, /from: resources\/pi\/shoggoth-pi-extension\.mjs\s*\n\s*to: pi\/shoggoth-pi-extension\.mjs/u);
  assert.match(builder, /from: resources\/deepseek-harness\/shoggoth-dsh-bridge\.mjs\s*\n\s*to: deepseek-harness\/shoggoth-dsh-bridge\.mjs/u);
  assert.ok(require("js-yaml").load(builder).extraResources.some((entry) => entry.from === "resources/legal" && entry.to === "legal"));
  assert.match(builder, /afterSign: scripts\/notarize\.cjs/u);
  assert.match(builder, /entitlements:\s*build\/entitlements\.mac\.plist/);
  const entitlements = await readFile(path.join(REPO_ROOT, "build", "entitlements.mac.plist"), "utf8");
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]) assert.match(entitlements, new RegExp(`<key>${entitlement.replaceAll(".", "\\.")}</key>\\s*<true/>`));
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "build", "codex-runtime-manifest.json"), "utf8"));
  assert.equal(manifest.runtime.version, "0.149.0");
  const cuaManifest = JSON.parse(await readFile(path.join(REPO_ROOT, "build", "cua-driver-manifest.json"), "utf8"));
  assert.equal(cuaManifest.version, "0.22.0");
  assert.equal(cuaManifest.nodePackages.length, 4);
  for (const expected of [
    { arch: "arm64", target: "aarch64-apple-darwin" },
    { arch: "x64", target: "x86_64-apple-darwin" },
  ].filter((expected) => onlyArch === null || expected.arch === onlyArch)) {
    await verifyPackage(path.join(REPO_ROOT, ".vendor", "codex", expected.arch, "package"), expected);
  }
  verifyJsonlFailureContract();
  await verifyZipFailureContract();
}

class JsonlClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBytes = 0;
    this.fatalError = null;
    child.stdout.on("data", (chunk) => {
      try { this.consume(chunk); } catch (error) { this.fail(error); }
    });
    child.once("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("app-server closed early"));
      this.pending.clear();
    });
  }
  consume(chunk) {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > OUTPUT_LIMIT) throw new Error("app-server stdout exceeded limit");
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (!Object.hasOwn(message, "id") || Object.hasOwn(message, "method")) continue;
      const pending = this.pending.get(message.id);
      if (!pending) throw new Error("unexpected app-server response id");
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`RPC ${Number.isInteger(message.error.code) ? message.error.code : "unknown"}`));
      else pending.resolve(message.result);
    }
  }
  fail(error) {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGKILL");
  }
  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }
  request(method, params) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {} };
  child.kill = () => {};
  return child;
}

function verifyJsonlFailureContract() {
  for (const failure of [
    (rpc) => rpc.consume(Buffer.from("{malformed}\n")),
    (rpc) => rpc.consume(Buffer.alloc(OUTPUT_LIMIT + 1, "x")),
  ]) {
    const rpc = new JsonlClient(fakeChild());
    const request = rpc.request("initialize", {});
    rpc.consume(Buffer.from('{"id":1,"result":{"ok":true}}\n'));
    request.catch(() => {});
    try { failure(rpc); } catch (error) { rpc.fail(error); }
    assert.throws(() => assertPackagedRpcClean(rpc), (error) => error === rpc.fatalError);
  }
  const child = fakeChild();
  const rpc = new JsonlClient(child);
  monitorAppServerStderr(child, rpc);
  const request = rpc.request("initialize", {});
  rpc.consume(Buffer.from('{"id":1,"result":{"ok":true}}\n'));
  request.catch(() => {});
  child.stderr.emit("data", Buffer.alloc(OUTPUT_LIMIT + 1, "x"));
  assert.throws(() => assertPackagedRpcClean(rpc), /stderr exceeded limit/);
}

function assertPackagedRpcClean(rpc) {
  if (rpc.fatalError) throw rpc.fatalError;
  if (rpc.buffer.trim()) throw new Error("packaged app-server emitted a malformed JSONL tail");
}

function monitorAppServerStderr(child, rpc) {
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > OUTPUT_LIMIT) rpc.fail(new Error("app-server stderr exceeded limit"));
  });
}

async function verifyZipFailureContract() {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-bad-zip-"));
  await chmod(scratchPath, 0o700);
  try {
    const dummyPath = path.join(scratchPath, "not-an-app.txt");
    const zipPath = path.join(scratchPath, "bad.zip");
    await writeFile(dummyPath, "not an app\n", { mode: 0o600 });
    const zipped = await runCaptured("/usr/bin/zip", ["-q", zipPath, path.basename(dummyPath)], { cwd: scratchPath });
    assert.equal(zipped.code, 0);
    await assert.rejects(verifyZipArtifact(zipPath, { arch: "arm64", target: "aarch64-apple-darwin", binaryArch: "arm64" }));

    const referenceApp = path.join(scratchPath, "Shoggoth.app");
    await mkdir(referenceApp, { mode: 0o700 });
    const payload = path.join(referenceApp, "payload.txt");
    await writeFile(payload, "original", { mode: 0o600 });
    await symlink("payload.txt", path.join(referenceApp, "current"));
    const matchingZip = path.join(scratchPath, "matching.zip");
    const packed = await runCaptured("/usr/bin/zip", ["-q", "-y", "-r", matchingZip, "Shoggoth.app"], { cwd: scratchPath });
    assert.equal(packed.code, 0);
    const output = path.join(scratchPath, "extracted");
    await mkdir(output, { mode: 0o700 });
    await extractVerifiedZip(matchingZip, output, referenceApp);
    assert.equal(await readFile(path.join(output, "Shoggoth.app", "payload.txt"), "utf8"), "original");
    assert.equal(await readlink(path.join(output, "Shoggoth.app", "current")), "payload.txt");

    // Every reference payload must also be present in the archive.
    const missingPayload = path.join(referenceApp, "missing.txt");
    await writeFile(missingPayload, "must be included");
    const missingOutput = path.join(scratchPath, "missing-payload");
    await mkdir(missingOutput, { mode: 0o700 });
    await assert.rejects(extractVerifiedZip(matchingZip, missingOutput, referenceApp), /ZIP omits file/u);
    await rm(missingPayload);

    // A reference must never hide differing archive bytes or executable bits.
    await chmod(payload, 0o700);
    const permissionsOutput = path.join(scratchPath, "different-permissions");
    await mkdir(permissionsOutput, { mode: 0o700 });
    await assert.rejects(extractVerifiedZip(matchingZip, permissionsOutput, referenceApp), /ZIP permissions differ/u);
    await chmod(payload, 0o600);
    await writeFile(payload, "modified");
    const contentsOutput = path.join(scratchPath, "different-contents");
    await mkdir(contentsOutput, { mode: 0o700 });
    await assert.rejects(extractVerifiedZip(matchingZip, contentsOutput, referenceApp), /ZIP content differs/u);
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function verifyPackagedAppServer(runtimePath, scratchPath) {
  const codexHome = path.join(scratchPath, "codex-home");
  await mkdir(codexHome, { mode: 0o700 });
  const child = spawn(runtimePath, ["app-server", "--stdio"], {
    cwd: REPO_ROOT,
    env: { CODEX_HOME: codexHome, HOME: scratchPath, PATH: process.env.PATH ?? "", TMPDIR: scratchPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new JsonlClient(child);
  monitorAppServerStderr(child, rpc);
  try {
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "shoggoth-packaged-spike", title: "Shoggoth Packaged Spike", version: "0.0.0" },
      capabilities: null,
    });
    assert.equal(Boolean(initialized), true);
    rpc.notify("initialized");
    const auth = await rpc.request("getAuthStatus", { includeToken: false, refreshToken: false });
    assert.equal(auth?.authToken == null, true);
    const thread = await rpc.request("thread/start", { cwd: REPO_ROOT, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    assert.equal(typeof thread?.thread?.id, "string");
  } finally {
    child.stdin.end();
    let closed = await Promise.race([
      new Promise((resolve) => child.once("close", () => resolve(true))),
      delay(2_000).then(() => false),
    ]);
    if (!closed) {
      child.kill("SIGKILL");
      closed = await Promise.race([
        new Promise((resolve) => child.once("close", () => resolve(true))),
        delay(2_000).then(() => false),
      ]);
    }
    assert.equal(closed, true, "packaged app-server did not close");
    assertPackagedRpcClean(rpc);
  }
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function verifyLaunchAgent(runtimePath, scratchPath) {
  const label = `ai.shoggoth.m0-spike.${process.pid}`;
  const stdoutPath = path.join(scratchPath, "launchd.stdout");
  const stderrPath = path.join(scratchPath, "launchd.stderr");
  const plistPath = path.join(scratchPath, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xmlEscape(runtimePath)}</string><string>--version</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string><key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string></dict></plist>\n`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  let bootstrapped = false;
  let primaryError;
  try {
    const bootstrap = await runCaptured("/bin/launchctl", ["bootstrap", domain, plistPath]);
    assert.equal(bootstrap.code, 0, "LaunchAgent bootstrap failed");
    bootstrapped = true;
    const output = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const value = await readFile(stdoutPath, "utf8");
          if (value.trim()) return value.trim();
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        await delay(50);
      }
      throw new Error("LaunchAgent output timed out");
    })();
    assert.equal(output, "codex-cli 0.149.0");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (bootstrapped) {
      let cleanupError;
      try {
        const bootout = await runCaptured("/bin/launchctl", ["bootout", `${domain}/${label}`]);
        assert.equal(bootout.code, 0, "LaunchAgent bootout failed");
        const registration = await runCaptured("/bin/launchctl", ["print", `${domain}/${label}`]);
        assert.notEqual(registration.code, 0, "LaunchAgent registration remained after bootout");
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError && primaryError) throw new AggregateError([primaryError, cleanupError], "LaunchAgent verification and cleanup failed");
      if (cleanupError) throw cleanupError;
    }
  }
}

async function verifyApp(appPath, expected, runLaunchAgent) {
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: package`);
  const appStat = await lstat(appPath);
  assert.equal(appStat.isDirectory(), true, `${appPath} must exist`);
  const electronExecutable = path.join(appPath, "Contents", "MacOS", "Shoggoth");
  require("./adhoc-sign.cjs").verifyPackagedSqlite(appPath);
  await verifyPackagedRunAsNode(appPath, electronExecutable);
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: agent-service-persistence`);
  await verifyPackagedService(appPath);
  const archivePath = path.join(appPath, "Contents", "Resources", "app.asar");
  assert.equal(JSON.parse(extractAsarFile(
    archivePath, "node_modules/electron-updater/package.json",
  ).toString("utf8")).version, "6.8.9");
  const releaseMarker = JSON.parse(await readFile(path.join(
    appPath, "Contents", "Resources", "shoggoth-release.json",
  ), "utf8"));
  assert.equal(releaseMarker.schemaVersion, 1);
  assert.equal(releaseMarker.version, require(path.join(REPO_ROOT, "package.json")).version);
  if (process.env.SHOGGOTH_EXPECT_NOTARIZED === "1") {
    assert.deepEqual({
      distribution: releaseMarker.distribution,
      signingMode: releaseMarker.signingMode,
      updateChannel: releaseMarker.updateChannel,
    }, { distribution: "official", signingMode: "developer-id", updateChannel: "stable" });
  } else {
    assert.equal(releaseMarker.distribution, "internal");
  }
  await access(path.join(appPath, "Contents", "Resources", "app-update.yml"));
  const schemaManifest = JSON.parse(extractAsarFile(
    archivePath, "schemas/codex-app-server/0.149.0/schema-manifest.json",
  ).toString("utf8"));
  assert.equal(schemaManifest.codexVersion, "0.149.0", "packaged schema contract is missing");
  assert.doesNotThrow(() => extractAsarFile(
    archivePath, "schemas/codex-app-server/0.149.0/json/ClientRequest.json",
  ));
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: cua-sdk`);
  await verifyPackagedCua(appPath, archivePath, electronExecutable, expected);
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: claude-excluded`);
  verifyClaudeExcluded(archivePath);
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: pi-extension`);
  await verifyPackagedPiExtension(appPath, electronExecutable);
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: deepseek-harness-bridge`);
  await verifyPackagedDeepSeekHarnessBridge(appPath, electronExecutable);
  const packageRoot = path.join(appPath, "Contents", "Resources", "codex", "package");
  await verifyPackage(packageRoot, expected);
  const runtimePath = path.join(packageRoot, "bin", "codex");
  const hostPath = path.join(packageRoot, "bin", "codex-code-mode-host");
  for (const signedPath of [runtimePath, hostPath]) {
    const signature = await runCaptured("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", signedPath]);
    assert.equal(signature.code, 0, `${signedPath} code signature is invalid`);
    const signatureDetails = await runCaptured("/usr/bin/codesign", ["-d", "--verbose=4", signedPath]);
    assert.equal(signatureDetails.code, 0, `${signedPath} signature details are unavailable`);
    assert.match(signatureDetails.stderr, /^TeamIdentifier=2DC432GLL2$/m,
      `${signedPath} must retain its OpenAI signature for the MCP parent-identity gate`);
  }
  const { assertCodeIdentity, CODEX_TEAM_IDENTIFIER, CODEX_DESIGNATED_REQUIREMENT } = require("../app/agent-service/code-identity");
  assertCodeIdentity(runtimePath, { teamIdentifier: CODEX_TEAM_IDENTIFIER, designatedRequirement: CODEX_DESIGNATED_REQUIREMENT });
  const architecture = await runCaptured("/usr/bin/lipo", ["-archs", runtimePath]);
  assert.equal(architecture.code, 0);
  assert.equal(architecture.stdout.trim(), expected.binaryArch);
  const scratchPath = await mkdtemp(path.join(tmpdir(), `shoggoth-packaged-${expected.arch}-`));
  await chmod(scratchPath, 0o700);
  try {
    console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: version`);
    const version = await runCaptured(runtimePath, ["--version"], {
      env: { CODEX_HOME: scratchPath, HOME: scratchPath, PATH: process.env.PATH ?? "", TMPDIR: scratchPath },
    });
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), "codex-cli 0.149.0");
    console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: app-server`);
    await verifyPackagedAppServer(runtimePath, scratchPath);
    if (runLaunchAgent) {
      console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: launch-agent`);
      await verifyLaunchAgent(runtimePath, scratchPath);
    }
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
  const appSignature = await runCaptured("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  assert.equal(appSignature.code, 0, `${appPath} deep signature is invalid`);
  const signatureDetails = await runCaptured("/usr/bin/codesign", ["-d", "--verbose=4", appPath]);
  assert.equal(signatureDetails.code, 0, `${appPath} signature details are unavailable`);
  assert.match(signatureDetails.stderr, /flags=.*\bruntime\b/, `${appPath} must enable hardened runtime`);
  if (process.env.SHOGGOTH_EXPECT_TEAM_ID) {
    assert.match(signatureDetails.stderr, new RegExp(`^TeamIdentifier=${process.env.SHOGGOTH_EXPECT_TEAM_ID}$`, "m"));
  }
  const entitlements = await runCaptured("/usr/bin/codesign", ["-d", "--entitlements", ":-", appPath]);
  assert.equal(entitlements.code, 0, `${appPath} entitlements are unavailable`);
  const entitlementDetails = `${entitlements.stdout}\n${entitlements.stderr}`;
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]) assert.match(entitlementDetails, new RegExp(`<key>${entitlement.replaceAll(".", "\\.")}</key><true/>`));
  console.log(`[shoggoth-packaged-runtime-smoke] ${expected.arch}: signed-mach-o`);
  await verifyEveryMachOSigned(appPath);
  if (process.env.SHOGGOTH_EXPECT_NOTARIZED === "1") {
    const staple = await runCaptured("/usr/bin/xcrun", ["stapler", "validate", appPath]);
    assert.equal(staple.code, 0, `${appPath} has no valid notarization ticket`);
    const gatekeeper = await runCaptured("/usr/sbin/spctl", [
      "--assess", "--type", "execute", "--verbose=4", appPath,
    ]);
    assert.equal(gatekeeper.code, 0, `${appPath} did not pass Gatekeeper`);
  }
}

function streamDigest(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function extractVerifiedZip(zipPath, destination, referenceAppPath) {
  // Read every compressed payload before cloning its byte-identical reference.
  // This creates a complete, independent extraction without another 900 MB of
  // physical allocation on APFS. Cloning falls back to copying on other volumes.
  const referenceRoot = path.dirname(referenceAppPath);
  const seen = new Set();
  await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        void (async () => {
          const parts = entry.fileName.replace(/\/$/u, "").split("/");
          assert.equal(parts[0], "Shoggoth.app");
          assert.equal(parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")), false);
          const name = parts.join("/");
          assert.equal(seen.has(name), false, `duplicate ZIP entry: ${name}`);
          seen.add(name);
          let parent = destination;
          for (const part of parts.slice(0, -1)) {
            parent = path.join(parent, part);
            await mkdir(parent, { recursive: true });
            assert.equal((await lstat(parent)).isSymbolicLink(), false, `ZIP parent is a symlink: ${name}`);
          }
          const target = path.join(destination, ...parts);
          const reference = path.join(referenceRoot, ...parts);
          const sourceStat = await lstat(reference);
          const mode = entry.externalFileAttributes >>> 16;
          const kind = mode & 0o170000;
          if (kind === 0o040000) {
            assert.equal(sourceStat.isDirectory(), true);
            await mkdir(target, { recursive: true });
            await chmod(target, mode & 0o777);
            return;
          }
          const stream = await new Promise((accept, fail) => {
            zip.openReadStream(entry, (streamError, value) => streamError ? fail(streamError) : accept(value));
          });
          if (kind === 0o120000) {
            assert.equal(sourceStat.isSymbolicLink(), true);
            assert.ok(entry.uncompressedSize <= 4096, "ZIP symlink target is too large");
            const link = await new Promise((accept, fail) => {
              const chunks = [];
              stream.on("data", (chunk) => chunks.push(chunk));
              stream.once("error", fail);
              stream.once("end", () => accept(Buffer.concat(chunks).toString("utf8")));
            });
            assert.equal(link, await readlink(reference), `ZIP symlink differs: ${name}`);
            await symlink(link, target);
            return;
          }
          assert.equal(kind, 0o100000, `unsupported ZIP entry: ${name}`);
          assert.equal(sourceStat.isFile(), true);
          assert.equal(sourceStat.size, entry.uncompressedSize, `ZIP size differs: ${name}`);
          assert.equal(sourceStat.mode & 0o777, mode & 0o777, `ZIP permissions differ: ${name}`);
          const digest = await streamDigest(stream);
          assert.equal(digest, await streamDigest(createReadStream(reference)), `ZIP content differs: ${name}`);
          await assert.rejects(lstat(target), { code: "ENOENT" }, `ZIP target already exists: ${name}`);
          const cloned = await runCaptured("/bin/cp", ["-cp", reference, target]);
          if (cloned.code !== 0) await copyFile(reference, target, fsConstants.COPYFILE_EXCL);
          await chmod(target, mode & 0o777);
          assert.equal(digest, await streamDigest(createReadStream(target)), `extracted file differs: ${name}`);
        })().then(() => zip.readEntry(), (failure) => { zip.close(); reject(failure); });
      });
      zip.readEntry();
    });
  });
  async function verifyInventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const name = path.relative(referenceRoot, source).split(path.sep).join("/");
      if (entry.isDirectory()) await verifyInventory(source);
      else assert.equal(seen.has(name), true, `ZIP omits file: ${name}`);
    }
  }
  await verifyInventory(referenceAppPath);
  // macOS cp cannot combine APFS cloning (-c) with omitting attributes (-X).
  // Remove attributes from this new extraction only, so reference metadata
  // cannot make a ZIP with missing signature data pass verification.
  const cleared = await runCaptured("/usr/bin/xattr", ["-cr", path.join(destination, "Shoggoth.app")]);
  assert.equal(cleared.code, 0, "could not clear cloned ZIP metadata");
  console.log(`[shoggoth-packaged-runtime-smoke] ZIP: ${seen.size} entries fully verified and extracted`);
}

async function verifyZipArtifact(zipPath, expected) {
  const checked = await runCaptured("/usr/bin/unzip", ["-t", zipPath], { timeoutMs: 120_000 });
  assert.equal(checked.code, 0, `${path.basename(zipPath)} failed integrity check`);
  const listing = await runCaptured("/usr/bin/unzip", ["-Z1", zipPath], { timeoutMs: 120_000 });
  assert.equal(listing.code, 0, `${path.basename(zipPath)} member listing failed`);
  const members = listing.stdout.split("\n").filter(Boolean);
  assert.equal(members.length > 0, true, "ZIP must not be empty");
  for (const member of members) {
    assert.equal(member.includes("\\"), false, `unsafe ZIP member: ${member}`);
    assert.equal(member.startsWith("/"), false, `unsafe ZIP member: ${member}`);
    assert.equal(member.split("/").some((part) => part === "." || part === ".."), false, `unsafe ZIP member: ${member}`);
    assert.equal(member.split("/")[0], "Shoggoth.app", `unexpected ZIP top-level member: ${member}`);
  }
  const scratchPath = await mkdtemp(path.join(tmpdir(), `shoggoth-zip-${expected.arch}-`));
  await chmod(scratchPath, 0o700);
  try {
    await extractVerifiedZip(zipPath, scratchPath, expected.appPath);
    assert.deepEqual(await readdir(scratchPath), ["Shoggoth.app"]);
    await verifyApp(path.join(scratchPath, "Shoggoth.app"), expected, false);
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function verifyPackagedSpike(onlyArch = null) {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const apps = [
    { appPath: path.join(ARTIFACT_ROOT, "mac-arm64", "Shoggoth.app"), arch: "arm64", target: "aarch64-apple-darwin", binaryArch: "arm64" },
    { appPath: path.join(ARTIFACT_ROOT, "mac", "Shoggoth.app"), arch: "x64", target: "x86_64-apple-darwin", binaryArch: "x86_64" },
  ].filter((app) => onlyArch === null || app.arch === onlyArch);
  for (const app of apps) await verifyApp(app.appPath, app, app.arch === process.arch);
  const zipArtifacts = apps.map((app) => [
    app.arch === "arm64"
      ? `Shoggoth-${packageJson.version}-arm64-mac.zip`
      : `Shoggoth-${packageJson.version}-mac.zip`,
    app,
  ]);
  for (const [zipName, expected] of zipArtifacts) {
    const zipPath = path.join(ARTIFACT_ROOT, zipName);
    await access(zipPath);
    await verifyZipArtifact(zipPath, expected);
  }
}

const requestedArch = process.argv[2] === "--spike-arm64" ? "arm64"
  : process.argv[2] === "--spike-x64" ? "x64" : null;
if (process.argv[2] === "--service-app") {
  if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3])) {
    throw new Error("--service-app requires one absolute App path");
  }
  await verifyPackagedService(process.argv[3]);
  console.log("[shoggoth-packaged-runtime-smoke] PASS Agent Service startup and persistence");
  process.exit(0);
}
await verifySourceContract(requestedArch);
if (process.argv[2] === "--spike") await verifyPackagedSpike();
else if (process.argv[2] === "--spike-arm64") await verifyPackagedSpike("arm64");
else if (process.argv[2] === "--spike-x64") await verifyPackagedSpike("x64");
else if (process.argv.length > 2) throw new Error(`unknown argument: ${process.argv[2]}`);
console.log(`[shoggoth-packaged-runtime-smoke] PASS${process.argv[2]?.startsWith("--spike") ? " packaged spike" : " source contract"}`);
