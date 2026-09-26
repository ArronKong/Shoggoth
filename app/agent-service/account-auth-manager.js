"use strict";

const crypto = require("node:crypto");
const { assertRuntimeProfileId } = require("./codex-runtime-paths");
const { runtimeBinding } = require("./runtime-adapter");
const { serviceError } = require("./security");

const ACTIVE_STATUSES = new Set(["starting", "waiting", "canceling"]);
const TERMINAL_STATUSES = new Set([
  "succeeded", "failed", "canceled", "timed_out", "interrupted", "unknown",
]);
const MODES = new Set(["browser", "deviceCode"]);
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_LOGIN_TIMEOUT_MS = 1_000;
const MAX_LOGIN_TIMEOUT_MS = 30 * 60 * 1000;
const RUNTIME_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function authError(code, message) {
  return serviceError(code, message);
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function assertProfile(runtimeProfileId) {
  try { assertRuntimeProfileId(runtimeProfileId); } catch {
    throw authError("AUTH_PARAMS_INVALID", "Account auth parameters are invalid");
  }
}

function assertAccount(runtimeAccountId) {
  if (typeof runtimeAccountId !== "string"
    || !RUNTIME_ACCOUNT_ID_PATTERN.test(runtimeAccountId)) {
    throw authError("AUTH_PARAMS_INVALID", "Account auth parameters are invalid");
  }
}

function stableAccountRead(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.requiresOpenaiAuth !== "boolean") {
    throw authError("AUTH_ACCOUNT_RESPONSE_INVALID", "Codex account response is invalid");
  }
  const raw = value.account;
  if (raw === null) return { account: null, requiresOpenaiAuth: value.requiresOpenaiAuth };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw authError("AUTH_ACCOUNT_RESPONSE_INVALID", "Codex account response is invalid");
  }
  if (raw.type === "chatgpt") {
    const result = { type: "chatgpt" };
    if (typeof raw.planType === "string" && raw.planType.length <= 64) result.planType = raw.planType;
    return {
      account: result, requiresOpenaiAuth: value.requiresOpenaiAuth,
      ...(value.authSource === "native-codex" ? { authSource: "native-codex" } : {}),
    };
  }
  if (raw.type === "apiKey") {
    return { account: { type: "apiKey" }, requiresOpenaiAuth: value.requiresOpenaiAuth };
  }
  if (raw.type === "amazonBedrock") {
    if (typeof raw.usesCodexManagedCredentials !== "boolean") {
      throw authError("AUTH_ACCOUNT_RESPONSE_INVALID", "Codex account response is invalid");
    }
    return {
      account: {
        type: "amazonBedrock",
        usesCodexManagedCredentials: raw.usesCodexManagedCredentials,
      },
      requiresOpenaiAuth: value.requiresOpenaiAuth,
    };
  }
  throw authError("AUTH_ACCOUNT_RESPONSE_INVALID", "Codex account response is invalid");
}

function loginSummary(session) {
  if (!session) return null;
  return {
    requestId: session.requestId,
    mode: session.mode,
    status: session.status,
    updatedAt: session.updatedAt,
    errorCode: session.errorCode,
  };
}

class AccountAuthManager {
  constructor(options = {}) {
    const runtimeManager = options.runtimeManager || (options.runtimePool && {
      acquire: ({ runtimeProfileId }) => options.runtimePool.get(runtimeProfileId),
      stop: ({ runtimeProfileId }) => options.runtimePool.stop(runtimeProfileId),
    });
    if (!options.stateStore || !runtimeManager
      || typeof runtimeManager.acquire !== "function" || typeof runtimeManager.stop !== "function") {
      throw authError("AUTH_MANAGER_OPTIONS_INVALID", "Account auth manager options are invalid");
    }
    const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(loginTimeoutMs)
      || loginTimeoutMs < MIN_LOGIN_TIMEOUT_MS || loginTimeoutMs > MAX_LOGIN_TIMEOUT_MS) {
      throw authError("AUTH_MANAGER_OPTIONS_INVALID", "Account auth manager options are invalid");
    }
    this.stateStore = options.stateStore;
    this.runtimeManager = runtimeManager;
    this.resolveRuntimeAccountBinding = options.resolveRuntimeAccountBinding
      || ((runtimeAccountId) => ({
        runtime: "codex",
        runtimeProfileId: runtimeAccountId,
        runtimeAccountId,
      }));
    this.resolveProfileAuthBinding = options.resolveProfileAuthBinding
      || options.resolveRuntimeBinding
      || ((runtimeProfileId) => ({
        runtime: "codex",
        runtimeProfileId,
        runtimeAccountId: runtimeProfileId,
      }));
    if (typeof this.resolveRuntimeAccountBinding !== "function"
      || typeof this.resolveProfileAuthBinding !== "function") {
      throw authError("AUTH_MANAGER_OPTIONS_INVALID", "Account auth manager options are invalid");
    }
    if (options.runtimeAccountAdmission !== undefined
      && (!options.runtimeAccountAdmission
        || ["beginMutation", "finishMutation", "cancelMutation"].some(
          (method) => typeof options.runtimeAccountAdmission[method] !== "function",
        ))) {
      throw authError("AUTH_MANAGER_OPTIONS_INVALID", "Account auth manager options are invalid");
    }
    if (options.invalidateRuntimeAccount !== undefined
      && typeof options.invalidateRuntimeAccount !== "function") {
      throw authError("AUTH_MANAGER_OPTIONS_INVALID", "Account auth manager options are invalid");
    }
    this.runtimeAccountAdmission = options.runtimeAccountAdmission || null;
    this.invalidateRuntimeAccount = options.invalidateRuntimeAccount
      || (({ binding }) => this.runtimeManager.stop(binding));
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.loginTimeoutMs = loginTimeoutMs;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.active = new Map();
    this.bindings = new Map();
    this.pendingInvalidations = new Set();
    this.opened = false;
    this.closePromise = null;
    this.generation = 0;
    this.poisonError = null;
    this.terminationSettled = false;
    this.#resetTermination();
  }

  open() {
    if (this.opened) return this;
    if (this.poisonError) throw this.poisonError;
    this.closePromise = null;
    if (this.terminationSettled) this.#resetTermination();
    this.generation += 1;
    this.opened = true;
    return this;
  }

  async read(input) {
    if (exactObject(input, ["runtimeProfileId"])) return this.readForProfile(input);
    const context = this.#accountContext(input, ["runtimeAccountId"]);
    return this.#read(context);
  }

  async readForProfile(input) {
    const context = this.#profileContext(input, ["runtimeProfileId"]);
    return this.#read(context);
  }

  async #read(context) {
    const generation = this.generation;
    const host = await this.runtimeManager.acquire(context.binding);
    this.#assertGeneration(generation);
    this.#bindHost(context.runtimeAccountId, host, generation);
    const account = stableAccountRead(await host.accountRead({ refreshToken: false }));
    this.#assertGeneration(generation);
    return { ...account, login: loginSummary(this.stateStore.get(context.runtimeAccountId)) };
  }

  async loginStart(input) {
    if (exactObject(input, ["runtimeProfileId", "mode"])) return this.loginStartForProfile(input);
    const context = this.#accountContext(input, ["runtimeAccountId", "mode"]);
    return this.#loginStart(context, input.mode);
  }

  async loginStartForProfile(input) {
    const context = this.#profileContext(input, ["runtimeProfileId", "mode"]);
    return this.#loginStart(context, input.mode);
  }

  async #loginStart(context, mode) {
    if (!MODES.has(mode)) {
      throw authError("AUTH_PARAMS_INVALID", "Account auth parameters are invalid");
    }
    const generation = this.generation;
    const previous = this.stateStore.get(context.runtimeAccountId);
    if (previous && ACTIVE_STATUSES.has(previous.status)) {
      throw authError("AUTH_LOGIN_IN_PROGRESS", "Account login is already in progress");
    }
    const requestId = this.randomUUID();
    const mutation = { runtimeAccountId: context.runtimeAccountId, operationId: requestId };
    this.runtimeAccountAdmission?.beginMutation(mutation);
    const timestamp = this.now();
    let session;
    try {
      session = this.stateStore.put({
        requestId,
        runtimeAccountId: context.runtimeAccountId,
        mode,
        status: "starting",
        createdAt: timestamp,
        updatedAt: timestamp,
        errorCode: null,
      });
    } catch (error) {
      this.runtimeAccountAdmission?.cancelMutation(mutation);
      throw error;
    }
    const entry = {
      binding: context.binding,
      host: null,
      session,
      loginId: null,
      timer: null,
      earlyCompletions: new Map(),
      cancelPromise: null,
      mutation,
    };
    this.active.set(context.runtimeAccountId, entry);
    entry.timer = this.setTimeout(() => {
      this.#timeout(context.runtimeAccountId).catch(() => {});
    }, this.loginTimeoutMs);
    entry.timer?.unref?.();
    try {
      const host = await this.runtimeManager.acquire(context.binding);
      this.#assertGeneration(generation);
      if (this.active.get(context.runtimeAccountId) !== entry) {
        throw authError("AUTH_LOGIN_CANCELED", "Account login was canceled");
      }
      entry.host = host;
      this.#bindHost(context.runtimeAccountId, host, generation);
      const params = mode === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" };
      const response = await host.accountLoginStart(params);
      this.#assertGeneration(generation);
      if (this.active.get(context.runtimeAccountId) !== entry) {
        throw authError("AUTH_LOGIN_CANCELED", "Account login was canceled");
      }
      entry.loginId = response.loginId;
      entry.session = this.#put(entry.session, "waiting", null);
      const early = entry.earlyCompletions.get(entry.loginId);
      if (early) {
        this.#applyCompletion(context.runtimeAccountId, early);
        if (entry.completionPromise) await entry.completionPromise;
        this.#assertGeneration(generation);
      }
      return {
        requestId: session.requestId,
        mode,
        status: entry.session.status,
        loginId: response.loginId,
        ...(mode === "browser"
          ? { authUrl: response.authUrl }
          : { verificationUrl: response.verificationUrl, userCode: response.userCode }),
      };
    } catch (error) {
      if (this.poisonError) throw this.poisonError;
      if (error?.code === "AUTH_MANAGER_CLOSED" || error?.code === "AUTH_STATE_COMMIT_UNCERTAIN") {
        throw error;
      }
      if (this.stateStore.get(context.runtimeAccountId)?.status === "timed_out") {
        throw authError("AUTH_LOGIN_TIMEOUT", "Account login timed out");
      }
      if (error?.code === "AUTH_LOGIN_CANCELED"
        || this.stateStore.get(context.runtimeAccountId)?.status === "canceled") {
        throw authError("AUTH_LOGIN_CANCELED", "Account login was canceled");
      }
      this.#finish(context.runtimeAccountId, "failed", "LOGIN_START_FAILED");
      throw error;
    }
  }

  async loginCancel(input) {
    if (exactObject(input, ["runtimeProfileId", "requestId"])) {
      return this.loginCancelForProfile(input);
    }
    const context = this.#accountContext(input, ["runtimeAccountId", "requestId"]);
    return this.#loginCancel(context, input.requestId);
  }

  async loginCancelForProfile(input) {
    const context = this.#profileContext(input, ["runtimeProfileId", "requestId"]);
    return this.#loginCancel(context, input.requestId);
  }

  async #loginCancel(context, requestId) {
    const generation = this.generation;
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
      throw authError("AUTH_PARAMS_INVALID", "Account auth parameters are invalid");
    }
    const saved = this.stateStore.get(context.runtimeAccountId);
    if (!saved || saved.requestId !== requestId) {
      throw authError("AUTH_LOGIN_NOT_FOUND", "Account login request was not found");
    }
    if (TERMINAL_STATUSES.has(saved.status)) {
      return { requestId: saved.requestId, status: saved.status };
    }
    const entry = this.active.get(context.runtimeAccountId);
    if (!entry || entry.session.requestId !== requestId || !ACTIVE_STATUSES.has(entry.session.status)) {
      throw authError("AUTH_LOGIN_NOT_ACTIVE", "Account login request is not active");
    }
    const terminal = await this.#convergeCancellation(
      context.runtimeAccountId,
      "canceled",
      null,
      true,
    );
    this.#assertGeneration(generation);
    return { requestId: terminal.requestId, status: terminal.status };
  }

  async logout(input) {
    if (exactObject(input, ["runtimeProfileId"])) return this.logoutForProfile(input);
    const context = this.#accountContext(input, ["runtimeAccountId"]);
    return this.#logout(context);
  }

  async logoutForProfile(input) {
    const context = this.#profileContext(input, ["runtimeProfileId"]);
    return this.#logout(context);
  }

  async #logout(context) {
    const generation = this.generation;
    const saved = this.stateStore.get(context.runtimeAccountId);
    if (saved && ACTIVE_STATUSES.has(saved.status)) {
      await this.#loginCancel(context, saved.requestId);
      this.#assertGeneration(generation);
    }
    const mutation = {
      runtimeAccountId: context.runtimeAccountId,
      operationId: this.randomUUID(),
    };
    this.runtimeAccountAdmission?.beginMutation(mutation);
    try {
      const host = await this.runtimeManager.acquire(context.binding);
      this.#assertGeneration(generation);
      await host.accountLogout();
    } catch (error) {
      this.runtimeAccountAdmission?.cancelMutation(mutation);
      throw error;
    }
    this.#unbindHost(context.runtimeAccountId);
    await this.#invalidateCommittedAccount({
      runtimeAccountId: context.runtimeAccountId,
      binding: context.binding,
      mutation,
      reason: "logout",
    });
    this.#assertGeneration(generation);
    return { loggedOut: true };
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (!this.opened) return Promise.resolve();
    this.opened = false;
    this.generation += 1;
    this.closePromise = (async () => {
      const errors = this.poisonError ? [this.poisonError] : [];
      try {
        for (const runtimeAccountId of [...this.active.keys()]) {
          try { this.#finish(runtimeAccountId, "interrupted", "SERVICE_STOPPED", false); } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        for (const [runtimeAccountId, entry] of [...this.active.entries()]) {
          try { this.#cleanup(entry); } catch (error) { errors.push(error); }
          this.active.delete(runtimeAccountId);
        }
        for (const runtimeAccountId of [...this.bindings.keys()]) this.#unbindHost(runtimeAccountId);
      }
      const pending = await Promise.allSettled([...this.pendingInvalidations]);
      for (const result of pending) {
        if (result.status === "rejected" && !errors.includes(result.reason)) {
          errors.push(result.reason);
        }
      }
      if (errors.length > 0) {
        const aggregate = new AggregateError(errors, "Account auth manager close failed");
        aggregate.code = "AUTH_MANAGER_CLOSE_FAILED";
        throw aggregate;
      }
      this.#settleTermination(null);
    })();
    return this.closePromise;
  }

  #accountContext(value, fields) {
    this.#assertOpen();
    if (!exactObject(value, fields)) throw authError("AUTH_PARAMS_INVALID", "Account auth parameters are invalid");
    assertAccount(value.runtimeAccountId);
    return this.#resolvedAccountContext(value.runtimeAccountId);
  }

  #resolvedAccountContext(runtimeAccountId) {
    let binding;
    try {
      binding = runtimeBinding(this.resolveRuntimeAccountBinding(runtimeAccountId));
    } catch {
      throw authError("AUTH_ACCOUNT_BINDING_INVALID", "Account auth RuntimeAccount binding is invalid");
    }
    if (binding.runtimeAccountId !== runtimeAccountId) {
      throw authError("AUTH_ACCOUNT_BINDING_INVALID", "Account auth RuntimeAccount binding is invalid");
    }
    return { runtimeAccountId, binding };
  }

  #profileContext(value, fields) {
    this.#assertOpen();
    if (!exactObject(value, fields)) throw authError("AUTH_PARAMS_INVALID", "Account auth parameters are invalid");
    assertProfile(value.runtimeProfileId);
    let profileBinding;
    try {
      profileBinding = runtimeBinding(this.resolveProfileAuthBinding(value.runtimeProfileId));
    } catch {
      throw authError("AUTH_PROFILE_BINDING_INVALID", "Account auth Runtime binding is invalid");
    }
    if (profileBinding.runtimeProfileId !== value.runtimeProfileId) {
      throw authError("AUTH_PROFILE_BINDING_INVALID", "Account auth Runtime binding is invalid");
    }
    const context = this.#resolvedAccountContext(profileBinding.runtimeAccountId);
    if (context.binding.runtime !== profileBinding.runtime) {
      throw authError("AUTH_PROFILE_BINDING_INVALID", "Account auth Runtime binding is invalid");
    }
    return context;
  }

  #assertOpen() {
    if (this.poisonError) throw this.poisonError;
    if (!this.opened) throw authError("AUTH_MANAGER_CLOSED", "Account auth manager is closed");
  }

  #assertGeneration(generation) {
    this.#assertOpen();
    if (generation !== this.generation) {
      throw authError("AUTH_MANAGER_CLOSED", "Account auth manager is closed");
    }
  }

  #put(session, status, errorCode) {
    return this.stateStore.put({
      ...session,
      status,
      updatedAt: Math.max(this.now(), session.updatedAt),
      errorCode,
    });
  }

  #cleanup(entry) {
    if (entry.timer !== null) this.clearTimeout(entry.timer);
    entry.timer = null;
    entry.earlyCompletions.clear();
  }

  #finish(runtimeAccountId, status, errorCode, poisonOnFailure = true) {
    const entry = this.active.get(runtimeAccountId);
    if (!entry || TERMINAL_STATUSES.has(entry.session.status)) return entry?.session || null;
    let persisted;
    let failure;
    let persistenceSucceeded = false;
    try {
      persisted = this.#put(entry.session, status, errorCode);
      entry.session = persisted;
      persistenceSucceeded = true;
    } catch (error) {
      failure = poisonOnFailure ? this.#poison(error) : error;
    } finally {
      this.#cleanup(entry);
      if (this.active.get(runtimeAccountId) === entry) this.active.delete(runtimeAccountId);
      if (persistenceSucceeded || !poisonOnFailure) {
        try { this.runtimeAccountAdmission?.finishMutation(entry.mutation); } catch (error) {
          failure ||= poisonOnFailure ? this.#poison(error) : error;
        }
      }
    }
    if (failure) throw failure;
    return persisted;
  }

  #onHostEvent(runtimeAccountId, event) {
    if (event?.known !== true) return;
    if (event.type === "account_updated" && event.method === "account/updated") {
      this.#refreshAccount(runtimeAccountId);
      return;
    }
  }

  #onAccountAuthEvent(runtimeAccountId, event) {
    const entry = this.active.get(runtimeAccountId);
    if (!entry || event?.type !== "account_login"
      || event.method !== "account/login/completed"
      || typeof event.loginId !== "string"
      || (event.status !== "succeeded" && event.status !== "failed")) return;
    const completion = {
      loginId: event.loginId,
      status: event.status,
      errorCode: event.status === "failed" ? "ACCOUNT_LOGIN_FAILED" : null,
    };
    if (entry.loginId === null) {
      if (entry.earlyCompletions.size >= 32 && !entry.earlyCompletions.has(event.loginId)) {
        const oldest = entry.earlyCompletions.keys().next().value;
        entry.earlyCompletions.delete(oldest);
      }
      entry.earlyCompletions.set(event.loginId, completion);
      return;
    }
    try { this.#applyCompletion(runtimeAccountId, completion); } catch {}
  }

  #refreshAccount(runtimeAccountId) {
    const binding = this.bindings.get(runtimeAccountId);
    if (!binding || binding.refreshPromise) return;
    const generation = this.generation;
    binding.refreshPromise = Promise.resolve()
      .then(() => binding.host.accountRead({ refreshToken: false }))
      .then(stableAccountRead)
      .then((summary) => {
        if (!this.opened || this.generation !== generation
          || this.bindings.get(runtimeAccountId) !== binding) return;
        try { this.onEvent({ type: "auth.updated", runtimeAccountId, ...summary }); } catch {}
      })
      .catch(() => {})
      .finally(() => { binding.refreshPromise = null; });
  }

  #applyCompletion(runtimeAccountId, completion) {
    const entry = this.active.get(runtimeAccountId);
    if (!entry || entry.loginId !== completion.loginId || entry.session.status !== "waiting") return;
    if (completion.status === "failed") {
      this.#finish(runtimeAccountId, completion.status, completion.errorCode);
      return;
    }
    try {
      entry.session = this.#put(entry.session, completion.status, completion.errorCode);
    } catch (error) {
      this.#cleanup(entry);
      if (this.active.get(runtimeAccountId) === entry) this.active.delete(runtimeAccountId);
      this.#unbindHost(runtimeAccountId);
      throw this.#poison(error);
    }
    this.#cleanup(entry);
    if (this.active.get(runtimeAccountId) === entry) this.active.delete(runtimeAccountId);
    this.#unbindHost(runtimeAccountId);
    entry.completionPromise = this.#invalidateCommittedAccount({
      runtimeAccountId,
      binding: entry.binding,
      mutation: entry.mutation,
      reason: "login-succeeded",
    });
    entry.completionPromise.catch(() => {});
  }

  #invalidateCommittedAccount(input) {
    const invalidation = (async () => {
      try {
        await this.invalidateRuntimeAccount(Object.freeze({
          runtimeAccountId: input.runtimeAccountId,
          binding: input.binding,
          reason: input.reason,
        }));
        this.runtimeAccountAdmission?.finishMutation(input.mutation);
      } catch (error) {
        throw this.#poison(error);
      }
    })();
    this.pendingInvalidations.add(invalidation);
    const forget = () => { this.pendingInvalidations.delete(invalidation); };
    invalidation.then(forget, forget);
    return invalidation;
  }

  #onHostTerminated(runtimeAccountId) {
    this.#unbindHost(runtimeAccountId);
    this.#finish(runtimeAccountId, "interrupted", "HOST_TERMINATED");
  }

  #bindHost(runtimeAccountId, host, generation) {
    this.#assertGeneration(generation);
    const current = this.bindings.get(runtimeAccountId);
    if (current?.host === host) return current;
    if (current) this.#unbindHost(runtimeAccountId);
    if (typeof host.subscribeAccountAuth !== "function") {
      throw authError("AUTH_HOST_CONTRACT_INVALID", "Codex account host contract is invalid");
    }
    const binding = {
      host,
      refreshPromise: null,
      unsubscribe: null,
      unsubscribeAccountAuth: null,
    };
    binding.unsubscribe = host.subscribe((event) => this.#onHostEvent(runtimeAccountId, event));
    binding.unsubscribeAccountAuth = host.subscribeAccountAuth(
      (event) => this.#onAccountAuthEvent(runtimeAccountId, event),
    );
    this.bindings.set(runtimeAccountId, binding);
    const termination = host.terminated.then(
      () => {
        if (this.bindings.get(runtimeAccountId) === binding) this.#onHostTerminated(runtimeAccountId);
      },
      () => {
        if (this.bindings.get(runtimeAccountId) === binding) this.#onHostTerminated(runtimeAccountId);
      },
    );
    termination.catch(() => {});
    return binding;
  }

  #unbindHost(runtimeAccountId) {
    const binding = this.bindings.get(runtimeAccountId);
    if (!binding) return;
    this.bindings.delete(runtimeAccountId);
    try { binding.unsubscribe?.(); } catch {}
    try { binding.unsubscribeAccountAuth?.(); } catch {}
    binding.unsubscribe = null;
    binding.unsubscribeAccountAuth = null;
    binding.refreshPromise = null;
  }

  async #timeout(runtimeAccountId) {
    const entry = this.active.get(runtimeAccountId);
    if (!entry) return;
    if (entry.session.status === "starting") {
      await this.#convergeCancellation(
        runtimeAccountId,
        "timed_out",
        "LOGIN_START_TIMEOUT",
        false,
      );
      return;
    }
    if (entry.session.status !== "waiting" && entry.session.status !== "canceling") return;
    await this.#convergeCancellation(runtimeAccountId, "timed_out", "LOGIN_TIMEOUT", false);
  }

  #convergeCancellation(runtimeAccountId, targetStatus, errorCode, failOnCancelError) {
    const entry = this.active.get(runtimeAccountId);
    if (!entry) return Promise.resolve(this.stateStore.get(runtimeAccountId));
    if (entry.cancelPromise) return entry.cancelPromise;
    entry.session = this.#put(entry.session, "canceling", null);
    const hadLoginId = entry.loginId !== null;
    const cancellation = (async () => {
      let cancelFailed = false;
      let terminal = null;
      let primaryError = null;
      let cleanupError = null;
      try {
        if (hadLoginId) {
          try { await entry.host.accountLoginCancel({ loginId: entry.loginId }); } catch { cancelFailed = true; }
        }
        if (cancelFailed && failOnCancelError) {
          terminal = this.#finish(runtimeAccountId, "unknown", "CANCEL_STATUS_UNKNOWN")
            || this.stateStore.get(runtimeAccountId);
          if (terminal?.status !== "interrupted") {
            primaryError = authError("AUTH_CANCEL_FAILED", "Account login cancellation failed");
          }
        } else {
          terminal = this.#finish(runtimeAccountId, targetStatus, errorCode)
            || this.stateStore.get(runtimeAccountId);
        }
      } catch (error) {
        primaryError = error;
      } finally {
        this.#unbindHost(runtimeAccountId);
        try {
          await this.runtimeManager.stop(entry.binding);
        } catch {
          cleanupError = authError("AUTH_HOST_CLEANUP_FAILED", "Account login Host cleanup failed");
        }
      }

      if (primaryError && cleanupError) {
        const aggregate = new AggregateError(
          [primaryError, cleanupError],
          primaryError.message,
        );
        aggregate.code = primaryError.code || "AUTH_CANCEL_FAILED";
        throw aggregate;
      }
      if (primaryError) throw primaryError;
      if (cleanupError) {
        let errors = [cleanupError];
        let code = cleanupError.code;
        let message = cleanupError.message;
        if (failOnCancelError) {
          const cancelError = authError("AUTH_CANCEL_FAILED", "Account login cancellation failed");
          errors = [cancelError, cleanupError];
          code = cancelError.code;
          message = cancelError.message;
        }
        const aggregate = new AggregateError(errors, message);
        aggregate.code = code;
        throw aggregate;
      }
      return terminal;
    })();
    entry.cancelPromise = cancellation;
    return cancellation;
  }

  #resetTermination() {
    this.terminationSettled = false;
    this.terminated = new Promise((resolve, reject) => {
      this.resolveTermination = resolve;
      this.rejectTermination = reject;
    });
    this.terminated.catch(() => {});
  }

  #settleTermination(error) {
    if (this.terminationSettled) return;
    this.terminationSettled = true;
    if (error) this.rejectTermination(error);
    else this.resolveTermination();
  }

  #poison(_cause) {
    if (this.poisonError) return this.poisonError;
    this.poisonError = authError(
      "AUTH_STATE_COMMIT_UNCERTAIN",
      "Account auth state commit is uncertain; Service restart is required",
    );
    this.#settleTermination(this.poisonError);
    return this.poisonError;
  }
}

module.exports = {
  AccountAuthManager,
  stableAccountRead,
};
