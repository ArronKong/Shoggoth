import i18n from "./index";

const zh = {
  details: "上下文明细", used: "已使用 {{percent}}", free: "可用空间",
  estimate: "占用分项 · 估算", previous: "最近一轮输入 · 估算",
  message: "本轮消息与附件", history: "随请求发送的历史", rules: "系统与工具规则", definition: "Agent 设定",
  memory: "记忆与召回", skills: "Skills", tools: "常驻工具定义", other: "消息",
  otherHint: "总占用减去本轮已归类的估算，含运行时管理的历史、内置指令和工具交互。",
  catalog: "可用工具目录 · {{count}} 个", catalogHint: "目录大小仅供参考。实际加载的工具由运行时决定。",
  separate: "输入快照与当前总量无法逐项核对。",
  loading: "正在读取本轮输入快照…", unavailable: "这次占用没有可用的分项快照。", totalsOnly: "此会话仅上报总占用。",
  failed: "暂时无法读取分项，重新展开可重试。",
  thresholdReached: "已到自动摘要阈值 {{tokens}}", untilThreshold: "距自动摘要阈值还剩 {{tokens}}",
  compact: "压缩会话", compacting: "正在压缩…",
};
const en = {
  details: "Context details", used: "{{percent}} used", free: "Available space",
  estimate: "Estimated usage by category", previous: "Latest turn’s estimated input",
  message: "Message and attachments", history: "History sent with the request", rules: "System and tool instructions",
  definition: "Agent instructions", memory: "Memory and recall", skills: "Skills", tools: "Resident tool definitions", other: "Messages",
  otherHint: "Usage left after subtracting the estimated categories, including runtime-managed history, built-in instructions and tool activity.",
  catalog: "Tool catalog · {{count}}", catalogHint: "The catalog size is shown for reference. The runtime decides which tools to load.",
  separate: "This input snapshot cannot be reconciled with current usage.",
  loading: "Reading the turn’s input snapshot…", unavailable: "No category breakdown is available for this observation.",
  totalsOnly: "This session reports total usage only.", failed: "Couldn’t load the breakdown. Reopen to retry.",
  thresholdReached: "Auto-summary threshold reached at {{tokens}}", untilThreshold: "{{tokens}} until the auto-summary threshold",
  compact: "Compact session", compacting: "Compacting…",
} satisfies typeof zh;

i18n.addResourceBundle("zh-CN", "translation", { contextMeter: zh }, true, true);
i18n.addResourceBundle("en", "translation", { contextMeter: en }, true, true);
