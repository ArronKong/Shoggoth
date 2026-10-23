"use strict";
// Private Worker -> original Service only. This is deliberately independent of
// plugin adapter credentials and accepts no environment or per-command paths.
const fs = require("node:fs"), net = require("node:net"), path = require("node:path"), crypto = require("node:crypto");
const schema = require("./managed-openclaw-provider-credential-schema");
const { plain, fail } = require("./managed-openclaw-model-policy");
const { SERVICE_PROTOCOL_VERSION } = require("./agent-service/service-protocol-version");
const { NATIVE_AUTH_API, NATIVE_AUTH_PREFIX } = require("./managed-openclaw-auth-profile-constants");
const PREFIX = "external.provider.credential.lease.";
const MAX_FRAME = schema.MAX_FRAME_BYTES;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const need = (value, code = "MANAGED_MODEL_CREDENTIAL_CHANNEL_INVALID") => { if (!value) throw fail(code); };
function privateStat(target, kind) {
  const stat = fs.lstatSync(target);
  need(!stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid())
    && (kind === "directory" ? stat.isDirectory() : kind === "socket" ? stat.isSocket() : stat.isFile() && stat.nlink === 1)
    && fs.realpathSync(target) === target, "MANAGED_MODEL_CREDENTIAL_PATH_UNSAFE");
  return stat;
}
function samePath(target, before, kind) {
  const after = privateStat(target, kind);
  need(before.dev === after.dev && before.ino === after.ino, "MANAGED_MODEL_CREDENTIAL_PATH_CHANGED"); return after;
}
function createManagedOpenClawProviderCredentialClient(options) {
  need(exact(options, ["serviceUserDataRoot", "assertCurrent"]) && typeof options.assertCurrent === "function"
    && typeof options.serviceUserDataRoot === "string" && path.isAbsolute(options.serviceUserDataRoot)
    && path.normalize(options.serviceUserDataRoot) === options.serviceUserDataRoot && Buffer.byteLength(options.serviceUserDataRoot) <= 4096);
  const root = options.serviceUserDataRoot, rootIdentity = privateStat(root, "directory");
  const run = path.join(root, "run"), tokenPath = path.join(run, "client.token"), socketPath = path.join(run, "service.sock");
  function check(context, permit) {
    need(context && Number.isSafeInteger(context.deadlineAt) && context.deadlineAt > Date.now()
      && context.deadlineAt <= Date.now() + 300000 && typeof context.assertCurrent === "function"
      && (context.signal === undefined || context.signal instanceof AbortSignal), "MANAGED_MODEL_CREDENTIAL_COMMAND_INVALID");
    context.signal?.throwIfAborted();
    const current = context.assertCurrent(); need(current === undefined || current === true, "MANAGED_MODEL_CREDENTIAL_COMMAND_RETIRED");
    need(options.assertCurrent() === true && permit.writer.expiresAt > Date.now(), "MANAGED_MODEL_CREDENTIAL_COMMAND_RETIRED");
    samePath(root, rootIdentity, "directory");
  }
  function readToken() {
    // The formal Service's instance-state.writePrivateToken producer emits a
    // 32-byte lowercase hex token, with one optional trailing newline.
    const before = privateStat(tokenPath, "file"); need(before.size >= 64 && before.size <= 65);
    const fd = fs.openSync(tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd); need(opened.dev === before.dev && opened.ino === before.ino, "MANAGED_MODEL_CREDENTIAL_PATH_CHANGED");
      const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
      need(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs);
      samePath(tokenPath, before, "file");
      const token = bytes.toString("utf8"); bytes.fill(0);
      need(/^[a-f0-9]{64}\n?$/u.test(token)); return { token: token.trim(), identity: before };
    } finally { fs.closeSync(fd); }
  }
  async function request(method, rawPermit, field, context, recovery = false, terminalExpected = null) {
    need(["read", "assert", "settle", "terminal.observe"].includes(method));
    const terminal = method === "terminal.observe";
    const permit = schema.credentialPermit(rawPermit); check(context, permit);
    need(typeof recovery === "boolean");
    if (terminal) need(exact(field, ["outcome", "writerState"]) && ["applied", "compensated", "blocked"].includes(field.outcome)
      && ["paused", "resumed"].includes(field.writerState));
    else if (method === "settle") need(["applied", "compensated", "blocked", "needs_verification"].includes(field));
    else need(["candidate", "previous"].includes(field));
    const runIdentity = privateStat(run, "directory"), socketIdentity = privateStat(socketPath, "socket"), auth = readToken();
    const params = { owner: permit.owner, scope: permit.scope, writer: permit.writer,
      ...(terminal ? field : method === "settle" ? { outcome: field } : { phase: field }), ...(method === "read" ? { recovery } : {}) };
    const id = crypto.randomUUID();
    let frame = Buffer.from(JSON.stringify({ id, version: SERVICE_PROTOCOL_VERSION, token: auth.token,
      method: (permit.scope.api === NATIVE_AUTH_API ? NATIVE_AUTH_PREFIX + "lease." : PREFIX) + method, params }) + "\n");
    need(frame.length <= MAX_FRAME);
    const deadlineAt = Math.min(context.deadlineAt, permit.writer.expiresAt, Date.now() + 10000);
    const checkPaths = () => { check(context, permit); samePath(run, runIdentity, "directory"); samePath(socketPath, socketIdentity, "socket");
      const current = samePath(tokenPath, auth.identity, "file");
      need(current.size === auth.identity.size && current.mtimeMs === auth.identity.mtimeMs && current.ctimeMs === auth.identity.ctimeMs,
        "MANAGED_MODEL_CREDENTIAL_PATH_CHANGED"); };
    checkPaths();
    return new Promise((resolve, reject) => {
      let socket, timer, buffered = Buffer.alloc(0), settled = false, dispatched = false;
      const done = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); context.signal?.removeEventListener("abort", aborted);
        socket?.destroy(); frame.fill(0); frame = Buffer.alloc(0); buffered.fill(0); buffered = Buffer.alloc(0);
        if (error) reject(error); else resolve(result);
      };
      const aborted = () => done(fail("MANAGED_MODEL_CREDENTIAL_REQUEST_RETIRED"));
      const guarded = action => { if (settled) return; try { checkPaths(); action(); } catch (error) {
        const code = /^MANAGED_MODEL_CREDENTIAL_[A-Z_]+$/u.test(error?.code || "") ? error.code : "MANAGED_MODEL_CREDENTIAL_REQUEST_RETIRED";
        done(fail(code));
      } };
      timer = setTimeout(() => done(fail("MANAGED_MODEL_CREDENTIAL_REQUEST_TIMEOUT")), Math.max(1, deadlineAt - Date.now()));
      context.signal?.addEventListener("abort", aborted, { once: true });
      if (context.signal?.aborted) { aborted(); return; }
      try { checkPaths(); socket = net.createConnection(socketPath); } catch { done(fail("MANAGED_MODEL_CREDENTIAL_CHANNEL_UNAVAILABLE")); return; }
      socket.on("connect", () => guarded(() => { need(Date.now() < deadlineAt); socket.write(frame); dispatched = true; }));
      socket.on("data", bytes => guarded(() => {
        need(Date.now() < deadlineAt); if (buffered.length + bytes.length > MAX_FRAME) return done(fail("MANAGED_MODEL_CREDENTIAL_RESPONSE_TOO_LARGE"));
        const previous = buffered; buffered = Buffer.concat([previous, bytes]); previous.fill(0);
      }));
      socket.on("error", () => done(fail("MANAGED_MODEL_CREDENTIAL_CHANNEL_UNAVAILABLE")));
      socket.on("end", () => guarded(() => {
        need(dispatched && Date.now() < deadlineAt); const newline = buffered.indexOf(10);
        need(newline >= 0 && newline === buffered.length - 1, "MANAGED_MODEL_CREDENTIAL_RESPONSE_INVALID");
        let response; try { response = JSON.parse(buffered.subarray(0, newline).toString("utf8")); } catch { return done(fail("MANAGED_MODEL_CREDENTIAL_RESPONSE_INVALID")); }
        if (exact(response, ["id", "ok", "error"]) && response.id === id && response.ok === false) {
          // No server message/body escapes this private boundary.
          return done(fail("MANAGED_MODEL_CREDENTIAL_SERVICE_REJECTED"));
        }
        need(exact(response, ["id", "ok", "result"]) && response.id === id && response.ok === true, "MANAGED_MODEL_CREDENTIAL_RESPONSE_INVALID");
        const result = terminal ? schema.credentialTerminalObservation(response.result, permit, field.outcome, terminalExpected)
          : method === "settle" ? schema.credentialSettlement(response.result, permit, field)
          : schema.credentialResponse(response.result, permit, { method, phase: field });
        checkPaths(); done(null, result);
      }));
      socket.on("close", () => { if (!settled) done(fail("MANAGED_MODEL_CREDENTIAL_CHANNEL_DISCONNECTED")); });
    });
  }
  return Object.freeze({
    read: (permit, phase, context, recovery = false) => request("read", permit, phase, context, recovery),
    assert: (permit, phase, context) => request("assert", permit, phase, context),
    settle: (permit, outcome, context) => request("settle", permit, outcome, context),
    observeTerminal: (permit, outcome, writerState, expected, context) => request("terminal.observe", permit, { outcome, writerState }, context, false, expected),
  });
}
module.exports = { createManagedOpenClawProviderCredentialClient };
