"use strict";
const PUBLIC_MESSAGES = Object.freeze({
  PROACTIVE_DOCUMENT_INVALID: "HEARTBEAT.md 内容或路径无效，请检查 YAML web 列表和文件大小",
  PROACTIVE_INVALID: "主动提醒参数无效",
  PROACTIVE_UNAVAILABLE: "主动提醒服务暂不可用",
  PROACTIVE_NOT_FOUND: "提醒或检查记录不存在",
  PROACTIVE_REVISION_CONFLICT: "提醒设置已更新，请重新读取",
  PROACTIVE_OPERATION_CONFLICT: "同一次操作的内容发生了变化",
  PROACTIVE_RUNTIME_UNVERIFIED: "这个 Runtime 的只读检查能力尚未验证",
  PROACTIVE_PROFILE_UNAVAILABLE: "检查 Agent 不可用，请检查安装、账号与启用状态",
  PROACTIVE_SCOPE_INVALID: "检查范围已失效或不属于这个 Agent",
  PROACTIVE_RESPONSE_INVALID: "检查结果不符合响应协议",
  PROACTIVE_STORE_CORRUPT: "主动提醒数据需要恢复核对",
  PROACTIVE_TARGET_DELETED: "提醒会话已删除，请明确选择新的会话",
  PROACTIVE_TARGET_INVALID: "提醒会话的归属或状态无效",
});
module.exports = { PUBLIC_MESSAGES };
