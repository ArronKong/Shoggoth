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

const PATTERNS: Array<[RegExp, string]> = [
  // Shoggoth durable transcript 会保留稳定错误码；历史重载时仍需显示可操作说明。
  [/^CODEX_PROMPT_TIMEOUT$/, "inputTimeout"],
  // 认证类
  [/OAuth session expired/i, "oauthExpired"],
  [/invalid (x-)?api key/i, "invalidApiKey"],
  // run 死在产出前的两代兜底文案（gateway GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT / transcript 占位）
  [/agent run failed before producing a reply/i, "runFailedNoReply"],
  [/assistant turn failed before producing content/i, "runFailedNoReply"],
  // gateway 固定的链路/瞬态文案
  [/All models are temporarily rate-limited/i, "allModelsRateLimited"],
  [/exceeded your current quota/i, "quotaExceeded"],
  [/LLM idle timeout/i, "idleTimeout"],
  [/initialization conflicted/i, "initConflicted"],
  [/^\W*overloaded\W*$/i, "overloaded"], // Anthropic 透传的单词全串；锚定防误伤含 overloaded 的具体文案
  [/request was aborted/i, "aborted"],
];

const URL_RE = /https?:\/\/\S+/;

export function translateGatewayError(raw: string, t: TFn): string {
  for (const [re, key] of PATTERNS) {
    if (re.test(raw)) {
      const translated = t(`chat.gwErrors.${key}`);
      // 原文携带的链接（如配额错误的帮助页）追加保留，翻译不吞细节
      const url = raw.match(URL_RE)?.[0];
      return url && !translated.includes(url) ? `${translated} — ${url}` : translated;
    }
  }
  return raw;
}
