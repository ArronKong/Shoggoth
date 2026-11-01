"use strict";

// The reference is a name, never a bearer capability. Only the Service's
// authenticated execution scope may resolve it; there is no model-facing get.
const SECRET_REFERENCE_VERSION = 1;
const SECRET_REFERENCE_PATTERN = /\{\{SHOGGOTH_SECRET_([a-f0-9]{32})\}\}/gu;
const SECRET_KINDS = Object.freeze(["password", "api_key", "token", "private_key", "secret"]);
const SECRET_METHODS = Object.freeze(["prepare", "list", "revoke", "result", "results", "capabilities", "disclosures", "decide"].map(action => `chat.secret.${action}`));
const SECRET_MESSAGES = Object.freeze({
  SECRET_INPUT_INVALID: "这条消息暂时无法发送，请检查填写的内容",
  SECRET_INPUT_REVIEW_REQUIRED: "消息中可能包含密码或密钥，请选中完整内容后再发送",
  SECRET_PROCESSING_UNAVAILABLE: "这条消息暂时无法安全发送，请稍后重试。内容已为你保留",
  SECRET_REFERENCE_INVALID: "无法使用之前提供的密码或密钥，请重新填写",
  SECRET_REFERENCE_EXPIRED: "之前提供的密码或密钥已过期，请重新填写",
  SECRET_REFERENCE_FORBIDDEN: "这份密码或密钥属于另一个会话，请在当前会话重新填写",
  SECRET_OPERATION_CONFLICT: "原消息身份已用于不同内容，请核对原消息",
  SECRET_STORE_UNCERTAIN: "暂时无法确认密码或密钥是否保存成功，消息尚未发送，请稍后查看",
  SECRET_TOOL_OUTCOME_UNKNOWN: "操作可能已执行，请核对结果；不会自动重复执行",
  SECRET_TOOL_NOT_SUPPORTED: "这个工具暂时无法代你填写密码或密钥，请手动完成这一步",
  SECRET_MODEL_PROJECTION_UNAVAILABLE: "暂时无法隐藏这次发送内容中的私密信息，对话已暂停。已完成的操作不会重复执行",
  SECRET_MODEL_RUNTIME_UNSUPPORTED: "当前助理版本暂时无法保护消息中的私密信息，请更新或切换助理后重试。内容已为你保留",
  SECRET_MODEL_IDENTITY_UNAVAILABLE: "暂时无法确认这次内容属于哪个对话，发送已暂停。请稍后重试，已完成的操作不会重复执行",
  SECRET_MODEL_SCOPE_INVALID: "这次对话暂时无法安全继续，发送已暂停。内容已为你保留",
  SECRET_DISCLOSURE_EXPIRED: "这次发送已结束或确认已过期，请查看对话的最新状态",
  SECRET_DISCLOSURE_CANCELED: "已取消这次发送，已完成的操作不受影响",
  SECRET_MEDIA_UNAVAILABLE: "暂时无法隐藏附件中的私密信息，附件尚未发送",
  SECRET_MEDIA_SPEECH_UNAVAILABLE: "暂时无法在这台设备上识别语音，附件尚未发送",
  SECRET_MEDIA_INVALID: "暂时无法读取这个附件，请检查文件后重新添加。附件尚未发送",
  SECRET_MEDIA_CAPACITY: "这个附件暂时无法在本机处理，请缩小文件或改用文字。附件尚未发送",
  SECRET_MEDIA_TIMEOUT: "处理这个附件花费了较长时间，请稍后重试。附件尚未发送",
  SECRET_MEDIA_CANCELED: "已取消附件处理，附件尚未发送",
});

function secretReference(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/u.test(id)) throw new TypeError("Invalid secret reference id");
  return `{{SHOGGOTH_SECRET_${id}}}`;
}
function secretReferences(text) {
  return typeof text === "string" ? [...text.matchAll(new RegExp(SECRET_REFERENCE_PATTERN))].map(match => ({
    id: match[1], reference: match[0], start: match.index, end: match.index + match[0].length,
  })) : [];
}
function secretCapability({ input = false, productTools = false, nativeTools = false, images = false } = {}) {
  // Product-owned handling only: nativeTools means direct reference injection,
  // while images means the local pixel processor is present. Neither boolean
  // grants access to a native Runtime's independent storage or system privacy.
  return Object.freeze({ version: SECRET_REFERENCE_VERSION, input, productTools, nativeTools, images,
    temporary: true, expires: "local-day-end", targetBinding: "current-tool-call" });
}
function validateSecretResult(method, value) {
  const object = (input, names) => input && Object.getPrototypeOf(input) === Object.prototype
    && Object.keys(input).sort().join() === [...names].sort().join();
  const instant = input => Number.isSafeInteger(input) && input >= 0;
  const reference = input => object(input, ["reference", "kind", "expiresAt", "available"])
    && typeof input.reference === "string" && /^\{\{SHOGGOTH_SECRET_[a-f0-9]{32}\}\}$/u.test(input.reference)
    && SECRET_KINDS.includes(input.kind) && (input.expiresAt === null || instant(input.expiresAt))
    && typeof input.available === "boolean";
  const status = input => ["dispatching", "unknown", "completed"].includes(input);
  const items = (input, check, max) => Array.isArray(input) && input.length <= max && input.every(check);
  let valid = false;
  if (method === "chat.secret.prepare") valid = object(value, ["text", "references", "version"])
    && value.version === SECRET_REFERENCE_VERSION && typeof value.text === "string" && value.text.isWellFormed()
    && items(value.references, reference, 2048);
  if (method === "chat.secret.list") valid = object(value, ["items"]) && items(value.items, reference, 4096);
  if (method === "chat.secret.disclosures") valid = object(value, ["items"]) && items(value.items, item =>
    object(item, ["id", "recipient", "expiresAt"]) && /^[a-f0-9]{64}$/u.test(item.id)
    && item.recipient === "OpenAI" && instant(item.expiresAt), 64);
  if (method === "chat.secret.decide") valid = object(value, ["decided"]) && value.decided === true;
  if (method === "chat.secret.revoke") valid = object(value, ["revoked"]) && instant(value.revoked) && value.revoked <= 4096;
  if (method === "chat.secret.result") valid = object(value, ["status", "result"]) && status(value.status);
  if (method === "chat.secret.results") valid = object(value, ["items"]) && items(value.items, item =>
    object(item, ["receiptId", "tool", "status", "at", "expiresAt", "originalAvailable"])
    && typeof item.receiptId === "string" && /^[a-f0-9]{64}$/u.test(item.receiptId)
    && typeof item.tool === "string" && item.tool.length > 0 && item.tool.length <= 2048
    && status(item.status) && instant(item.at) && instant(item.expiresAt) && typeof item.originalAvailable === "boolean", 100);
  if (method === "chat.secret.capabilities") valid = object(value, Object.keys(secretCapability()))
    && value.version === SECRET_REFERENCE_VERSION && ["input", "productTools", "nativeTools", "images"].every(key => typeof value[key] === "boolean")
    && value.temporary === true && value.expires === "local-day-end" && value.targetBinding === "current-tool-call";
  if (!valid || Buffer.byteLength(JSON.stringify(value), "utf8") > 8 * 1024 * 1024) {
    throw Object.assign(new Error(SECRET_MESSAGES.SECRET_PROCESSING_UNAVAILABLE), { code: "SECRET_PROCESSING_UNAVAILABLE" });
  }
  return value;
}
// Elicitation schemas identify password fields even when a field has an opaque
// ID and a short value. Selection offsets refer to the serialized JSON literal,
// so the local parser decodes escapes exactly once.
function secretAnswerInput(answers, schema = {}) {
  let text = "{";
  const selections = [];
  for (const [key, value] of Object.entries(answers)) {
    if (text.length > 1) text += ",";
    text += `${JSON.stringify(key)}:`;
    const start = text.length;
    text += JSON.stringify(value);
    const field = schema.properties?.[key];
    if ((field?.writeOnly === true || field?.format === "password") && typeof value === "string" && value.length) {
      selections.push({ start, end: text.length, kind: "password" });
    }
  }
  return { text: `${text}}`, selections };
}
module.exports = { SECRET_REFERENCE_VERSION, SECRET_REFERENCE_PATTERN, SECRET_KINDS, SECRET_MESSAGES, SECRET_METHODS,
  secretReference, secretReferences, secretCapability, secretAnswerInput, validateSecretResult };
