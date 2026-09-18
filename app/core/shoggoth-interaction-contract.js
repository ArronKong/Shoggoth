"use strict";

const MAX_FIELDS = 32;
const MAX_OPTIONS = 32;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
// Keep enough headroom for the federation event envelope. Run events and the
// Service event ring both cap an encoded item at 48 KiB, but the latter adds
// profile/session routing fields around this payload.
const MAX_RENDERABLE_APPROVAL_PAYLOAD_BYTES = 32 * 1024;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MCP_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MCP_PERMISSION_MESSAGE_PATTERN = /^Allow the ([A-Za-z0-9][A-Za-z0-9._-]{0,127}) MCP server to run tool "([A-Za-z0-9][A-Za-z0-9._-]{0,127})"\?$/u;

function interactionError(code = "INTERACTION_REQUEST_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function safeString(value, maxBytes = MAX_TEXT_BYTES, allowEmpty = false) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && (allowEmpty || value.length > 0) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function text(value, fallback = "", maxBytes = MAX_TEXT_BYTES) {
  return safeString(value, maxBytes, true) ? value : fallback;
}

function exactKeys(value, keys) {
  return ownDataObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseMcpToolPermission(payload) {
  if (!ownDataObject(payload)
    || payload.method !== "mcpServer/elicitation/request"
    || payload.kind !== "mcp_elicitation"
    || payload.mode !== "form"
    || !safeString(payload.serverName, 128)
    || !MCP_PART_PATTERN.test(payload.serverName)
    || !safeString(payload.message, 512)) return null;
  const schema = payload.requestedSchema;
  if (!ownDataObject(schema) || schema.type !== "object"
    || !ownDataObject(schema.properties) || Object.keys(schema.properties).length !== 0
    || Object.keys(schema).some((key) => ![
      "type", "properties", "required", "additionalProperties",
    ].includes(key))
    || (Object.hasOwn(schema, "required")
      && (!Array.isArray(schema.required) || schema.required.length !== 0))
    || (Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== false)) {
    return null;
  }
  const match = MCP_PERMISSION_MESSAGE_PATTERN.exec(payload.message);
  if (!match || match[1] !== payload.serverName || !MCP_PART_PATTERN.test(match[2])) return null;
  return deepFreeze({ serverName: match[1], toolName: match[2] });
}

function mcpElicitationUsesApprovalWait(payload) {
  if (parseMcpToolPermission(payload)) return true;
  if (!ownDataObject(payload) || payload.method !== "mcpServer/elicitation/request"
    || payload.kind !== "mcp_elicitation" || payload.mode !== "form") return false;
  try {
    return normalizeFields(payload.requestedSchema)
      .some((field) => field.id === "confirm_product_action");
  } catch {
    return false;
  }
}

function optionDescriptions(description, labels) {
  const lines = description.split("\n");
  if (lines.length !== labels.length + 1) return null;
  const values = [];
  for (let index = 0; index < labels.length; index += 1) {
    const prefix = `${labels[index]}: `;
    if (!lines[index + 1].startsWith(prefix)) return null;
    values.push(lines[index + 1].slice(prefix.length));
  }
  return { field: lines[0], options: values };
}

function normalizeFields(schema) {
  if (!ownDataObject(schema) || schema.type !== "object" || !ownDataObject(schema.properties)) {
    throw interactionError();
  }
  let schemaBytes;
  try { schemaBytes = Buffer.byteLength(JSON.stringify(schema), "utf8"); } catch { throw interactionError(); }
  if (schemaBytes > MAX_SCHEMA_BYTES) throw interactionError("INTERACTION_REQUEST_TOO_LARGE");
  const entries = Object.entries(schema.properties);
  if (entries.length === 0 || entries.length > MAX_FIELDS) throw interactionError();
  const requiredValues = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(requiredValues) || requiredValues.length > entries.length
    || requiredValues.some((value) => !safeString(value, 128))) throw interactionError();
  const required = new Set(requiredValues);
  if (required.size !== requiredValues.length
    || [...required].some((id) => !Object.prototype.hasOwnProperty.call(schema.properties, id))) {
    throw interactionError();
  }
  const ids = new Set();
  const fields = entries.map(([id, spec]) => {
    if (!safeString(id, 128) || !SAFE_ID_PATTERN.test(id) || ids.has(id) || !ownDataObject(spec)) {
      throw interactionError();
    }
    ids.add(id);
    const label = text(spec.title, id, 512);
    const rawDescription = text(spec.description, "", 2048);
    const secret = spec.writeOnly === true || spec.format === "password";
    if (Array.isArray(spec.enum)) {
      if (spec.type !== "string" || spec.enum.length < 2 || spec.enum.length > MAX_OPTIONS
        || spec.enum.some((value) => !safeString(value, 512))) throw interactionError();
      const values = [...spec.enum];
      if (new Set(values).size !== values.length) throw interactionError();
      const labels = spec.enumNames === undefined ? values : spec.enumNames;
      if (!Array.isArray(labels) || labels.length !== values.length
        || labels.some((value) => !safeString(value, 512)) || new Set(labels).size !== labels.length) {
        throw interactionError();
      }
      const described = optionDescriptions(rawDescription, labels);
      return {
        id,
        type: "choice",
        label,
        description: described?.field ?? rawDescription,
        required: required.has(id),
        secret,
        options: values.map((value, index) => ({
          value,
          label: labels[index],
          description: described?.options[index] ?? "",
        })),
      };
    }
    if (spec.type !== "string" || spec.enumNames !== undefined) throw interactionError();
    return {
      id,
      type: "text",
      label,
      description: rawDescription,
      required: required.has(id),
      secret,
      options: [],
    };
  });
  return fields;
}

const APPROVAL_DETAIL_KEYS = ["kind", "toolName", "serverName", "command", "cwd", "grantRoot", "input", "permissions"];

function validInteractiveApprovalChoice(choice) {
  return ["once", "session", "deny", "cancel"].includes(choice)
    || (typeof choice === "string" && /^runtime:(?:[0-9]|[12][0-9]|3[01])$/u.test(choice));
}

function validInteractiveApprovalOptions(options) {
  return Array.isArray(options) && options.length > 0 && options.length <= MAX_OPTIONS
    && new Set(options.map((option) => option?.choice)).size === options.length
    && options.every((option) => ownDataObject(option)
      && exactKeys(option, ["choice", "label", "kind", ...(Object.hasOwn(option, "scope") ? ["scope"] : [])])
      && validInteractiveApprovalChoice(option.choice) && !["session", "cancel"].includes(option.choice)
      && safeString(option.label, 4 * 1024)
      && ["allow_once", "allow_always", "reject_once", "reject_always"].includes(option.kind)
      && (option.choice !== "once" || option.kind === "allow_once")
      && (option.choice !== "deny" || option.kind === "reject_once")
      && (!Object.hasOwn(option, "scope") || (option.kind === "allow_always"
        && ["tool", "server", "session_files", "all_operations"].includes(option.scope))));
}

function interactiveApprovalCanAllow(request) {
  return Array.isArray(request.approvalChoices) && request.approvalChoices.some((choice) => ["once", "session"].includes(choice)
    || (Array.isArray(request.approvalOptions) && request.approvalOptions.some((option) =>
      option?.choice === choice && typeof option.kind === "string" && option.kind.startsWith("allow_"))));
}

function validInteractiveApprovalDetails(value) {
  return ownDataObject(value) && Object.keys(value).length > 0
    && Object.keys(value).every((key) => APPROVAL_DETAIL_KEYS.includes(key)
      && safeString(value[key], MAX_TEXT_BYTES))
    && (!value.kind || ["command", "file_change", "permissions"].includes(value.kind))
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_RENDERABLE_APPROVAL_PAYLOAD_BYTES;
}

function approvalDetails(payload) {
  const details = {};
  for (const key of ["kind", "toolName", "command", "cwd", "grantRoot"]) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") continue;
    if (key === "kind" && !["command", "file_change", "permissions"].includes(payload.kind)) continue;
    details[key] = payload[key];
  }
  for (const [key, source] of [["input", "toolInput"], ["permissions", "permissions"]]) {
    if (payload[source] !== undefined && payload[source] !== null) {
      details[key] = JSON.stringify(payload[source]);
    }
  }
  if (Object.keys(details).length === 0) return null;
  if (!validInteractiveApprovalDetails(details)) throw interactionError();
  return details;
}

function normalizeInteractiveRequestV1(input) {
  if (!ownDataObject(input) || !safeString(input.runId, 128)
    || !["approval", "prompt"].includes(input.eventType) || !ownDataObject(input.payload)) {
    throw interactionError();
  }
  const { payload } = input;
  if (!safeString(payload.requestId, 128) || !SAFE_ID_PATTERN.test(payload.requestId)) {
    throw interactionError();
  }
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null
    ? null : input.expiresAt;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) {
    throw interactionError();
  }
  if (input.eventType === "approval") {
    let details = null;
    let invalidDetails = false;
    try { details = approvalDetails(payload); } catch { invalidDetails = true; }
    let encodedPayloadBytes = Infinity;
    try {
      encodedPayloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {}
    const reasonPresent = Object.prototype.hasOwnProperty.call(payload, "reason");
    const messagePresent = Object.prototype.hasOwnProperty.call(payload, "message");
    const nativeOptions = Object.hasOwn(payload, "approvalOptions") ? payload.approvalOptions : undefined;
    const detailCannotBeRendered = payload.redacted === true || invalidDetails
      || (nativeOptions !== undefined && !validInteractiveApprovalOptions(nativeOptions))
      || encodedPayloadBytes > MAX_RENDERABLE_APPROVAL_PAYLOAD_BYTES
      || (reasonPresent && !safeString(payload.reason, MAX_MESSAGE_BYTES, true))
      || (!reasonPresent && messagePresent
        && !safeString(payload.message, MAX_MESSAGE_BYTES, true));
    if (detailCannotBeRendered) {
      return deepFreeze({
        version: 1,
        requestId: payload.requestId,
        runId: input.runId,
        kind: "runtime_approval",
        title: "审批详情不可用",
        message: "审批详情无法安全完整显示，只能拒绝或取消。请在 Agent 对话中重新发起任务。",
        fields: [],
        approvalChoices: ["deny", "cancel"],
        expiresAt,
      });
    }
    const message = text(payload.reason, text(payload.message, "需要用户授权", MAX_MESSAGE_BYTES), MAX_MESSAGE_BYTES);
    return deepFreeze({
      version: 1,
      requestId: payload.requestId,
      runId: input.runId,
      kind: "runtime_approval",
      title: "需要授权",
      message,
      fields: [],
      approvalChoices: nativeOptions ? [...new Set([...nativeOptions.map((option) => option.choice), "deny", "cancel"])]
        : payload.sessionApprovalAvailable === true
        ? ["once", "session", "deny", "cancel"]
        : ["once", "deny", "cancel"],
      ...(nativeOptions ? { approvalOptions: structuredClone(nativeOptions) } : {}),
      ...(details ? { approvalDetails: details } : {}),
      expiresAt,
    });
  }
  const permission = parseMcpToolPermission(payload);
  if (permission) {
    return deepFreeze({
      version: 1,
      requestId: payload.requestId,
      runId: input.runId,
      kind: "mcp_permission",
      title: "工具授权",
      message: `允许 ${permission.serverName} MCP 运行工具“${permission.toolName}”？`,
      fields: [],
      approvalChoices: ["once", "deny"],
      approvalDetails: { serverName: permission.serverName, toolName: permission.toolName },
      expiresAt,
    });
  }
  const fields = normalizeFields(payload.requestedSchema);
  return deepFreeze({
    version: 1,
    requestId: payload.requestId,
    runId: input.runId,
    kind: fields.some((field) => field.id === "confirm_product_action")
      ? "product_confirmation" : "user_input",
    title: fields.some((field) => field.id === "confirm_product_action")
      ? "确认产品操作" : "需要补充信息",
    message: text(payload.message, "请完成以下字段", MAX_MESSAGE_BYTES),
    fields,
    approvalChoices: [],
    expiresAt,
  });
}

function validateInteractiveResponseV1(request, response) {
  if (!ownDataObject(request) || request.version !== 1 || !Array.isArray(request.fields)
    || !ownDataObject(response)) throw interactionError("INTERACTION_RESPONSE_INVALID");
  if (request.fields.length === 0) {
    if (!exactKeys(response, ["choice"]) || !request.approvalChoices.includes(response.choice)) {
      throw interactionError("INTERACTION_RESPONSE_INVALID");
    }
    return deepFreeze({ choice: response.choice });
  }
  if (response.action === "cancel") {
    if (!exactKeys(response, ["action", "answers"]) || !ownDataObject(response.answers)
      || Object.keys(response.answers).length !== 0) throw interactionError("INTERACTION_RESPONSE_INVALID");
    return deepFreeze({ action: "cancel", answers: {} });
  }
  if (!exactKeys(response, ["action", "answers"]) || response.action !== "submit"
    || !ownDataObject(response.answers)) throw interactionError("INTERACTION_RESPONSE_INVALID");
  const fieldById = new Map(request.fields.map((field) => [field.id, field]));
  if (Object.keys(response.answers).some((id) => !fieldById.has(id))) {
    throw interactionError("INTERACTION_RESPONSE_INVALID");
  }
  const answers = {};
  for (const field of request.fields) {
    const hasValue = Object.prototype.hasOwnProperty.call(response.answers, field.id);
    if (!hasValue) {
      if (field.required) throw interactionError("INTERACTION_RESPONSE_INVALID");
      continue;
    }
    const value = response.answers[field.id];
    if (!safeString(value, MAX_TEXT_BYTES, !field.required)
      || (field.type === "choice" && !field.options.some((option) => option.value === value))) {
      throw interactionError("INTERACTION_RESPONSE_INVALID");
    }
    answers[field.id] = value;
  }
  return deepFreeze({ action: "submit", answers });
}

module.exports = {
  mcpElicitationUsesApprovalWait,
  normalizeInteractiveRequestV1,
  parseMcpToolPermission,
  validateInteractiveResponseV1,
  validInteractiveApprovalDetails,
  validInteractiveApprovalChoice,
  validInteractiveApprovalOptions,
  interactiveApprovalCanAllow,
};
