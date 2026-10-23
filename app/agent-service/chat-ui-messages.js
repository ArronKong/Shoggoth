"use strict";
// Public errors shared with store-free runtime discovery.
const MESSAGES = Object.freeze({
  CODEX_DESKTOP_BUSY: "Codex 客户端正在运行，完成后可继续操作这张卡片",
  UI_ARTIFACT_NOT_FOUND: "这张卡片已不可用",
  UI_SCOPE_MISMATCH: "卡片不属于当前对话",
  UI_REVISION_CONFLICT: "卡片已有新版本，请重新打开",
  UI_STATE_CONFLICT: "另一窗口已修改参数，请确认当前选择后再操作",
  UI_STATE_INVALID: "参数不符合卡片要求",
  UI_SCHEMA_INVALID: "卡片的参数定义不受支持",
  UI_ACTION_INVALID: "这项操作不可用",
  UI_OPERATION_CONFLICT: "该请求已用于另一项操作",
  UI_SOURCE_EXPIRED: "卡片来源已变化，请重新生成",
  UI_CONTENT_TOO_LARGE: "卡片内容超过容量限制",
  UI_STORAGE_CAPACITY: "卡片存储空间不足，已有内容仍可查看",
  UI_STORAGE_FAILED: "保存失败，请稍后重试",
  UI_STORAGE_CORRUPT: "卡片数据无法核验",
  UI_COMMIT_UNCERTAIN: "保存结果待确认，请稍后重新打开",
  UI_RATE_LIMITED: "操作太频繁，请稍后重试",
  UI_RESOURCE_UNAVAILABLE: "卡片所需的内置资源不可用",
  UI_RENDERER_UNRESPONSIVE: "卡片暂时无响应，可重新加载",
  UI_OPERATION_EXPIRED: "这项操作已过期，请重新选择",
  UI_HOST_REQUIRED: "请在 Shoggoth 桌面应用中操作这张卡片",
  UI_FEATURE_DISABLED: "交互卡片已停用，已有内容仍可查看",
  UI_REQUEST_INVALID: "卡片请求无效",
  UI_DIRECT_CHAT_REQUIRED: "交互卡片仅供直接聊天使用",
  UI_SENSITIVE_CONTENT: "卡片包含不能保存的敏感信息",
});
module.exports = { MESSAGES };
