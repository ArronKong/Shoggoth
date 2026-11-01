"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const WebSocket = require("ws");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

// This is a narrowly scoped compatibility adapter for the verified 1.4.3
// protocol, not a user-configurable replacement for the official harness.
const VERSION = "1.4.3";
// The verified upstream contract requires a positive duration. Match the
// portable runtime MCP limit; local task/approval waits have no total deadline.
const TIMEOUT_SECONDS = require("./interactive-timeouts").DEFAULT_MCP_TOOL_TIMEOUT_SEC;
const MAX_CONTROL = 16 * 1024;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_BUFFERED = 32 * 1024 * 1024;
const MAX_SESSIONS = 16;
const MAX_CONNECTIONS = 32;
const HANDSHAKE_MS = 5000;
const STARTUP_MS = 30_000;
// sdk_local_connection.py in 1.4.3 closes WS, then stdin, then waits this long
// for a normal harness exit. Control EOF is cancellation, so it must not race
// that ordering. Explicit Host/scope cancellation still disposes immediately.
const RETIREMENT_MS = 180_000;
const PREFIX = "ANTIGRAVITY_MCP_TIMEOUT_";
const decoder = new TextDecoder("utf-8", { fatal: true });
const fail = (code) => { throw serviceError(PREFIX + code, PREFIX + code); };
const need = (condition, code) => { if (!condition) fail(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const pid = (value) => Number.isSafeInteger(value) && value > 1 && value <= 0x7fffffff;
const text = (value, limit = 16 * 1024) => typeof value === "string" && value.isWellFormed()
  && !value.includes("\0") && Buffer.byteLength(value) <= limit;
const secureEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function processIdentity(targetPid) {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(targetPid)], {
      encoding: "utf8", timeout: 500, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

function processLink(targetPid) {
  try {
    const read = (field) => execFileSync("/bin/ps", ["-o", `${field}=`, "-p", String(targetPid)], {
      encoding: "utf8", timeout: 500, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { ppid: Number(read("ppid")), executable: read("comm"), command: read("command") };
  } catch { return null; }
}

function executable(target) {
  need(text(target) && path.isAbsolute(target), "OPTIONS_INVALID");
  const stat = fs.lstatSync(target);
  need(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(target) === target
    && (stat.mode & 0o022) === 0
    && (!process.getuid || [0, process.getuid()].includes(stat.uid)), "EXECUTABLE_INVALID");
  fs.accessSync(target, fs.constants.X_OK);
  return target;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function descriptor(value, acp = false) {
  need(object(value) && value.name === "shoggoth", "DESCRIPTOR_INVALID");
  const stdio = acp ? value : value.stdio;
  need(object(stdio) && (acp || keys(stdio, ["command", "args", "env"]))
    && text(stdio.command) && stdio.command.length > 0, "DESCRIPTOR_INVALID");
  const args = stdio.args === undefined ? [] : stdio.args;
  need(Array.isArray(args) && args.length <= 128 && args.every((arg) => text(arg)), "DESCRIPTOR_INVALID");
  let env = stdio.env === undefined ? (acp ? [] : {}) : stdio.env;
  if (acp) {
    need(Array.isArray(env) && env.length <= 128, "DESCRIPTOR_INVALID");
    const converted = Object.create(null);
    for (const entry of env) {
      need(object(entry) && keys(entry, ["name", "value"]) && text(entry.name, 1024)
        && entry.name.length > 0 && !entry.name.includes("=") && text(entry.value)
        && !Object.hasOwn(converted, entry.name), "DESCRIPTOR_INVALID");
      converted[entry.name] = entry.value;
    }
    env = converted;
  }
  need(object(env) && Object.keys(env).length <= 128
    && Object.entries(env).every(([name, value]) => text(name, 1024) && name.length > 0
      && !name.includes("=") && text(value)), "DESCRIPTOR_INVALID");
  return canonical({ name: value.name, command: stdio.command, args, env });
}

function varint(value) {
  const bytes = [];
  do { let byte = value & 127; value = Math.floor(value / 128); if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}

// OutputConfig in the pinned release contains only int32 port(1) and string
// api_key(2). Reject ambiguous/extended protobufs rather than forwarding secrets
// or a listener selected through a different interpretation of the bytes.
function outputConfig(bytes) {
  let cursor = 0;
  const read = () => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      need(cursor < bytes.length, "CONTROL_INVALID");
      const byte = bytes[cursor++];
      value += (byte & 127) * (2 ** (index * 7));
      if (!(byte & 128)) return value;
    }
    fail("CONTROL_INVALID");
  };
  let port, key;
  while (cursor < bytes.length) {
    const tag = read();
    if (tag === 8 && port === undefined) port = read();
    else if (tag === 18 && key === undefined) {
      const length = read();
      need(length > 0 && length <= 4096 && cursor + length <= bytes.length, "CONTROL_INVALID");
      try { key = decoder.decode(bytes.subarray(cursor, cursor + length)); } catch { fail("CONTROL_INVALID"); }
      cursor += length;
    } else fail("CONTROL_INVALID");
  }
  need(Number.isSafeInteger(port) && port > 0 && port <= 65535 && text(key, 4096) && key.length > 0, "CONTROL_INVALID");
  return { port, key };
}

function encodeOutput(port, key) {
  const bytes = Buffer.from(key);
  return Buffer.concat([Buffer.from([8]), varint(port), Buffer.from([18]), varint(bytes.length), bytes]);
}

function frame(bytes) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

class AntigravityMcpTimeoutBridge {
  constructor(options = {}) {
    need(options.server?.version === VERSION, "VERSION_UNSUPPORTED");
    need(typeof options.getAcpPid === "function" && typeof options.onFatal === "function"
      && object(options.paths), "OPTIONS_INVALID");
    this.paths = options.paths;
    this.serverPath = options.server.serverPath;
    this.harnessPath = options.server.harnessPath;
    this.bootstrapPath = options.bootstrapPath;
    this.getAcpPid = options.getAcpPid;
    this.onFatal = options.onFatal;
    this.readProcessLink = options.readProcessLink || processLink;
    this.readProcessIdentity = options.readProcessIdentity || processIdentity;
    this.registrations = new Map();
    this.connections = new Set();
    this.sessions = new Map();
    this.retired = new Set();
    this.started = false;
    this.closing = false;
    this.fatal = false;
  }

  async start() {
    need(!this.started && !this.closing, "CLOSED");
    this.started = true;
    try {
      executable(this.harnessPath);
      executable(this.serverPath);
      executable(this.bootstrapPath);
      let parent = "/private/tmp";
      if (text(this.paths.runtimeDir) && path.isAbsolute(this.paths.runtimeDir)
        && Buffer.byteLength(path.join(this.paths.runtimeDir, "agy-to-XXXXXX", "c.sock")) <= 103) {
        ensurePrivateDirectoryTree(this.paths.runtimeDir, this.paths.trustedRoot);
        parent = this.paths.runtimeDir;
      }
      this.directory = fs.mkdtempSync(path.join(parent, "agy-to-"));
      fs.chmodSync(this.directory, 0o700);
      this.directoryIdentity = fs.lstatSync(this.directory);
      this.socketPath = path.join(this.directory, "c.sock");
      need(Buffer.byteLength(this.socketPath) <= 103, "SOCKET_PATH_INVALID");
      this.token = crypto.randomBytes(32).toString("hex");
      this.listener = net.createServer((socket) => this._acceptControl(socket));
      await new Promise((resolve, reject) => {
        this.listener.once("error", reject);
        this.listener.listen(this.socketPath, () => { this.listener.removeListener("error", reject); resolve(); });
      });
      this.listener.on("error", () => this._fatal("CONTROL_LISTEN_FAILED"));
      fs.chmodSync(this.socketPath, 0o600);
      this.env = Object.freeze({
        SHOGGOTH_AGY_HARNESS_PATH: this.harnessPath,
        SHOGGOTH_AGY_TIMEOUT_SOCKET: this.socketPath,
        SHOGGOTH_AGY_TIMEOUT_TOKEN: this.token,
      });
      return this.env;
    } catch (error) {
      await this.close();
      if (error?.code?.startsWith(PREFIX)) throw error;
      fail("START_FAILED");
    }
  }

  getBootstrapEnv() {
    need(this.env && !this.closing, "CLOSED");
    return this.env;
  }

  registerMcpServer(value) {
    need(!this.closing, "CLOSED");
    const fingerprint = descriptor(value, true);
    this.registrations.set(fingerprint, (this.registrations.get(fingerprint) || 0) + 1);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const count = (this.registrations.get(fingerprint) || 0) - 1;
      if (count > 0) this.registrations.set(fingerprint, count);
      else {
        this.registrations.delete(fingerprint);
        for (const session of this.sessions.values()) {
          if (session.fingerprint === fingerprint) this._disposeSession(session);
        }
      }
    };
  }

  _fatal(code) {
    if (this.fatal || this.closing) return;
    this.fatal = true;
    // Close before notifying the Host; a callback must not leave a live bypass.
    void this.close().catch(() => {});
    try { this.onFatal(serviceError(PREFIX + code, PREFIX + code)); } catch { /* Host callback cannot keep sockets alive. */ }
  }

  _assertProcesses(session, capture = false) {
    const acpPid = this.getAcpPid();
    need(pid(acpPid) && acpPid !== session.harnessPid && acpPid !== session.relayPid, "PROCESS_INVALID");
    const readIdentities = () => [acpPid, this.readProcessIdentity(acpPid),
      this.readProcessIdentity(session.harnessPid), this.readProcessIdentity(session.relayPid)];
    const before = readIdentities();
    need(before.slice(1).every((identity) => text(identity, 4096) && identity.length > 0), "PROCESS_INVALID");
    const acp = this.readProcessLink(acpPid);
    const harness = this.readProcessLink(session.harnessPid);
    const relay = this.readProcessLink(session.relayPid);
    need(acp?.executable === this.serverPath && text(acp.command) && acp.command.length > 0
      && harness?.executable === this.harnessPath && harness.ppid === acpPid
      && text(harness.command) && harness.command.length > 0
      && relay?.executable === this.bootstrapPath && relay.ppid === session.harnessPid
      && text(relay.command) && relay.command.length > 0, "PROCESS_INVALID");
    const identities = readIdentities();
    need(this.getAcpPid() === acpPid && canonical(before) === canonical(identities), "PROCESS_CHANGED");
    if (capture) session.identities = identities;
    else need(canonical(identities) === canonical(session.identities), "PROCESS_CHANGED");
  }

  _acceptControl(socket) {
    if (this.closing || this.connections.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    this.connections.add(socket);
    let stage = 0, buffer = Buffer.alloc(0), expected = null, session;
    let timeout = setTimeout(() => {
      if (session) this._fatal("CONTROL_TIMEOUT");
      socket.destroy();
    }, HANDSHAKE_MS);
    timeout.unref();
    socket.on("error", () => {
      if (session?.retiring) this._disposeSession(session);
      else if (session && !session.disposed) this._fatal("CONTROL_FAILED");
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      this.connections.delete(socket);
      if (session && !session.disposed) this._disposeSession(session);
    });
    socket.on("data", (chunk) => {
      try {
        need(stage < 2 && buffer.length + chunk.length <= MAX_CONTROL + 4096, "CONTROL_INVALID");
        buffer = Buffer.concat([buffer, chunk]);
        while (stage < 2) {
          if (expected === null) {
            if (buffer.length < 4) return;
            expected = buffer.readUInt32LE(0);
            buffer = buffer.subarray(4);
            need(expected > 0 && expected <= (stage === 0 ? 2048 : MAX_CONTROL), "CONTROL_INVALID");
          }
          if (buffer.length < expected) return;
          const bytes = buffer.subarray(0, expected);
          buffer = buffer.subarray(expected);
          expected = null;
          if (stage === 0) {
            let hello;
            try { hello = JSON.parse(decoder.decode(bytes)); } catch { fail("CONTROL_INVALID"); }
            need(object(hello) && secureEqual(hello.token, this.token), "UNAUTHENTICATED");
            need(keys(hello, ["version", "token", "harnessPid", "relayPid"]) && hello.version === 1
              && pid(hello.harnessPid) && pid(hello.relayPid) && hello.harnessPid !== hello.relayPid,
            "CONTROL_INVALID");
            need(this.sessions.size < MAX_SESSIONS && !this.sessions.has(hello.harnessPid)
              && ![...this.sessions.values()].some((item) => item.relayPid === hello.relayPid), "CONTROL_DUPLICATE");
            session = { harnessPid: hello.harnessPid, relayPid: hello.relayPid, control: socket, disposed: false };
            this.sessions.set(session.harnessPid, session);
            // Unauthenticated peers get only the short handshake budget. A
            // native launcher proving the private token gets the same bounded
            // cold-start allowance as the C bootstrap's OutputConfig read.
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              this._fatal("CONTROL_TIMEOUT");
              socket.destroy();
            }, STARTUP_MS);
            timeout.unref();
          } else {
            need(buffer.length === 0, "CONTROL_INVALID");
            session.original = outputConfig(bytes);
            // The native launcher announces PIDs before its parent execs the
            // signed harness. OutputConfig is produced by that harness, so
            // inspect executable/ancestry only after receiving this frame.
            this._assertProcesses(session, true);
            clearTimeout(timeout);
            session.preparing = this._prepareProxy(session).catch((error) => this._fatal(
              error?.code?.startsWith(PREFIX) ? error.code.slice(PREFIX.length) : "PROXY_FAILED"));
          }
          stage += 1;
        }
      } catch (error) {
        if (session) this._fatal(error?.code?.startsWith(PREFIX) ? error.code.slice(PREFIX.length) : "CONTROL_INVALID");
        socket.destroy();
      }
    });
  }

  async _prepareProxy(session) {
    const listener = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    session.listener = listener;
    session.websockets = new WebSocket.WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    session.key = crypto.randomBytes(32).toString("hex");
    listener.on("clientError", (_error, socket) => socket.destroy());
    listener.on("connection", (socket) => {
      if (session.disposed || session.retiring || session.httpSockets?.size >= 8) { socket.destroy(); return; }
      session.httpSockets ||= new Set();
      session.httpSockets.add(socket);
      socket.setTimeout(HANDSHAKE_MS, () => socket.destroy());
      socket.once("close", () => session.httpSockets.delete(socket));
    });
    listener.on("upgrade", (request, socket, head) => {
      try {
        const keyHeaders = request.rawHeaders.filter((_value, index) => index % 2 === 0)
          .filter((name) => name.toLowerCase() === "x-goog-api-key");
        if (session.disposed || session.retiring || session.claimed || request.url !== "/"
          || request.socket.remoteAddress !== "127.0.0.1" || keyHeaders.length !== 1
          || !secureEqual(request.headers["x-goog-api-key"], session.key)) {
          socket.destroy(); return;
        }
        this._assertProcesses(session);
        session.claimed = true;
        socket.setTimeout(0);
        session.websockets.handleUpgrade(request, socket, head, (client) => this._acceptWebSocket(session, client));
      } catch { socket.destroy(); this._fatal("PROCESS_CHANGED"); }
    });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => { listener.removeListener("error", reject); resolve(); });
    });
    listener.on("error", () => this._fatal("PROXY_FAILED"));
    if (session.disposed || this.closing) {
      await new Promise((resolve) => listener.close(() => resolve()));
      return;
    }
    this._assertProcesses(session);
    session.control.write(frame(encodeOutput(listener.address().port, session.key)));
    session.handshake = setTimeout(() => this._fatal("INITIAL_TIMEOUT"), HANDSHAKE_MS);
    session.handshake.unref();
  }

  _initial(session, bytes, binary) {
    need(!binary && bytes.length <= MAX_PAYLOAD, "INITIAL_INVALID");
    let event;
    try { event = JSON.parse(decoder.decode(bytes)); } catch { fail("INITIAL_INVALID"); }
    need(object(event) && object(event.config) && !Object.hasOwn(event.config, "mcp_servers"), "INITIAL_INVALID");
    const servers = event.config.mcpServers;
    need(servers === undefined || (Array.isArray(servers) && servers.length <= 128), "INITIAL_INVALID");
    const targets = (servers || []).filter((item) => object(item) && item.name === "shoggoth");
    this._assertProcesses(session);
    // Model-catalog discovery starts a real SDK harness with no MCP servers.
    // Protobuf JSON omits the empty repeated field. Absence of our server is
    // a reduction in authority: preserve the exact config bytes and bind no
    // Shoggoth scope. Any present target still has to match below.
    if (targets.length === 0) return bytes;
    need(targets.length === 1, "DESCRIPTOR_MISMATCH");
    const target = targets[0];
    // Accept canonical protobuf JSON names only. In particular a second
    // timeout_seconds/mcp_servers spelling must not compete with our edit.
    need(keys(target, ["name", "stdio", "enabledTools", "disabledTools", "authProviderType",
      "timeoutSeconds", "forceAllToolsEager"]), "DESCRIPTOR_MISMATCH");
    const fingerprint = descriptor(target);
    need(this.registrations.has(fingerprint), "DESCRIPTOR_MISMATCH");
    session.fingerprint = fingerprint;
    target.timeoutSeconds = TIMEOUT_SECONDS;
    return Buffer.from(JSON.stringify(event));
  }

  _acceptWebSocket(session, client) {
    session.client = client;
    let first = true;
    const queued = [];
    let queuedBytes = 0;
    const relay = (source, destination, bytes, binary) => {
      if (session.disposed || session.retiring) return;
      if (bytes.length + destination.bufferedAmount > MAX_BUFFERED) { this._fatal("BACKPRESSURE_LIMIT"); return; }
      if (destination.bufferedAmount + bytes.length >= 1024 * 1024) source.pause();
      destination.send(bytes, { binary }, (error) => {
        if (session.disposed || session.retiring) return;
        if (error) this._fatal("RELAY_FAILED");
        else if (destination.bufferedAmount < 1024 * 1024) source.resume();
      });
    };
    client.on("error", () => { if (!session.disposed && !session.retiring) this._fatal("CLIENT_FAILED"); });
    client.on("close", () => { if (!session.disposed) this._retireSession(session); });
    client.on("message", (data, binary) => {
      if (session.disposed || session.retiring) return;
      try {
        let bytes = Buffer.from(data);
        if (first) {
          bytes = this._initial(session, bytes, binary);
          first = false;
          clearTimeout(session.handshake);
          const upstream = new WebSocket(`ws://127.0.0.1:${session.original.port}/`, {
            headers: { "x-goog-api-key": session.original.key }, handshakeTimeout: HANDSHAKE_MS,
            maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
          });
          session.upstream = upstream;
          upstream.on("error", () => { if (!session.disposed && !session.retiring) this._fatal("UPSTREAM_FAILED"); });
          upstream.on("close", () => { if (!session.disposed) this._retireSession(session); });
          upstream.on("message", (reply, isBinary) => relay(upstream, client, Buffer.from(reply), isBinary));
          upstream.once("open", () => {
            if (session.disposed || session.retiring) { upstream.terminate(); return; }
            for (const entry of queued) relay(client, upstream, entry.bytes, entry.binary);
            queued.length = 0;
            queuedBytes = 0;
            client.resume();
          });
        }
        if (session.upstream.readyState === WebSocket.OPEN) relay(client, session.upstream, bytes, binary);
        else {
          queuedBytes += bytes.length;
          need(queuedBytes <= MAX_BUFFERED, "BACKPRESSURE_LIMIT");
          queued.push({ bytes, binary });
          client.pause();
        }
      } catch (error) {
        this._fatal(error?.code?.startsWith(PREFIX) ? error.code.slice(PREFIX.length) : "INITIAL_INVALID");
      }
    });
  }

  _closeProxy(session) {
    if (session.proxyClosed) return session.proxyClosed;
    const closed = [];
    if (session.websockets) closed.push(new Promise((resolve) => session.websockets.close(() => resolve())));
    if (session.listener?.listening) closed.push(new Promise((resolve) => session.listener.close(() => resolve())));
    session.proxyClosed = Promise.all(closed);
    return session.proxyClosed;
  }

  _retireSession(session) {
    if (session.disposed || session.retiring) return;
    session.retiring = true;
    clearTimeout(session.handshake);
    // Send a normal close on the other side. Keep this session in the live
    // map, including its scope and control socket, until parent exit or expiry.
    for (const socket of [session.client, session.upstream]) {
      if (socket?.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
    }
    this._closeProxy(session);
    session.retirementTimer = setTimeout(() => this._disposeSession(session), RETIREMENT_MS);
    session.retirementTimer.unref();
    session.original = null;
    session.key = null;
  }

  _disposeSession(session) {
    if (session.disposed) return session.closed;
    session.disposed = true;
    clearTimeout(session.handshake);
    clearTimeout(session.retirementTimer);
    session.client?.terminate();
    session.upstream?.terminate();
    for (const socket of session.httpSockets || []) socket.destroy();
    session.closed = this._closeProxy(session);
    this.retired.add(session);
    Promise.all([session.preparing, session.closed]).then(() => this.retired.delete(session));
    session.control.destroy();
    this.sessions.delete(session.harnessPid);
    session.original = null;
    session.key = null;
    return session.closed;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const sessions = [...new Set([...this.sessions.values(), ...this.retired])];
      for (const session of sessions) this._disposeSession(session);
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      this.registrations.clear();
      if (this.listener) await new Promise((resolve) => this.listener.close(() => resolve()));
      await Promise.all(sessions.flatMap((session) => [session.preparing, session.closed]));
      if (this.directory) {
        try {
          const actual = fs.lstatSync(this.directory);
          if (actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === this.directoryIdentity.dev
            && actual.ino === this.directoryIdentity.ino) fs.rmSync(this.directory, { recursive: true, force: true });
        } catch (error) { if (error?.code !== "ENOENT") fail("CLEANUP_FAILED"); }
      }
      this.token = null;
      this.env = null;
    })();
    return this.closePromise;
  }
}

module.exports = { AntigravityMcpTimeoutBridge };
