"use strict";

const ADVANCED_SESSION_METHOD_NAMES = Object.freeze([
  "environments.list",
  "sessions.describe",
  "sessions.branches.list",
  "sessions.fork",
]);

const FORK_ATTACHMENT_MAX_COUNT = 10;
const FORK_ATTACHMENT_MAX_BASE64_BYTES = 8 * 1024 * 1024;
const FORK_ATTACHMENTS_MAX_BASE64_BYTES = 64 * 1024 * 1024;

function advancedSessionMethodMap(methods = {}) {
  return Object.fromEntries(
    ADVANCED_SESSION_METHOD_NAMES.map((name) => [name, methods[name] === true]),
  );
}

function unsupportedAdvancedSessionResult(reason = "unsupported", methods) {
  return {
    supported: false,
    reason,
    methods: advancedSessionMethodMap(methods),
  };
}

function safeString(value, maxLength = 4096) {
  return typeof value === "string" && value.length <= maxLength && !value.includes("\0")
    ? value
    : undefined;
}

function safeId(value) {
  const text = safeString(value, 1024);
  return text && text.trim() && !/[\r\n]/.test(text) ? text : undefined;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeStringList(value, { maxItems = 256, maxLength = 256 } = {}) {
  if (!Array.isArray(value)) return undefined;
  const output = [];
  const seen = new Set();
  for (const item of value) {
    const text = safeString(item, maxLength);
    if (!text || !text.trim() || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output.length ? output : undefined;
}

function projectWorkerSlots(value) {
  const total = safePositiveInteger(value?.total);
  const available = safeNonNegativeInteger(value?.available);
  return total !== undefined && available !== undefined && available <= total
    ? { total, available }
    : undefined;
}

function projectWorkerBundle(value) {
  if (value?.status === "missing") return { status: "missing" };
  const version = safeString(value?.version, 128);
  return value?.status === "installed" && version
    ? { status: "installed", version }
    : undefined;
}

function projectEnvironmentIssues(value) {
  if (!Array.isArray(value)) return undefined;
  const issues = value.slice(0, 32).flatMap((item) => {
    const code = safeString(item?.code, 128);
    const action = safeString(item?.action, 128);
    return code && action ? [{ code, action }] : [];
  });
  return issues.length ? issues : undefined;
}

function projectEnvironmentWorker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const providerId = safeId(value.providerId);
  const state = safeString(value.state, 128);
  if (!providerId || !state) return undefined;
  const ageMs = safeNonNegativeInteger(value.ageMs);
  const idleMs = safeNonNegativeInteger(value.idleMs);
  const tunnelStatus = safeString(value.tunnelStatus, 128);
  const desktopApps = safeStringList(value.desktopApps, { maxItems: 8, maxLength: 128 });
  const attachedSessionCount = Array.isArray(value.attachedSessionIds)
    ? value.attachedSessionIds.length
    : safeNonNegativeInteger(value.attachedSessionCount);
  return {
    providerId,
    state,
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
    ...(tunnelStatus ? { tunnelStatus } : {}),
    ...(typeof value.desktop === "boolean" ? { desktop: value.desktop } : {}),
    ...(desktopApps ? { desktopApps } : {}),
    ...(attachedSessionCount !== undefined ? { attachedSessionCount } : {}),
  };
}

function projectEnvironmentSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeId(value.id);
  const type = safeString(value.type, 128);
  const status = safeString(value.status, 128);
  if (!id || !type || !status) return null;
  const label = safeString(value.label, 512);
  const platform = safeString(value.platform, 128);
  const trust = safeString(value.trust, 128);
  const workerSlots = projectWorkerSlots(value.workerSlots);
  const workerBundle = projectWorkerBundle(value.workerBundle);
  const issues = projectEnvironmentIssues(value.issues);
  const worker = projectEnvironmentWorker(value.worker);
  const lastConnectedAtMs = safeNonNegativeInteger(value.lastConnectedAtMs);
  const lastDisconnectedAtMs = safeNonNegativeInteger(value.lastDisconnectedAtMs);
  const lastSeenAtMs = safeNonNegativeInteger(value.lastSeenAtMs);
  return {
    id,
    type,
    status,
    ...(label ? { label } : {}),
    ...(platform ? { platform } : {}),
    ...(typeof value.sessionHost === "boolean" ? { sessionHost: value.sessionHost } : {}),
    ...(trust ? { trust } : {}),
    ...(typeof value.desktop === "boolean" ? { desktop: value.desktop } : {}),
    ...(workerSlots ? { workerSlots } : {}),
    ...(workerBundle ? { workerBundle } : {}),
    ...(lastConnectedAtMs !== undefined ? { lastConnectedAtMs } : {}),
    ...(lastDisconnectedAtMs !== undefined ? { lastDisconnectedAtMs } : {}),
    ...(lastSeenAtMs !== undefined ? { lastSeenAtMs } : {}),
    ...(issues ? { issues } : {}),
    ...(worker ? { worker } : {}),
  };
}

function projectEnvironmentMachine(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeId(value.id);
  const label = safeString(value.label, 128);
  if (!id || !label) return null;
  const cpu = safePositiveInteger(value.cpu);
  const memoryGb = safePositiveInteger(value.memoryGb);
  return {
    id,
    label,
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memoryGb !== undefined ? { memoryGb } : {}),
    ...(typeof value.default === "boolean" ? { default: value.default } : {}),
  };
}

function projectEnvironmentProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeId(value.id);
  const providerId = safeId(value.providerId);
  if (!id || !providerId) return null;
  const trust = safeString(value.trust, 128);
  const executionMode = safeString(value.executionMode, 128);
  const executionModes = safeStringList(value.executionModes, { maxItems: 8, maxLength: 128 });
  const machines = Array.isArray(value.machines)
    ? value.machines.slice(0, 32).map(projectEnvironmentMachine).filter(Boolean)
    : undefined;
  return {
    id,
    providerId,
    ...(trust ? { trust } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(executionModes ? { executionModes } : {}),
    ...(machines?.length ? { machines } : {}),
  };
}

function projectEnvironmentInventory(value, methods) {
  const source = value && typeof value === "object" ? value : {};
  return {
    supported: true,
    methods: advancedSessionMethodMap(methods),
    environments: (Array.isArray(source.environments) ? source.environments : [])
      .map(projectEnvironmentSummary)
      .filter(Boolean),
    profiles: (Array.isArray(source.profiles) ? source.profiles : [])
      .map(projectEnvironmentProfile)
      .filter(Boolean),
  };
}

function projectForkSource(value) {
  const sessionKey = safeId(value?.sessionKey);
  const entryId = safeId(value?.entryId);
  return sessionKey && entryId ? { sessionKey, entryId } : undefined;
}

function projectPlacement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = {};
  for (const field of ["state", "environmentId", "providerId", "profileId", "terminalReason"]) {
    const text = safeString(value[field], field === "terminalReason" ? 1024 : 256);
    if (text) output[field] = text;
  }
  for (const field of ["generation", "createdAtMs", "updatedAtMs", "stateChangedAtMs", "terminalAtMs"]) {
    const number = safeNonNegativeInteger(value[field]);
    if (number !== undefined) output[field] = number;
  }
  return Object.keys(output).length ? output : undefined;
}

function projectSessionDescription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = safeId(value.key);
  const agentId = safeId(value.agentId);
  if (!key || !agentId) return null;
  const output = { key, agentId };
  for (const field of [
    "kind", "label", "displayName", "derivedTitle", "lastMessagePreview", "status",
    "model", "modelProvider", "activeLeafEntryId", "parentSessionKey",
  ]) {
    const text = safeString(value[field], field === "lastMessagePreview" ? 4096 : 1024);
    if (text) output[field] = text;
  }
  for (const field of ["createdAt", "updatedAt"]) {
    const number = safeNonNegativeInteger(value[field]);
    if (number !== undefined) output[field] = number;
  }
  if (typeof value.archived === "boolean") output.archived = value.archived;
  const forkSource = projectForkSource(value.forkSource);
  if (forkSource) output.forkSource = forkSource;
  const placement = projectPlacement(value.placement);
  if (placement) output.placement = placement;
  return output;
}

function projectSessionDescribeResult(value, methods) {
  return {
    supported: true,
    methods: advancedSessionMethodMap(methods),
    session: projectSessionDescription(value?.session),
  };
}

function projectSessionBranch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const leafEntryId = safeId(value.leafEntryId);
  const headline = safeString(value.headline, 512);
  const messageCount = safeNonNegativeInteger(value.messageCount);
  if (!leafEntryId || headline === undefined || messageCount === undefined || typeof value.active !== "boolean") {
    return null;
  }
  const updatedAt = safeString(value.updatedAt, 128);
  return {
    leafEntryId,
    headline,
    messageCount,
    ...(updatedAt ? { updatedAt } : {}),
    active: value.active,
  };
}

function projectSessionBranchesResult(value, methods) {
  return {
    supported: true,
    methods: advancedSessionMethodMap(methods),
    branches: (Array.isArray(value?.branches) ? value.branches : [])
      .map(projectSessionBranch)
      .filter(Boolean),
  };
}

function isCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bodyLength = value.length - padding;
  const sextet = (code) => {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (code === 43) return 62;
    if (code === 47) return 63;
    return -1;
  };
  for (let index = 0; index < bodyLength; index += 1) {
    if (sextet(value.charCodeAt(index)) < 0) return false;
  }
  for (let index = bodyLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  if (padding === 2 && (sextet(value.charCodeAt(bodyLength - 1)) & 0x0f) !== 0) return false;
  if (padding === 1 && (sextet(value.charCodeAt(bodyLength - 1)) & 0x03) !== 0) return false;
  return true;
}

function projectForkAttachments(value) {
  if (!Array.isArray(value)) return { attachments: undefined, omitted: false };
  const attachments = [];
  let total = 0;
  let omitted = value.length > FORK_ATTACHMENT_MAX_COUNT;
  for (const item of value.slice(0, FORK_ATTACHMENT_MAX_COUNT)) {
    const mimeType = safeString(item?.mimeType, 255);
    const data = item?.data;
    if (
      !mimeType
      || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)
      || !isCanonicalBase64(data)
      || data.length > FORK_ATTACHMENT_MAX_BASE64_BYTES
      || total + data.length > FORK_ATTACHMENTS_MAX_BASE64_BYTES
    ) {
      omitted = true;
      continue;
    }
    total += data.length;
    attachments.push({ mimeType, data });
  }
  return { attachments: attachments.length ? attachments : undefined, omitted };
}

function projectSessionForkResult(value, methods) {
  const sessionKey = safeId(value?.sessionKey);
  if (!sessionKey) return unsupportedAdvancedSessionResult("invalid-response", methods);
  const editorText = safeString(value?.editorText, 1024 * 1024);
  const { attachments, omitted } = projectForkAttachments(value?.editorAttachments);
  return {
    supported: true,
    methods: advancedSessionMethodMap(methods),
    sessionKey,
    ...(editorText !== undefined ? { editorText } : {}),
    ...(attachments ? { editorAttachments: attachments } : {}),
    ...(omitted || value?.attachmentsOmitted === true ? { attachmentsOmitted: true } : {}),
  };
}

module.exports = {
  ADVANCED_SESSION_METHOD_NAMES,
  FORK_ATTACHMENT_MAX_COUNT,
  FORK_ATTACHMENT_MAX_BASE64_BYTES,
  FORK_ATTACHMENTS_MAX_BASE64_BYTES,
  advancedSessionMethodMap,
  unsupportedAdvancedSessionResult,
  projectEnvironmentInventory,
  projectSessionDescribeResult,
  projectSessionBranchesResult,
  projectSessionForkResult,
};
