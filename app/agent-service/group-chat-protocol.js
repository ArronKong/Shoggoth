"use strict";

const { validOffset, validDigest } = require("../group-result-content");
const { serviceError } = require("./security");
const { validAttachments } = require("./inspiration-media");
const { validModelSelection, validModelCatalog } = require("../group-member-model");

const MAX_GROUP_MEMBERS = 32;
const MIN_GROUP_MEMBERS_ON_CREATE = 2;
const MAX_GROUP_NAME_CHARS = 64;
const MAX_GROUP_PURPOSE_CHARS = 1000;
const MAX_USER_MESSAGE_BYTES = 32 * 1024;
const MAX_HISTORY_LIMIT = 200;

const METHODS = Object.freeze({
  "group.list": ["includeArchived"],
  "group.artifacts.list": ["sinceMs", "limit", "backendIds"],
  "group.remote.tool": ["callId", "fingerprint", "execution", "name", "arguments", "identity"],
  "group.get": ["groupId"],
  "group.hosts.list": [],
  "group.host.test": ["peer"],
  "group.response.read": ["cursor", "method", "groupId", "offset", "digest"],
  "group.create": ["operationId", "name", "purpose", "members"],
  "group.update": ["groupId", "expectedMetadataRevision", "patch"],
  "group.delete": ["groupId", "expectedMetadataRevision"],
  "group.members.add": ["groupId", "expectedRosterRevision", "member"],
  "group.members.remove": ["groupId", "expectedRosterRevision", "memberId"],
  "group.members.stop": ["groupId", "memberId"],
  "group.member.models": ["groupId", "memberId"],
  "group.members.model": ["groupId", "expectedRosterRevision", "memberId", "modelSelection"],
  "group.member.role": ["groupId", "memberId"],
  "group.member.role.history": ["groupId", "memberId", "before", "limit"],
  "group.send": ["groupId", "clientMessageId", "body", "mentions", "replyTo", "attachments"],
  "group.send.lookup": ["groupId", "clientMessageId"],
  "group.message.read": ["groupId", "seq", "offset", "digest"],
  "group.execution.reconcile": ["groupId", "target"],
  "group.execution.receipt": ["groupId", "ownerId", "hostId", "execution"],
  "group.history": ["groupId", "afterSeq", "beforeSeq", "limit"],
  "group.search": ["groupId", "query", "discussionId", "authorKind", "memberId", "cursor", "limit"],
  "group.discussion.stop": ["groupId"],
  "group.turn.retry": ["groupId", "memberId", "operationId"],
  "group.interaction.respond": ["groupId", "target", "requestId", "response", "operationId"],
  "group.diagnostics": [],
});
const GROUP_CHAT_SERVICE_METHODS = Object.freeze(Object.keys(METHODS));

const PUBLIC_MESSAGES = Object.freeze({
  GROUP_HOST_REMOTE_DISABLED: "远程群宿主暂未启用",
  GROUP_HOST_CONFIG_INVALID: "群宿主连接参数无效",
  GROUP_HOST_IDENTITY_MISMATCH: "群宿主身份不匹配，请核对设备与成员",
  GROUP_HOST_AUTH_FAILED: "群宿主认证失败",
  GROUP_HOST_UNAVAILABLE: "群宿主当前不可用",
  GROUP_HOST_OWNER_CHANGED: "这台设备已失去群宿主的写入租约",
  GROUP_HOST_LEASE_EXPIRED: "群宿主租约已过期，正在核对原运行",
  GROUP_HOST_GROUP_STOPPED: "这个群已停止，不能启动新执行",
  GROUP_HOST_PREPARATION_PENDING: "原会话准备结果待核对，尚未重复启动",
  GROUP_CHAT_INVALID: "群聊参数无效",
  GROUP_CHAT_UNAVAILABLE: "群聊服务暂不可用",
  GROUP_CHAT_NOT_FOUND: "群聊不存在",
  GROUP_CHAT_ARCHIVED: "群聊已归档",
  GROUP_CHAT_DELETED: "群聊已删除或正在停止执行，不能再进行新动作",
  GROUP_CHAT_REVISION_CONFLICT: "群聊已被更新，请刷新后重试",
  GROUP_CHAT_OPERATION_CONFLICT: "同一次操作的内容发生了变化",
  GROUP_CHAT_MESSAGE_CONFLICT: "这条消息的重传内容与原消息不一致",
  GROUP_CHAT_POLICY_CONFLICT: "群设置已变化，请核对原输入后重新发送",
  GROUP_CHAT_POLICY_CHANGED: "群设置已变化或尚未确认，请刷新并核对原输入后重新发送",
  GROUP_CHAT_OWNER_CHANGED: "群聊所属实例已变化，请核对原发送记录",
  GROUP_CHAT_MEMBER_LIMIT: `群成员需要 ${MIN_GROUP_MEMBERS_ON_CREATE}–${MAX_GROUP_MEMBERS} 位`,
  GROUP_CHAT_MEMBER_DUPLICATE: "这个 Agent 已经在群里",
  GROUP_CHAT_MEMBER_NOT_FOUND: "群成员不存在或已移除",
  GROUP_CHAT_MEMBER_UNSUPPORTED: "这个后端的 Agent 暂不支持入群",
  GROUP_CHAT_DISABLED: "多 Agent 群聊已在设置中关闭",
  GROUP_CHAT_PROFILE_UNAVAILABLE: "Agent 不存在或未启用",
  GROUP_CHAT_MODEL_UNAVAILABLE: "所选模型当前不可用，请在成员设置中重新选择或跟随 Agent 默认模型",
  GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE: "暂时无法读取该成员的模型目录，请重试",
  GROUP_CHAT_NOTHING_TO_RETRY: "这位成员现在没有可以重试的回合",
  GROUP_CHAT_QUEUE_LIMIT: "待答请求已达上限，请等待或停止已有请求后再发送",
  GROUP_CHAT_REQUEST_NOT_FOUND: "关联的讨论不存在或不属于这个群",
  GROUP_RESULT_MISMATCH: "完整结果或分页位置不匹配，请重新读取",
  GROUP_RESULT_INVALID: "结果内容无效",
  GROUP_CHAT_RESPONSE_EXPIRED: "群聊快照已过期，请重新读取最新状态",
  GROUP_CHAT_RESPONSE_TOO_LARGE: "群聊内容过多，暂时无法读取完整状态",
  GROUP_CHAT_REPLY_NOT_FOUND: "被引用的消息不存在",
  GROUP_CHAT_ATTACHMENT_INVALID: "附件无效，或者还没有上传完成",
  GROUP_CHAT_INTERACTION_EXPIRED: "这个请求已经失效，请查看最新状态",
  GROUP_CHAT_INTERACTION_INVALID: "回应内容不符合这个请求",
  GROUP_TASK_NOT_FOUND: "任务不存在",
  GROUP_CHAT_STORE_CORRUPT: "群聊数据需要恢复核对",
});

function groupChatError(code) {
  return serviceError(code, PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.GROUP_CHAT_UNAVAILABLE);
}

function fail(code = "GROUP_CHAT_INVALID") {
  throw groupChatError(code);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, fields) {
  return plainObject(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function text(value, maxChars, { allowEmpty = false } = {}) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && (allowEmpty || value.trim().length > 0) && [...value].length <= maxChars;
}

function opaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function revision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function seq(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function agentRef(value) {
  return exact(value, ["backendId", "agentId", ...(Object.hasOwn(value ?? {}, "peerId") ? ["peerId"] : [])])
    && opaqueId(value.backendId) && opaqueId(value.agentId) && (value.peerId === undefined
      || ["hermes", "openclaw"].includes(value.backendId) && opaqueId(value.peerId));
}

function executionTarget(target) {
  return exact(target, ["kind", "opportunityId"]) && target.kind === "turn" && opaqueId(target.opportunityId);
}

function validateParams(method, params) {
  const optional = method === "group.member.role" ? ["revision", "cursor"]
    : method === "group.send" ? ["taskId", "requestMode", "discussionId", "summaryMemberId", "ownerScope", "expectedPolicyVersion"]
      : method === "group.send.lookup" ? ["payloadDigest", "ownerScope"] : [];
  const fields = METHODS[method] && [...METHODS[method], ...optional.filter(key => plainObject(params) && Object.hasOwn(params, key))];
  if (!fields || !exact(params, fields)) fail();
  const valid = {
    "group.remote.tool": () => require("../group-runtime-host-protocol").validToolCall({ callId: params.callId, fingerprint: params.fingerprint,
      execution: params.execution, name: params.name, arguments: params.arguments }) && plainObject(params.identity)
      && exact(params.identity, ["backendId", "agentId", "execution", "hostId", "peerId", "ownerId", "epoch"])
      && params.identity.backendId === params.execution.backendId && params.identity.agentId === params.execution.agentId
      && opaqueId(params.identity.peerId) && opaqueId(params.identity.hostId) && opaqueId(params.identity.ownerId) && revision(params.identity.epoch)
      && JSON.stringify(params.identity.execution) === JSON.stringify(params.execution),
    "group.list": () => typeof params.includeArchived === "boolean",
    "group.artifacts.list": () => Number.isSafeInteger(params.sinceMs) && params.sinceMs >= 0
      && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 100
      && Array.isArray(params.backendIds) && params.backendIds.length <= 32 && params.backendIds.every(opaqueId)
      && new Set(params.backendIds).size === params.backendIds.length,
    "group.hosts.list": () => true,
    "group.host.test": () => require("../group-runtime-host-protocol").validPeer(params.peer),
    "group.get": () => opaqueId(params.groupId),
    "group.execution.receipt": () => require("../external-inspiration-protocol").validateGroupExecutionReceiptParams(params),
    "group.response.read": () => typeof params.cursor === "string" && /^[a-f0-9]{48}$/u.test(params.cursor)
      && Object.hasOwn(METHODS, params.method) && params.method !== "group.response.read"
      && (params.groupId === null || opaqueId(params.groupId)) && validOffset(params.offset) && validDigest(params.digest),
    "group.create": () => opaqueId(params.operationId)
      && text(params.name, MAX_GROUP_NAME_CHARS)
      && text(params.purpose, MAX_GROUP_PURPOSE_CHARS, { allowEmpty: true })
      && Array.isArray(params.members) && params.members.length <= MAX_GROUP_MEMBERS
      && params.members.every(agentRef),
    "group.delete": () => opaqueId(params.groupId) && revision(params.expectedMetadataRevision),
    "group.update": () => opaqueId(params.groupId) && revision(params.expectedMetadataRevision)
      && plainObject(params.patch) && Object.keys(params.patch).length > 0
      && Object.keys(params.patch).every((key) => ["name", "purpose", "status", "ownerMemberId"].includes(key))
      && (!Object.hasOwn(params.patch, "name") || text(params.patch.name, MAX_GROUP_NAME_CHARS))
      && (!Object.hasOwn(params.patch, "purpose")
        || text(params.patch.purpose, MAX_GROUP_PURPOSE_CHARS, { allowEmpty: true }))
      && (!Object.hasOwn(params.patch, "status") || ["active", "archived"].includes(params.patch.status))
      && (!Object.hasOwn(params.patch, "ownerMemberId") || opaqueId(params.patch.ownerMemberId)),
    "group.members.add": () => opaqueId(params.groupId) && revision(params.expectedRosterRevision)
      && agentRef(params.member),
    "group.members.remove": () => opaqueId(params.groupId) && revision(params.expectedRosterRevision)
      && opaqueId(params.memberId),
    "group.members.stop": () => opaqueId(params.groupId) && opaqueId(params.memberId),
    "group.member.models": () => opaqueId(params.groupId) && opaqueId(params.memberId),
    "group.members.model": () => opaqueId(params.groupId) && revision(params.expectedRosterRevision)
      && opaqueId(params.memberId) && validModelSelection(params.modelSelection),
    "group.member.role": () => opaqueId(params.groupId) && opaqueId(params.memberId)
      && (!Object.hasOwn(params, "revision") || text(params.revision, 128))
      && (!Object.hasOwn(params, "cursor") || text(params.cursor, 2048)),
    "group.member.role.history": () => opaqueId(params.groupId) && opaqueId(params.memberId)
      && (params.before === null || opaqueId(params.before)) && Number.isSafeInteger(params.limit) && params.limit > 0 && params.limit <= 50,
    "group.send": () => opaqueId(params.groupId) && opaqueId(params.clientMessageId)
      && typeof params.body === "string" && params.body.isWellFormed() && !params.body.includes("\0")
      && validAttachments(params.attachments)
      // 只发附件、不写文字也可以。
      && (params.body.trim().length > 0 || params.attachments.length > 0)
      && Buffer.byteLength(params.body, "utf8") <= MAX_USER_MESSAGE_BYTES
      && Array.isArray(params.mentions) && params.mentions.length <= MAX_GROUP_MEMBERS
      && params.mentions.every(opaqueId)
      && (!Object.hasOwn(params, "taskId") || opaqueId(params.taskId))
      && (!Object.hasOwn(params, "requestMode") || ["auto", "new", "append", "replace"].includes(params.requestMode))
      && (!Object.hasOwn(params, "discussionId") || opaqueId(params.discussionId))
      && (!Object.hasOwn(params, "summaryMemberId") || opaqueId(params.summaryMemberId))
      && (!Object.hasOwn(params, "ownerScope") || text(params.ownerScope, 256))
      && (!Object.hasOwn(params, "expectedPolicyVersion") || revision(params.expectedPolicyVersion))
      && (params.replyTo === null || (Number.isSafeInteger(params.replyTo) && params.replyTo >= 1)),
    "group.send.lookup": () => opaqueId(params.groupId) && opaqueId(params.clientMessageId)
      && (!Object.hasOwn(params, "payloadDigest") || validDigest(params.payloadDigest))
      && (!Object.hasOwn(params, "ownerScope") || text(params.ownerScope, 256)),
    "group.message.read": () => opaqueId(params.groupId) && revision(params.seq) && validOffset(params.offset)
      && (params.digest === null ? params.offset === 0 : validDigest(params.digest)),
    "group.execution.reconcile": () => opaqueId(params.groupId) && executionTarget(params.target),
    "group.history": () => opaqueId(params.groupId) && seq(params.afterSeq) && seq(params.beforeSeq)
      && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= MAX_HISTORY_LIMIT,
    "group.search": () => opaqueId(params.groupId) && text(params.query, 200)
      && (params.discussionId === null || opaqueId(params.discussionId))
      && (params.authorKind === null || ["user", "member"].includes(params.authorKind))
      && (params.memberId === null || params.authorKind === "member" && opaqueId(params.memberId))
      && (params.cursor === null || typeof params.cursor === "string" && params.cursor.length <= 1024 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(params.cursor))
      && Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 20,
    "group.discussion.stop": () => opaqueId(params.groupId),
    "group.turn.retry": () => opaqueId(params.groupId) && opaqueId(params.memberId) && opaqueId(params.operationId),
    "group.interaction.respond": () => opaqueId(params.groupId) && opaqueId(params.requestId)
      && executionTarget(params.target)
      && opaqueId(params.operationId) && plainObject(params.response)
      && Buffer.byteLength(JSON.stringify(params.response), "utf8") <= 24 * 1024,
    "group.diagnostics": () => true,
  }[method]();
  if (!valid) fail();
  return structuredClone(params);
}

function validateResult(method, result, params = null) {
  if (!METHODS[method] || !plainObject(result)) fail("GROUP_CHAT_UNAVAILABLE");
  if (method === "group.artifacts.list") {
    if (!exact(result, ["supported", "items", "truncated", "partial"]) || result.supported !== true
      || typeof result.truncated !== "boolean" || typeof result.partial !== "boolean"
      || !Array.isArray(result.items) || result.items.length > (params?.limit ?? 100)
      || !result.items.every(item => exact(item, ["attachment", "groupId", "groupName", "messageSeq", "backendId", "agentId", "agentName", "createdAt"])
        && validAttachments([item.attachment]) && opaqueId(item.groupId) && text(item.groupName, MAX_GROUP_NAME_CHARS)
        && revision(item.messageSeq) && opaqueId(item.backendId) && opaqueId(item.agentId) && text(item.agentName, 256)
        && Number.isSafeInteger(item.createdAt) && item.createdAt >= (params?.sinceMs ?? 0)
        && (!params || params.backendIds.includes(item.backendId)))) fail("GROUP_CHAT_UNAVAILABLE");
  }
  if (method === "group.delete" && (!exact(result, ["groupId", "status"]) || !opaqueId(result.groupId)
    || !["deleting", "deleted"].includes(result.status) || params && result.groupId !== params.groupId)) fail("GROUP_CHAT_UNAVAILABLE");
  if (method === "group.member.models" && !validModelCatalog(result)) fail("GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE");
  if (method === "group.execution.receipt"
    && !require("../external-inspiration-protocol").validateGroupExecutionReceiptResult(result, params)) fail("GROUP_CHAT_UNAVAILABLE");
  if (method === "group.search") {
    if (!opaqueId(result.groupId) || !text(result.query, 200) || !seq(result.upperSeq) || result.upperSeq === null
      || typeof result.partial !== "boolean" || typeof result.hasMore !== "boolean"
      || (result.hasMore ? typeof result.nextCursor !== "string" || result.nextCursor.length > 1024 : result.nextCursor !== null)
      || !Array.isArray(result.hits) || result.hits.length > 20
      || !result.hits.every(hit => plainObject(hit) && typeof hit.partial === "boolean" && text(hit.snippet, 320, { allowEmpty: true })
        && Number.isSafeInteger(hit.snippetOffset) && hit.snippetOffset >= 0
        && plainObject(hit.message) && hit.message.groupId === result.groupId && opaqueId(hit.message.id)
        && revision(hit.message.seq) && hit.message.seq <= result.upperSeq && ["user", "member"].includes(hit.message.author?.kind)
        && hit.message.body === hit.snippet && validDigest(hit.message.fullResult?.digest)
        && Number.isSafeInteger(hit.message.fullResult?.bytes) && hit.message.fullResult.bytes >= 0)
      || params && (result.groupId !== params.groupId || result.query !== params.query.trim()
        || result.discussionId !== params.discussionId || result.authorKind !== params.authorKind || result.memberId !== params.memberId
        || result.hits.length > params.limit)) fail("GROUP_CHAT_UNAVAILABLE");
  }
  if (method === "group.send.lookup") {
    if (!["found", "not_found", "unknown"].includes(result.status) || !opaqueId(result.groupId)
      || !opaqueId(result.clientMessageId) || !text(result.ownerScope, 256)
      || !(result.payloadMatches === null || typeof result.payloadMatches === "boolean")
      || !(result.discussionId === null || opaqueId(result.discussionId))) fail("GROUP_CHAT_UNAVAILABLE");
    if (result.status === "found") {
      if (!plainObject(result.message) || result.message.groupId !== result.groupId || !opaqueId(result.message.id)
        || !revision(result.message.seq) || result.message.author?.kind !== "user" || !validDigest(result.payloadDigest)) {
        fail("GROUP_CHAT_UNAVAILABLE");
      }
    } else if (result.message !== null || result.payloadMatches !== null) fail("GROUP_CHAT_UNAVAILABLE");
    if (params && (result.groupId !== params.groupId || result.clientMessageId !== params.clientMessageId
      || (result.status !== "unknown" && params.ownerScope !== undefined && result.ownerScope !== params.ownerScope)
      || (result.status === "found" && result.payloadMatches === true && params.payloadDigest !== undefined
        && result.payloadDigest !== params.payloadDigest))) fail("GROUP_CHAT_UNAVAILABLE");
  }
  return result;
}

module.exports = {
  GROUP_CHAT_SERVICE_METHODS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_CHARS,
  MAX_GROUP_PURPOSE_CHARS,
  MAX_HISTORY_LIMIT,
  MAX_USER_MESSAGE_BYTES,
  MIN_GROUP_MEMBERS_ON_CREATE,
  PUBLIC_MESSAGES,
  fail,
  groupChatError,
  opaqueId,
  validateParams,
  validateResult,
};
