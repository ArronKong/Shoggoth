import i18next from "./index";

// Loaded with the chat/settings surfaces; these strings are not boot UI.
const zh = {
  resumeUnavailable: "无法继续历史会话。历史仍可查看，请新建对话继续。",
  compactUnavailable: "不支持原生压缩",
  availableAttachments: "可用附件：{{kinds}}",
  attachmentsUnverified: "尚无已验证类型",
  image: "图片", pdf: "PDF", file: "文件",
};
const en: Record<keyof typeof zh, string> = {
  resumeUnavailable: "Cannot resume past sessions. History stays available; start a new chat to continue.",
  compactUnavailable: "Native compaction unavailable",
  availableAttachments: "Available attachments: {{kinds}}",
  attachmentsUnverified: "none verified",
  image: "images", pdf: "PDFs", file: "files",
};
i18next.addResourceBundle("zh-CN", "runtimeFeatures", zh, true, true);
i18next.addResourceBundle("en", "runtimeFeatures", en, true, true);
