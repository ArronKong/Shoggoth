import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const VERSION = 11;
const MAX_FRAME = 64 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function roots() {
  const home = os.userInfo().homedir;
  const root = path.join(home, "Library", "Application Support", "Shoggoth");
  return { socket: path.join(root, "run", "service.sock"),
    credential: path.join(root, "shoggoth-core", "external-plugin-openclaw.auth.json") };
}

function safeStat(target, kind) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (kind === "socket" && !stat.isSocket())
    || (kind === "file" && (!stat.isFile() || stat.nlink !== 1))) {
    throw new Error("Shoggoth adapter path is unsafe");
  }
  return stat;
}

export function readCredential() {
  const target = roots().credential;
  const before = safeStat(target, "file");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 256) {
      throw new Error("Shoggoth adapter credential changed");
    }
    const record = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (record?.schemaVersion !== 1 || typeof record.token !== "string"
      || !tokenPattern.test(record.token)) throw new Error("Shoggoth adapter credential invalid");
    return record.token;
  } finally { fs.closeSync(fd); }
}

export function request(method, params, { signal, timeoutMs = 10_000 } = {}) {
  const target = roots().socket;
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
      try { current = safeStat(target, "socket"); }
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
