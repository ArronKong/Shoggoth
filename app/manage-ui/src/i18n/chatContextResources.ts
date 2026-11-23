import i18n from "./index";
import "./chatErrorResources";

const zh = {
  productContextAutomatic: { enabled: "自动摘要已启用", unavailable: "未配置摘要能力", disabled: "自动摘要已关闭" },
  productContextPending: "正在生成会话摘要",
  selectCodexModelBeforeSend: "请选择当前账号可用的 Codex 模型，再发送消息。",
  productContextFailed: "上下文摘要未完成",
  productContextErrors: {
    PRODUCT_COMPACTION_QUOTA_EXHAUSTED: "摘要模型额度已用尽",
    PRODUCT_COMPACTION_RATE_LIMITED: "摘要模型请求受到限流",
    PRODUCT_COMPACTION_UPSTREAM_UNAVAILABLE: "摘要服务商暂时不可用",
    PRODUCT_COMPACTION_CONNECTION_LOST: "与摘要运行时的连接已中断",
    PRODUCT_COMPACTION_TIMEOUT: "摘要模型响应超时",
    PRODUCT_COMPACTION_AUTH_REQUIRED: "摘要模型未登录或凭据不可用",
    PRODUCT_COMPACTION_MODEL_UNAVAILABLE: "摘要模型或配置不可用",
    PRODUCT_COMPACTION_MODEL_CATALOG_TOO_LARGE: "OpenCode 模型目录过大，无法读取摘要模型",
    PRODUCT_COMPACTION_OUTPUT_INVALID: "摘要模型返回了无效摘要",
    PRODUCT_COMPACTION_OUTCOME_UNKNOWN: "上次摘要结果待核验",
    MODEL_ONLY_ACCEPTANCE_UNKNOWN: "上次摘要结果待核验",
    COMPACTION_RECOVERY_UNAVAILABLE: "上次摘要结果待核验",
  },
  productContextUnchanged: "当前没有需要压缩的历史",
  productContextHint: "摘要由 {{runtime}} / {{model}} 生成，费用单独记录，已覆盖至记录 #{{seq}}。可迁移范围以保存的原文为准；原生 CLI 的自动压缩设置未核实。",
};

const en = {
  productContextAutomatic: { enabled: "Automatic summaries enabled", unavailable: "Summary capability not configured", disabled: "Automatic summaries disabled" },
  productContextPending: "Generating conversation summary",
  selectCodexModelBeforeSend: "Select an available Codex model for this account before sending.",
  productContextFailed: "The conversation summary did not finish",
  productContextErrors: {
    PRODUCT_COMPACTION_QUOTA_EXHAUSTED: "Summary model quota exhausted",
    PRODUCT_COMPACTION_RATE_LIMITED: "Summary model is rate limited",
    PRODUCT_COMPACTION_UPSTREAM_UNAVAILABLE: "Summary provider temporarily unavailable",
    PRODUCT_COMPACTION_CONNECTION_LOST: "Connection to the summary runtime was interrupted",
    PRODUCT_COMPACTION_TIMEOUT: "Summary model timed out",
    PRODUCT_COMPACTION_AUTH_REQUIRED: "Summary model needs authentication",
    PRODUCT_COMPACTION_MODEL_UNAVAILABLE: "Summary model or settings unavailable",
    PRODUCT_COMPACTION_MODEL_CATALOG_TOO_LARGE: "OpenCode provider catalog too large to read the summary model",
    PRODUCT_COMPACTION_OUTPUT_INVALID: "Summary model returned an invalid summary",
    PRODUCT_COMPACTION_OUTCOME_UNKNOWN: "Previous summary outcome needs verification",
    MODEL_ONLY_ACCEPTANCE_UNKNOWN: "Previous summary outcome needs verification",
    COMPACTION_RECOVERY_UNAVAILABLE: "Previous summary outcome needs verification",
  },
  productContextUnchanged: "No history needs compaction yet",
  productContextHint: "Summaries use {{runtime}} / {{model}} with separately recorded usage, covering record #{{seq}}. Transferable content depends on saved originals. Native CLI auto-compaction settings are unverified.",
} satisfies typeof zh;

i18n.addResourceBundle("zh-CN", "translation", { chat: zh }, true, true);
i18n.addResourceBundle("en", "translation", { chat: en }, true, true);
