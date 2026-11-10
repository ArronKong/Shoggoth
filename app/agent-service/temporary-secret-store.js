"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile, preparePrivateParent, recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { serviceError } = require("./security");
const { SECRET_MESSAGES, SECRET_KINDS, secretReference, secretReferences } = require("../core/chat-secret-contract");
const { detectSecrets, replaceSecrets, variants, knownMatchBoundary, textValue, fieldKind, MAX_SECRET_BYTES } = require("./secret-detector");

const VERSION = 1;
const MAX_ENTRIES = 4096;
const MAX_OPERATIONS = 16384;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const HEX_ID = /^[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const MCP_KEYS = new Set(["content", "isError", "structuredContent"]);
const MCP_TEXT_KEYS = new Set(["type", "text", "annotations"]);
const fail = code => { throw serviceError(code, SECRET_MESSAGES[code] || SECRET_MESSAGES.SECRET_PROCESSING_UNAVAILABLE); };
function scopeOf(scope) {
  if (!plain(scope) || Object.keys(scope).length !== 2 || ![scope.profileId, scope.sessionId]
    .every(value => textValue(value, 1024) && value.length > 0)) fail("SECRET_REFERENCE_FORBIDDEN");
  return { profileId: scope.profileId, sessionId: scope.sessionId };
}
const sameScope = (a, b) => a.profileId === b.profileId && a.sessionId === b.sessionId;
const operationKey = (scope, id) => crypto.createHash("sha256").update(JSON.stringify([scope.profileId, scope.sessionId, id])).digest("hex");
const aad = row => Buffer.from(JSON.stringify([VERSION, row.id, row.scope.profileId, row.scope.sessionId, row.kind, row.createdAt, row.expiresAt]));
function endOfLocalDay(now) {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}
function base64(value, maxBytes = MAX_FILE_BYTES) {
  if (typeof value !== "string" || !value.length || value.length > maxBytes * 2) fail("SECRET_PROCESSING_UNAVAILABLE");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== value) fail("SECRET_PROCESSING_UNAVAILABLE");
  return bytes;
}

// Structural projection is shared, but a legacy federation helper has no
// conversation authority. Its redactor must never mint or resolve references.
async function projectValue(value, { keys = false, model = false }, redact) {
  let nodes = 0;
  const mcpEnvelope = model && plain(value) && Array.isArray(value.content)
    && value.content.every(block => plain(block) && ["text", "image", "audio", "resource", "resource_link"].includes(block.type));
  const walk = async (input, depth = 0, protocol = null) => {
    if (++nodes > 32768 || depth > 48) fail("SECRET_INPUT_INVALID");
    if (typeof input === "string") return redact(input);
    if (input === null || typeof input === "boolean" || typeof input === "number" && Number.isFinite(input)) return input;
    if (!Array.isArray(input) && !plain(input)) fail("SECRET_INPUT_INVALID");
    if (Array.isArray(input)) { const result = []; for (const item of input) result.push(await walk(item, depth + 1, protocol === "content" ? "block" : null)); return result; }
    if (model && ["image", "audio"].includes(input.type)) return { type: "text", text: "Visual/audio output is available locally. This path has no verified local credential masking; use the text snapshot or user takeover." };
    const result = {};
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("SECRET_INPUT_INVALID");
      const fixedKey = protocol === "envelope" && MCP_KEYS.has(key) || protocol === "block" && MCP_TEXT_KEYS.has(key);
      const projectedKey = keys && !fixedKey ? await redact(key) : key;
      if (Object.hasOwn(result, projectedKey)) fail("SECRET_INPUT_INVALID");
      const child = descriptor.value;
      const projected = protocol === "block" && key === "type" ? child : fieldKind(key) && (typeof child === "string" || typeof child === "number")
        ? JSON.parse(await redact(JSON.stringify({ [key]: child })))[key]
        : await walk(child, depth + 1, protocol === "envelope" && key === "content" ? "content" : null);
      Object.defineProperty(result, projectedKey, { enumerable: true, configurable: true, writable: true, value: projected });
    }
    return result;
  };
  const first = await walk(value, 0, mcpEnvelope ? "envelope" : null);
  // Finish discovery over the complete object before revisiting earlier
  // fields. Property order must not decide which known values escape.
  nodes = 0;
  const result = await walk(first, 0, mcpEnvelope ? "envelope" : null);
  if (Buffer.byteLength(JSON.stringify(result) || "") > MAX_FILE_BYTES) fail("SECRET_INPUT_INVALID");
  return result;
}
async function projectUnscopedResult(value, { autoDetect = false } = {}) {
  const known = [];
  const redact = async input => {
    const text = input.replace(/\{\{SHOGGOTH_SECRET_[a-f0-9]{32}\}\}/gu, "[LOCAL_CREDENTIAL_REDACTED]");
    if (!autoDetect) return text;
    const detection = detectSecrets(text, { known });
    for (const range of detection.ambiguous) if (range.end > range.start
      && !detection.matches.some(match => range.start < match.end && range.end > match.start)) {
      detection.matches.push({ ...range, value: text.slice(range.start, range.end), kind: "secret" });
    }
    detection.matches.sort((a, b) => a.start - b.start);
    return replaceSecrets(text, detection, async match => {
      if (!known.some(entry => entry.value === match.value)) known.push({ value: match.value, kind: match.kind || "secret" });
      return "[LOCAL_CREDENTIAL_REDACTED]";
    });
  };
  return projectValue(value, { keys: true, model: true }, redact);
}

class TemporarySecretStore {
  constructor({ paths, cryptoBroker, now = Date.now, endOfDay = endOfLocalDay,
    getKnownSecrets = () => [], autoDetect = true, onError = () => {} } = {}) {
    if (!paths?.stateDir || !paths?.trustedRoot || !cryptoBroker?.encrypt || !cryptoBroker?.decrypt) throw new TypeError("Temporary secrets need private paths and a crypto broker");
    this.paths = paths; this.cryptoBroker = cryptoBroker; this.now = now; this.endOfDay = endOfDay;
    this.getKnownSecrets = getKnownSecrets; this.onError = onError;
    this.autoDetect = autoDetect;
    this.directory = path.join(paths.stateDir, "temporary-secrets");
    this.file = path.join(this.directory, "state-v1.json");
    this.identityFile = path.join(this.directory, "identity-v1.key");
    this.state = { version: VERSION, revision: 0, clockFloor: 0, entries: {}, operations: {} };
    this.cache = new Map(); this.lockedScopes = new Set(); this.identity = null; this.observedTime = 0;
    this.queue = Promise.resolve(); this.opened = false; this.closing = false; this.uncertain = false;
  }
  async open() {
    if (this.opened) return this;
    preparePrivateParent(this.file, this.paths.trustedRoot);
    if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("SECRET_STORE_UNCERTAIN");
    if (statIfExists(fs, this.file)) {
      try { this.state = this._validate(JSON.parse(readPrivateFile(this.file, { maxBytes: MAX_FILE_BYTES }).toString("utf8"))); }
      catch { fail("SECRET_PROCESSING_UNAVAILABLE"); }
    }
    this.opened = true; this.closing = false;
    this._expire();
    for (const row of Object.values(this.state.entries)) {
      try { this.cache.set(row.id, await this._decrypt(row)); }
      catch { if (row.expiresAt > this._time()) this.lockedScopes.add(JSON.stringify(row.scope)); }
    }
    this.timer = setInterval(() => { void this._enqueue(() => this._expire()).catch(error => this.onError(error.code)); }, 1000);
    this.timer.unref?.();
    return this;
  }
  async close() {
    if (!this.opened) return;
    this.closing = true; clearInterval(this.timer); await this.queue;
    for (const bytes of this.cache.values()) bytes.fill(0);
    this.cache.clear(); this.lockedScopes.clear(); this.identity?.fill(0); this.identity = null;
    this.opened = false; this.closing = false;
  }
  _assert() {
    if (!this.opened || this.closing) fail("SECRET_PROCESSING_UNAVAILABLE");
    if (this.uncertain) fail("SECRET_STORE_UNCERTAIN");
  }
  _time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail("SECRET_PROCESSING_UNAVAILABLE");
    this.observedTime = Math.max(now, this.state.clockFloor, this.observedTime);
    return this.observedTime;
  }
  _validate(state) {
    if (!plain(state) || Object.keys(state).sort().join() !== "clockFloor,entries,operations,revision,version"
      || state.version !== VERSION || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !Number.isSafeInteger(state.clockFloor) || state.clockFloor < 0 || !plain(state.entries) || !plain(state.operations)
      || Object.keys(state.entries).length > MAX_ENTRIES || Object.keys(state.operations).length > MAX_OPERATIONS) fail("SECRET_PROCESSING_UNAVAILABLE");
    for (const [id, row] of Object.entries(state.entries)) {
      if (!HEX_ID.test(id) || !plain(row) || Object.keys(row).sort().join() !== "ciphertext,createdAt,expiresAt,id,iv,key,kind,scope,tag"
        || row.id !== id || !SECRET_KINDS.includes(row.kind) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
        || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.createdAt || row.expiresAt - row.createdAt > 26 * 60 * 60 * 1000) fail("SECRET_PROCESSING_UNAVAILABLE");
      scopeOf(row.scope);
      if (base64(row.iv, 12).length !== 12 || base64(row.tag, 16).length !== 16) fail("SECRET_PROCESSING_UNAVAILABLE");
      base64(row.key, 4096); base64(row.ciphertext, MAX_SECRET_BYTES);
    }
    for (const [key, operation] of Object.entries(state.operations)) {
      if (!HASH.test(key) || !plain(operation) || Object.keys(operation).some(name => !["createdAt", "fingerprint", "operationId", "references", "scope", "text", "ordinary", "ordinaryExpiresAt"].includes(name))
        || !textValue(operation.operationId, 2048) || !operation.operationId || !HASH.test(operation.fingerprint)
        || !textValue(operation.text) || !Number.isSafeInteger(operation.createdAt) || operation.createdAt < 0
        || !Array.isArray(operation.references) || operation.references.length > 2048
        || operation.references.some(id => !HEX_ID.test(id)) || key !== operationKey(scopeOf(operation.scope), operation.operationId)
        || operation.ordinary !== undefined && (!Array.isArray(operation.ordinary) || operation.ordinary.length > 2048
          || operation.ordinary.some(value => !HASH.test(value)) || !Number.isSafeInteger(operation.ordinaryExpiresAt))) fail("SECRET_PROCESSING_UNAVAILABLE");
    }
    return state;
  }
  _enqueue(action) {
    this._assert();
    const operation = this.queue.then(() => { this._assert(); return action(); });
    this.queue = operation.catch(() => {});
    return operation;
  }
  _commit(next) {
    next.revision = this.state.revision + 1;
    next.clockFloor = Math.max(next.clockFloor, this._time());
    this._validate(next);
    const encoded = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) fail("SECRET_PROCESSING_UNAVAILABLE");
    try { atomicWritePrivateFile(this.file, encoded, { trustedRoot: this.paths.trustedRoot }); }
    catch (error) { if (error?.committedUncertain || error?.code === "PRIVATE_FILE_COMMIT_UNCERTAIN") this.uncertain = true; fail(this.uncertain ? "SECRET_STORE_UNCERTAIN" : "SECRET_PROCESSING_UNAVAILABLE"); }
    this.state = next;
  }
  _expire() {
    const now = this._time();
    const ids = Object.values(this.state.entries).filter(row => row.expiresAt <= now).map(row => row.id);
    if (!ids.length) return 0;
    const next = structuredClone(this.state);
    for (const id of ids) { delete next.entries[id]; this.cache.get(id)?.fill(0); this.cache.delete(id); }
    this._commit(next);
    this.lockedScopes = new Set([...this.lockedScopes].filter(scope => Object.values(next.entries).some(row => JSON.stringify(row.scope) === scope && !this.cache.has(row.id))));
    return ids.length;
  }
  expire() { return this._enqueue(() => this._expire()); }
  async _identity() {
    if (this.identity) return this.identity;
    let raw;
    try {
      if (recoverInterruptedPrivateFile(this.identityFile, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("SECRET_STORE_UNCERTAIN");
      if (statIfExists(fs, this.identityFile)) raw = await this.cryptoBroker.decrypt(readPrivateFile(this.identityFile, { maxBytes: 4096 }));
      else {
        // Missing identity with existing receipts is corruption, never a new
        // identity that would let an old operation be admitted again.
        if (Object.keys(this.state.operations).length) fail("SECRET_STORE_UNCERTAIN");
        raw = Buffer.from(crypto.randomBytes(32).toString("base64"));
        const sealed = await this.cryptoBroker.encrypt(raw);
        atomicWritePrivateFile(this.identityFile, sealed, { trustedRoot: this.paths.trustedRoot });
      }
      this.identity = base64(raw.toString("utf8"), 32);
      if (this.identity.length !== 32) fail("SECRET_PROCESSING_UNAVAILABLE");
      return this.identity;
    } catch (error) { fail(error?.code === "SECRET_STORE_UNCERTAIN" ? error.code : "SECRET_PROCESSING_UNAVAILABLE"); }
    finally { raw?.fill(0); }
  }
  async _seal(value, scope, kind) {
    const now = this._time(), expiresAt = this.endOfDay(now);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 26 * 60 * 60 * 1000) fail("SECRET_PROCESSING_UNAVAILABLE");
    const row = { id: crypto.randomBytes(16).toString("hex"), scope, kind, createdAt: now, expiresAt };
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), bytes = Buffer.from(value), keyText = Buffer.from(key.toString("base64"));
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad(row));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return { ...row, key: (await this.cryptoBroker.encrypt(keyText)).toString("base64"),
        iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") };
    } catch { fail("SECRET_PROCESSING_UNAVAILABLE"); }
    finally { key.fill(0); keyText.fill(0); bytes.fill(0); }
  }
  async _decrypt(row) {
    if (row.expiresAt <= this._time()) fail("SECRET_REFERENCE_EXPIRED");
    let wrapped, key;
    try {
      wrapped = await this.cryptoBroker.decrypt(base64(row.key, 4096));
      if (row.expiresAt <= this._time()) { this._expire(); fail("SECRET_REFERENCE_EXPIRED"); }
      key = base64(wrapped.toString("utf8"), 32);
      if (key.length !== 32) fail("SECRET_PROCESSING_UNAVAILABLE");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, base64(row.iv, 12));
      decipher.setAAD(aad(row)); decipher.setAuthTag(base64(row.tag, 16));
      const bytes = Buffer.concat([decipher.update(base64(row.ciphertext, MAX_SECRET_BYTES)), decipher.final()]);
      if (!textValue(bytes.toString("utf8"), MAX_SECRET_BYTES) || !bytes.length) { bytes.fill(0); fail("SECRET_PROCESSING_UNAVAILABLE"); }
      return bytes;
    } finally { wrapped?.fill(0); key?.fill(0); }
  }
  _known(scope, pending = []) {
    this._expire();
    if (this.lockedScopes.has(JSON.stringify(scope))) fail("SECRET_PROCESSING_UNAVAILABLE");
    const now = this._time();
    return [...Object.values(this.state.entries).filter(row => sameScope(row.scope, scope) && row.expiresAt > now).map(row => {
      const bytes = this.cache.get(row.id); if (!bytes) fail("SECRET_PROCESSING_UNAVAILABLE");
      return { value: bytes.toString("utf8"), kind: row.kind, reference: secretReference(row.id) };
    }), ...pending.map(item => ({ value: item.value, kind: item.row.kind, reference: secretReference(item.row.id) }))];
  }
  _ordinaryHash(scope, value) {
    return this.identity ? crypto.createHmac("sha256", this.identity).update(JSON.stringify(["ordinary", scope, value])).digest("hex") : null;
  }
  _isOrdinary(scope, value) {
    const digest = this._ordinaryHash(scope, value);
    return digest && Object.values(this.state.operations).some(operation => sameScope(scope, operation.scope)
      && operation.ordinaryExpiresAt > this._time() && operation.ordinary?.includes(digest));
  }
  async _redact(text, scope, pending, selections, review, extraKnown = [], ordinary = [], ordinaryHashes = []) {
    const known = this._known(scope, pending);
    let supplied;
    try { supplied = await this.getKnownSecrets(scope); } catch { fail("SECRET_PROCESSING_UNAVAILABLE"); }
    if (!Array.isArray(supplied) || !Array.isArray(extraKnown)) fail("SECRET_PROCESSING_UNAVAILABLE");
    const external = [...supplied, ...extraKnown];
    const detection = detectSecrets(text, { selections, known: [...known, ...external], autoDetect: this.autoDetect });
    const protectedValue = match => [...known, ...external].some(entry => variants(entry.value).includes(match.value));
    const removeOrdinary = (matches, inherited = false) => matches.filter(match => {
      const explicitlyOrdinary = inherited || ordinary.some(range => range.start <= match.start && range.end >= match.end
        || text.slice(range.start, range.end) === match.value);
      if (match.nested) { match.nested = removeOrdinary(match.nested, explicitlyOrdinary); return match.nested.length > 0; }
      if (match.source === "selection" || protectedValue(match)) return true;
      if (explicitlyOrdinary) { ordinaryHashes.push(this._ordinaryHash(scope, match.value)); return false; }
      return !this._isOrdinary(scope, match.value);
    });
    detection.matches = removeOrdinary(detection.matches);
    detection.ambiguous = detection.ambiguous.filter(range => {
      if (!ordinary.some(item => item.start <= range.start && item.end >= range.end)) return true;
      ordinaryHashes.push(this._ordinaryHash(scope, text.slice(range.start, range.end))); return false;
    });
    if (detection.ambiguous.length && review) {
      const error = serviceError("SECRET_INPUT_REVIEW_REQUIRED", SECRET_MESSAGES.SECRET_INPUT_REVIEW_REQUIRED);
      error.ranges = detection.ambiguous; throw error;
    }
    // Model-only projections must not send an uncertain labelled value raw.
    // Keep the rest of the result and replace only that bounded value.
    if (!review) for (const range of detection.ambiguous) if (range.end > range.start
      && !detection.matches.some(match => range.start < match.end && range.end > match.start)) {
      detection.matches.push({ ...range, value: text.slice(range.start, range.end), kind: "secret", source: "selection" });
    }
    detection.matches.sort((a, b) => a.start - b.start);
    const result = await replaceSecrets(text, detection, async match => {
      const existing = this._known(scope, pending).find(entry => entry.value === match.value && entry.kind === match.kind);
      if (existing) return existing.reference;
      // A connector's authentication is used by its transport, never copied
      // into the chat vault or converted into a new cross-tool capability.
      if (external.some(entry => entry.value === match.value) && (!review || match.source === "known")) {
        return "[CONNECTED_CREDENTIAL_REDACTED]";
      }
      if (Object.keys(this.state.entries).length + pending.length >= MAX_ENTRIES) fail("SECRET_PROCESSING_UNAVAILABLE");
      const row = await this._seal(match.value, scope, match.kind);
      pending.push({ row, value: match.value });
      return secretReference(row.id);
    });
    // A labelled value may be discovered after an earlier, unlabelled echo
    // in this same string. Apply the newly known values before persisting it.
    const echoes = detectSecrets(result, { known: [...this._known(scope, pending), ...external], autoDetect: this.autoDetect });
    const knownOnly = matches => matches.flatMap(match => {
      if (match.nested) { const nested = knownOnly(match.nested); return nested.length ? [{ ...match, nested }] : []; }
      return match.source === "known" ? [match] : [];
    });
    return replaceSecrets(result, { ...echoes, matches: knownOnly(echoes.matches) },
      match => match.reference || "[CONNECTED_CREDENTIAL_REDACTED]");
  }
  _commitPending(next, pending) {
    for (const item of pending) next.entries[item.row.id] = item.row;
    this._commit(next);
    for (const item of pending) this.cache.set(item.row.id, Buffer.from(item.value));
  }
  prepare({ scope: inputScope, operationId, text, selections = [], ordinary = [] }) {
    const scope = scopeOf(inputScope);
    if (!textValue(operationId, 2048) || !operationId || !textValue(text)) fail("SECRET_INPUT_INVALID");
    if (!Array.isArray(ordinary) || ordinary.length > 64 || ordinary.some(range => !plain(range)
      || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end > text.length
      || range.end <= range.start || Object.keys(range).some(key => !["start", "end"].includes(key)))) fail("SECRET_INPUT_INVALID");
    return this._enqueue(async () => {
      this._expire();
      const key = operationKey(scope, operationId), existing = this.state.operations[key];
      const identity = await this._identity();
      const fingerprint = crypto.createHmac("sha256", identity).update(JSON.stringify([scope, operationId, text, selections, ...(ordinary.length ? [ordinary] : [])])).digest("hex");
      if (existing) {
        if (existing.fingerprint !== fingerprint && (text !== existing.text || selections.length || ordinary.length)) fail("SECRET_OPERATION_CONFLICT");
        return this._prepared(existing);
      }
      if (Object.keys(this.state.operations).length >= MAX_OPERATIONS) fail("SECRET_PROCESSING_UNAVAILABLE");
      const pending = [];
      const ordinaryHashes = [];
      const safeText = await this._redact(text, scope, pending, selections, true, [], ordinary, ordinaryHashes);
      const operation = { scope, operationId, fingerprint, text: safeText, createdAt: this._time(),
        references: [...new Set(secretReferences(safeText).map(ref => ref.id))],
        ...(ordinaryHashes.length ? { ordinary: [...new Set(ordinaryHashes)], ordinaryExpiresAt: this.endOfDay(this._time()) } : {}) };
      // A reference pasted from a different chat must not silently gain a new
      // owner during admission. An expired reference may remain in history.
      for (const id of operation.references) {
        const row = pending.find(item => item.row.id === id)?.row || this.state.entries[id];
        if (row && !sameScope(row.scope, scope)) fail("SECRET_REFERENCE_FORBIDDEN");
      }
      const next = structuredClone(this.state); next.operations[key] = operation;
      this._commitPending(next, pending);
      return this._prepared(operation);
    });
  }
  hasPreparation(scope, operationId) {
    this._assert(); return Object.hasOwn(this.state.operations, operationKey(scopeOf(scope), operationId));
  }
  // Local integrity tags for non-secret projection receipts. The protected
  // identity key never leaves the Service and tags cannot resolve a credential.
  prepareMetadata() { return this._enqueue(async () => { await this._identity(); }); }
  metadataMac(scopeInput, purpose, value) {
    this._assert(); const scope = scopeOf(scopeInput);
    if (!/^[a-z0-9-]{1,64}$/u.test(purpose) || !this.identity) fail("SECRET_INPUT_INVALID");
    return crypto.createHmac("sha256", this.identity).update(JSON.stringify([purpose, scope, value])).digest("hex");
  }
  _prepared(operation) {
    this._expire();
    return { text: operation.text, references: operation.references.map(id => {
      const row = this.state.entries[id];
      return { reference: secretReference(id), kind: row?.kind || "secret", expiresAt: row?.expiresAt || null,
        available: !!row && row.expiresAt > this._time() && this.cache.has(id) };
    }), version: VERSION };
  }
  project(scopeInput, value, { keys = false, model = false, known = [] } = {}) {
    const scope = scopeOf(scopeInput);
    return this._enqueue(async () => {
      this._expire();
      const pending = [];
      const result = await projectValue(value, { keys, model }, text => this._redact(text, scope, pending, [], false, known));
      if (pending.length) this._commitPending(structuredClone(this.state), pending);
      return result;
    });
  }
  // Synchronous context construction cannot create new authority. Known values
  // keep their scoped references; newly found legacy values become inert marks.
  // This projection runs before derived context snapshots or model requests.
  projectText(scopeInput, text) {
    this._assert(); const scope = scopeOf(scopeInput);
    let external;
    try { external = this.getKnownSecrets(scope); } catch { fail("SECRET_PROCESSING_UNAVAILABLE"); }
    if (!Array.isArray(external)) fail("SECRET_PROCESSING_UNAVAILABLE");
    const known = [...this._known(scope), ...external];
    const detection = detectSecrets(text, { known, autoDetect: this.autoDetect });
    for (const range of detection.ambiguous) if (!detection.matches.some(match => range.start < match.end && range.end > match.start)) {
      detection.matches.push({ ...range, value: text.slice(range.start, range.end) });
    }
    const replace = (source, matches) => {
      let cursor = 0, result = "";
      for (const match of [...matches].sort((a, b) => a.start - b.start)) {
        if (!match.nested && this._isOrdinary(scope, match.value) && !known.some(item => variants(item.value).includes(match.value))) continue;
        const reference = match.nested ? replace(match.value, match.nested)
          : match.reference || known.find(item => item.value === match.value)?.reference || "[LOCAL_CREDENTIAL_REDACTED]";
        result += source.slice(cursor, match.start) + (match.json ? JSON.stringify(reference) : reference); cursor = match.end;
      }
      return result + source.slice(cursor);
    };
    return replace(text, detection.matches);
  }
  // Synchronous projection for diagnostic/stream copies: never creates a
  // credential or execution capability. New values are masked, not published.
  redactKnown(scopeInput, text) {
    this._assert(); const scope = scopeOf(scopeInput);
    if (!textValue(text)) fail("SECRET_INPUT_INVALID");
    const known = this._known(scope);
    const replacements = known.flatMap(entry => variants(entry.value).map(value => ({ value, original: entry.value, reference: entry.reference })))
      .sort((a, b) => b.value.length - a.value.length);
    if (!replacements.length) return text;
    const occupied = secretReferences(text); let result = "", cursor = 0;
    while (cursor < text.length) {
      const ref = occupied.find(item => item.start === cursor);
      if (ref) { result += ref.reference; cursor = ref.end; continue; }
      const match = replacements.find(item => text.startsWith(item.value, cursor) && knownMatchBoundary(text, cursor, item.value, item.original));
      if (match) { result += match.reference; cursor += match.value.length; }
      else result += text[cursor++];
    }
    return result;
  }
  resolve(scopeInput, text, assertCurrent = () => {}) {
    this._assert(); const scope = scopeOf(scopeInput);
    if (!textValue(text)) fail("SECRET_REFERENCE_INVALID");
    const now = this._time(); let result = "", cursor = 0;
    for (const ref of secretReferences(text)) {
      const row = this.state.entries[ref.id];
      if (row?.expiresAt <= now) this._expire();
      if (!row || row.expiresAt <= now) fail("SECRET_REFERENCE_EXPIRED");
      if (!sameScope(row.scope, scope)) fail("SECRET_REFERENCE_FORBIDDEN");
      const bytes = this.cache.get(ref.id); if (!bytes) fail("SECRET_PROCESSING_UNAVAILABLE");
      assertCurrent(); result += text.slice(cursor, ref.start) + bytes.toString("utf8"); cursor = ref.end;
    }
    assertCurrent();
    return result + text.slice(cursor);
  }
  revoke(scopeInput, reference = null) {
    const scope = scopeOf(scopeInput);
    return this._enqueue(() => {
      const id = reference === null ? null : secretReferences(reference).find(ref => ref.reference === reference)?.id;
      if (reference !== null && !id) fail("SECRET_REFERENCE_INVALID");
      if (id && this.state.entries[id] && !sameScope(this.state.entries[id].scope, scope)) fail("SECRET_REFERENCE_FORBIDDEN");
      const next = structuredClone(this.state), removed = [];
      for (const row of Object.values(next.entries)) if (sameScope(row.scope, scope) && (!id || row.id === id)) {
        delete next.entries[row.id]; removed.push(row.id);
      }
      if (removed.length) this._commit(next);
      for (const ref of removed) { this.cache.get(ref)?.fill(0); this.cache.delete(ref); }
      return { revoked: removed.length };
    });
  }
  list(scopeInput) {
    this._assert(); this._expire(); const scope = scopeOf(scopeInput), now = this._time();
    return Object.values(this.state.entries).filter(row => sameScope(row.scope, scope) && row.expiresAt > now)
      .map(row => ({ reference: secretReference(row.id), kind: row.kind, expiresAt: row.expiresAt, available: this.cache.has(row.id) }));
  }
}
module.exports = { TemporarySecretStore, scopeOf, endOfLocalDay, projectUnscopedResult, VERSION };
