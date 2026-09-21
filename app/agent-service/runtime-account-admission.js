"use strict";

const { validRuntimeAccountId } = require("./runtime-adapter");
const { validateRuntimeAccount } = require("./runtime-account");
const { serviceError } = require("./security");

const DEFAULT_MAX_ACTIVE = require("./execution-policy").account;
const MAX_ACTIVE_LIMIT = 64;
const QUOTA_ERROR_CODES = new Set(["RUNTIME_QUOTA_EXHAUSTED", "RUNTIME_SPENDING_LIMIT_REACHED"]);

function admissionError(code, message) {
  return serviceError(code, message);
}

function validOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value.isWellFormed() && !value.includes("\0");
}

class RuntimeAccountAdmission {
  constructor(options = {}) {
    if (typeof options.runtimeAccountLookup !== "function") {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_DEPENDENCY_REQUIRED",
        "Runtime account admission requires an account lookup",
      );
    }
    if (options.resolveMaxActive !== undefined
      && typeof options.resolveMaxActive !== "function") {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_DEPENDENCY_REQUIRED",
        "Runtime account admission limit resolver is invalid",
      );
    }
    this.runtimeAccountLookup = options.runtimeAccountLookup;
    this.resolveMaxActive = options.resolveMaxActive || (() => DEFAULT_MAX_ACTIVE);
    this.now = options.now || Date.now;
    this.accounts = new Map();
  }

  admit(input) {
    const account = this.#account(input?.runtimeAccountId);
    if (!validOpaqueId(input?.runId)) {
      throw admissionError("RUNTIME_ACCOUNT_ADMISSION_INVALID", "Runtime account run id is invalid");
    }
    const state = this.#state(account.id);
    if (state.active.has(input.runId)) {
      return Object.freeze({
        disposition: "started",
        reason: null,
        generation: state.generation,
        retryAt: null,
      });
    }
    const current = this.#timestamp(this.now());
    if (state.mutation !== null) {
      return Object.freeze({
        disposition: "queued",
        reason: "RUNTIME_ACCOUNT_MUTATION_BUSY",
        generation: state.generation,
        retryAt: null,
      });
    }
    if (state.rateLimitErrorCode !== null
      && (state.rateLimitBackoffUntil === null || state.rateLimitBackoffUntil > current)) {
      return Object.freeze({
        disposition: "rejected",
        reason: state.rateLimitErrorCode,
        generation: state.generation,
        retryAt: state.rateLimitBackoffUntil,
      });
    }
    const backoffUntil = Math.max(state.backoffUntil, state.rateLimitBackoffUntil ?? 0);
    if (backoffUntil > current) {
      return Object.freeze({
        disposition: "queued",
        reason: "RUNTIME_ACCOUNT_BACKOFF",
        generation: state.generation,
        retryAt: backoffUntil,
      });
    }
    const limit = this.#limit(account);
    if (state.active.size >= limit) {
      return Object.freeze({
        disposition: "queued",
        reason: "RUNTIME_ACCOUNT_ACTIVE_LIMIT",
        generation: state.generation,
        retryAt: null,
      });
    }
    state.active.add(input.runId);
    return Object.freeze({
      disposition: "started",
      reason: null,
      generation: state.generation,
      retryAt: null,
    });
  }

  release(input) {
    const account = this.#account(input?.runtimeAccountId);
    if (!validOpaqueId(input?.runId)) {
      throw admissionError("RUNTIME_ACCOUNT_ADMISSION_INVALID", "Runtime account run id is invalid");
    }
    return this.#state(account.id).active.delete(input.runId);
  }

  beginMutation(input) {
    const account = this.#account(input?.runtimeAccountId);
    if (!validOpaqueId(input?.operationId)) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_INVALID",
        "Runtime account mutation id is invalid",
      );
    }
    const state = this.#state(account.id);
    if (state.active.size > 0) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ACTIVE",
        "Runtime account has active work and cannot be changed",
      );
    }
    if (state.mutation !== null && state.mutation !== input.operationId) {
      throw admissionError(
        "RUNTIME_ACCOUNT_MUTATION_BUSY",
        "Runtime account is already being changed",
      );
    }
    state.mutation = input.operationId;
    return Object.freeze({ runtimeAccountId: account.id, operationId: input.operationId });
  }

  finishMutation(input) {
    const account = this.#account(input?.runtimeAccountId);
    if (!validOpaqueId(input?.operationId)) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_INVALID",
        "Runtime account mutation id is invalid",
      );
    }
    const state = this.#state(account.id);
    if (state.mutation !== input.operationId) {
      throw admissionError(
        "RUNTIME_ACCOUNT_MUTATION_STALE",
        "Runtime account mutation is no longer current",
      );
    }
    state.mutation = null;
    state.generation += 1;
    state.backoffUntil = 0;
    state.rateLimitBackoffUntil = 0;
    state.rateLimitErrorCode = null;
    return state.generation;
  }

  cancelMutation(input) {
    const account = this.#account(input?.runtimeAccountId);
    if (!validOpaqueId(input?.operationId)) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_INVALID",
        "Runtime account mutation id is invalid",
      );
    }
    const state = this.#state(account.id);
    if (state.mutation === input.operationId) state.mutation = null;
  }

  noteBackoff(input) {
    const account = this.#account(input?.runtimeAccountId);
    const retryAt = this.#timestamp(input?.retryAt);
    const state = this.#state(account.id);
    state.backoffUntil = Math.max(state.backoffUntil, retryAt);
    return state.backoffUntil;
  }

  noteRateLimitBackoff(input) {
    this.assertGeneration(input);
    const errorCode = input?.errorCode ?? null;
    if (errorCode !== null && !QUOTA_ERROR_CODES.has(errorCode)) {
      throw admissionError("RUNTIME_ACCOUNT_ADMISSION_INVALID", "Runtime account quota error is invalid");
    }
    const retryAt = input?.retryAt === null && errorCode !== null
      ? null : this.#timestamp(input?.retryAt);
    const state = this.#state(input.runtimeAccountId);
    if (state.rateLimitErrorCode !== null && state.rateLimitBackoffUntil !== null
      && state.rateLimitBackoffUntil <= this.#timestamp(this.now())) {
      state.rateLimitErrorCode = null;
      state.rateLimitBackoffUntil = 0;
    }
    // Credit/quota recovery must not erase an independent transport Retry-After.
    if (retryAt === 0) {
      state.rateLimitBackoffUntil = 0;
      state.rateLimitErrorCode = null;
    } else if (errorCode !== null) {
      state.rateLimitErrorCode = errorCode;
      state.rateLimitBackoffUntil = retryAt;
    } else if (state.rateLimitErrorCode === null) {
      state.rateLimitBackoffUntil = Math.max(state.rateLimitBackoffUntil ?? 0, retryAt);
    }
    return state.rateLimitBackoffUntil;
  }

  assertGeneration(input) {
    const account = this.#account(input?.runtimeAccountId);
    if (!Number.isSafeInteger(input?.generation) || input.generation < 1
      || this.#state(account.id).generation !== input.generation) {
      throw admissionError(
        "RUNTIME_ACCOUNT_GENERATION_STALE",
        "Runtime account generation is stale",
      );
    }
    return true;
  }

  read(runtimeAccountId) {
    const account = this.#account(runtimeAccountId);
    const state = this.#state(account.id);
    const current = this.#timestamp(this.now());
    const backoffUntil = Math.max(state.backoffUntil, state.rateLimitBackoffUntil ?? 0);
    return Object.freeze({
      runtimeAccountId: account.id,
      generation: state.generation,
      active: state.active.size,
      maxActive: this.#limit(account),
      mutationActive: state.mutation !== null,
      backoffUntil: backoffUntil > current ? backoffUntil : null,
    });
  }

  #account(runtimeAccountId) {
    if (!validRuntimeAccountId(runtimeAccountId)) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_INVALID",
        "Runtime account id is invalid",
      );
    }
    let account;
    try { account = this.runtimeAccountLookup(runtimeAccountId); } catch {
      throw admissionError("RUNTIME_ACCOUNT_NOT_FOUND", "Runtime account does not exist");
    }
    if (!account) throw admissionError("RUNTIME_ACCOUNT_NOT_FOUND", "Runtime account does not exist");
    try { return validateRuntimeAccount(account); } catch {
      throw admissionError("RUNTIME_ACCOUNT_NOT_FOUND", "Runtime account does not exist");
    }
  }

  #state(runtimeAccountId) {
    let state = this.accounts.get(runtimeAccountId);
    if (!state) {
      state = { generation: 1, active: new Set(), mutation: null, backoffUntil: 0,
        rateLimitBackoffUntil: 0, rateLimitErrorCode: null };
      this.accounts.set(runtimeAccountId, state);
    }
    return state;
  }

  #limit(account) {
    const value = this.resolveMaxActive(account);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACTIVE_LIMIT) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_LIMIT_INVALID",
        "Runtime account active limit is invalid",
      );
    }
    return value;
  }

  #timestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw admissionError(
        "RUNTIME_ACCOUNT_ADMISSION_INVALID",
        "Runtime account timestamp is invalid",
      );
    }
    return value;
  }
}

module.exports = {
  DEFAULT_MAX_ACTIVE,
  MAX_ACTIVE_LIMIT,
  RuntimeAccountAdmission,
};
