// Lobe Icons attribution and MIT terms: resources/legal/licenses/source/LOBE-ICONS.txt
// Per-directory provenance: resources/legal/source-components.json.
// 提供方 logo（模型 Provider 分组行的行首图标）。
//
// 为什么内联 SVG 而不是 <img>：35 个里有 16 个是 `fill="currentColor"` 的单色标，
// 走 <img> 拿不到继承色，暗色主题下会糊成黑块。内联后它们跟着文字色走，另外
// 19 个固定品牌色的照常显示。素材统一是 lobe-icons 形制（viewBox + width/height
// = 1em），所以尺寸由容器的 font-size 决定，不用逐个改属性。
//
// dangerouslySetInnerHTML 的安全边界：这些 SVG 是**构建期打进包**的本地静态资源，
// 不是运行时数据，且入库前已扫过——无 <script>、无 on* 事件、无 http(s) 外链。
import styles from "./KeysPanel.module.css";

// eager + ?raw：35 个标一共约 155KB 源码，进主 chunk 换取零请求与继承色。
const RAW = import.meta.glob("../../assets/provider-logos/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// 文件名（不含扩展名）-> SVG 源码
const BY_SLUG: Record<string, string> = {};
for (const [path, svg] of Object.entries(RAW)) {
  const slug = path.slice(path.lastIndexOf("/") + 1).replace(/\.svg$/, "");
  BY_SLUG[slug] = svg;
}

// 分组名规范化后多数直接等于文件名；这张表只收「对不上的那几个」。
// 键是规范化后的值（小写、非字母数字折成 -、去首尾 -），因此同时覆盖服务端
// 下发的 provider_label 与 KeysPanel 里 PROVIDER_GROUPS 的兜底名。
// OAuth 卡按 provider **id**（slug）取图标，模型 Provider 卡按分组显示名取，两套
// 都归到这张表里——id 是稳定标识，比长显示名（"Anthropic OAuth: …"）可靠。
const ALIASES: Record<string, string> = {
  nous: "nous-portal",
  "openai-codex": "openai-api",
  "minimax-oauth": "minimax",
  "qwen-oauth": "qwen-cloud",
  "xai-oauth": "xai",
  "claude-code": "anthropic",
  "deepseek-harness": "deepseek",
  "copilot-acp": "github-copilot",
  copilot: "github-copilot",
  "alibaba-cloud-coding-plan": "alibaba-cloud",
  "kimi-kimi-coding-plan": "kimi",
  "kimi-coding-plan": "kimi",
  "kimi-moonshot": "kimi",
  "kimi-moonshot-china": "moonshot-china",
  "kimi-moonshot-cn": "moonshot-china",
  "kimi-china": "moonshot-china",
  novitaai: "novita-ai",
  "stepfun-step-plan": "stepfun",
  "z-ai-glm": "zai-glm",
  "glm-z-ai": "zai-glm",
  "hugging-face": "huggingface",
  gemini: "google-ai-studio",
  "google-gemini": "google-ai-studio",
  // OpenClaw 目录 id（提供方页签：OAuth 卡按 id、目录卡按 logoKey=id 取）
  openai: "openai-api",
  google: "google-ai-studio",
  "google-gemini-cli": "google-ai-studio",
  "minimax-portal": "minimax",
  "minimax-china": "minimax-china",
  "microsoft-foundry": "azure-foundry",
  azure: "azure-foundry",
  "claude-cli": "anthropic",
  "copilot-proxy": "github-copilot",
  xiaomi: "xiaomi-mimo",
  "xiaomi-token-plan": "xiaomi-mimo",
  novita: "novita-ai",
  nvidia: "nvidia-nim",
  ollama: "ollama-cloud",
  lmstudio: "lm-studio",
  moonshot: "kimi",
  alibaba: "alibaba-cloud",
  "google-vertex": "google-vertex-ai",
  opencode: "opencode-go",
  qwen: "qwen-cloud",
};

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 分组名 -> logo SVG 源码；认不出来返回空串（调用方留位不留图）。 */
export function providerLogoFor(name: string): string {
  const slug = normalize(name);
  return BY_SLUG[ALIASES[slug] || slug] || "";
}

export default function ProviderLogo({ name }: { name: string }) {
  const svg = providerLogoFor(name);
  // 认不出的 provider 也占位：少一个图标不能让整列名字错位。
  if (!svg) return <span className={styles.logo} aria-hidden="true" />;
  return (
    <span
      className={styles.logo}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
