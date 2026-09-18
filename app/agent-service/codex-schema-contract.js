"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CODEX_VERSION = "0.149.0";
const SCHEMA_BUNDLES = Object.freeze({
  legacy: "json/codex_app_server_protocol.schemas.json",
  v2: "json/codex_app_server_protocol.v2.schemas.json",
});
const PINNED_BUNDLE_SHA256 = Object.freeze({
  [SCHEMA_BUNDLES.legacy]: "02a4c63a638fdae4a5f6c3ad32a41a377b642c66f3abc84f6fc47c7f3d6074df",
  [SCHEMA_BUNDLES.v2]: "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9",
});
const OPERATION_DEFINITIONS = Object.freeze({
  initialize: ["InitializeParams", "InitializeResponse"],
  threadStart: ["ThreadStartParams", "ThreadStartResponse"],
  threadResume: ["ThreadResumeParams", "ThreadResumeResponse"],
  threadRead: ["ThreadReadParams", "ThreadReadResponse"],
  threadList: ["ThreadListParams", "ThreadListResponse"],
  threadSetName: ["ThreadSetNameParams", "ThreadSetNameResponse"],
  threadArchive: ["ThreadArchiveParams", "ThreadArchiveResponse"],
  threadUnarchive: ["ThreadUnarchiveParams", "ThreadUnarchiveResponse"],
  threadDelete: ["ThreadDeleteParams", "ThreadDeleteResponse"],
  threadCompactStart: ["ThreadCompactStartParams", "ThreadCompactStartResponse"],
  threadGoalSet: ["ThreadGoalSetParams", "ThreadGoalSetResponse"],
  threadGoalGet: ["ThreadGoalGetParams", "ThreadGoalGetResponse"],
  threadGoalClear: ["ThreadGoalClearParams", "ThreadGoalClearResponse"],
  turnStart: ["TurnStartParams", "TurnStartResponse"],
  turnSteer: ["TurnSteerParams", "TurnSteerResponse"],
  turnInterrupt: ["TurnInterruptParams", "TurnInterruptResponse"],
  accountRead: ["GetAccountParams", "GetAccountResponse"],
  accountLoginStart: ["LoginAccountParams", "LoginAccountResponse"],
  accountLoginCancel: ["CancelLoginAccountParams", "CancelLoginAccountResponse"],
  accountLogout: [null, "LogoutAccountResponse", "account/logout"],
  modelList: ["ModelListParams", "ModelListResponse"],
  mcpServerStatusList: ["ListMcpServerStatusParams", "ListMcpServerStatusResponse"],
  skillsList: ["SkillsListParams", "SkillsListResponse"],
});
const constructedSchemaContracts = new WeakSet();
const validatedNotifications = new WeakSet();

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function decodePointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveLocalRef(root, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) return null;
  let cursor = root;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return null;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function matchesType(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return Number.isFinite(value);
  return typeof value === type;
}

function matchesNumericFormat(format, value) {
  if (format === "int32") {
    return Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
  }
  if (format === "int64") return Number.isSafeInteger(value);
  if (format === "uint" || format === "uint64") return Number.isSafeInteger(value) && value >= 0;
  if (format === "uint16") return Number.isSafeInteger(value) && value >= 0 && value <= 65_535;
  if (format === "uint32") return Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295;
  return true;
}

function validateSchemaValue(schema, value, root = schema, location = "$", state = null) {
  const context = state || { errors: [], refs: new Set(), limit: 16 };
  const fail = (keyword, at = location) => {
    if (context.errors.length < context.limit) context.errors.push(`${at}:${keyword}`);
  };
  if (schema === true || schema === undefined) return context.errors;
  if (schema === false || schema === null || typeof schema !== "object") {
    fail("falseSchema");
    return context.errors;
  }
  if (schema.$ref) {
    const target = resolveLocalRef(root, schema.$ref);
    if (!target) {
      fail("unresolvedRef");
      return context.errors;
    }
    const refKey = `${schema.$ref}@${location}`;
    if (context.refs.has(refKey)) return context.errors;
    context.refs.add(refKey);
    validateSchemaValue(target, value, root, location, context);
    context.refs.delete(refKey);
    return context.errors;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !deepEqual(schema.const, value)) fail("const");
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) fail("enum");
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      fail("type");
      return context.errors;
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validateSchemaValue(branch, value, root, location, context);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((branch) => validateSchemaValue(
      branch,
      value,
      root,
      location,
      { errors: [], refs: new Set(context.refs), limit: context.limit },
    ).length === 0);
    if (!matched) fail("anyOf");
  }
  if (Array.isArray(schema.oneOf)) {
    const count = schema.oneOf.filter((branch) => validateSchemaValue(
      branch,
      value,
      root,
      location,
      { errors: [], refs: new Set(context.refs), limit: context.limit },
    ).length === 0).length;
    if (count !== 1) fail("oneOf");
  }
  if (schema.not && validateSchemaValue(
    schema.not,
    value,
    root,
    location,
    { errors: [], refs: new Set(context.refs), limit: context.limit },
  ).length === 0) fail("not");
  if (schema.if) {
    const condition = validateSchemaValue(
      schema.if,
      value,
      root,
      location,
      { errors: [], refs: new Set(context.refs), limit: context.limit },
    ).length === 0;
    if (condition && schema.then) validateSchemaValue(schema.then, value, root, location, context);
    if (!condition && schema.else) validateSchemaValue(schema.else, value, root, location, context);
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) fail("minLength");
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) fail("maxLength");
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) fail("pattern");
      } catch {
        fail("invalidPattern");
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.format === "string" && !matchesNumericFormat(schema.format, value)) fail("format");
    if (typeof schema.minimum === "number" && value < schema.minimum) fail("minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) fail("maximum");
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) fail("exclusiveMinimum");
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) fail("exclusiveMaximum");
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0
      && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON) {
      fail("multipleOf");
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) fail("minItems");
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) fail("maxItems");
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) fail("uniqueItems");
    if (schema.items && !Array.isArray(schema.items)) {
      value.forEach((entry, index) => validateSchemaValue(schema.items, entry, root, `${location}[${index}]`, context));
    } else if (Array.isArray(schema.items)) {
      schema.items.forEach((itemSchema, index) => {
        if (index < value.length) validateSchemaValue(itemSchema, value[index], root, `${location}[${index}]`, context);
      });
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (Number.isInteger(schema.minProperties) && keys.length < schema.minProperties) fail("minProperties");
    if (Number.isInteger(schema.maxProperties) && keys.length > schema.maxProperties) fail("maxProperties");
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) fail("required", `${location}.${required}`);
    }
    const properties = schema.properties || {};
    const patternProperties = schema.patternProperties || {};
    for (const key of keys) {
      const childLocation = `${location}.${key}`;
      let covered = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        covered = true;
        validateSchemaValue(properties[key], value[key], root, childLocation, context);
      }
      for (const [pattern, propertySchema] of Object.entries(patternProperties)) {
        if (new RegExp(pattern, "u").test(key)) {
          covered = true;
          validateSchemaValue(propertySchema, value[key], root, childLocation, context);
        }
      }
      if (!covered && schema.additionalProperties === false) fail("additionalProperties", childLocation);
      else if (!covered && schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateSchemaValue(schema.additionalProperties, value[key], root, childLocation, context);
      }
    }
  }
  return context.errors;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function readVerifiedFile(target, expected, pinnedDigest = null) {
  let fd;
  let contents;
  let failure;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size) {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema file is unsafe");
    }
    contents = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(fd, contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== contents.length) {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema file could not be read completely");
    }
    const digest = sha256(contents);
    if (digest !== expected.sha256 || (pinnedDigest && digest !== pinnedDigest)) {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex generated schema integrity check failed");
    }
  } catch (error) {
    failure = error?.code === "CODEX_SCHEMA_TAMPERED"
      ? error
      : contractError("CODEX_SCHEMA_TAMPERED", "Codex schema file is unsafe");
  }
  if (fd !== undefined) {
    try { fs.closeSync(fd); } catch {
      failure ||= contractError("CODEX_SCHEMA_TAMPERED", "Codex schema file could not be closed safely");
    }
  }
  if (failure) throw failure;
  return contents;
}

function definitionName(reference) {
  if (typeof reference !== "string") return null;
  const segments = reference.split("/");
  return segments.at(-1) || null;
}

function methodOf(variant) {
  const values = variant?.properties?.method?.enum;
  return Array.isArray(values) && values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

class CodexSchemaContract {
  constructor(options = {}) {
    const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, "..", ".."));
    this.schemaRoot = path.resolve(
      options.schemaRoot || path.join(repoRoot, "schemas", "codex-app-server", CODEX_VERSION),
    );
    const expectedRoot = path.join(repoRoot, "schemas", "codex-app-server", CODEX_VERSION);
    if (!options.schemaRoot && this.schemaRoot !== path.resolve(expectedRoot)) {
      throw contractError("CODEX_SCHEMA_PATH_INVALID", "Codex schema path is invalid");
    }
    const rootStat = fs.lstatSync(this.schemaRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema directory is unsafe");
    }
    const manifestPath = path.join(this.schemaRoot, "schema-manifest.json");
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema manifest is unsafe");
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema manifest is malformed");
    }
    if (manifest.schemaVersion !== 1 || manifest.codexVersion !== CODEX_VERSION
      || manifest.includeExperimental !== false || !manifest.files || typeof manifest.files !== "object") {
      throw contractError("CODEX_SCHEMA_VERSION_MISMATCH", "Codex schema manifest version is incompatible");
    }
    const verifiedFiles = new Map();
    for (const [relative, expected] of Object.entries(manifest.files)) {
      if (!relative.startsWith("json/")) continue;
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema manifest contains an unsafe path");
      }
      verifiedFiles.set(relative, readVerifiedFile(
        path.join(this.schemaRoot, relative),
        expected,
        PINNED_BUNDLE_SHA256[relative] || null,
      ));
    }
    for (const bundle of Object.values(SCHEMA_BUNDLES)) {
      if (!manifest.files[bundle]) throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema bundle is missing");
    }
    try {
      this.legacySchema = JSON.parse(verifiedFiles.get(SCHEMA_BUNDLES.legacy).toString("utf8"));
      this.v2Schema = JSON.parse(verifiedFiles.get(SCHEMA_BUNDLES.v2).toString("utf8"));
    } catch {
      throw contractError("CODEX_SCHEMA_TAMPERED", "Codex schema bundle is malformed");
    }
    if (this.legacySchema.title !== "CodexAppServerProtocol"
      || this.v2Schema.title !== "CodexAppServerProtocolV2") {
      throw contractError("CODEX_SCHEMA_VERSION_MISMATCH", "Codex schema bundle title is incompatible");
    }
    this.version = CODEX_VERSION;
    this.operations = Object.freeze(this._buildOperations());
    this.notifications = Object.freeze(this._buildMessages(this.v2Schema, "ServerNotification"));
    this.serverRequests = Object.freeze(this._buildMessages(this.legacySchema, "ServerRequest"));
    constructedSchemaContracts.add(this);
  }

  _buildOperations() {
    const variants = this.v2Schema.definitions?.ClientRequest?.oneOf;
    if (!Array.isArray(variants)) throw contractError("CODEX_SCHEMA_TAMPERED", "Codex ClientRequest union is missing");
    const operations = {};
    for (const [name, [paramsDefinition, responseDefinition, explicitMethod]] of Object.entries(OPERATION_DEFINITIONS)) {
      const matches = variants.filter((variant) => explicitMethod
        ? methodOf(variant) === explicitMethod
        : definitionName(variant?.properties?.params?.$ref) === paramsDefinition);
      const responseRoot = this.v2Schema.definitions?.[responseDefinition]
        ? this.v2Schema
        : this.legacySchema.definitions?.[responseDefinition]
          ? this.legacySchema
          : null;
      if (matches.length !== 1 || !methodOf(matches[0]) || !responseRoot) {
        throw contractError("CODEX_SCHEMA_TAMPERED", "Codex core operation mapping is incomplete");
      }
      operations[name] = Object.freeze({
        method: methodOf(matches[0]),
        paramsDefinition,
        responseDefinition,
        responseRoot,
      });
    }
    return operations;
  }

  _buildMessages(root, definition) {
    const variants = root.definitions?.[definition]?.oneOf;
    if (!Array.isArray(variants)) throw contractError("CODEX_SCHEMA_TAMPERED", `Codex ${definition} union is missing`);
    const messages = {};
    for (const variant of variants) {
      const method = methodOf(variant);
      if (!method || messages[method]) throw contractError("CODEX_SCHEMA_TAMPERED", `Codex ${definition} mapping is invalid`);
      const paramsDefinition = definitionName(variant?.properties?.params?.$ref);
      const responseDefinition = definition === "ServerRequest" && paramsDefinition?.endsWith("Params")
        ? `${paramsDefinition.slice(0, -"Params".length)}Response`
        : null;
      if (definition === "ServerRequest" && !root.definitions?.[responseDefinition]) {
        throw contractError("CODEX_SCHEMA_TAMPERED", "Codex server response mapping is incomplete");
      }
      messages[method] = Object.freeze({
        schema: variant,
        paramsDefinition,
        responseDefinition,
        root,
      });
    }
    return messages;
  }

  _validate(schema, value, root, target) {
    if (validateSchemaValue(schema, value, root).length > 0) {
      const error = contractError("CODEX_SCHEMA_ERROR", "Codex protocol schema validation failed");
      error.schemaTarget = target;
      throw error;
    }
  }

  validateParams(operationName, params) {
    const operation = this.operations[operationName];
    if (!operation) throw contractError("CODEX_SCHEMA_OPERATION_UNKNOWN", "Codex operation is not registered");
    if (operation.paramsDefinition === null) {
      if (params !== undefined) {
        throw contractError("CODEX_SCHEMA_ERROR", "Codex protocol schema validation failed");
      }
      return params;
    }
    this._validate(
      this.v2Schema.definitions[operation.paramsDefinition],
      params,
      this.v2Schema,
      `${operationName}:params`,
    );
    return params;
  }

  validateResponse(operationName, response) {
    const operation = this.operations[operationName];
    if (!operation) throw contractError("CODEX_SCHEMA_OPERATION_UNKNOWN", "Codex operation is not registered");
    this._validate(
      operation.responseRoot.definitions[operation.responseDefinition],
      response,
      operation.responseRoot,
      `${operationName}:response`,
    );
    return response;
  }

  validateNotification(message) {
    const entry = this.notifications[message?.method];
    if (!entry) return { known: false, method: String(message?.method ?? "<invalid>").slice(0, 96) };
    this._validate(entry.schema, message, entry.root, `notification:${message.method}`);
    validatedNotifications.add(message);
    return { known: true, method: message.method };
  }

  validateServerRequest(message) {
    const entry = this.serverRequests[message?.method];
    if (!entry) return { known: false, method: String(message?.method ?? "<invalid>").slice(0, 96) };
    this._validate(entry.schema, message, entry.root, `serverRequest:${message.method}`);
    return { known: true, method: message.method };
  }

  validateServerResponse(method, response) {
    const entry = this.serverRequests[method];
    if (!entry) throw contractError("CODEX_SCHEMA_OPERATION_UNKNOWN", "Codex server request method is not registered");
    this._validate(
      entry.root.definitions[entry.responseDefinition],
      response,
      entry.root,
      `serverResponse:${method}`,
    );
    return response;
  }
}

// Schema 验证器是 RPC 信任边界；在类离开模块前锁定方法，避免已创建 mapper
// 通过公共 prototype 的前置或运行期替换绕过 pinned schema 校验。
Object.freeze(CodexSchemaContract.prototype);

function isCodexSchemaContract(value) {
  return constructedSchemaContracts.has(value);
}

function isValidatedCodexNotification(value, method) {
  return Boolean(value && (typeof value === "object" || typeof value === "function")
    && validatedNotifications.has(value) && value.method === method);
}

module.exports = {
  CODEX_VERSION,
  CodexSchemaContract,
  OPERATION_DEFINITIONS,
  PINNED_BUNDLE_SHA256,
  SCHEMA_BUNDLES,
  contractError,
  isCodexSchemaContract,
  isValidatedCodexNotification,
  validateSchemaValue,
};
