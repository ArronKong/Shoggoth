import i18next from "./index";

// Loaded with the chat/settings surfaces; these strings are not boot UI.
const zh = {
  resumeUnavailable: "无法继续历史会话。历史仍可查看，请新建对话继续。",
  compactUnavailable: "不支持原生压缩",
};
const en: Record<keyof typeof zh, string> = {
  resumeUnavailable: "Cannot resume past sessions. History stays available; start a new chat to continue.",
  compactUnavailable: "Native compaction unavailable",
};
i18next.addResourceBundle("zh-CN", "runtimeFeatures", zh, true, true);
i18next.addResourceBundle("en", "runtimeFeatures", en, true, true);
