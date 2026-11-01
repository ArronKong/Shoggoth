"use strict";

// The ledger owns execution facts. The temporary result envelope owns display
// bytes; neither model projection nor UI delivery can authorize another call.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile, preparePrivateParent, recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { processOrOriginal } = require("../core/chat-secret-fallback");
const { canonicalJsonSnapshotBounded } = require("./run-event-stream");
const { scopeOf, endOfLocalDay } = require("./temporary-secret-store");
const { SECRET_MESSAGES, secretReferences } = require("../core/chat-secret-contract");
const { serviceError } = require("./security");
const { variants } = require("./secret-detector");
const VERSION = 1, MAX_BYTES = 8 * 1024 * 1024, MAX_RECEIPTS = 16384;
const fail = code => { throw serviceError(code, SECRET_MESSAGES[code] || SECRET_MESSAGES.SECRET_PROCESSING_UNAVAILABLE); };
const clone = value => canonicalJsonSnapshotBounded(value, MAX_BYTES, "SECRET_INPUT_INVALID");
const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const completedNotice = Object.freeze({ operationStatus: "completed", retryAllowed: false,
  content: [{ type: "text", text: "The operation completed. Model projection is temporarily unavailable; check the local completion receipt. Do not repeat the operation." }] });

class SecretExecutionBroker {
  constructor({ paths, cryptoBroker, secrets, media = null, now = Date.now, onDisplay = () => {}, onError = () => {}, beforeRevoke = async () => {} }) {
    this.paths = paths; this.cryptoBroker = cryptoBroker; this.secrets = secrets; this.now = now;
    this.media = media;
    this.onDisplay = onDisplay; this.onError = onError;
    this.beforeRevoke = beforeRevoke;
    this.file = path.join(paths.stateDir, "secret-tool-receipts-v1.json");
    this.keyFile = path.join(paths.stateDir, "secret-tool-receipts-v1.key");
    this.rawDirectory = path.join(paths.stateDir, "temporary-secrets", "outcomes");
    this.state = { version: VERSION, receipts: {}, clockFloor: 0 };
    this.inflight = new Map(); this.rawRevisions = new Map(); this.observedTime = 0;
    this.queue = Promise.resolve(); this.opened = false; this.uncertain = false;
  }
  _time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail("SECRET_PROCESSING_UNAVAILABLE");
    this.observedTime = Math.max(now, this.state.clockFloor, this.observedTime);
    return this.observedTime;
  }
  _assert() { if (!this.opened || this.closing) fail("SECRET_PROCESSING_UNAVAILABLE"); if (this.uncertain) fail("SECRET_STORE_UNCERTAIN"); }
  async open() {
    if (this.opened) return;
    preparePrivateParent(this.file, this.paths.trustedRoot);
    preparePrivateParent(path.join(this.rawDirectory, ".boundary"), this.paths.trustedRoot);
    for (const file of [this.file, this.keyFile]) if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("SECRET_STORE_UNCERTAIN");
    if (statIfExists(fs, this.file)) {
      try {
        this.state = JSON.parse(readPrivateFile(this.file, { maxBytes: 64 * 1024 * 1024 }));
        if (this.state.version !== VERSION || !this.state.receipts || Object.getPrototypeOf(this.state.receipts) !== Object.prototype
          || !Number.isSafeInteger(this.state.clockFloor) || this.state.clockFloor < 0
          || Object.keys(this.state.receipts).length > MAX_RECEIPTS) fail("SECRET_STORE_UNCERTAIN");
        for (const [id, row] of Object.entries(this.state.receipts)) {
          scopeOf(row.scope);
          if (!/^[a-f0-9]{64}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(row.fingerprint)
            || !["dispatching", "unknown", "completed"].includes(row.status)
            || typeof row.callId !== "string" || !row.callId || row.callId.length > 2048
            || typeof row.tool !== "string" || !row.tool || row.tool.length > 2048
            || id !== hash(stable([row.scope, row.callId]))
            || !Number.isSafeInteger(row.at) || row.at < 0 || !Number.isSafeInteger(row.expiresAt)
            || row.expiresAt <= row.at || row.expiresAt - row.at > 26 * 3600000) fail("SECRET_STORE_UNCERTAIN");
          if (row.modelResult !== undefined) clone(row.modelResult);
        }
      } catch { fail("SECRET_STORE_UNCERTAIN"); }
    }
    let key;
    try {
      if (statIfExists(fs, this.keyFile)) key = await this.cryptoBroker.decrypt(readPrivateFile(this.keyFile, { maxBytes: 4096 }));
      else {
        if (Object.keys(this.state.receipts).length) fail("SECRET_STORE_UNCERTAIN");
        key = Buffer.from(crypto.randomBytes(32).toString("base64"));
        atomicWritePrivateFile(this.keyFile, await this.cryptoBroker.encrypt(key), { trustedRoot: this.paths.trustedRoot });
      }
      this.identity = Buffer.from(key.toString(), "base64");
      if (this.identity.length !== 32) fail("SECRET_STORE_UNCERTAIN");
    } finally { key?.fill(0); }
    this.opened = true; this.closing = false;
    this.expire();
    // Authenticated result bytes prove the endpoint returned before a crash.
    // Recover only that fact; the external action is never dispatched again.
    for (const [id, row] of Object.entries(this.state.receipts)) if (row.status !== "completed") {
      try {
        if (await this._readRaw(id, row) !== null) this._record(id, {
          ...row, status: "completed", rawSaved: true, projection: "pending",
        });
      } catch { this.onError("SECRET_RESULT_RECOVERY_UNAVAILABLE"); }
    }
    this.timer = setInterval(() => { try { this.expire(); } catch (error) { this.onError(error.code); } }, 1000);
    this.timer.unref?.();
  }
  _write(next) {
    next.clockFloor = this._time();
    const data = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(data) > 64 * 1024 * 1024) fail("SECRET_PROCESSING_UNAVAILABLE");
    try { atomicWritePrivateFile(this.file, data, { trustedRoot: this.paths.trustedRoot }); }
    catch { this.uncertain = true; fail("SECRET_STORE_UNCERTAIN"); }
    this.state = next;
  }
  _record(id, row) {
    const next = structuredClone(this.state); next.receipts[id] = row; this._write(next);
  }
  _rawPath(id) { return path.join(this.rawDirectory, `${id}.json`); }
  _serialize(action) {
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  _withoutValues(value, values) {
    const replacements = [...new Set(values.flatMap(variants))].sort((a, b) => b.length - a.length);
    const text = input => {
      let out = "", at = 0;
      while (at < input.length) {
        const match = replacements.find(candidate => input.startsWith(candidate, at));
        if (match) { out += "[REVOKED_CREDENTIAL]"; at += match.length; } else out += input[at++];
      }
      return out;
    };
    const walk = input => typeof input === "string" ? text(input) : !input || typeof input !== "object" ? input
      : Array.isArray(input) ? input.map(walk) : Object.fromEntries(Object.entries(input).map(([key, child]) => [text(key), walk(child)]));
    return walk(value);
  }
  async revokeReference(scopeInput, reference) {
    this._assert(); const scope = scopeOf(scopeInput);
    return this._serialize(async () => {
      const item = this.secrets.list(scope).find(entry => entry.reference === reference);
      if (!item) return this.secrets.revoke(scope, reference);
      const value = this.secrets.resolve(scope, reference);
      await this.beforeRevoke(scope, reference);
      // Replace only this credential's matching fragments. Other result text,
      // unrelated results and the durable completion receipts stay intact.
      for (const [id, row] of Object.entries(this.state.receipts)) if (stable(row.scope) === stable(scope)) {
        const raw = await this._readRaw(id, row);
        if (raw === null) continue;
        const redacted = this._withoutValues(raw, [value]);
        if (JSON.stringify(redacted) !== JSON.stringify(raw)) await this._saveRaw(id, row, redacted);
      }
      return this.secrets.revoke(scope, reference);
    });
  }
  async _saveRaw(id, row, value) {
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), bytes = Buffer.from(JSON.stringify(value));
    const keyText = Buffer.from(key.toString("base64"));
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`${id}:${row.expiresAt}`));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const sealed = { version: VERSION, expiresAt: row.expiresAt, iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64"),
        key: (await this.cryptoBroker.encrypt(keyText)).toString("base64") };
      if (row.expiresAt <= this._time()) fail("SECRET_REFERENCE_EXPIRED");
      atomicWritePrivateFile(this._rawPath(id), `${JSON.stringify(sealed)}\n`, { trustedRoot: this.paths.trustedRoot });
      this.rawRevisions.set(id, (this.rawRevisions.get(id) || 0) + 1);
    } finally { key.fill(0); keyText.fill(0); bytes.fill(0); }
  }
  async _readRaw(id, row) {
    if (row.expiresAt <= this._time()) { this.expire(); return null; }
    if (!statIfExists(fs, this._rawPath(id))) return null;
    const revision = this.rawRevisions.get(id) || 0;
    const raw = JSON.parse(readPrivateFile(this._rawPath(id), { maxBytes: MAX_BYTES * 2 }));
    if (raw.version !== VERSION || raw.expiresAt !== row.expiresAt) fail("SECRET_STORE_UNCERTAIN");
    let wrapped, key, bytes;
    try {
      wrapped = await this.cryptoBroker.decrypt(Buffer.from(raw.key, "base64")); key = Buffer.from(wrapped.toString(), "base64");
      // The encryption provider can wait on IPC. Recheck after it returns so
      // expiry or a concurrent revocation cannot deliver an obsolete envelope.
      if (row.expiresAt <= this._time()) { this.expire(); return null; }
      if (revision !== (this.rawRevisions.get(id) || 0)) return null;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(raw.iv, "base64"));
      decipher.setAAD(Buffer.from(`${id}:${row.expiresAt}`)); decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
      bytes = Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]);
      return clone(JSON.parse(bytes));
    } finally { wrapped?.fill(0); key?.fill(0); bytes?.fill(0); }
  }
  // UI-only local read. The caller must prove the same authenticated scope;
  // this is never exposed as a model tool or returned through the tool bridge.
  async display(scopeInput, receiptId) {
    this._assert(); const scope = scopeOf(scopeInput), row = this.state.receipts[receiptId];
    if (!row || stable(row.scope) !== stable(scope)) fail("SECRET_REFERENCE_FORBIDDEN");
    if (row.status !== "completed") return { status: row.status, result: null };
    return { status: "completed", result: await this._readRaw(receiptId, row) ?? row.modelResult ?? completedNotice };
  }
  list(scopeInput) {
    this._assert(); const scope = scopeOf(scopeInput);
    return Object.entries(this.state.receipts).filter(([, row]) => stable(row.scope) === stable(scope))
      .sort((a, b) => b[1].at - a[1].at).slice(0, 100).map(([receiptId, row]) => ({
        receiptId, tool: row.tool, status: row.status, at: row.at, expiresAt: row.expiresAt,
        originalAvailable: row.status === "completed" && row.rawSaved === true && row.expiresAt > this._time(),
      }));
  }
  expire() {
    this._assert(); const now = this._time(); let changed = false;
    for (const [id, row] of Object.entries(this.state.receipts)) if (row.expiresAt <= now) {
      const file = this._rawPath(id);
      if (statIfExists(fs, file)) {
        readPrivateFile(file, { maxBytes: MAX_BYTES * 2 }); fs.unlinkSync(file);
        this.rawRevisions.set(id, (this.rawRevisions.get(id) || 0) + 1); changed = true;
      }
    }
    if (changed) this._write(structuredClone(this.state));
  }
  // Only business values are injectable. Object keys, code and command source
  // are deliberately outside this resolver; callers select the value subtree.
  resolveValues(scope, value, assertCurrent) {
    const walk = input => {
      if (typeof input === "string") return this.secrets.resolve(scope, input, assertCurrent);
      if (!input || typeof input !== "object") return input;
      if (Array.isArray(input)) return input.map(walk);
      const result = {};
      for (const [key, child] of Object.entries(input)) {
        if (secretReferences(key).length) fail("SECRET_TOOL_NOT_SUPPORTED");
        if (/^(?:command|commands|code|script|scripts|expression|shell|sql)$/iu.test(key)
          && secretReferences(JSON.stringify(child)).length) fail("SECRET_TOOL_NOT_SUPPORTED");
        Object.defineProperty(result, key, { enumerable: true, value: walk(child) });
      }
      return result;
    };
    return walk(clone(value));
  }
  projectForModel(scope, value, options = {}) {
    return processOrOriginal(() => this.media ? this.media.projectResult(scope, value, options)
      : this.secrets.project(scope, value, { ...options, model: true }), value, options);
  }
  async execute({ scope: scopeInput, callId, tool, args, assertCurrent, invoke, resolve = true, resultSecrets = () => [] }) {
    this._assert(); const scope = scopeOf(scopeInput);
    if (typeof assertCurrent !== "function" || typeof invoke !== "function"
      || typeof callId !== "string" || !callId || callId.length > 2048
      || typeof tool !== "string" || !tool || tool.length > 2048) fail("SECRET_INPUT_INVALID");
    const id = hash(stable([scope, callId]));
    const fingerprint = crypto.createHmac("sha256", this.identity).update(stable([tool, clone(args)])).digest("hex");
    assertCurrent();
    const existing = this.state.receipts[id];
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.tool !== tool) fail("SECRET_OPERATION_CONFLICT");
      if (this.inflight.has(id)) return this.inflight.get(id);
      if (existing.status !== "completed") fail("SECRET_TOOL_OUTCOME_UNKNOWN");
      if (existing.projection === "original") {
        const revision = this.rawRevisions.get(id) || 0;
        const raw = await this._readRaw(id, existing);
        assertCurrent();
        const result = raw === null ? completedNotice : await this.projectForModel(scope, raw, { assertCurrent });
        this._assert(); assertCurrent();
        const retired = revision !== (this.rawRevisions.get(id) || 0) || existing.expiresAt <= this._time();
        return { receiptId: id, result: retired ? completedNotice : result, recovered: true };
      }
      return { receiptId: id, result: existing.modelResult ?? completedNotice, recovered: true };
    }
    if (Object.keys(this.state.receipts).length >= MAX_RECEIPTS) fail("SECRET_PROCESSING_UNAVAILABLE");
    // Validate every reference before persisting dispatch intent. Inject again
    // immediately before invocation so cancellation/expiry cannot race a wait.
    if (resolve) this.resolveValues(scope, args, assertCurrent);
    const used = [...new Set(secretReferences(JSON.stringify(args)).map(ref => ref.reference))]
      .map(reference => ({ reference, bytes: Buffer.from(this.secrets.resolve(scope, reference, assertCurrent)) }));
    const row = { scope, callId, tool, fingerprint, at: this._time(), expiresAt: endOfLocalDay(this._time()), status: "dispatching" };
    this._record(id, row);
    const task = Promise.resolve().then(async () => {
      let value;
      try {
        assertCurrent();
        value = await invoke(resolve ? this.resolveValues(scope, args, assertCurrent) : args);
      } catch (error) {
        try { this._record(id, { ...row, status: "unknown" }); } catch { /* pending intent still forbids replay */ }
        fail("SECRET_TOOL_OUTCOME_UNKNOWN");
      }
      // Shape/size failures happen after a confirmed response. Preserve that
      // response fact instead of making the action appear safe to retry.
      let raw;
      try { raw = clone(value); }
      catch {
        this._record(id, { ...row, status: "completed", rawSaved: false, projection: "invalid", modelResult: completedNotice });
        this.onError("SECRET_RESULT_INVALID");
        return { receiptId: id, result: completedNotice, recovered: false };
      }
      // Commit the completion fact and encrypted display bytes before attempting
      // any model transformation. A projection failure is a completed result.
      let rawSaved = false;
      try {
        await this._serialize(async () => {
          const unavailable = used.filter(item => {
            try { this.secrets.resolve(scope, item.reference, () => {}); return false; } catch { return true; }
          }).map(item => item.bytes.toString());
          if (unavailable.length) raw = this._withoutValues(raw, unavailable);
          await this._saveRaw(id, row, raw);
        });
        rawSaved = true;
      }
      catch (error) { this.onError(error?.code || "SECRET_RESULT_STORAGE_FAILED"); }
      const complete = { ...row, status: "completed", rawSaved, projection: "pending" };
      this._record(id, complete);
      const rawRevision = this.rawRevisions.get(id) || 0;
      try { await this.onDisplay({ scope, callId, tool, receiptId: id, result: raw }); }
      catch (error) { this.onError(error?.code || "SECRET_DISPLAY_UNAVAILABLE"); }
      let result = completedNotice;
      try {
        const known = resultSecrets();
        if (!Array.isArray(known)) fail("SECRET_PROCESSING_UNAVAILABLE");
        let original = false;
        result = await this.projectForModel(scope, raw, { keys: true, assertCurrent, onFallback: () => { original = true; },
          known: [...known, ...used.map(item => item.bytes.toString())].map(value => ({ value, kind: "secret" })) });
        if (original) {
          const retired = used.filter(item => {
            try { this.secrets.resolve(scope, item.reference, assertCurrent); return false; } catch { return true; }
          }).map(item => item.bytes.toString());
          if (retired.length) result = this._withoutValues(result, retired);
          if (rawRevision !== (this.rawRevisions.get(id) || 0) || row.expiresAt <= this._time()) result = completedNotice;
          assertCurrent();
        }
        // Never persist an original result in the plaintext completion ledger.
        // Its existing encrypted envelope can serve a duplicate call until it
        // expires; that branch above never invokes the tool again.
        this._record(id, { ...complete, modelResult: original ? completedNotice : result, projection: original ? "original" : "ready" });
      } catch (error) { result = completedNotice; this.onError(error?.code || "SECRET_PROJECTION_UNAVAILABLE"); }
      this._assert(); assertCurrent();
      return { receiptId: id, result, recovered: false };
    }).finally(() => { for (const item of used) item.bytes.fill(0); this.inflight.delete(id); });
    this.inflight.set(id, task); return task;
  }
  async close() {
    if (!this.opened) return;
    this.closing = true; clearInterval(this.timer);
    await Promise.allSettled([...this.inflight.values()]);
    await this.queue;
    this.identity?.fill(0); this.identity = null; this.opened = false;
  }
}
module.exports = { SecretExecutionBroker, completedNotice };
