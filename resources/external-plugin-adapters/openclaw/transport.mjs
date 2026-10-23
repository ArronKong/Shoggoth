import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const VERSION = 13; // Checked against the Service at registration and packaging.
const MAX_FRAME = 64 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

const hashPattern = /^[a-f0-9]{64}$/u;
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function safeStat(target, kind) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (kind === "directory" && !stat.isDirectory())
    || (kind === "socket" && !stat.isSocket())
    || (kind === "file" && (!stat.isFile() || stat.nlink !== 1))) {
    throw new Error("Shoggoth adapter path is unsafe");
  }
  return stat;
}

function canonical(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096
    || !path.isAbsolute(value) || path.normalize(value) !== value
    || fs.realpathSync(value) !== value) {
    throw new Error("Managed Shoggoth Service binding is not canonical");
  }
  return value;
}

function stablePrivateBytes(target, limit) {
  const before = safeStat(target, "file");
  if (before.size > limit) throw new Error("Shoggoth adapter private record is too large");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error("Shoggoth adapter private record changed");
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length);
    const current = fs.fstatSync(fd);
    const after = safeStat(target, "file");
    if (bytes.length > limit || bytes.length !== opened.size || current.size !== opened.size
      || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs
      || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("Shoggoth adapter private record changed");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

// App-main supplies this only to its protected managed foreground Host. Freeze
// the profile before any tool runs; a standalone legacy Host ignores root ENV.
function freezeManagedRoot() {
  const descriptorValue = process.env.OPENCLAW_SHOGGOTH_MANAGED_DESCRIPTOR;
  if (descriptorValue === undefined) return null;
  const rootValue = process.env.SHOGGOTH_SERVICE_USER_DATA_ROOT;
  if (!descriptorValue || !rootValue) throw new Error("Managed Shoggoth Service binding is missing");
  const descriptorPath = canonical(descriptorValue);
  const root = canonical(rootValue);
  const descriptor = JSON.parse(stablePrivateBytes(descriptorPath, 8192));
  const keys = ["version", "protocol", "backendId", "nonce", "operationId", "runtimeRoot", "runtimeTreeSha256", "dataRoot", "controlToken"];
  if (!descriptor || Array.isArray(descriptor) || Object.keys(descriptor).length !== keys.length
    || !keys.every(key => Object.hasOwn(descriptor, key)) || descriptor.version !== 1
    || descriptor.protocol !== "openclaw-managed-v1" || descriptor.backendId !== "openclaw"
    || ![descriptor.nonce, descriptor.controlToken, descriptor.runtimeTreeSha256].every(value => typeof value === "string" && hashPattern.test(value))
    || typeof descriptor.operationId !== "string" || !operationPattern.test(descriptor.operationId)) {
    throw new Error("Managed Shoggoth descriptor is invalid");
  }
  const dataRoot = canonical(descriptor.dataRoot);
  const runtimeRoot = canonical(descriptor.runtimeRoot);
  const entry = canonical(process.argv[1]);
  if (descriptorPath !== path.join(dataRoot, "managed-control.json")
    || process.env.OPENCLAW_STATE_DIR !== path.join(dataRoot, "state")
    || process.env.OPENCLAW_CONFIG_PATH !== path.join(dataRoot, "openclaw.json")
    || entry !== path.join(runtimeRoot, "openclaw.mjs") || !fs.lstatSync(entry).isFile()) {
    throw new Error("Managed Shoggoth descriptor owner differs");
  }
  safeStat(dataRoot, "directory");
  const anchor = safeStat(root, "directory");
  return Object.freeze({ root, dev: anchor.dev, ino: anchor.ino });
}
const managedRoot = freezeManagedRoot();

function root() {
  if (!managedRoot) {
    return path.join(os.userInfo().homedir, "Library", "Application Support", "Shoggoth");
  }
  canonical(managedRoot.root);
  const current = safeStat(managedRoot.root, "directory");
  if (current.dev !== managedRoot.dev || current.ino !== managedRoot.ino) {
    throw new Error("Managed Shoggoth Service root changed");
  }
  return managedRoot.root;
}

function privateChild(name) {
  const target = path.join(root(), name);
  if (managedRoot) { canonical(target); safeStat(target, "directory"); }
  return target;
}
function credentialPath() { return path.join(privateChild("shoggoth-core"), "external-plugin-openclaw.auth.json"); }
function socketPath() { return path.join(privateChild("run"), "service.sock"); }

export function readCredential() {
  const record = JSON.parse(stablePrivateBytes(credentialPath(), 256));
  if (record?.schemaVersion !== 1 || typeof record.token !== "string"
    || !tokenPattern.test(record.token)) throw new Error("Shoggoth adapter credential invalid");
  return record.token;
}

export function request(method, params, { signal, timeoutMs = 10_000 } = {}) {
  const target = socketPath();
  const before = safeStat(target, "socket");
  const id = crypto.randomUUID();
  const frame = `${JSON.stringify({ id, version: VERSION, method, params })}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME) {
    throw new Error("Shoggoth adapter request is too large");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new Error("Shoggoth adapter call canceled"));
    const timer = setTimeout(() => finish(new Error("Shoggoth adapter request timed out")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    socket.on("connect", () => {
      let current;
      try { if (socketPath() !== target) throw new Error("Shoggoth Service binding changed"); current = safeStat(target, "socket"); }
      catch (error) { finish(error); return; }
      if (current.dev !== before.dev || current.ino !== before.ino) {
        finish(new Error("Shoggoth Service socket changed")); return;
      }
      socket.write(frame);
    });
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) finish(new Error("Shoggoth adapter response is too large"));
    });
    socket.on("error", error => finish(error));
    socket.on("end", () => {
      if (settled) return;
      try { socketPath(); } catch (error) { finish(error); return; }
      if (buffer.at(-1) !== 10 || buffer.subarray(0, -1).includes(10)) {
        finish(new Error("Shoggoth adapter response framing invalid")); return;
      }
      let response;
      try { response = JSON.parse(buffer.subarray(0, -1).toString("utf8")); }
      catch { finish(new Error("Shoggoth adapter response invalid")); return; }
      if (response.id !== id || typeof response.ok !== "boolean") {
        finish(new Error("Shoggoth adapter response identity invalid")); return;
      }
      if (!response.ok) {
        const error = new Error("Shoggoth capability unavailable");
        error.code = response.error?.code || "SHOGGOTH_SERVICE_ERROR";
        finish(error); return;
      }
      finish(null, response.result);
    });
    socket.on("close", () => {
      if (!settled) finish(new Error("Shoggoth Service disconnected"));
    });
  });
}
