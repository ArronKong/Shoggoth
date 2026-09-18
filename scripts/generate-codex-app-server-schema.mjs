#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 5_000;
const SUPPORTED_PLATFORMS = new Set(["darwin-arm64", "darwin-x64"]);
const GENERATORS = {
  json: ["app-server", "generate-json-schema"],
  typescript: ["app-server", "generate-ts"],
};

function fail(message) {
  throw new Error(message);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function defaultPlatform() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    fail("--platform is required when not running on supported macOS hardware");
  }
  return `darwin-${process.arch}`;
}

export function parseCliArgs(argv) {
  const result = { mode: "check" };
  const names = new Map([
    ["--mode", "mode"],
    ["--platform", "platform"],
    ["--manifest", "manifestPath"],
    ["--repo-root", "repoRoot"],
    ["--runtime", "runtimePath"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const key = names.get(option);
    if (!key) fail(`unknown argument: ${option ?? "<missing>"}`);
    if (seen.has(option)) fail(`duplicate argument: ${option}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for argument: ${option}`);
    seen.add(option);
    result[key] = value;
  }
  if (!new Set(["check", "write"]).has(result.mode)) fail("--mode must be write or check");
  if (result.platform && !SUPPORTED_PLATFORMS.has(result.platform)) {
    fail("--platform must be darwin-arm64 or darwin-x64");
  }
  return result;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    fail(`unable to read ${label}: ${error.code ?? "read failed"}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function validateRuntime(runtimePath, requiredRoot) {
  let stat;
  try {
    stat = await fs.promises.lstat(runtimePath);
  } catch (error) {
    fail(`runtime is unavailable: ${error.code ?? "stat failed"}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("runtime must be a regular file, not a symlink");
  if ((stat.mode & 0o111) === 0) fail("runtime must be executable");
  if (requiredRoot) {
    const [realRoot, realRuntime] = await Promise.all([
      fs.promises.realpath(requiredRoot),
      fs.promises.realpath(runtimePath),
    ]);
    if (!inside(realRoot, realRuntime)) fail("manifest runtime destination must remain inside repo root");
  }
}

async function loadConfiguration(options) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const manifestPath = path.resolve(options.manifestPath ?? path.join(repoRoot, "build", "codex-runtime-manifest.json"));
  const manifest = await readJson(manifestPath, "runtime manifest");
  const version = manifest?.runtime?.version;
  if (typeof version !== "string" || !version) fail("runtime manifest version is invalid");
  if (manifest?.schema?.version !== version) fail("schema.version must equal runtime.version");
  if (manifest?.schema?.includeExperimental !== false) {
    fail("schema.includeExperimental must be false; experimental schemas are refused");
  }
  const expectedDirectory = `schemas/codex-app-server/${version}`;
  if (manifest?.schema?.directory !== expectedDirectory) {
    fail(`schema directory must be ${expectedDirectory}`);
  }
  const target = path.resolve(repoRoot, manifest.schema.directory);
  if (!inside(repoRoot, target)) fail("schema directory must remain inside repo root");

  const platform = options.platform ?? defaultPlatform();
  if (!SUPPORTED_PLATFORMS.has(platform)) fail("unsupported platform");
  const platformEntry = manifest?.platforms?.[platform];
  if (!platformEntry || typeof platformEntry.destination !== "string") {
    fail(`runtime manifest has no destination for ${platform}`);
  }
  const defaultRuntime = path.resolve(repoRoot, platformEntry.destination);
  if (!inside(repoRoot, defaultRuntime)) fail("manifest runtime destination must remain inside repo root");
  const runtimePath = options.runtimePath ? path.resolve(options.runtimePath) : defaultRuntime;
  await validateRuntime(runtimePath, options.runtimePath ? undefined : repoRoot);
  return { repoRoot, manifestPath, manifest, version, platform, target, runtimePath };
}

async function ensureSafeDirectoryTree(root, directory) {
  let current = root;
  const parts = path.relative(root, directory).split(path.sep).filter(Boolean);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) {
      current = path.join(current, parts[index]);
      try {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("schema directory parent must contain only real directories");
    }
  }
}

function safeEnvironment(codexHome) {
  const env = { CODEX_HOME: codexHome };
  for (const key of ["PATH", "TMPDIR", "HOME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function terminateProcessTree(child) {
  try {
    if (["darwin", "linux"].includes(process.platform) && child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function runProcess(command, args, { env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationError;
    let terminationTimer;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const grouped = ["darwin", "linux"].includes(process.platform);
    const child = spawn(command, args, {
      env,
      detached: grouped,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => requestTermination(new Error("command timed out")), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (error) reject(error);
      else resolve(value);
    }

    function requestTermination(reason) {
      if (settled || terminationError) return;
      terminationError = reason;
      try {
        terminateProcessTree(child);
      } catch {
        terminationError = new Error(`${reason.message}; unable to kill process group`);
        try {
          child.kill("SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            terminationError = new Error(`${terminationError.message}; unable to kill direct child`);
          }
        }
      }
      terminationTimer = setTimeout(() => {
        finish(new Error(`${terminationError.message}; process tree did not close after SIGKILL`));
      }, TERMINATION_GRACE_MS);
    }

    function capture(current, chunk) {
      if (terminationError) return current;
      if (current.length + chunk.length > OUTPUT_LIMIT) {
        requestTermination(new Error("command output exceeded safe limit"));
        return current;
      }
      return Buffer.concat([current, chunk]);
    }

    child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
    child.on("error", () => finish(new Error("unable to start command")));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminationError) finish(terminationError);
      else if (code !== 0) finish(new Error(`command exited unsuccessfully (${signal ?? code})`));
      else finish(null, { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

async function verifyVersion(config, codexHome, timeoutMs) {
  const result = await runProcess(config.runtimePath, ["--version"], {
    env: safeEnvironment(codexHome),
    timeoutMs,
  });
  const expected = `codex-cli ${config.version}`;
  if (result.stdout !== expected && result.stdout !== `${expected}\n` && result.stdout !== `${expected}\r\n`) {
    fail(`runtime version mismatch: expected ${expected}`);
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size };
}

async function scanFiles(root, options = {}) {
  const {
    omitManifest = false,
    allowedRoot,
    rejectReservedManifest = false,
    rootLabel = "scan root",
    emptyDirectoryErrors,
  } = options;
  const rootStat = await fs.promises.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`${rootLabel} must be a real directory, not a symlink`);
  if (allowedRoot) {
    const realRoot = await fs.promises.realpath(root);
    const realAllowedRoot = await fs.promises.realpath(allowedRoot);
    if (!inside(realAllowedRoot, realRoot)) fail(`${rootLabel} escaped its staging directory`);
  }
  const entries = [];
  async function visit(directory) {
    let regularFileCount = 0;
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePaths(left.name, right.name));
    for (const child of children) {
      const fullPath = path.join(directory, child.name);
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      if (!relative || path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
        fail("generated output contains an unsafe path");
      }
      const stat = await fs.promises.lstat(fullPath);
      if (rejectReservedManifest && relative === "schema-manifest.json") {
        fail("reserved output: schema-manifest.json");
      }
      if (stat.isSymbolicLink()) fail(`invalid: ${relative} (symlink)`);
      if (stat.isDirectory()) {
        const descendantFileCount = await visit(fullPath);
        if (descendantFileCount === 0) {
          const message = `invalid: ${relative}/ (empty directory)`;
          if (emptyDirectoryErrors) emptyDirectoryErrors.push(message);
          else fail(message);
        }
        regularFileCount += descendantFileCount;
      } else if (stat.isFile()) {
        if (stat.nlink > 1) fail(`invalid: ${relative} (hardlink)`);
        regularFileCount += 1;
        if (!(omitManifest && relative === "schema-manifest.json")) {
          entries.push([relative, await hashFile(fullPath)]);
        }
      } else {
        fail(`invalid: ${relative} (not a regular file)`);
      }
    }
    return regularFileCount;
  }
  await visit(root);
  entries.sort(([left], [right]) => comparePaths(left, right));
  return Object.fromEntries(entries);
}

function createSchemaManifest(version, files) {
  return {
    schemaVersion: 1,
    codexVersion: version,
    includeExperimental: false,
    generators: GENERATORS,
    files,
  };
}

function stableManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function generate(config, stagingRoot, timeoutMs) {
  const generatedRoot = path.join(stagingRoot, "schema");
  const codexHome = path.join(stagingRoot, "codex-home");
  await fs.promises.mkdir(generatedRoot, { mode: 0o700 });
  await fs.promises.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const env = safeEnvironment(codexHome);
  for (const [kind, commandArgs] of Object.entries(GENERATORS)) {
    const output = path.join(generatedRoot, kind);
    try {
      await runProcess(config.runtimePath, [...commandArgs, "--out", output], { env, timeoutMs });
    } catch (error) {
      fail(`generator command failed (${kind}): ${error.message}`);
    }
  }
  const files = await scanFiles(generatedRoot, {
    allowedRoot: stagingRoot, rejectReservedManifest: true, rootLabel: "generated output root",
  });
  for (const kind of Object.keys(GENERATORS)) {
    if (!Object.keys(files).some((name) => name.startsWith(`${kind}/`))) {
      fail(`generator produced no ${kind} files`);
    }
  }
  const manifest = createSchemaManifest(config.version, files);
  const text = stableManifest(manifest);
  await fs.promises.writeFile(path.join(generatedRoot, "schema-manifest.json"), text, { mode: 0o600 });
  return {
    generatedRoot,
    manifest,
    manifestText: text,
    digest: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function diffFiles(expected, actual) {
  const changes = [];
  for (const name of Object.keys(expected)) {
    if (!actual[name]) changes.push(`deleted: ${name}`);
    else if (actual[name].sha256 !== expected[name].sha256 || actual[name].size !== expected[name].size) {
      changes.push(`modified: ${name}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!expected[name]) changes.push(`added: ${name}`);
  }
  return changes.sort(comparePaths);
}

async function checkTarget(target, generated) {
  let targetStat;
  try {
    targetStat = await fs.promises.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") fail("schema drift detected\ndeleted: schema-manifest.json");
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    fail("schema drift detected\ninvalid: target (not a regular directory)");
  }
  let actual;
  const emptyDirectoryErrors = [];
  try {
    actual = await scanFiles(target, { omitManifest: true, emptyDirectoryErrors });
  } catch (error) {
    fail(`schema drift detected\n${error.message}`);
  }
  const changes = [...diffFiles(generated.manifest.files, actual), ...emptyDirectoryErrors];
  const targetManifestPath = path.join(target, "schema-manifest.json");
  let targetManifestText = "";
  let targetManifest;
  try {
    targetManifestText = await fs.promises.readFile(targetManifestPath, "utf8");
    targetManifest = JSON.parse(targetManifestText);
  } catch (error) {
    changes.push(`${error.code === "ENOENT" ? "deleted" : "modified"}: schema-manifest.json`);
  }
  if (targetManifest && (
    targetManifestText !== stableManifest(targetManifest)
    || JSON.stringify(targetManifest) !== JSON.stringify(generated.manifest)
  )) {
    changes.push("modified: schema-manifest.json");
  }
  if (changes.length > 0) fail(`schema drift detected\n${[...new Set(changes)].sort().join("\n")}`);
}

async function commitTarget(target, generatedRoot, operations) {
  const { rename, remove } = operations;
  let targetExists = false;
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("existing schema target must be a directory, not a symlink");
    targetExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!targetExists) {
    await rename(generatedRoot, target);
    return;
  }

  const backup = path.join(path.dirname(target), `.${path.basename(target)}.backup-${crypto.randomUUID()}`);
  await rename(target, backup);
  try {
    await rename(generatedRoot, target);
  } catch (error) {
    try {
      await rename(backup, target);
    } catch {
      fail("schema replacement failed and restoring the previous schema also failed");
    }
    throw error;
  }
  try {
    await remove(backup);
  } catch {
    fail("new schema committed but backup cleanup failed");
  }
}

export async function runCodexSchema(options = {}) {
  const mode = options.mode ?? "check";
  if (mode !== "write" && mode !== "check") fail("mode must be write or check");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("timeoutMs must be a positive integer");
  const config = await loadConfiguration(options);
  const parent = path.dirname(config.target);
  await ensureSafeDirectoryTree(config.repoRoot, parent);
  const stagingRoot = await fs.promises.mkdtemp(path.join(parent, `.${path.basename(config.target)}.staging-`));
  const codexHome = path.join(stagingRoot, "codex-home");
  let generated;
  let operationError;
  try {
    await fs.promises.chmod(stagingRoot, 0o700);
    await fs.promises.mkdir(codexHome, { mode: 0o700 });
    await verifyVersion(config, codexHome, timeoutMs);
    generated = await generate(config, stagingRoot, timeoutMs);
    if (mode === "check") {
      await checkTarget(config.target, generated);
    } else {
      await commitTarget(config.target, generated.generatedRoot, {
        rename: options.rename ?? fs.promises.rename,
        remove: options.remove ?? ((entry) => fs.promises.rm(entry, { recursive: true })),
      });
    }
  } catch (error) {
    operationError = new Error(error.message.split(stagingRoot).join("<staging>"));
  }
  try {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
  } catch {
    if (operationError) fail(`${operationError.message}; temporary cleanup also failed`);
    fail("schema operation succeeded but temporary cleanup failed");
  }
  if (operationError) throw operationError;
  return {
    mode,
    version: config.version,
    directory: config.manifest.schema.directory,
    fileCount: Object.keys(generated.manifest.files).length,
    digest: generated.digest,
  };
}

async function cli() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = await runCodexSchema(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`codex schema: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  await cli();
}
