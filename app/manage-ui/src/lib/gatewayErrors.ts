import publicErrors from "../../../agent-service/chat-error-messages.json";

// 已知网关/模型错误串 → i18n key 的显示层翻译。
// 收录原则：只翻【全串语义都被译文覆盖】的固定文案（gateway 自有兜底/汇总文案，
// 或 "401 Invalid API Key" 这类本身就是全部信息的短句）。provider 透传的具体错误
// （配额/账单/带 request id 的限流详情等）**不硬翻**——细节和链接比统一中文更有用，
// 原样显示。因此模式必须足够特异，宽泛词（\b429\b、rate limit、Failed to authenticate
// 前缀）一律不收，避免把信息量更大的具体文案压扁。
// 匹配不中原样返回，对任意非错误文本调用无害。顺序：具体在前。
// 调用方在【渲染时】翻译（不落地进 state），语言切换即时全量生效；
// 原始英文串保留在气泡 title（hover 可见）供排障对照。

type TFn = (key: string, opts?: Record<string, unknown>) => string;

// Older transcripts and some live events only carry the product's display
// string. Match the complete message against the shared public catalog.
const publicErrorKeys = new Map(Object.entries(publicErrors).flatMap(([group, messages]) =>
  Object.entries(messages).map(([code, message]) => [message, `chatErrors:${group}.${code}`] as const)));

function productErrorMessage(raw: string, t: TFn): string | null {
  const key = publicErrorKeys.get(raw);
  if (key) return t(key, { defaultValue: raw });
  const fallback = /^Shoggoth (任务未完成|请求失败) \(([A-Z][A-Z0-9_]{0,127})\)$/u.exec(raw);
  if (!fallback) return null;
  return t(fallback[1] === "任务未完成" ? "chat.gwErrors.taskFailedCode" : "chat.gwErrors.requestFailedCode", { code: fallback[2] });
}

export function translateProductError(raw: string, t: TFn): string {
  const prefixed = raw.startsWith("错误：");
  const message = productErrorMessage(prefixed ? raw.slice("错误：".length) : raw, t);
  if (message === null) return raw;
  return prefixed ? t("chat.errorPrefix", { msg: message }) : message;
}

// Error-code presentation data, shared by all Chat surfaces and runtimes.
// Provider text and codes retain their original language; only App copy changes.
const FAILURE_SUMMARIES: Record<string, string> = {
  ANTIGRAVITY_REGION_UNSUPPORTED: "regionUnsupported",
  ANTIGRAVITY_NETWORK_UNAVAILABLE: "providerNetworkUnavailable",
  ANTIGRAVITY_MCP_UNAVAILABLE: "runtimeToolsUnavailable",
  AUTH_REQUIRED: "runtimeAuthRequired",
  RUNTIME_AUTH_REQUIRED: "runtimeAuthRequired",
  RUNTIME_QUOTA_EXHAUSTED: "runtimeQuotaExceeded",
  RUNTIME_RATE_LIMITED: "runtimeRateLimited",
  RUNTIME_SPENDING_LIMIT_REACHED: "runtimeSpendingLimit",
  RUNTIME_ACCOUNT_BLOCKED: "runtimeAccountBlocked",
  RUNTIME_UPSTREAM_UNAVAILABLE: "runtimeUpstreamUnavailable",
  RUNTIME_MODEL_UNAVAILABLE: "runtimeModelUnavailable",
  RUNTIME_MODEL_SETTINGS_INVALID: "runtimeSettingsInvalid",
  RUNTIME_MAX_TOKENS: "runtimeMaxTokens",
  RUNTIME_MAX_TURN_REQUESTS: "runtimeMaxTurnRequests",
  RUNTIME_REFUSED: "runtimeRefused",
};

function detailedFailure(raw: string, t: TFn): string | null {
  // This exact envelope is emitted by the App bridge. Never translate a
  // provider sentence merely because it contains a familiar error keyword.
  const match = /^(错误：)?([^\n]+)\n(上游原因|启动详情)：([\s\S]+)\n错误码：([A-Z][A-Z0-9_]{0,127})$/u.exec(raw);
  if (!match) return null;
  const [, prefix, summary, detailLabel, originalDetail, code] = match;
  const detail = originalDetail.replace(/\[(已隐藏|地址已隐藏|邮箱已隐藏|路径已隐藏)\]/gu, (_match, label: string) =>
    t(`chat.gwErrors.${({ 已隐藏: "redacted", 地址已隐藏: "redactedUrl", 邮箱已隐藏: "redactedEmail", 路径已隐藏: "redactedPath" } as Record<string, string>)[label]}`));
  const title = FAILURE_SUMMARIES[code] ? t(`chat.gwErrors.${FAILURE_SUMMARIES[code]}`)
    : productErrorMessage(summary, t) ?? t("chat.gwErrors.runtimeFailureSummary", { summary });
  const detailKey = detailLabel === "启动详情" ? "chat.gwErrors.startupDetail" : "chat.gwErrors.providerReason";
  const message = `${title}\n${t(detailKey, { detail })}\n${t("chat.gwErrors.errorCode", { code })}`;
  return prefix ? t("chat.errorPrefix", { msg: message }) : message;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/^(?:错误：)?(?:ANTIGRAVITY_REGION_UNSUPPORTED|Google 模型接口不支持当前请求所在地区，本次任务未完成；请检查服务的地区支持范围和当前网络出口)$/, "regionUnsupported"],
  [/^(?:错误：)?(?:ANTIGRAVITY_TURN_FAILED|Antigravity 本次任务执行失败，上游未提供可展示的具体原因；未自动重放，请查看原生会话后决定是否重试|Antigravity 本次任务执行失败，未自动重放；请重试，若持续失败请在「模型」中检查登录状态)$/, "runtimeFailureNoDetails"],
  [/^(?:错误：)?(?:ANTIGRAVITY_NETWORK_UNAVAILABLE|Antigravity 无法连接 Google 服务，本次任务未完成；请检查代理与网络后重试)$/, "providerNetworkUnavailable"],
  [/^(?:错误：)?(?:ANTIGRAVITY_MCP_UNAVAILABLE|Antigravity 未能加载 Shoggoth 工具，本次任务未完成；请重试，若持续失败请重启 App)$/, "runtimeToolsUnavailable"],
  [/^(?:错误：)?(?:AUTH_REQUIRED|RUNTIME_AUTH_REQUIRED|当前 Agent 登录验证失败，请前往「模型」检查账号状态或重新登录后重试)$/, "runtimeAuthRequired"],
  [/^(?:错误：)?(?:RUNTIME_QUOTA_EXHAUSTED|当前账号额度已用尽，本次请求已停止，不会继续排队。请等待额度恢复、补充额度或更换账号后重试)$/, "runtimeQuotaExceeded"],
  [/^(?:错误：)?(?:RUNTIME_RATE_LIMITED|模型服务限流，本次回复未完成。请稍后重试，或更换模型)$/, "runtimeRateLimited"],
  [/^(?:错误：)?(?:RUNTIME_SPENDING_LIMIT_REACHED|当前账号已达到消费上限，本次请求已停止，不会继续排队。请检查服务商的消费上限设置，恢复后重试)$/, "runtimeSpendingLimit"],
  [/^(?:错误：)?(?:RUNTIME_ACCOUNT_BLOCKED|模型服务商返回账号受限（account blocked），请前往服务商检查账号状态；解除限制或更换可用账号后重试)$/, "runtimeAccountBlocked"],
  [/^(?:错误：)?(?:RUNTIME_UPSTREAM_UNAVAILABLE|上游模型服务不可用，请稍后重试，或选择其他可用模型)$/, "runtimeUpstreamUnavailable"],
  [/^(?:错误：)?(?:RUNTIME_MODEL_UNAVAILABLE|当前账号或登录方式不支持所选模型，请选择其他可用模型)$/, "runtimeModelUnavailable"],
  [/^(?:错误：)?(?:RUNTIME_MODEL_SETTINGS_INVALID|所选模型不支持当前推理档位或服务档位，请调整会话模型设置后重试)$/, "runtimeSettingsInvalid"],
  // Shoggoth durable transcript 会保留稳定错误码；历史重载时仍需显示可操作说明。
  [/^CODEX_PROMPT_TIMEOUT$/, "inputTimeout"],
  [/^(?:错误：)?(?:RUNTIME_MAX_TOKENS|Agent 已达到本轮输出长度限制，本轮未完成；请缩小任务范围后继续)$/, "runtimeMaxTokens"],
  [/^(?:错误：)?(?:RUNTIME_MAX_TURN_REQUESTS|Agent 已达到本轮请求次数限制，本轮已停止；请缩小任务范围后继续)$/, "runtimeMaxTurnRequests"],
  [/^(?:错误：)?(?:RUNTIME_REFUSED|Agent 拒绝了本轮请求，原生会话不会保留这一轮；请调整请求后再发送)$/, "runtimeRefused"],

  // 认证类
  [/^OAuth session expired[.!]?$/i, "oauthExpired"],
  [/^(?:401[ :]+)?invalid (?:x-)?api key[.!]?$/i, "invalidApiKey"],
  // run 死在产出前的两代兜底文案（gateway GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT / transcript 占位）
  [/^agent run failed before producing a reply[.!]?$/i, "runFailedNoReply"],
  [/^assistant turn failed before producing content[.!]?$/i, "runFailedNoReply"],
  // gateway 固定的链路/瞬态文案
  [/^All models are temporarily rate-limited[.!]?$/i, "allModelsRateLimited"],
  [/^(?:You )?exceeded your current quota[.!]?$/i, "quotaExceeded"],
  [/^LLM idle timeout[.!]?$/i, "idleTimeout"],
  [/^initialization conflicted[.!]?$/i, "initConflicted"],
  [/^\W*overloaded\W*$/i, "overloaded"], // Anthropic 透传的单词全串；锚定防误伤含 overloaded 的具体文案
  [/^(?:The )?request was aborted[.!]?$/i, "aborted"],
];

export function translateGatewayError(raw: string, t: TFn): string {
  const detailed = detailedFailure(raw, t);
  if (detailed !== null) return detailed;
  // OpenClaw uses the same bounded copy for live failures and saved history.
  // Match that complete envelope, never a generic HTTP 400 or provider detail.
  const unavailable = /^(错误：)?(?:⚠️\s*)?LLM request failed \(model unavailable(?:, HTTP ([1-5]\d{2}))?\)\. Choose another model or check the model id and provider availability\.$/u.exec(raw.trim());
  if (unavailable) {
    const message = unavailable[2]
      ? t("chat.gwErrors.providerModelUnavailableHttp", { status: unavailable[2] })
      : t("chat.gwErrors.providerModelUnavailable");
    return unavailable[1] ? t("chat.errorPrefix", { msg: message }) : message;
  }
  for (const [re, key] of PATTERNS) {
    if (re.test(raw.trim())) {
      const message = t(`chat.gwErrors.${key}`);
      return raw.startsWith("错误：") ? t("chat.errorPrefix", { msg: message }) : message;
    }
  }
  return translateProductError(raw, t);
}
