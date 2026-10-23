"use strict";
const protocol = require("../agent-service/chat-ui-protocol");
const METHODS = Object.freeze({ describeChatUi: "chat.ui.describe", openChatUi: "chat.ui.open",
  readChatUi: "chat.ui.read", saveChatUiState: "chat.ui.state.save", renewChatUi: "chat.ui.renew",
  closeChatUi: "chat.ui.close", importChatUi: "chat.ui.import", exportChatUi: "chat.ui.export",
  getChatUiOperation: "chat.ui.operation.get", submitChatUiAction: "chat.ui.action" });
const REST_METHODS = Object.freeze({ describe: "describeChatUi", open: "openChatUi", read: "readChatUi",
  state: "saveChatUiState", renew: "renewChatUi", close: "closeChatUi", import: "importChatUi",
  export: "exportChatUi", operation: "getChatUiOperation" });
function normalizeSpec(name, spec) {
  const method = METHODS[name]; if (!method) throw Object.assign(new Error("交互卡片请求无效"), { code: "UI_REQUEST_INVALID" });
  if (!spec || Object.getPrototypeOf(spec) !== Object.prototype || Object.hasOwn(spec, "profileId") || Object.hasOwn(spec, "sessionKey")) {
    throw Object.assign(new Error("交互卡片请求无效"), { code: "UI_REQUEST_INVALID" });
  }
  const normalized = protocol.validateParams(method, { ...spec, profileId: "scope", sessionKey: "scope" });
  delete normalized.profileId; delete normalized.sessionKey; return normalized;
}
function projectResult(name, result) {
  if (result?.supported === false) return { supported: false };
  return { supported: true, ...protocol.validateResult(METHODS[name], result) };
}
module.exports = { METHODS, REST_METHODS, normalizeSpec, projectResult };
