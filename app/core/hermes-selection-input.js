"use strict";

// Separate from the immutable selection-dispatch v1 envelope. Only this
// negotiated Host contract may stage attachments for a selected operation.
const { createHash } = require("node:crypto");
const { validateExternalPluginSelectionInput, validateExternalPluginSelectionResult } = require("./plugin-external-selection-dto");
const { trustedHermesSelectionSubject, getHermesSelectionReceipt, validateHermesSelectionReceipt,
  readHermesPluginSelectionOperation, prepareHermesPluginSelection } = require("./hermes-plugin-selection");
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 16;
const ADAPTER_ID = "shoggoth_shared_capabilities";
const META = ["kind", "name", "mime_type", "size", "sha256"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => sha(Buffer.from(JSON.stringify(value), "utf8"));
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  });
function fail(code = "PLUGIN_SELECTION_ATTACHMENTS_INVALID", uncertain = false, originalOperation) {
  throw Object.assign(new Error(uncertain ? "原 Hermes 插件操作需要核实；附件没有重新上传，消息没有重新发送"
    : code === "PLUGIN_SELECTION_ATTACHMENTS_UNSUPPORTED" ? "当前 Hermes 尚未提供单次插件操作的附件协议，消息和附件已保留"
    : "本次 Hermes 插件附件无法核对，消息和附件已保留"), { code, executionUncertain: uncertain,
    ...(originalOperation ? { originalOperation } : {}) });
}
function utf8(value) {
  return typeof value === "string" && Buffer.from(value, "utf8").toString("utf8") === value;
}
function captureHermesSelectionInput(message, attachments) {
  if (!utf8(message) || message.includes("\0") || Buffer.byteLength(message, "utf8") > 1024 * 1024
    || !Array.isArray(attachments) || attachments.length > MAX_ITEMS) fail();
  let total = 0;
  const items = attachments.map((value, index) => {
    const data = typeof value?.source?.data === "string" && value.source.data ? value.source.data
      : typeof value?.content === "string" && value.content ? value.content : null;
    if (!data || data.length > MAX_BYTES * 4 / 3 + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) fail();
    const body = Buffer.from(data, "base64");
    if (body.toString("base64") !== data) fail();
    const mime = value?.source?.media_type || value?.mimeType || "";
    if (typeof mime !== "string") fail();
    const kind = value?.type === "pdf" || mime === "application/pdf" ? "pdf"
      : ["file", "audio", "video"].includes(value?.type) || mime.startsWith("audio/") || mime.startsWith("video/") ? "file" : "image";
    const mimeType = kind === "pdf" ? "application/pdf" : mime || (kind === "image" ? "image/png" : "application/octet-stream");
    const rawName = typeof value?.fileName === "string" ? value.fileName : value?.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim()
      : kind === "pdf" ? "attachment.pdf" : kind === "file" ? "attachment.bin"
      : `image-${index}.${({ "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[mimeType] || "png"}`;
    if (!utf8(name) || Buffer.byteLength(name, "utf8") > 255 || /[\\/\u0000-\u001f\u007f]/u.test(name) || [".", ".."].includes(name)
      || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(mimeType) || mimeType.length > 128
      || (kind === "image" && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType))) fail();
    total += body.length;
    if (body.length > MAX_BYTES || total > MAX_BYTES) fail("PLUGIN_SELECTION_ATTACHMENTS_TOO_LARGE");
    return Object.freeze({ kind, name, mime_type: mimeType, size: body.length, sha256: sha(body), data_base64: data });
  });
  const metadata = items.map(({ data_base64: _data, ...row }) => Object.freeze(row));
  const attachmentDigest = digest(metadata.map(row => META.map(key => row[key])));
  const messageDigest = sha(Buffer.from(message, "utf8"));
  return Object.freeze({ message, items: Object.freeze(items), metadata: Object.freeze(metadata),
    attachmentDigest, messageDigest, inputDigest: digest([1, messageDigest, attachmentDigest]) });
}
function supportsHermesSelectionInputs(value) {
  return exact(value, ["version", "max_bytes", "max_items", "kinds"]) && value.version === 1
    && value.max_bytes === MAX_BYTES && value.max_items === MAX_ITEMS
    && Array.isArray(value.kinds) && JSON.stringify(value.kinds) === JSON.stringify(["image", "pdf", "file"]);
}
function validateHermesSelectionInputReceipt(value, captured, owner, operationId, allowExpired = false) {
  if (!exact(value, ["version", "owner_session_id", "operation_id", "input_digest", "message_digest", "attachment_digest", "attachments", "expires_at"])
    || value.version !== 1 || value.owner_session_id !== owner || value.operation_id !== operationId
    || !Number.isSafeInteger(value.expires_at) || value.expires_at < 0
    || value.input_digest !== captured.inputDigest || value.message_digest !== captured.messageDigest
    || value.attachment_digest !== captured.attachmentDigest || !Array.isArray(value.attachments)
    || value.attachments.length !== captured.metadata.length || value.attachments.some((row, index) =>
      !exact(row, META) || META.some(key => row[key] !== captured.metadata[index][key]))) fail("PLUGIN_SELECTION_ATTACHMENTS_CONFLICT");
  if (!allowExpired && value.expires_at * 1000 <= Date.now()) fail("PLUGIN_SELECTION_ATTACHMENTS_EXPIRED");
  return Object.freeze(structuredClone(value));
}
async function prepareHermesSelectedInput({ runtimeId, agentId, operationId, pluginSelection, message, attachments = [],
  requestHost, service, assertCurrent = () => {} }) {
  const captured = captureHermesSelectionInput(message, attachments);
  pluginSelection = structuredClone(pluginSelection);
  let previous;
  try { previous = await getHermesSelectionReceipt(requestHost, runtimeId, operationId); }
  catch { fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true); }
  assertCurrent();
  let capabilities;
  try { capabilities = await requestHost("prompt.selection.capabilities", { session_id: runtimeId }); }
  catch { fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true); }
  assertCurrent();
  let trusted;
  try { trusted = trustedHermesSelectionSubject(capabilities, agentId); }
  catch (error) { if (previous !== null) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true); throw error; }
  const input = validateExternalPluginSelectionInput("plugins.selection.external.prepare", {
    ...trusted, operationId, requiredAdapterId: ADAPTER_ID, pluginSelection });
  const supported = supportsHermesSelectionInputs(capabilities.selection_inputs);
  const params = { session_id: runtimeId, operation_id: operationId, owner_session_id: trusted.subject.sessionId };
  let staged = null;
  if (supported) {
    let result;
    try { result = await requestHost("prompt.selection.input.get", params); }
    catch { fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true); }
    assertCurrent();
    if (!exact(result, ["selection_input"])) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    staged = result.selection_input;
    if (staged !== null) validateHermesSelectionInputReceipt(staged, captured, trusted.subject.sessionId, operationId, previous !== null);
    if (staged === null && previous && captured.items.length) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
  }
  if (previous !== null) {
    // Observe only. A Service record must already exist before its immutable
    // fingerprint is compared; never mint a new ref for an existing Host turn.
    if (typeof service?.getExternalPluginSelection !== "function") fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    const query = { subject: trusted.subject, operationId };
    let original;
    try { original = validateExternalPluginSelectionResult("plugins.selection.external.get",
      await service.getExternalPluginSelection(query), query); }
    catch { fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true); }
    assertCurrent();
    if (!original) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    const envelope = Object.fromEntries(["version", "operationId", "dispatchRef", "selectionDigest", "requiredAdapterId", "adapterGeneration"].map(key => [key, original[key]]));
    validateHermesSelectionReceipt(previous, { subject: trusted.subject, operationId, envelope });
    let observed;
    try { observed = validateExternalPluginSelectionResult("plugins.selection.external.prepare",
      await service.prepareExternalPluginSelection(input), input); }
    catch (error) {
      if (error?.code === "EXTERNAL_PLUGIN_SELECTION_CONFLICT") throw error;
      fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    }
    assertCurrent();
    if (Object.keys(envelope).some(key => observed.envelope[key] !== envelope[key])) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    const operation = await readHermesPluginSelectionOperation({ runtimeId, agentId, operationId, requestHost });
    assertCurrent();
    fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true, operation);
  }
  if (captured.items.length && !supported) fail("PLUGIN_SELECTION_ATTACHMENTS_UNSUPPORTED");
  if (captured.items.length && staged === null) {
    let result;
    try { result = await requestHost("prompt.selection.input.stage", { ...params, text: captured.message, attachments: captured.items }, { timeoutMs: 45000 }); }
    catch (error) {
      if (error?.jsonRpc === true && !["SELECTION_INPUT_ALREADY_DISPATCHED", "SELECTION_INPUT_OWNER_CHANGED"].includes(error.contractCode)) {
        fail("PLUGIN_SELECTION_ATTACHMENTS_REJECTED");
      }
      fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    }
    assertCurrent();
    if (!exact(result, ["selection_input"]) || result.selection_input === null) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
    staged = validateHermesSelectionInputReceipt(result.selection_input, captured, trusted.subject.sessionId, operationId);
  }
  const selected = await prepareHermesPluginSelection({ runtimeId, agentId, operationId, pluginSelection, requestHost, service, assertCurrent, requireNewOperation: true });
  if (Object.keys(trusted.subject).some(key => selected.selection.subject[key] !== trusted.subject[key])) fail("PLUGIN_SELECTION_NEEDS_VERIFICATION", true);
  return { ...selected, ...(staged ? { inputDigest: staged.input_digest } : {}) };
}
module.exports = { captureHermesSelectionInput, supportsHermesSelectionInputs, validateHermesSelectionInputReceipt, prepareHermesSelectedInput };
