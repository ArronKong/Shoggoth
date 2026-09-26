#!/usr/bin/env node
"use strict";

// A one-install exception for six already-running Hermes federation clients.
// It never stops a process or starts a Service. Without an explicit permit the
// backup/install policy remains: no Shoggoth App or Service process may exist.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const KNOWN_PARENTS = Object.freeze({ 30485: 30111, 30547: 30110, 38087: 36183,
  39138: 30112, 39139: 30115, 39140: 30113 });
const PERMIT_ENV = "SHOGGOTH_EXTERNAL_MCP_PERMIT";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/u;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = target => sha256(fs.readFileSync(target));
function privateJson(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600
      || before.size > 1024 * 1024) fail("INSTALL_PERMIT_NOT_PRIVATE");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(target);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key]
      || before[key] !== current[key]) || current.isSymbolicLink()) fail("INSTALL_PERMIT_CHANGED");
    return { data: JSON.parse(bytes), sha256: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}
function parseProcesses(output) {
  return output.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(line);
    if (!match) fail("INSTALL_PROCESS_STATE_UNKNOWN");
    return { pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]),
      starttime: match[4].replace(/\s+/gu, " "), command: match[5] };
  });
}
function readProcesses() {
  return parseProcesses(execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,uid=,lstart=,command="],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10000, env: { ...process.env, LC_ALL: "C" } }));
}
function readFederationFacts(pid) {
  // Never return or persist the full environment: it may contain credentials.
  const output = execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 });
  return { federationHermes: /(?:^|\s)SHOGGOTH_FEDERATION_MCP_CLIENT=hermes(?:\s|$)/u.test(output),
    electronRunAsNode: /(?:^|\s)ELECTRON_RUN_AS_NODE=1(?:\s|$)/u.test(output) };
}
function isAppOrService(row) {
  return /\/[^/\n]*Shoggoth[^/\n]*\.app\/Contents\//u.test(row.command)
    || /(?:^|\s)--shoggoth-internal-role=agent-service(?:\s|$)/u.test(row.command);
}
function validateIdentity(record) {
  if (!record || KNOWN_PARENTS[record.pid] !== record.ppid || record.uid !== process.getuid()
    || !record.parent || record.parent.pid !== record.ppid || record.parent.uid !== record.uid
    || typeof record.starttime !== "string" || typeof record.parent.starttime !== "string") fail("INSTALL_PERMIT_IDENTITY_INVALID");
  const prefix = "/Applications/Shoggoth.app/Contents/";
  if (!record.command.startsWith(`${prefix}MacOS/Shoggoth ${prefix}Resources/app.asar/app/bootstrap.js --shoggoth-internal-role=mcp `)
    || !/^--shoggoth-runtime-profile=[A-Za-z0-9-]+ --shoggoth-runtime-account=[A-Za-z0-9-]+$/u.test(record.command.split("--shoggoth-internal-role=mcp ")[1])) {
    fail("INSTALL_PERMIT_NOT_EXTERNAL_HELPER");
  }
  const hermes = path.join(os.userInfo().homedir, ".hermes/hermes-agent/venv/bin");
  const prefixParent = `${hermes}/python3 ${hermes}/hermes `;
  if (!record.parent.command.startsWith(prefixParent)
    || !/^(?:--profile (?:bull|coder|horse|travel|owl) )?dashboard (?:--isolated )?--no-open --skip-build --port \d+ --host 127\.0\.0\.1$/u.test(record.parent.command.slice(prefixParent.length))) {
    fail("INSTALL_PERMIT_PARENT_NOT_HERMES_DASHBOARD");
  }
}
function assertAllowedProcesses(rows, permit, facts = readFederationFacts) {
  const running = rows.filter(isAppOrService);
  if (!permit) {
    if (running.length) fail("INSTALL_APP_OR_SERVICE_RUNNING");
    return { permittedExternalMcpPids: [] };
  }
  if (!Array.isArray(permit.processes) || permit.processes.length !== 6
    || new Set(permit.processes.map(row => row.pid)).size !== 6) fail("INSTALL_PERMIT_IDENTITY_INVALID");
  const byPid = new Map(rows.map(row => [row.pid, row]));
  for (const expected of permit.processes) {
    validateIdentity(expected);
    const actual = byPid.get(expected.pid), parent = byPid.get(expected.ppid);
    for (const key of ["pid", "ppid", "uid", "starttime", "command"]) {
      if (actual?.[key] !== expected[key] || parent?.[key] !== expected.parent[key]) fail("INSTALL_PERMITTED_PROCESS_CHANGED");
    }
    const env = facts(expected.pid);
    if (env.federationHermes !== true || env.electronRunAsNode !== true) fail("INSTALL_PERMIT_NOT_FEDERATION_CLIENT");
  }
  if (running.some(row => !permit.processes.some(expected => expected.pid === row.pid))) fail("INSTALL_UNEXPECTED_APP_OR_SERVICE_RUNNING");
  return { permittedExternalMcpPids: permit.processes.map(row => row.pid).sort((a, b) => a - b) };
}
function validateArtifactBindings(permit) {
  if (!Array.isArray(permit.artifacts) || permit.artifacts.length < 5) fail("INSTALL_PERMIT_PARITY_INVALID");
  for (const row of permit.artifacts) {
    if (typeof row.path !== "string" || !path.isAbsolute(row.path) || !HASH.test(row.sha256)
      || hashFile(row.path) !== row.sha256) fail("INSTALL_PERMIT_ARTIFACT_CHANGED");
  }
}
function readPermit(target) {
  const { data: permit, sha256: permitSha256 } = privateJson(path.resolve(target));
  if (permit.version !== 1 || permit.kind !== "hermes-external-mcp-install-0.8.131-to-0.8.132"
    || !Number.isFinite(Date.parse(permit.createdAt)) || Date.now() < Date.parse(permit.createdAt)
    || Date.now() - Date.parse(permit.createdAt) > MAX_AGE_MS) fail("INSTALL_PERMIT_INVALID_OR_EXPIRED");
  validateArtifactBindings(permit);
  return { permit, permitSha256 };
}
function assertInstallProcesses({ permitPath = process.env[PERMIT_ENV] || null } = {}) {
  const loaded = permitPath ? readPermit(permitPath) : null;
  const result = assertAllowedProcesses(readProcesses(), loaded?.permit);
  // Re-read after environment probing to catch exit/reparent/PID replacement.
  if (loaded) assertAllowedProcesses(readProcesses(), loaded.permit, () => ({ federationHermes: true, electronRunAsNode: true }));
  return { ...result, permitSha256: loaded?.permitSha256 || null };
}
function createPermit({ output, parityPath }) {
  const parityFile = privateJson(path.resolve(parityPath));
  const parity = parityFile.data;
  if (parity.compatible !== true || parity.installedApp !== "/Applications/Shoggoth.app"
    || parity.oldVersion !== "0.8.131" || parity.newVersion !== "0.8.132"
    || !parity.sourceApp?.endsWith("runtime-v2-s6-package-0.8.132/mac-arm64/Shoggoth.app")
    || !HASH.test(parity.unsignedExecutableSha256)) fail("INSTALL_PERMIT_PARITY_INVALID");
  const rows = readProcesses(), byPid = new Map(rows.map(row => [row.pid, row]));
  const processes = Object.keys(KNOWN_PARENTS).map(Number).map(pid => {
    const row = byPid.get(pid);
    if (!row) fail("INSTALL_PERMITTED_PROCESS_MISSING");
    return { ...row, parent: byPid.get(row.ppid) };
  });
  const artifactRows = [[parityPath, parityFile.sha256],
    [path.join(parity.installedApp, "Contents/Resources/app.asar"), parity.oldAsarSha256],
    [path.join(parity.sourceApp, "Contents/Resources/app.asar"), parity.newAsarSha256],
    [path.join(parity.installedApp, "Contents/MacOS/Shoggoth"), parity.oldExecutableSha256],
    [path.join(parity.sourceApp, "Contents/MacOS/Shoggoth"), parity.newExecutableSha256]];
  const permit = { version: 1, kind: "hermes-external-mcp-install-0.8.131-to-0.8.132",
    createdAt: new Date().toISOString(), processes,
    artifacts: artifactRows.map(([file, hash]) => ({ path: path.resolve(file), sha256: hash })),
    boundary: "Only these six unchanged IPC-only federation helpers; all authority writers, App UI and Service must remain stopped. Retained helpers may advertise 0.8.129 until relaunched." };
  validateArtifactBindings(permit);
  assertAllowedProcesses(rows, permit);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(output, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(permit, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return assertInstallProcesses({ permitPath: output });
}
if (require.main === module) {
  try {
    const options = new Map(), args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!["--output", "--parity", "--external-mcp-permit"].includes(args[i]) || !args[i + 1] || options.has(args[i])) fail("INSTALL_GUARD_ARGUMENTS_INVALID");
      options.set(args[i], args[i + 1]);
    }
    const result = options.has("--output")
      ? createPermit({ output: options.get("--output"), parityPath: options.get("--parity") })
      : assertInstallProcesses({ permitPath: options.get("--external-mcp-permit") || process.env[PERMIT_ENV] || null });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.code || "INSTALL_PROCESS_GUARD_FAILED"); process.exitCode = 1; }
}
module.exports = { parseProcesses, assertAllowedProcesses, assertInstallProcesses, readPermit, createPermit, PERMIT_ENV };
