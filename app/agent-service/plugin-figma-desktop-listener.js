"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { serviceError } = require("./security");

const APP_PATH = "/Applications/Figma.app";
const TEAM_ID = "T8RA8NE3B7";
const LISTENER = "127.0.0.1:3845";
const LSOF = "/usr/sbin/lsof";
const CODESIGN = "/usr/bin/codesign";
const MAX_OUTPUT = 16 * 1024;
const execFileAsync = promisify(execFile);
const PID = /^[1-9][0-9]{0,9}$/u;
const UID = /^(?:0|[1-9][0-9]{0,9})$/u;

const fail = () => {
  throw serviceError("FIGMA_DESKTOP_IDENTITY_UNVERIFIED", "无法验证 Figma 桌面 MCP 监听进程身份");
};

async function runBounded(run, binary, args, timeoutMs) {
  let result;
  try {
    result = await run(binary, args, { encoding: "utf8", timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT, windowsHide: true });
  } catch { fail(); }
  if (!result || result.error || result.signal
    || (result.status !== undefined && result.status !== 0)
    || typeof result.stdout !== "string" || typeof result.stderr !== "string"
    || Buffer.byteLength(result.stdout) > MAX_OUTPUT
    || Buffer.byteLength(result.stderr) > MAX_OUTPUT) fail();
  return `${result.stdout}\n${result.stderr}`;
}

function lsofProcesses(output) {
  const processes = [];
  let current = null, file = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const kind = line[0], value = line.slice(1);
    if (kind === "p") {
      if (!PID.test(value) || processes.some(item => item.pid === value)) fail();
      current = { pid: value, uid: null, command: null, files: [] };
      processes.push(current);
      file = null;
    } else if (kind === "u" || kind === "c") {
      if (!current || file || !value || current[kind === "u" ? "uid" : "command"] !== null) fail();
      current[kind === "u" ? "uid" : "command"] = value;
    } else if (kind === "f") {
      if (!current || !value) fail();
      file = { fd: value, type: null, name: null };
      current.files.push(file);
    } else if (kind === "t" || kind === "n") {
      if (!file || !value || file[kind === "t" ? "type" : "name"] !== null) fail();
      file[kind === "t" ? "type" : "name"] = value;
    } else fail();
  }
  return processes;
}

async function listenerProcess(run, uid) {
  const output = await runBounded(run, LSOF,
    ["-nP", "-a", "-iTCP:3845", "-sTCP:LISTEN", "-Fpcuftn"], 3_000);
  const processes = lsofProcesses(output);
  if (processes.length !== 1) fail();
  const owner = processes[0];
  if (!UID.test(owner.uid || "") || Number(owner.uid) !== uid
    || !owner.command?.startsWith("Figma") || owner.files.length !== 1) fail();
  const socket = owner.files[0];
  if (socket.type !== "IPv4" || socket.name !== LISTENER) fail();
  return owner;
}

function expectedExecutables(appPath) {
  const main = path.join(appPath, "Contents", "MacOS", "Figma");
  const allowed = new Map([[main, "com.figma.Desktop"]]);
  for (const suffix of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
    const name = `Figma Helper${suffix}`;
    allowed.set(path.join(appPath, "Contents", "Frameworks", `${name}.app`,
      "Contents", "MacOS", name), "com.figma.Desktop.helper");
  }
  return allowed;
}

async function executablePath(run, owner, allowed) {
  const output = await runBounded(run, LSOF,
    ["-nP", "-a", "-p", owner.pid, "-d", "txt", "-Fpcuftn"], 3_000);
  const processes = lsofProcesses(output);
  if (processes.length !== 1 || processes[0].pid !== owner.pid
    || processes[0].uid !== owner.uid || processes[0].command !== owner.command) fail();
  // macOS lsof reports the process executable as its first txt vnode, before
  // dyld and other mapped files. A signed Figma file merely mapped by an
  // unrelated process is not sufficient evidence of process identity.
  const first = processes[0].files[0];
  if (!first || first.fd !== "txt" || first.type !== "REG"
    || !allowed.has(first.name)) fail();
  return first.name;
}

function assertPathNotLinked(appPath, executable) {
  if (!path.isAbsolute(appPath) || !path.isAbsolute(executable)
    || !executable.startsWith(`${appPath}${path.sep}`)) fail();
  let current = path.parse(appPath).root;
  for (const part of path.relative(current, executable).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail(); }
    if (stat.isSymbolicLink() || (current === executable
      ? !stat.isFile() || (stat.mode & 0o111) === 0 : !stat.isDirectory())) fail();
  }
  try {
    if (fs.realpathSync.native(appPath) !== appPath
      || fs.realpathSync.native(executable) !== executable) fail();
  } catch { fail(); }
}

async function signatureDetails(run, target, identifier, executable) {
  const output = await runBounded(run, CODESIGN, ["-dv", "--verbose=4", target], 8_000);
  const fields = new Map();
  for (const line of output.split("\n")) {
    const match = /^(Executable|Identifier|TeamIdentifier)=(.*)$/u.exec(line);
    if (match) {
      if (fields.has(match[1])) fail();
      fields.set(match[1], match[2]);
    }
  }
  if (fields.get("Executable") !== executable
    || fields.get("Identifier") !== identifier
    || fields.get("TeamIdentifier") !== TEAM_ID) fail();
}

async function verifyFigmaDesktopListener({ run = execFileAsync, appPath = APP_PATH,
  platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform !== "darwin" || !Number.isSafeInteger(uid) || uid < 0
    || typeof run !== "function") fail();
  const allowed = expectedExecutables(appPath);
  const before = await listenerProcess(run, uid);
  const executable = await executablePath(run, before, allowed);
  assertPathNotLinked(appPath, executable);
  await runBounded(run, CODESIGN, ["--verify", "--deep", "--strict", appPath], 10_000);
  await signatureDetails(run, appPath, "com.figma.Desktop",
    path.join(appPath, "Contents", "MacOS", "Figma"));
  await runBounded(run, CODESIGN, ["--verify", "--strict", executable], 10_000);
  await signatureDetails(run, executable, allowed.get(executable), executable);
  // Refuse a changed listener or executable after signature verification. This
  // narrows, but cannot eliminate, PID reuse or a later listener replacement.
  const after = await listenerProcess(run, uid);
  if (after.pid !== before.pid || after.uid !== before.uid
    || after.command !== before.command
    || await executablePath(run, after, allowed) !== executable) fail();
  assertPathNotLinked(appPath, executable);
  return true;
}

module.exports = { verifyFigmaDesktopListener };
