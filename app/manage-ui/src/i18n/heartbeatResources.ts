import i18n from "./index";
const zh = {
  title: "心跳检查", enabled: "启用心跳检查", save: "保存检查设置", saved: "心跳检查设置已保存",
  hint: "按 HEARTBEAT.md 的规则在主会话中检查，只显示最终提醒。可在开头的 YAML 用 inspiration: true 收集未归档便签，用 web 列表声明网页来源。规则与检查设置分别保存。",
  interval: "检查间隔（分钟）", timezone: "时区", systemTimezone: "时区（跟随电脑）", runs: "每天最多检查次数", tokens: "每日 Token 预算",
  hours: "限定活跃时段", start: "开始时间", end: "结束时间", push: "系统通知", lastCheck: "最近检查",
  unavailable: "检查沿用主会话的 Runtime、模型、工具和权限。首次检查会验证对话能力，请先确认该 Runtime 已登录。",
  scratch: "检查笔记", scratchHint: "由检查 Agent 更新，供后续检查参考；不会覆盖你的 HEARTBEAT.md 规则。",
  emptyScratch: "暂无检查笔记", reset: "清空检查笔记",
  reasons: { disabled: "已关闭", empty_checklist: "检查规则为空", outside_active_hours: "不在活跃时段", budget_exhausted: "已达每日预算",
    usage_unverified: "上次检查的 Token 用量未能确认，今日后续检查已暂停以保护预算",
    model_silent: "暂无需要提醒的变化", no_change: "没有变化", duplicate_notice: "已通知过相同结果",
    web_source_failed: "网页来源读取失败，请稍后检查", inspiration_source_unavailable: "未能读取便签状态", source_changed: "检查资料已变化，本轮结果未发布",
    notice_published: "已发布提醒", runtime_unverified: "主会话对话能力尚未验证", main_session_busy: "主会话正在处理消息，稍后检查", main_session_unavailable: "主会话暂不可用", heartbeat_document_invalid: "检查规则文件无效",
    disabled_or_stale: "配置已变化，本轮结果已停用", no_candidates: "没有待检查事项", no_structured_response: "未收到有效检查结论" },
};
const en = {
  title: "Heartbeat", enabled: "Enable heartbeat", save: "Save check settings", saved: "Heartbeat settings saved",
  hint: "Follow HEARTBEAT.md in the main conversation and show only the final reminder. Its YAML front matter can use inspiration: true to collect unarchived notes and a web list for public sources. Save rules and check settings separately.",
  interval: "Interval (minutes)", timezone: "Time zone", systemTimezone: "Time zone (system)", runs: "Maximum checks per day", tokens: "Daily token budget",
  hours: "Use active hours", start: "Start time", end: "End time", push: "System notifications", lastCheck: "Last check",
  unavailable: "Checks use the main conversation's Runtime, model, tools and permissions. The first check verifies chat support. Sign in to that Runtime first.",
  scratch: "Working notes", scratchHint: "The reviewing Agent updates these notes for later checks. They never replace your HEARTBEAT.md rules.",
  emptyScratch: "No working notes yet", reset: "Clear working notes",
  reasons: { disabled: "Disabled", empty_checklist: "Empty rules", outside_active_hours: "Outside active hours", budget_exhausted: "Daily budget reached",
    usage_unverified: "The previous token usage could not be verified; further checks are paused today to protect the budget",
    model_silent: "Nothing needs attention", no_change: "No change", duplicate_notice: "Same result already reported",
    web_source_failed: "A web source could not be read", inspiration_source_unavailable: "Note statuses could not be read", source_changed: "The check data changed before publication",
    notice_published: "Alert published", runtime_unverified: "Main conversation chat support is unverified", main_session_busy: "The main conversation is busy; the check will wait", main_session_unavailable: "Main conversation unavailable", heartbeat_document_invalid: "Invalid heartbeat document",
    disabled_or_stale: "Configuration changed; this result was discarded", no_candidates: "Nothing to check", no_structured_response: "No valid review verdict" },
} satisfies typeof zh;
i18n.addResourceBundle("zh-CN", "translation", { heartbeat: zh }, true, true);
i18n.addResourceBundle("en", "translation", { heartbeat: en }, true, true);
