"use strict";

const { serviceError } = require("./security");
const { validRuntime } = require("./runtime-adapter");

const RUNTIME_ACCOUNT_FIELDS = Object.freeze([
  "id",
  "runtime",
  "kind",
  "installationKind",
  "homeKind",
  "providerRef",
  "isDefault",
  "createdAt",
  "updatedAt",
]);
const RUNTIME_ACCOUNT_RUNTIMES = Object.freeze([
  "codex",
  "grok-build",
  "antigravity",
  "pi",
  "claude-code",
  "deepseek-harness",
]);
const RUNTIME_ACCOUNT_KINDS = Object.freeze(["native-user", "shoggoth-managed"]);
const RUNTIME_ACCOUNT_INSTALLATION_KINDS = Object.freeze(["system", "bundled"]);
const RUNTIME_ACCOUNT_HOME_KINDS = Object.freeze(["system-default", "managed-shared"]);

const SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID = "shoggoth-internal-codex-default-v1";
const NATIVE_CODEX_RUNTIME_ACCOUNT_ID = "native-codex-default-v1";
const NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID = "native-grok-build-default-v1";
const NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID = "native-antigravity-default-v1";
const NATIVE_PI_RUNTIME_ACCOUNT_ID = "native-pi-default-v1";
const NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID = "native-claude-code-default-v1";
const NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID = "native-deepseek-harness-default-v1";

const DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND = Object.freeze({
  shoggoth: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  codex: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  "grok-build": NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  antigravity: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
  pi: NATIVE_PI_RUNTIME_ACCOUNT_ID,
  "claude-code": NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
  "deepseek-harness": NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
});

function defaultAccount(id, runtime, kind, installationKind, homeKind) {
  return Object.freeze({
    id,
    runtime,
    kind,
    installationKind,
    homeKind,
    providerRef: null,
    isDefault: true,
    createdAt: null,
    updatedAt: null,
  });
}

const DEFAULT_RUNTIME_ACCOUNTS = Object.freeze([
  defaultAccount(
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    "codex",
    "shoggoth-managed",
    "bundled",
    "managed-shared",
  ),
  defaultAccount(
    NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    "codex",
    "native-user",
    "system",
    "system-default",
  ),
  defaultAccount(
    NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    "grok-build",
    "native-user",
    "system",
    "system-default",
  ),
  defaultAccount(
    NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    "antigravity",
    "native-user",
    "system",
    "system-default",
  ),
  defaultAccount(
    NATIVE_PI_RUNTIME_ACCOUNT_ID,
    "pi",
    "native-user",
    "system",
    "system-default",
  ),
  defaultAccount(
    NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    "claude-code",
    "native-user",
    "system",
    "system-default",
  ),
  defaultAccount(
    NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
    "deepseek-harness",
    "native-user",
    "system",
    "system-default",
  ),
]);

const RUNTIME_ACCOUNT_SCHEMA = Object.freeze({
  fields: RUNTIME_ACCOUNT_FIELDS,
  builtInRuntimes: RUNTIME_ACCOUNT_RUNTIMES,
  kinds: RUNTIME_ACCOUNT_KINDS,
  installationKinds: RUNTIME_ACCOUNT_INSTALLATION_KINDS,
  homeKinds: RUNTIME_ACCOUNT_HOME_KINDS,
});

const KIND_SET = new Set(RUNTIME_ACCOUNT_KINDS);
const INSTALLATION_KIND_SET = new Set(RUNTIME_ACCOUNT_INSTALLATION_KINDS);
const HOME_KIND_SET = new Set(RUNTIME_ACCOUNT_HOME_KINDS);
const DEFAULT_ACCOUNT_BY_ID = new Map(
  DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]),
);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function runtimeAccountError(code, message) {
  return serviceError(code, message);
}

function invalidRuntimeAccount(message) {
  return runtimeAccountError("RUNTIME_ACCOUNT_INVALID", message);
}

function exactRuntimeAccount(record) {
  let descriptors;
  let keys;
  try {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || Object.getPrototypeOf(record) !== Object.prototype) {
      throw invalidRuntimeAccount("RuntimeAccount must be a plain object");
    }
    keys = Reflect.ownKeys(record);
    descriptors = Object.getOwnPropertyDescriptors(record);
  } catch (error) {
    if (error?.code === "RUNTIME_ACCOUNT_INVALID") throw error;
    throw invalidRuntimeAccount("RuntimeAccount cannot be inspected safely");
  }
  if (keys.length !== RUNTIME_ACCOUNT_FIELDS.length
    || keys.some((key) => typeof key !== "string" || !RUNTIME_ACCOUNT_FIELDS.includes(key))) {
    throw invalidRuntimeAccount("RuntimeAccount fields are invalid");
  }
  for (const field of RUNTIME_ACCOUNT_FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw invalidRuntimeAccount(`RuntimeAccount.${field} must be an enumerable data property`);
    }
  }
  return Object.fromEntries(
    RUNTIME_ACCOUNT_FIELDS.map((field) => [field, descriptors[field].value]),
  );
}

function validOpaqueId(value) {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function validTimestamp(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function assertFixedDefaultIdentity(account) {
  const fixed = DEFAULT_ACCOUNT_BY_ID.get(account.id);
  if (account.isDefault && !fixed) {
    throw invalidRuntimeAccount("RuntimeAccount default id is not reserved");
  }
  if (!fixed) return;
  for (const field of [
    "runtime", "kind", "installationKind", "homeKind", "isDefault",
  ]) {
    if (account[field] !== fixed[field]) {
      throw invalidRuntimeAccount(`RuntimeAccount.${field} conflicts with its reserved identity`);
    }
  }
}

function validateLegacyRuntimeAccountShape(record) {
  const account = exactRuntimeAccount(record);
  if (!validOpaqueId(account.id)) {
    throw invalidRuntimeAccount("RuntimeAccount.id is invalid");
  }
  if (!validRuntime(account.runtime)) {
    throw invalidRuntimeAccount("RuntimeAccount.runtime is invalid");
  }
  if (!KIND_SET.has(account.kind)) {
    throw invalidRuntimeAccount("RuntimeAccount.kind is invalid");
  }
  if (!INSTALLATION_KIND_SET.has(account.installationKind)) {
    throw invalidRuntimeAccount("RuntimeAccount.installationKind is invalid");
  }
  if (!HOME_KIND_SET.has(account.homeKind)) {
    throw invalidRuntimeAccount("RuntimeAccount.homeKind is invalid");
  }
  if (account.providerRef !== null
    && (typeof account.providerRef !== "string"
      || !PROVIDER_REF_PATTERN.test(account.providerRef))) {
    throw invalidRuntimeAccount("RuntimeAccount.providerRef is invalid");
  }
  if (typeof account.isDefault !== "boolean") {
    throw invalidRuntimeAccount("RuntimeAccount.isDefault must be a boolean");
  }
  if (!validTimestamp(account.createdAt) || !validTimestamp(account.updatedAt)
    || (account.createdAt !== null && account.updatedAt !== null
      && account.updatedAt < account.createdAt)) {
    throw invalidRuntimeAccount("RuntimeAccount timestamps are invalid");
  }

  if (account.kind === "native-user") {
    if (account.installationKind !== "system" || account.homeKind !== "system-default"
      || account.providerRef !== null) {
      throw invalidRuntimeAccount("Native RuntimeAccount configuration is invalid");
    }
    const fixed = DEFAULT_ACCOUNT_BY_ID.get(account.id);
    if (!fixed || fixed.kind !== "native-user") {
      throw invalidRuntimeAccount("Native RuntimeAccount must use its reserved default identity");
    }
  } else if (account.installationKind !== "bundled" || account.homeKind !== "managed-shared"
    || (account.runtime !== "codex" && account.providerRef !== null)) {
    throw invalidRuntimeAccount("Managed RuntimeAccount configuration is invalid");
  }

  assertFixedDefaultIdentity(account);
  return account;
}

function validateRuntimeAccount(record) {
  const account = validateLegacyRuntimeAccountShape(record);
  if (account.providerRef !== null) {
    throw invalidRuntimeAccount("RuntimeAccount.providerRef is legacy-only and must be null");
  }
  return account;
}

function normalizeLegacyRuntimeAccount(record) {
  const account = validateLegacyRuntimeAccountShape(record);
  return validateRuntimeAccount({ ...account, providerRef: null });
}

function cloneRuntimeAccount(record) {
  return validateRuntimeAccount(record);
}

function freezeRuntimeAccount(record) {
  return Object.freeze(cloneRuntimeAccount(record));
}

function profileRuntime(profile) {
  let descriptor;
  try {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)
      || Object.getPrototypeOf(profile) !== Object.prototype) {
      throw runtimeAccountError("RUNTIME_ACCOUNT_PROFILE_INVALID", "AgentProfile must be a plain object");
    }
    descriptor = Object.getOwnPropertyDescriptor(profile, "runtime");
  } catch (error) {
    if (error?.code === "RUNTIME_ACCOUNT_PROFILE_INVALID") throw error;
    throw runtimeAccountError(
      "RUNTIME_ACCOUNT_PROFILE_INVALID",
      "AgentProfile cannot be inspected safely",
    );
  }
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")
    || !validRuntime(descriptor.value)) {
    throw runtimeAccountError("RUNTIME_ACCOUNT_PROFILE_INVALID", "AgentProfile.runtime is invalid");
  }
  return descriptor.value;
}

function runtimeAccountMatchesProfile(account, profile) {
  return validateRuntimeAccount(account).runtime === profileRuntime(profile);
}

function assertRuntimeAccountMatchesProfile(account, profile) {
  if (!runtimeAccountMatchesProfile(account, profile)) {
    throw runtimeAccountError(
      "RUNTIME_ACCOUNT_PROFILE_MISMATCH",
      "AgentProfile runtime does not match RuntimeAccount runtime",
    );
  }
  return true;
}

module.exports = {
  DEFAULT_RUNTIME_ACCOUNTS,
  DEFAULT_RUNTIME_ACCOUNT_ID_BY_BACKEND,
  NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
  NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  NATIVE_PI_RUNTIME_ACCOUNT_ID,
  RUNTIME_ACCOUNT_FIELDS,
  RUNTIME_ACCOUNT_HOME_KINDS,
  RUNTIME_ACCOUNT_INSTALLATION_KINDS,
  RUNTIME_ACCOUNT_KINDS,
  RUNTIME_ACCOUNT_RUNTIMES,
  RUNTIME_ACCOUNT_SCHEMA,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  assertRuntimeAccountMatchesProfile,
  cloneRuntimeAccount,
  freezeRuntimeAccount,
  normalizeLegacyRuntimeAccount,
  runtimeAccountMatchesProfile,
  validateRuntimeAccount,
};
