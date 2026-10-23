"use strict";

// Service owns both this ledger and the shared EncryptedSecretStore. No method
// in this module is a renderer/HTTP entry point; managed reads are private IPC.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWritePrivateFile, preparePrivateParent, readPrivateFile,
  recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { serviceError } = require("./security");
const { EXTERNAL_PROVIDER_CREDENTIAL_PREFIX, EXTERNAL_PROVIDER_SECRET_KIND,
  reconcileExternalProviderCredentialSecrets } = require("./external-provider-credential-reconciliation");
const { NATIVE_AUTH_API, NATIVE_AUTH_KEY, NATIVE_AUTH_SECRET_PREFIX, NATIVE_AUTH_SECRET_KIND } = require("../managed-openclaw-auth-profile-constants");

const HASH = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const APIS = new Set(["openai-completions", "openai-responses", "openai-chatgpt-responses", "anthropic-messages",
  "google-generative-ai", "google-vertex", "github-copilot", "bedrock-converse-stream", "ollama", "azure-openai-responses"]);
const TERMINAL = new Set(["applied", "compensated", "blocked", "failed"]);
const STATES = new Set(["preparing", "prepared", "inflight", "needs_verification", ...TERMINAL]);
const MAX_OPERATIONS = 256, MAX_BINDINGS = 128, MAX_BYTES = 1024 * 1024, ENVELOPE_TTL = 30000;
const authorities = new WeakMap();
const controllers = new WeakSet();
const error = code => serviceError(code, code);
const need = (value, code = "EXTERNAL_PROVIDER_CREDENTIAL_INVALID") => { if (!value) throw error(code); };
function plain(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (records, key) => Object.hasOwn(records, key) ? records[key] : null;
const scopeDigest = scope => crypto.createHash("sha256").update(JSON.stringify(scope)).digest("hex");
function endpoint(value) {
  need(typeof value === "string" && value.length <= 4096 && value === value.trim());
  let parsed; try { parsed = new URL(value); } catch { throw error("EXTERNAL_PROVIDER_ENDPOINT_INVALID"); }
  need(["https:", "http:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash, "EXTERNAL_PROVIDER_ENDPOINT_INVALID");
  const result = parsed.toString().replace(/\/$/u, "");
  need(result === value, "EXTERNAL_PROVIDER_ENDPOINT_NOT_CANONICAL");
  return result;
}
function providerScope(value) {
  need(plain(value, ["backendId", "providerKey", "baseUrl", "api"]));
  if (value.api === NATIVE_AUTH_API) {
    need(value.backendId === "openclaw" && typeof value.providerKey === "string" && NATIVE_AUTH_KEY.test(value.providerKey) && value.baseUrl === null);
    return Object.freeze({ backendId: "openclaw", providerKey: value.providerKey, baseUrl: null, api: NATIVE_AUTH_API });
  }
  need(value.backendId === "openclaw" && typeof value.providerKey === "string" && PROVIDER.test(value.providerKey)
    && typeof value.api === "string" && APIS.has(value.api));
  return Object.freeze({ backendId: "openclaw", providerKey: value.providerKey, baseUrl: endpoint(value.baseUrl), api: value.api });
}
function operationScope(value) {
  need(plain(value, ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest"]));
  const scope = providerScope(Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"].map(key => [key, value[key]])));
  need(typeof value.operationId === "string" && OPAQUE.test(value.operationId)
    && typeof value.requestDigest === "string" && HASH.test(value.requestDigest));
  return Object.freeze({ ...scope, operationId: value.operationId, requestDigest: value.requestDigest });
}
function scopeOf(value) { return operationScope(Object.fromEntries(
  ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest"].map(key => [key, value[key]]))); }
function leaseInput(value, allowRecovery) {
  const fields = ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest"];
  need(plain(value, fields) || plain(value, [...fields, "phase"]) || allowRecovery
    && (plain(value, [...fields, "recovery"]) || plain(value, [...fields, "phase", "recovery"])));
  const phase = Object.hasOwn(value, "phase") && value.phase !== undefined ? value.phase : "candidate";
  const recovery = Object.hasOwn(value, "recovery") ? value.recovery : undefined;
  need(["candidate", "previous"].includes(phase) && (recovery === undefined || typeof recovery === "boolean"));
  return { scope: scopeOf(value), phase, recovery: recovery === true };
}
function createExternalProviderManagementAuthority(assertCurrent) {
  need(typeof assertCurrent === "function", "EXTERNAL_PROVIDER_CREDENTIAL_AUTHORITY_INVALID");
  const handle = Object.freeze({}); authorities.set(handle, { kind: "management", assertCurrent }); return handle;
}
function createExternalProviderManagedLeaseAuthority(value) {
  const keys = ["assertCurrent", "ownerGeneration", "expiresAt"];
  need(plain(value, keys) || plain(value, [...keys, "previousOwnerGeneration"]), "EXTERNAL_PROVIDER_CREDENTIAL_AUTHORITY_INVALID");
  need(typeof value.assertCurrent === "function" && typeof value.ownerGeneration === "string" && OPAQUE.test(value.ownerGeneration)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now(), "EXTERNAL_PROVIDER_CREDENTIAL_AUTHORITY_INVALID");
  need(value.previousOwnerGeneration === undefined || typeof value.previousOwnerGeneration === "string"
    && OPAQUE.test(value.previousOwnerGeneration) && value.previousOwnerGeneration !== value.ownerGeneration,
  "EXTERNAL_PROVIDER_CREDENTIAL_AUTHORITY_INVALID");
  const handle = Object.freeze({}); authorities.set(handle, { kind: "managed", ...value }); return handle;
}
function validateBinding(value) {
  const fields = ["backendId", "providerKey", "baseUrl", "api", "revision", "credentialRef", "credentialFingerprint", "lastOperationId"];
  need(plain(value, fields), "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
  providerScope(Object.fromEntries(fields.slice(0, 4).map(key => [key, value[key]])));
  need(Number.isSafeInteger(value.revision) && value.revision >= 1
    && typeof value.lastOperationId === "string" && OPAQUE.test(value.lastOperationId), "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
  need(value.credentialRef === null && value.credentialFingerprint === null
    || typeof value.credentialRef === "string" && [EXTERNAL_PROVIDER_CREDENTIAL_PREFIX,NATIVE_AUTH_SECRET_PREFIX].some(prefix => value.credentialRef.startsWith(prefix))
    && OPAQUE.test(value.credentialRef) && typeof value.credentialFingerprint === "string" && HASH.test(value.credentialFingerprint),
  "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
  return value;
}
function validateLedger(value) {
  need(plain(value, ["version", "revision", "bindings", "operations"]) && value.version === 1
    && Number.isSafeInteger(value.revision) && value.revision >= 0,
  "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
  for (const [records, limit] of [[value.bindings, MAX_BINDINGS], [value.operations, MAX_OPERATIONS]])
    need(records && Object.getPrototypeOf(records) === Object.prototype && Object.keys(records).length <= limit,
      "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
  const bindingRefs = new Set(), pendingRefs = new Set();
  for (const [key, binding] of Object.entries(value.bindings)) {
    need(validateBinding(binding).providerKey === key, "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    if (binding.credentialRef) { need(!bindingRefs.has(binding.credentialRef), "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
      bindingRefs.add(binding.credentialRef); }
  }
  const fields = ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest", "action", "status",
    "previousBinding", "candidateRef", "candidateFingerprint", "ownerGeneration", "createdAt", "updatedAt"];
  for (const [key, operation] of Object.entries(value.operations)) {
    need(plain(operation, fields), "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT"); scopeOf(operation);
    need(operation.operationId === key && ["set", "clear", "preserve"].includes(operation.action) && STATES.has(operation.status)
      && Number.isSafeInteger(operation.createdAt) && operation.createdAt >= 0
      && Number.isSafeInteger(operation.updatedAt) && operation.updatedAt >= operation.createdAt,
    "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    if (operation.previousBinding !== null) need(validateBinding(operation.previousBinding).providerKey === operation.providerKey,
      "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    need(operation.candidateRef === null || typeof operation.candidateRef === "string"
      && [EXTERNAL_PROVIDER_CREDENTIAL_PREFIX,NATIVE_AUTH_SECRET_PREFIX].some(prefix => operation.candidateRef.startsWith(prefix)) && OPAQUE.test(operation.candidateRef),
    "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    need(operation.candidateFingerprint === null || typeof operation.candidateFingerprint === "string" && HASH.test(operation.candidateFingerprint),
      "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    need(operation.ownerGeneration === null || typeof operation.ownerGeneration === "string" && OPAQUE.test(operation.ownerGeneration),
      "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    need(operation.action !== "clear" || operation.candidateRef === null && operation.candidateFingerprint === null,
      "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    need(operation.action !== "set" || operation.candidateRef !== null,
      "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    if (operation.action === "preserve") need(operation.candidateRef === (operation.previousBinding?.credentialRef || null)
      && operation.candidateFingerprint === (operation.previousBinding?.credentialFingerprint || null),
    "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
    if (operation.action === "set" && !TERMINAL.has(operation.status)) {
      need(!bindingRefs.has(operation.candidateRef) && !pendingRefs.has(operation.candidateRef),
        "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT"); pendingRefs.add(operation.candidateRef);
    }
    if (!TERMINAL.has(operation.status) && !["preparing", "needs_verification"].includes(operation.status))
      need(operation.candidateRef === null || operation.candidateFingerprint !== null,
        "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
  }
  return value;
}

class ExternalProviderCredentialController {
  #terminalObservations = new Map();
  constructor(options) {
    need(options?.paths?.stateDir && options.paths.trustedRoot && options.secretStore
      && ["listMetadata", "getCredentialRevision", "getCredentialFingerprint", "get", "putIfRevision", "delete"]
        .every(method => typeof options.secretStore[method] === "function")
      && typeof options.authorizeManagement === "function" && typeof options.authorizeManagedLease === "function",
    "EXTERNAL_PROVIDER_CREDENTIAL_OPTIONS_INVALID");
    this.paths = options.paths; this.secretStore = options.secretStore; this.fs = options.fs || fs;
    need(options.namespace === undefined || options.namespace === "auth-profile", "EXTERNAL_PROVIDER_CREDENTIAL_OPTIONS_INVALID");
    this.nativeAuth = options.namespace === "auth-profile";
    this.credentialPrefix = this.nativeAuth ? NATIVE_AUTH_SECRET_PREFIX : EXTERNAL_PROVIDER_CREDENTIAL_PREFIX;
    this.secretKind = this.nativeAuth ? NATIVE_AUTH_SECRET_KIND : EXTERNAL_PROVIDER_SECRET_KIND;
    this.file = path.join(this.paths.stateDir, this.nativeAuth ? "openclaw-auth-profile-credentials.json" : "external-provider-credentials.json");
    this.receiptsDir = path.join(this.paths.stateDir, this.nativeAuth ? "openclaw-auth-profile-credential-receipts" : "external-provider-credential-receipts");
    this.authorizeManagement = options.authorizeManagement; this.authorizeManagedLease = options.authorizeManagedLease;
    this.queue = Promise.resolve(); this.opened = false; this.closing = false; this.commitUncertain = false;
    this.incarnation = Symbol("external-provider-credential-controller");
    this.state = { version: 1, revision: 0, bindings: {}, operations: {} }; controllers.add(this);
  }

  async open() {
    if (this.opened) return this;
    this.incarnation = Symbol("external-provider-credential-controller");
    this.#terminalObservations.clear();
    preparePrivateParent(this.file, this.paths.trustedRoot, this.fs);
    const recovery = recoverInterruptedPrivateFile(this.file, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    need(recovery !== "uncertain", "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
    try { this.state = statIfExists(this.fs, this.file)
      ? validateLedger(JSON.parse(readPrivateFile(this.file, { fs: this.fs, maxBytes: MAX_BYTES }).toString("utf8")))
      : { version: 1, revision: 0, bindings: {}, operations: {} }; }
    catch { throw error("EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT"); }
    this.opened = true; this.closing = false; this.commitUncertain = false;
    this.#assertNamespace(this.state);
    try {
      const next = copy(this.state); let changed = false;
      for (const operation of Object.values(next.operations)) if (!TERMINAL.has(operation.status) && operation.status !== "needs_verification") {
        operation.status = "needs_verification"; operation.updatedAt = Math.max(operation.updatedAt, Date.now()); changed = true;
      }
      if (changed) this.#persist(next);
      this.#compactTerminals();
      await reconcileExternalProviderCredentialSecrets({ controller: this, secretStore: this.secretStore });
      for (const binding of Object.values(this.state.bindings)) if (binding.credentialRef) need(
        this.secretStore.getCredentialFingerprint(binding.credentialRef) === binding.credentialFingerprint,
        "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
      return this;
    } catch (failure) { this.opened = false; throw failure; }
  }

  async close() { this.closing = true; this.incarnation = Symbol("external-provider-credential-controller");
    this.#terminalObservations.clear();
    await this.queue; this.opened = false; this.closing = false; }
  #assertOpen() {
    need(this.opened && !this.closing, "EXTERNAL_PROVIDER_CREDENTIAL_CLOSED");
    need(!this.commitUncertain, "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
  }
  #enqueue(action) {
    const accepted = this.queue.then(() => { this.#assertOpen(); return action(); });
    this.queue = accepted.catch(() => {}); return accepted;
  }
  async #authorize(kind, scope, context) {
    if (scope?.api) need((scope.api === NATIVE_AUTH_API) === this.nativeAuth, "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
    this.#assertOpen(); const callback = kind === "management" ? this.authorizeManagement : this.authorizeManagedLease;
    const incarnation = this.incarnation; let handle;
    try { handle = await callback(scope, context); } catch { throw error("EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN"); }
    const authority = authorities.get(handle);
    need(authority?.kind === kind, "EXTERNAL_PROVIDER_CREDENTIAL_FORBIDDEN");
    const check = () => { this.#assertOpen(); need(incarnation === this.incarnation, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED");
      let current; try { current = authority.assertCurrent(); } catch { throw error("EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); }
      need(current === true, "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED");
      if (kind === "managed") need(authority.expiresAt > Date.now(), "EXTERNAL_PROVIDER_CREDENTIAL_RETIRED"); };
    check(); return { authority, check };
  }
  #persist(next) {
    next.revision = this.state.revision + 1; validateLedger(next); this.#assertNamespace(next);
    const serialized = JSON.stringify(next) + "\n"; need(Buffer.byteLength(serialized) <= MAX_BYTES, "EXTERNAL_PROVIDER_CREDENTIAL_CAPACITY");
    try { atomicWritePrivateFile(this.file, serialized, { fs: this.fs, trustedRoot: this.paths.trustedRoot }); }
    catch { this.commitUncertain = true; throw error("EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN"); }
    this.state = next;
  }
  #assertNamespace(state) {
    for (const row of [...Object.values(state.bindings), ...Object.values(state.operations)]) {
      need((row.api === NATIVE_AUTH_API) === this.nativeAuth, "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
      for (const ref of [row.credentialRef, row.candidateRef, row.previousBinding?.credentialRef].filter(Boolean)) {
        need(ref.startsWith(this.credentialPrefix), "EXTERNAL_PROVIDER_CREDENTIAL_LEDGER_CORRUPT");
      }
    }
  }
  #dto(operation, binding) {
    const ref = operation && !TERMINAL.has(operation.status) ? operation.candidateRef : binding?.credentialRef;
    return Object.freeze({ version: 1, backendId: "openclaw", providerKey: operation?.providerKey || binding?.providerKey || null,
      state: operation ? operation.status === "preparing" ? "needs_verification" : operation.status : binding?.revision ? "stored" : "unconfigured",
      hasSecret: ref != null && this.secretStore.getCredentialRevision(ref) !== null,
      operationId: operation?.operationId || null });
  }
  #operation(scope) {
    const operation = own(this.state.operations, scope.operationId);
    need(operation && equal(scopeOf(operation), scope), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH"); return operation;
  }
  #receiptFile(operationId) { return path.join(this.receiptsDir, crypto.createHash("sha256").update(operationId).digest("hex") + ".json"); }
  #receipt(scope, readOnly = false) {
    const file = this.#receiptFile(scope.operationId);
    if (readOnly) {
      // Terminal observation may inspect existing evidence, never repair or
      // create it. The live proof was captured only after receipt publication.
      for (const directory of [this.paths.stateDir, this.receiptsDir]) {
        const stat = this.fs.lstatSync(directory);
        need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
          && (!process.getuid || stat.uid === process.getuid()) && this.fs.realpathSync(directory) === directory,
        "EXTERNAL_PROVIDER_CREDENTIAL_RECEIPT_CORRUPT");
      }
      need(!statIfExists(this.fs, file + ".tmp") && !this.fs.readdirSync(this.receiptsDir).some(name =>
        name.startsWith(path.basename(file) + ".backup-")),
        "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
    } else {
      preparePrivateParent(file, this.paths.trustedRoot, this.fs);
      const recovered = recoverInterruptedPrivateFile(file, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
      need(recovered !== "uncertain", "EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN");
    }
    if (!statIfExists(this.fs, file)) return null;
    let receipt; try { receipt = JSON.parse(readPrivateFile(file, { fs: this.fs, maxBytes: 2048 }).toString("utf8")); }
    catch { throw error("EXTERNAL_PROVIDER_CREDENTIAL_RECEIPT_CORRUPT"); }
    need(plain(receipt, ["version", "operationId", "requestDigest", "scopeDigest", "providerKey", "action", "status"])
      && receipt.version === 1 && TERMINAL.has(receipt.status) && ["set", "clear", "preserve"].includes(receipt.action),
    "EXTERNAL_PROVIDER_CREDENTIAL_RECEIPT_CORRUPT");
    need(receipt.operationId === scope.operationId && receipt.requestDigest === scope.requestDigest
      && receipt.providerKey === scope.providerKey && receipt.scopeDigest === scopeDigest(scope),
    "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH"); return receipt;
  }
  #compactTerminals() {
    // Publish the verified terminal binding in the primary ledger FIRST. A
    // separate minimal tombstone may then be written, followed by removing only
    // that terminal payload. Any crash prefix retains the original ID forever.
    const next = copy(this.state); let changed = false;
    for (const operation of Object.values(next.operations)) if (TERMINAL.has(operation.status)) {
      const scope = scopeOf(operation), existing = this.#receipt(scope);
      const receipt = { version: 1, operationId: scope.operationId, requestDigest: scope.requestDigest,
        scopeDigest: scopeDigest(scope), providerKey: scope.providerKey, action: operation.action, status: operation.status };
      if (existing) need(equal(existing, receipt), "EXTERNAL_PROVIDER_CREDENTIAL_RECEIPT_CORRUPT");
      else try { atomicWritePrivateFile(this.#receiptFile(scope.operationId), JSON.stringify(receipt) + "\n",
        { fs: this.fs, trustedRoot: this.paths.trustedRoot }); }
      catch { this.commitUncertain = true; throw error("EXTERNAL_PROVIDER_CREDENTIAL_COMMIT_UNCERTAIN"); }
      delete next.operations[scope.operationId]; changed = true;
    }
    if (changed) this.#persist(next);
  }
  #assertBinding(operation) {
    need(equal(own(this.state.bindings, operation.providerKey), operation.previousBinding),
      "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
    if (operation.previousBinding?.credentialRef) need(this.secretStore.getCredentialFingerprint(operation.previousBinding.credentialRef)
      === operation.previousBinding.credentialFingerprint, "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
  }
  #assertCandidate(operation) {
    if (operation.candidateRef) need(this.secretStore.getCredentialFingerprint(operation.candidateRef) === operation.candidateFingerprint
      && this.secretStore.getCredentialRevision(operation.candidateRef) !== null, "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
  }
  #ownedOperation(next, operationId, status, ownerGeneration = undefined) {
    const operation = next.operations[operationId]; operation.status = status; operation.updatedAt = Math.max(operation.updatedAt, Date.now());
    if (ownerGeneration !== undefined) operation.ownerGeneration = ownerGeneration; return operation;
  }
  #assertOwner(operation, authority) {
    need(operation.ownerGeneration === null || operation.ownerGeneration === authority.ownerGeneration
      || authority.previousOwnerGeneration === operation.ownerGeneration, "EXTERNAL_PROVIDER_CREDENTIAL_OWNER_CHANGED");
  }
  #previousProjection(scope, previous, authority, credentialRevision, secret) {
    return Object.freeze({ version: 1, ...scope, phase: "previous",
      previousScope: previous ? providerScope(Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"]
        .map(key => [key, previous[key]]))) : null,
      bindingRevision: previous?.revision || 0, credentialRevision,
      ownerGeneration: authority.ownerGeneration, expiresAt: Math.min(Date.now() + ENVELOPE_TTL, authority.expiresAt),
      ...(typeof secret === "string" ? { apiKey: secret } : {}) });
  }

  async getStatus(input, context) {
    const scope = providerScope(input); const auth = await this.#authorize("management", scope, context);
    return this.#enqueue(() => { auth.check(); const binding = own(this.state.bindings, scope.providerKey);
      if (binding) need(equal(providerScope(Object.fromEntries(Object.keys(scope).map(key => [key, binding[key]]))), scope),
        "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
      const held = Object.values(this.state.operations).find(operation => operation.providerKey === scope.providerKey && !TERMINAL.has(operation.status));
      if (binding?.credentialRef) need(this.secretStore.getCredentialFingerprint(binding.credentialRef) === binding.credentialFingerprint,
        "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
      return this.#dto(held, binding || { providerKey: scope.providerKey, credentialRef: null }); });
  }

  async list(context) {
    const auth = await this.#authorize("management", Object.freeze({ backendId: "openclaw", action: "list" }), context);
    return this.#enqueue(() => { auth.check(); const keys = new Set([...Object.keys(this.state.bindings),
      ...Object.values(this.state.operations).filter(operation => !TERMINAL.has(operation.status)).map(operation => operation.providerKey)]);
      return Object.freeze([...keys].sort().map(key => this.#dto(Object.values(this.state.operations).find(
        operation => operation.providerKey === key && !TERMINAL.has(operation.status)), own(this.state.bindings, key)))); });
  }

  async observe(input, context) {
    const scope = operationScope(input); const auth = await this.#authorize("management", scope, context);
    return this.#enqueue(() => { auth.check(); const receipt = this.#receipt(scope);
      if (!receipt && !own(this.state.operations, scope.operationId))
        return Object.freeze({ version: 1, backendId: "openclaw", providerKey: scope.providerKey,
          state: "not_found", hasSecret: false, operationId: scope.operationId });
      const operation = receipt || this.#operation(scope);
      return this.#dto(operation, own(this.state.bindings, scope.providerKey)); });
  }

  async prepare(input, context) {
    const fields = ["backendId", "providerKey", "baseUrl", "api", "operationId", "requestDigest", "action"];
    need(plain(input, fields) || plain(input, [...fields, "secret"])); const scope = scopeOf(input);
    const action = input.action; let secret = input.secret;
    need(["set", "clear", "preserve"].includes(action) && (action === "set"
      ? typeof secret === "string" && secret.length > 0 && Buffer.byteLength(secret) <= 65536 && !secret.includes("\0")
      : !Object.hasOwn(input, "secret")));
    if (secret) need(!JSON.stringify({ ...scope, action }).includes(secret), "EXTERNAL_PROVIDER_CREDENTIAL_SECRET_COLLISION");
    const auth = await this.#authorize("management", Object.freeze({ ...scope, action }), context);
    try { return await this.#enqueue(async () => {
      auth.check(); const existingOperation = own(this.state.operations, scope.operationId);
      const terminalReceipt = this.#receipt(scope);
      if (terminalReceipt) { need(terminalReceipt.action === action, "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
        return this.#dto(terminalReceipt, own(this.state.bindings, scope.providerKey)); }
      if (existingOperation) {
        need(equal(scopeOf(existingOperation), scope) && existingOperation.action === action,
          "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH");
        if (TERMINAL.has(existingOperation.status)) return this.#dto(existingOperation, own(this.state.bindings, scope.providerKey));
        this.#assertBinding(existingOperation); this.#assertCandidate(existingOperation);
        if (action === "set") { const saved = await this.secretStore.get(existingOperation.candidateRef); auth.check();
          const a = Buffer.from(secret), b = Buffer.from(saved || "");
          try { need(a.length === b.length && crypto.timingSafeEqual(a, b), "EXTERNAL_PROVIDER_CREDENTIAL_OPERATION_MISMATCH"); }
          finally { a.fill(0); b.fill(0); }
          this.#assertCandidate(existingOperation);
        }
        return this.#dto(existingOperation, own(this.state.bindings, scope.providerKey));
      }
      need(Object.keys(this.state.operations).length < MAX_OPERATIONS, "EXTERNAL_PROVIDER_CREDENTIAL_CAPACITY");
      need(!Object.values(this.state.operations).some(operation => operation.providerKey === scope.providerKey && !TERMINAL.has(operation.status)),
        "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
      const previousBinding = own(this.state.bindings, scope.providerKey);
      if (!previousBinding) {
        const reserved = new Set([...Object.keys(this.state.bindings), ...Object.values(this.state.operations)
          .filter(operation => !TERMINAL.has(operation.status)).map(operation => operation.providerKey)]);
        need(reserved.size < MAX_BINDINGS, "EXTERNAL_PROVIDER_CREDENTIAL_CAPACITY");
      }
      if (previousBinding?.credentialRef) {
        need(this.secretStore.getCredentialFingerprint(previousBinding.credentialRef) === previousBinding.credentialFingerprint,
          "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
        if (action === "preserve") need(previousBinding.baseUrl === scope.baseUrl && previousBinding.api === scope.api,
          "EXTERNAL_PROVIDER_CREDENTIAL_ENDPOINT_CHANGED");
      }
      const candidateRef = action === "set" ? this.credentialPrefix + crypto.randomUUID()
        : action === "preserve" ? previousBinding?.credentialRef || null : null;
      const next = copy(this.state), now = Date.now();
      next.operations[scope.operationId] = { ...scope, action, status: "preparing", previousBinding: copy(previousBinding),
        candidateRef, candidateFingerprint: action === "preserve" ? previousBinding?.credentialFingerprint || null : null,
        ownerGeneration: null, createdAt: now, updatedAt: now };
      auth.check(); this.#persist(next);
      if (action === "set") {
        try { await this.secretStore.putIfRevision(candidateRef, secret, { kind: this.secretKind }, null); }
        catch (failure) {
          if (failure?.code === "credentials_locked") { auth.check(); const failed = copy(this.state);
            this.#ownedOperation(failed, scope.operationId, "failed"); this.#persist(failed); this.#compactTerminals(); throw failure; }
          if (failure?.code === "SECRET_COMMIT_UNCERTAIN") this.commitUncertain = true;
          throw error("EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
        }
        auth.check();
      }
      const prepared = copy(this.state); const operation = this.#ownedOperation(prepared, scope.operationId, "prepared");
      if (candidateRef) operation.candidateFingerprint = this.secretStore.getCredentialFingerprint(candidateRef);
      auth.check(); this.#persist(prepared); return this.#dto(operation, previousBinding);
    }); } finally { secret = null; }
  }

  async readForManagedLease(input, context) {
    const { scope, phase, recovery } = leaseInput(input, true);
    const auth = await this.#authorize("managed", Object.freeze({ ...scope, action: "read",
      ...(phase === "previous" ? { phase } : {}) }), context);
    return this.#enqueue(async () => {
      auth.check(); need(!this.#receipt(scope), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION"); const operation = this.#operation(scope);
      need(!TERMINAL.has(operation.status) && operation.status !== "preparing"
        && (operation.status !== "needs_verification" || recovery), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
      this.#assertBinding(operation); if (phase === "candidate") this.#assertCandidate(operation);
      this.#assertOwner(operation, auth.authority);
      const previous = copy(operation.previousBinding);
      const pending = copy(this.state); this.#ownedOperation(pending, scope.operationId, "inflight", auth.authority.ownerGeneration);
      auth.check(); this.#persist(pending);
      const credentialRef = phase === "previous" ? previous?.credentialRef || null : operation.candidateRef;
      const credentialRevision = credentialRef ? this.secretStore.getCredentialRevision(credentialRef) : null;
      const readsSecret = phase === "previous" ? credentialRef !== null : operation.action === "set";
      const secret = readsSecret ? await this.secretStore.get(credentialRef) : null;
      auth.check(); const current = this.#operation(scope);
      need(current.status === "inflight" && current.ownerGeneration === auth.authority.ownerGeneration,
        "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
      need(equal(current.previousBinding, previous), "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
      this.#assertBinding(current); if (phase === "candidate") this.#assertCandidate(current);
      need(credentialRevision === (credentialRef ? this.secretStore.getCredentialRevision(credentialRef) : null),
        "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
      need(!readsSecret || typeof secret === "string" && secret.length > 0,
        "EXTERNAL_PROVIDER_CREDENTIAL_CHANGED");
      if (phase === "previous") return this.#previousProjection(scope, previous, auth.authority, credentialRevision, secret);
      return Object.freeze({ version: 1, ...scope, action: operation.action,
        bindingRevision: operation.previousBinding?.revision || 0, credentialRevision,
        ownerGeneration: auth.authority.ownerGeneration, expiresAt: Math.min(Date.now() + ENVELOPE_TTL, auth.authority.expiresAt),
        ...(operation.action === "set" ? { apiKey: secret } : {}) });
    });
  }

  async assertForManagedLease(input, context) {
    const { scope, phase } = leaseInput(input, false);
    const auth = await this.#authorize("managed", Object.freeze({ ...scope, action: "assert",
      ...(phase === "previous" ? { phase } : {}) }), context);
    return this.#enqueue(() => { auth.check(); need(!this.#receipt(scope), "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
      const operation = this.#operation(scope);
      need(operation.status === "inflight" && operation.ownerGeneration === auth.authority.ownerGeneration,
        "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
      this.#assertBinding(operation);
      if (phase === "previous") return this.#previousProjection(scope, operation.previousBinding, auth.authority,
        operation.previousBinding?.credentialRef ? this.secretStore.getCredentialRevision(operation.previousBinding.credentialRef) : null);
      this.#assertCandidate(operation);
      return Object.freeze({ version: 1, ...scope, action: operation.action,
        bindingRevision: operation.previousBinding?.revision || 0,
        credentialRevision: operation.candidateRef ? this.secretStore.getCredentialRevision(operation.candidateRef) : null,
        ownerGeneration: auth.authority.ownerGeneration, expiresAt: Math.min(Date.now() + ENVELOPE_TTL, auth.authority.expiresAt) });
    });
  }

  async observeTerminalForManagedLease(input, context) {
    need(plain(input, ["scope", "outcome"]));
    const scope = operationScope(input.scope), outcome = input.outcome;
    need(["applied", "compensated", "blocked"].includes(outcome));
    const auth = await this.#authorize("managed", Object.freeze({ ...scope, action: "terminal-observe", outcome }), context);
    return this.#enqueue(() => {
      const observed = this.#terminalObservations.get(scope.operationId);
      const assertCurrent = () => {
        auth.check();
        need(observed && this.#terminalObservations.get(scope.operationId) === observed
          && equal(observed.scope, scope) && observed.ownerGeneration === auth.authority.ownerGeneration
          && observed.expiresAt > Date.now(), "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
        need(observed.outcome === outcome, "EXTERNAL_PROVIDER_CREDENTIAL_OUTCOME_MISMATCH");
        const receipt = this.#receipt(scope, true);
        need(receipt && receipt.status === outcome && receipt.action === observed.action,
          "EXTERNAL_PROVIDER_CREDENTIAL_TERMINAL_UNVERIFIED");
        const binding = own(this.state.bindings, scope.providerKey);
        need(equal(binding, observed.binding) && !Object.values(this.state.operations).some(operation =>
          operation.providerKey === scope.providerKey && !TERMINAL.has(operation.status)),
        "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
        if (binding?.credentialRef) need(this.secretStore.getCredentialFingerprint(binding.credentialRef) === binding.credentialFingerprint
          && this.secretStore.getCredentialRevision(binding.credentialRef) === observed.credentialRevision,
        "EXTERNAL_PROVIDER_CREDENTIAL_BINDING_CHANGED");
        return true;
      };
      assertCurrent(); const binding = observed.binding;
      const envelope = Object.freeze({ version: 1, ...scope, outcome, action: observed.action,
        bindingScope: binding ? providerScope(Object.fromEntries(["backendId", "providerKey", "baseUrl", "api"]
          .map(key => [key, binding[key]]))) : null,
        bindingRevision: binding?.revision || 0, credentialRevision: observed.credentialRevision,
        ownerGeneration: observed.ownerGeneration,
        expiresAt: Math.min(Date.now() + 10000, observed.expiresAt, auth.authority.expiresAt) });
      // This private closure never crosses IPC. Gate must call it after its
      // second physical await, before releasing the closed public envelope.
      return Object.freeze({ envelope, assertCurrent });
    });
  }

  async settleManagedLease(input, context) {
    need(plain(input, ["scope", "outcome"])); const scope = operationScope(input.scope), outcome = input.outcome;
    need(["applied", "compensated", "blocked", "needs_verification"].includes(outcome));
    const auth = await this.#authorize("managed", Object.freeze({ ...scope, action: "settle", outcome }), context);
    return this.#enqueue(() => {
      auth.check(); const receipt = this.#receipt(scope);
      if (receipt) { need(receipt.status === outcome, "EXTERNAL_PROVIDER_CREDENTIAL_OUTCOME_MISMATCH");
        return this.#dto(receipt, own(this.state.bindings, scope.providerKey)); }
      const operation = this.#operation(scope);
      if (TERMINAL.has(operation.status)) { need(operation.status === outcome, "EXTERNAL_PROVIDER_CREDENTIAL_OUTCOME_MISMATCH");
        return this.#dto(operation, own(this.state.bindings, scope.providerKey)); }
      need(operation.ownerGeneration !== null && operation.status !== "preparing", "EXTERNAL_PROVIDER_CREDENTIAL_NEEDS_VERIFICATION");
      this.#assertBinding(operation); this.#assertOwner(operation, auth.authority);
      if (outcome !== "needs_verification") this.#assertCandidate(operation);
      if (TERMINAL.has(outcome)) {
        for (const [id, proof] of this.#terminalObservations) if (proof.expiresAt <= Date.now()
          || proof.scope.providerKey === scope.providerKey) this.#terminalObservations.delete(id);
        need(this.#terminalObservations.size < MAX_OPERATIONS, "EXTERNAL_PROVIDER_CREDENTIAL_CAPACITY");
      }
      const next = copy(this.state); const settled = this.#ownedOperation(next, scope.operationId, outcome, auth.authority.ownerGeneration);
      if (outcome === "applied") next.bindings[scope.providerKey] = { ...providerScope(Object.fromEntries(
        ["backendId", "providerKey", "baseUrl", "api"].map(key => [key, scope[key]]))),
        revision: (operation.previousBinding?.revision || 0) + 1, credentialRef: operation.candidateRef,
        credentialFingerprint: operation.candidateFingerprint, lastOperationId: scope.operationId };
      auth.check(); this.#persist(next); const dto = this.#dto(settled, next.bindings[scope.providerKey]);
      if (TERMINAL.has(outcome)) {
        this.#compactTerminals(); auth.check();
        const binding = copy(own(this.state.bindings, scope.providerKey));
        this.#terminalObservations.set(scope.operationId, Object.freeze({ scope, action: operation.action, outcome,
          ownerGeneration: auth.authority.ownerGeneration, expiresAt: auth.authority.expiresAt, binding,
          credentialRevision: binding?.credentialRef ? this.secretStore.getCredentialRevision(binding.credentialRef) : null }));
      }
      return dto;
    });
  }

  // Service startup only. Nonterminal operations retain BOTH old and candidate
  // credentials. Terminal IDs are direct-addressed fixed SHA256 filenames, not
  // subject to the 256 pending limit, and are never evicted to grant a new ID.
  credentialOwnershipSnapshot() {
    this.#assertOpen(); const refs = new Set();
    for (const binding of Object.values(this.state.bindings)) if (binding.credentialRef) refs.add(binding.credentialRef);
    for (const operation of Object.values(this.state.operations)) if (!TERMINAL.has(operation.status)) {
      if (operation.previousBinding?.credentialRef) refs.add(operation.previousBinding.credentialRef);
      if (operation.candidateRef) refs.add(operation.candidateRef);
    }
    return Object.freeze([...refs]);
  }
}

module.exports = { ExternalProviderCredentialController, createExternalProviderManagementAuthority,
  createExternalProviderManagedLeaseAuthority, isExternalProviderCredentialController: value => controllers.has(value),
  MAX_EXTERNAL_PROVIDER_OPERATIONS: MAX_OPERATIONS, externalProviderOperationScope: operationScope };
