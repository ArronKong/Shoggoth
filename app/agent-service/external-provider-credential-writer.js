"use strict";
// Service independently checks the actual paused writer. No caller-supplied
// PID, path, nonce, lease-shaped object, or empty configuration grants access.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createExternalProviderRuntimeAttestor } = require("./external-provider-credential-runtime");
const WebSocket = require("ws");
const { generateIdentity, buildConnectParams } = require("../core/device-auth");
const { credentialOwner } = require("../managed-openclaw-provider-credential");
const { externalProviderOperationScope } = require("./external-provider-credential-controller");
const { serviceError } = require("./security");
const HASH = /^[a-f0-9]{64}$/u, OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_FILE = 1024 * 1024, MAX_WS = 65536;
const fail = code => { throw serviceError(code, code); };
const need = (value, code) => { if (!value) fail(code); };
const signature = stat => ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "uid"].map(key => String(stat[key])).join(":");
const sameWriter = (a, b) => a && b && ["pid", "startIdentity", "nonce", "generation", "runtimeRoot", "runtimeTreeSha256",
  "dataRoot", "interpreterPath", "entryPath", "operationId", "requestDigest"].every(key => a[key] === b[key]);
function privateDirectory(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077n) === 0n
    && (!process.getuid || stat.uid === BigInt(process.getuid())) && fs.realpathSync(target) === target,
  "EXTERNAL_PROVIDER_WRITER_PATH_UNSAFE");
  return stat;
}
function privateFile(target) {
  const before = fs.lstatSync(target, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(MAX_FILE)
    && (before.mode & 0o077n) === 0n && (!process.getuid || before.uid === BigInt(process.getuid())),
  "EXTERNAL_PROVIDER_WRITER_FILE_UNSAFE");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    need(signature(fs.fstatSync(fd, { bigint: true })) === signature(before), "EXTERNAL_PROVIDER_WRITER_FILE_CHANGED");
    const bytes = fs.readFileSync(fd);
    need(signature(fs.fstatSync(fd, { bigint: true })) === signature(before)
      && signature(fs.lstatSync(target, { bigint: true })) === signature(before), "EXTERNAL_PROVIDER_WRITER_FILE_CHANGED");
    return { target, signature: signature(before), hash: crypto.createHash("sha256").update(bytes).digest("hex"), value: JSON.parse(bytes) };
  } finally { fs.closeSync(fd); }
}
function processRecord(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
    { encoding: "utf8", timeout: 1500, maxBuffer: 4096 });
  need(!result.error && !result.signal, "EXTERNAL_PROVIDER_WRITER_IDENTITY_UNAVAILABLE");
  if (result.status === 0 && result.stdout.trim()) return { state: "alive", startIdentity: result.stdout.trim() };
  if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return { state: "absent", startIdentity: null };
    }
  }
  fail("EXTERNAL_PROVIDER_WRITER_IDENTITY_UNAVAILABLE");
}
function assertProcess(writer, readProcess) {
  const actual = readProcess(writer.pid);
  need(actual?.state === "alive" && actual.startIdentity === writer.startIdentity, "EXTERNAL_PROVIDER_WRITER_CHANGED");
}
function lsof(args) {
  const result = spawnSync("/usr/sbin/lsof", [...args, "-Fpn"],
    { encoding: "utf8", timeout: 1500, maxBuffer: 65536 });
  need(!result.error && !result.signal && result.status === 0, "EXTERNAL_PROVIDER_WRITER_SOCKET_UNVERIFIED");
  return result.stdout.split("\n").filter(Boolean);
}
function assertExecutable(writer) {
  const lines = lsof(["-nP", "-a", "-p", String(writer.pid), "-d", "txt"]);
  need(lines.includes("p" + writer.pid) && lines.includes("n" + fs.realpathSync(writer.interpreterPath)),
    "EXTERNAL_PROVIDER_WRITER_EXECUTABLE_CHANGED");
  return true;
}
function assertListener(writer, port) {
  const lines = lsof(["-nP", "-a", "-p", String(writer.pid), "-iTCP:" + port, "-sTCP:LISTEN"]);
  need(lines.includes("p" + writer.pid) && lines.includes("n127.0.0.1:" + port),
    "EXTERNAL_PROVIDER_WRITER_SOCKET_UNVERIFIED");
  return true;
}
async function queryStatus(url, token, params, assertCurrent, timeoutMs) {
  const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1" }, maxPayload: MAX_WS });
  const identity = generateIdentity();
  let connected = false, settled = false, timer;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    const rejectCode = code => finish(serviceError(code, code));
    timer = setTimeout(() => rejectCode("EXTERNAL_PROVIDER_WRITER_TIMEOUT"), timeoutMs);
    socket.on("error", () => rejectCode("EXTERNAL_PROVIDER_WRITER_CONNECTION_FAILED"));
    socket.on("close", () => rejectCode("EXTERNAL_PROVIDER_WRITER_CONNECTION_CLOSED"));
    socket.on("message", bytes => {
      try {
        need(assertCurrent() === true, "EXTERNAL_PROVIDER_WRITER_RETIRED");
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "event" && frame.event === "connect.challenge" && !connected) {
          connected = true;
          socket.send(JSON.stringify({ type: "req", id: "credential-connect", method: "connect",
            params: buildConnectParams({ ...identity, token, scopes: ["operator.read", "operator.write", "operator.admin"] }, frame.payload?.nonce) }));
          return;
        }
        if (frame.type !== "res") return;
        need(frame.ok === true, "EXTERNAL_PROVIDER_WRITER_RPC_REJECTED");
        if (frame.id === "credential-connect") {
          socket.send(JSON.stringify({ type: "req", id: "credential-status", method: "gateway.shoggoth.managed.status", params }));
        } else if (frame.id === "credential-status") finish(null, frame.payload);
      } catch (error) { finish(serviceError(/^EXTERNAL_PROVIDER_[A-Z_]+$/u.test(error.code || "") ? error.code
        : "EXTERNAL_PROVIDER_WRITER_PROOF_INVALID", "EXTERNAL_PROVIDER_WRITER_PROOF_INVALID")); }
    });
  }).catch(error => { clearTimeout(timer); if (!settled) { settled = true; socket.terminate(); } throw error; });
}
function createExternalProviderWriterVerifier(options) {
  need(options?.paths && typeof options.paths.stateDir === "string" && path.isAbsolute(options.paths.stateDir)
    && typeof options.resourcesRoot === "string" && path.isAbsolute(options.resourcesRoot), "EXTERNAL_PROVIDER_WRITER_OPTIONS_INVALID");
  const stateDir = options.paths.stateDir;
  need(fs.realpathSync(stateDir) === stateDir, "EXTERNAL_PROVIDER_WRITER_PATH_UNSAFE");
  const expectedDataRoot = path.join(stateDir, "external-plugin-host-data", "openclaw", "v1");
  const readProcess = options.readProcess || processRecord;
  const verifyExecutable = options.verifyExecutable || assertExecutable;
  const verifyListener = options.verifyListener || assertListener;
  const runtime = options.verifyRuntime ? null : createExternalProviderRuntimeAttestor({ stateDir, resourcesRoot: options.resourcesRoot });
  const verifyRuntime = options.verifyRuntime || runtime.verify;
  const query = options.queryStatus || queryStatus;
  let current = true;
  return Object.freeze({
    close() { current = false; return runtime ? runtime.close() : Promise.resolve(); },
    async verify(rawWriter, context) {
      const writer = credentialOwner(rawWriter), scope = externalProviderOperationScope(context?.scope);
      need(current && context && typeof context.assertCurrent === "function"
        && ["open", "read", "assert", "renew", "advance", "settle", "terminal-observe"].includes(context.phase), "EXTERNAL_PROVIDER_WRITER_CONTEXT_INVALID");
      need(writer.operationId === scope.operationId && writer.requestDigest === scope.requestDigest && writer.dataRoot === expectedDataRoot,
        "EXTERNAL_PROVIDER_WRITER_SCOPE_MISMATCH");
      if (context.phase === "terminal-observe") need(["applied", "compensated", "blocked"].includes(context.outcome)
        && ["paused", "resumed"].includes(context.writerState), "EXTERNAL_PROVIDER_WRITER_CONTEXT_INVALID");
      const expiresAt = Math.min(writer.expiresAt, Date.now() + 60000);
      const guard = () => { need(current && context.assertCurrent() === true && expiresAt > Date.now(), "EXTERNAL_PROVIDER_WRITER_RETIRED"); return true; };
      guard();
      let previous = null;
      if (context.phase === "advance") {
        previous = credentialOwner(context.previousWriter);
        need(previous.operationId === scope.operationId && previous.requestDigest === scope.requestDigest
          && previous.dataRoot === expectedDataRoot && !sameWriter(previous, writer)
          && previous.nonce !== writer.nonce && previous.generation !== writer.generation,
        "EXTERNAL_PROVIDER_WRITER_ADVANCE_INVALID");
        const old = readProcess(previous.pid);
        need(old?.state === "absent" || old?.state === "alive" && old.startIdentity !== previous.startIdentity,
          "EXTERNAL_PROVIDER_PREVIOUS_WRITER_NOT_EXITED");
      }
      const dirs = [stateDir, path.join(stateDir, "external-plugin-host-data"), path.join(stateDir, "external-plugin-host-data", "openclaw"), expectedDataRoot];
      const directoryAnchors = dirs.map(target => ({ target, stat: privateDirectory(target) }));
      const files = ["owner-root.json", "writer.fence", "managed-control.json", "openclaw.json"].map(name => privateFile(path.join(expectedDataRoot, name)));
      const [marker, fence, descriptor, config] = files.map(file => file.value);
      need(marker?.version === 1 && marker.backendId === "openclaw" && typeof marker.rootId === "string" && OP.test(marker.rootId), "EXTERNAL_PROVIDER_WRITER_MARKER_INVALID");
      need(fence?.version === 1 && fence.nonce === writer.nonce && typeof fence.operationId === "string" && OP.test(fence.operationId)
        && fence.runtimeRoot === writer.runtimeRoot, "EXTERNAL_PROVIDER_WRITER_FENCE_INVALID");
      need(descriptor?.version === 1 && descriptor.protocol === "openclaw-managed-v1" && descriptor.backendId === "openclaw"
        && descriptor.nonce === writer.nonce && descriptor.operationId === fence.operationId && descriptor.runtimeRoot === writer.runtimeRoot
        && descriptor.runtimeTreeSha256 === writer.runtimeTreeSha256 && descriptor.dataRoot === expectedDataRoot
        && typeof descriptor.controlToken === "string" && HASH.test(descriptor.controlToken), "EXTERNAL_PROVIDER_WRITER_DESCRIPTOR_INVALID");
      need(config?.gateway?.mode === "local" && config.gateway.bind === "loopback" && config.gateway.auth?.mode === "token"
        && Number.isSafeInteger(config.gateway.port) && config.gateway.port > 0 && config.gateway.port <= 65535
        && typeof config.gateway.auth.token === "string" && HASH.test(config.gateway.auth.token), "EXTERNAL_PROVIDER_WRITER_GATEWAY_INVALID");
      assertProcess(writer, readProcess);
      const assertRuntime = await verifyRuntime(writer); guard();
      need(typeof assertRuntime === "function" && assertRuntime() === true, "EXTERNAL_PROVIDER_RUNTIME_UNVERIFIED");
      assertProcess(writer, readProcess);
      need(verifyExecutable(writer) === true && verifyListener(writer, config.gateway.port) === true,
        "EXTERNAL_PROVIDER_WRITER_SOCKET_UNVERIFIED");
      const assertAnchors = () => {
        guard();
        try { process.kill(writer.pid, 0); } catch { fail("EXTERNAL_PROVIDER_WRITER_CHANGED"); }
        need(assertRuntime() === true, "EXTERNAL_PROVIDER_RUNTIME_UNVERIFIED");
        for (const anchor of directoryAnchors) {
          const now = privateDirectory(anchor.target);
          need(now.dev === anchor.stat.dev && now.ino === anchor.stat.ino, "EXTERNAL_PROVIDER_WRITER_PATH_CHANGED");
        }
        for (const file of files) {
          const latest = privateFile(file.target);
          need(latest.signature === file.signature && latest.hash === file.hash, "EXTERNAL_PROVIDER_WRITER_FILE_CHANGED");
        }
        return true;
      };
      assertAnchors();
      const proof = await query(`ws://127.0.0.1:${config.gateway.port}`, config.gateway.auth.token, {
        version: 1, controlToken: descriptor.controlToken, nonce: writer.nonce, operationId: scope.operationId,
        deadlineAt: expiresAt, generation: writer.generation,
      }, assertAnchors, Math.max(1, Math.min(5000, expiresAt - Date.now())));
      assertAnchors(); assertProcess(writer, readProcess);
      need(verifyExecutable(writer) === true && verifyListener(writer, config.gateway.port) === true,
        "EXTERNAL_PROVIDER_WRITER_SOCKET_UNVERIFIED");
      need(proof?.version === 1 && proof.protocol === "openclaw-managed-v1" && proof.backendId === "openclaw"
        && proof.pid === writer.pid && proof.nonce === writer.nonce && proof.generation === writer.generation
        && proof.runtimeRoot === writer.runtimeRoot && proof.runtimeTreeSha256 === writer.runtimeTreeSha256
        && proof.dataRoot === expectedDataRoot && proof.selectionSupported === true && proof.snapshot?.idle === true
        && proof.snapshot.counts?.totalActive === 0, "EXTERNAL_PROVIDER_WRITER_PROOF_INVALID");
      if (context.phase === "settle" && context.outcome !== "needs_verification"
        || context.phase === "terminal-observe" && context.writerState === "resumed") {
        need(proof.paused === false && proof.operationId === null, "EXTERNAL_PROVIDER_WRITER_RESUME_UNVERIFIED");
      } else need(proof.paused === true && proof.operationId === scope.operationId, "EXTERNAL_PROVIDER_WRITER_NOT_PAUSED");
      if (previous) {
        const old = readProcess(previous.pid);
        need(old?.state === "absent" || old?.state === "alive" && old.startIdentity !== previous.startIdentity,
          "EXTERNAL_PROVIDER_PREVIOUS_WRITER_NOT_EXITED");
      }
      return assertAnchors;
    },
  });
}
module.exports = { createExternalProviderWriterVerifier, sameExternalProviderWriter: sameWriter };
