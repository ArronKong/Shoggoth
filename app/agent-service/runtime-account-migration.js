"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { validRuntime } = require("./runtime-adapter");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  freezeRuntimeAccount,
} = require("./runtime-account");

const LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID = "f8a76c25-bd49-4c12-9d63-7b7d1eb1d0a4";
const NATIVE_BACKEND_RUNTIMES = Object.freeze({
  codex: "codex",
  "grok-build": "grok-build",
  antigravity: "antigravity",
  pi: "pi",
  "claude-code": "claude-code",
  "deepseek-harness": "deepseek-harness",
});
const DEFAULT_ACCOUNT_BY_ID = new Map(
  DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]),
);
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const RUNTIME_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function migrationError(code, message) {
  return serviceError(code, message);
}

function dataProperty(record, field) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, field);
  } catch {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_PROFILE_INVALID",
      "Legacy AgentProfile cannot be inspected safely",
    );
  }
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_PROFILE_INVALID",
      `Legacy AgentProfile.${field} is invalid`,
    );
  }
  return descriptor.value;
}

function legacyProfileIdentity(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)
    || Object.getPrototypeOf(profile) !== Object.prototype) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_PROFILE_INVALID",
      "Legacy AgentProfile must be a plain object",
    );
  }
  const identity = Object.fromEntries([
    "id", "backendId", "runtime", "runtimeProfileId", "providerRef", "isDefault",
  ].map((field) => [field, dataProperty(profile, field)]));
  // Legacy ProductStore accepted every non-empty string for Profile.id. The
  // derived RuntimeAccount ID is SHA-256 bounded, so migration must preserve
  // that older input domain rather than applying the new account-ID grammar.
  if (typeof identity.id !== "string" || identity.id.length === 0
    || typeof identity.backendId !== "string" || !BACKEND_ID_PATTERN.test(identity.backendId)
    || !validRuntime(identity.runtime)
    || typeof identity.runtimeProfileId !== "string"
    || !RUNTIME_PROFILE_ID_PATTERN.test(identity.runtimeProfileId)
    || (identity.providerRef !== null
      && (typeof identity.providerRef !== "string"
        || !PROVIDER_REF_PATTERN.test(identity.providerRef)))
    || typeof identity.isDefault !== "boolean") {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_PROFILE_INVALID",
      "Legacy AgentProfile identity is invalid",
    );
  }
  return identity;
}

function fixedAccount(accountId) {
  const template = DEFAULT_ACCOUNT_BY_ID.get(accountId);
  if (!template) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_DEFAULT_MISSING",
      `Default RuntimeAccount is missing: ${accountId}`,
    );
  }
  return freezeRuntimeAccount(template);
}

function result(account) {
  return Object.freeze({ account, runtimeAccountId: account.id });
}

function legacyManagedAccountId(profileId, runtime) {
  const digest = crypto.createHash("sha256")
    .update("shoggoth-runtime-account-legacy-profile-v1\0", "utf8")
    // JSON's escaped representation preserves lone UTF-16 surrogates that
    // Buffer's UTF-8 encoder would otherwise collapse to the same U+FFFD.
    .update(JSON.stringify([profileId, runtime]), "utf8")
    .digest("hex");
  return `legacy-managed-${digest}-v1`;
}

function runtimeAccountForLegacyProfile(profile) {
  const identity = legacyProfileIdentity(profile);
  if (identity.id === LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID) {
    if (identity.backendId !== "shoggoth" || identity.runtime !== "codex"
      || identity.isDefault !== true) {
      throw migrationError(
        "RUNTIME_ACCOUNT_MIGRATION_DEFAULT_PROFILE_CONFLICT",
        "Reserved Shoggoth AgentProfile identity is inconsistent",
      );
    }
    return result(fixedAccount(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID));
  }
  if (identity.isDefault) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_DEFAULT_PROFILE_CONFLICT",
      "Only the reserved Shoggoth AgentProfile may be default",
    );
  }

  const nativeRuntime = NATIVE_BACKEND_RUNTIMES[identity.backendId];
  if (nativeRuntime && identity.runtime !== nativeRuntime) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_BACKEND_RUNTIME_MISMATCH",
      "Legacy AgentProfile backend and runtime are inconsistent",
    );
  }
  if (nativeRuntime) {
    return result(fixedAccount(DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND[identity.backendId]));
  }
  if (identity.runtime === "codex") {
    return result(fixedAccount(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID));
  }
  if (identity.providerRef !== null) {
    throw migrationError(
      "RUNTIME_ACCOUNT_MIGRATION_PROVIDER_UNSUPPORTED",
      "A non-Codex legacy AgentProfile cannot preserve providerRef",
    );
  }
  const account = freezeRuntimeAccount({
    id: legacyManagedAccountId(identity.id, identity.runtime),
    runtime: identity.runtime,
    kind: "shoggoth-managed",
    installationKind: "bundled",
    homeKind: "managed-shared",
    providerRef: null,
    isDefault: false,
    createdAt: null,
    updatedAt: null,
  });
  return result(account);
}

module.exports = {
  LEGACY_DEFAULT_SHOGGOTH_PROFILE_ID,
  NATIVE_BACKEND_RUNTIMES,
  legacyManagedAccountId,
  runtimeAccountForLegacyProfile,
};
