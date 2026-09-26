// Hermes 内置 provider 的默认接口地址。
//
// 为什么要在前端存一份：Hermes 不外发这个值。dashboard 的 `/api/model/options`
// 每行有 `api_url`，但只有**用户自建**的 provider（config.yaml `providers:` 里那些）
// 才填，内置 provider 一律是 null——内置地址写死在各自的 ProviderProfile 里，
// 从没进过任何 HTTP 响应。模型页要把它显示出来（不可改的那些直接展示，可改的
// 那些当默认值提示），只能自己带一份。
//
// 数据不是手抄的，是从本机 Hermes 运行时导出的：
//
//   cd ~/.hermes/hermes-agent && ./venv/bin/python -c "
//   import sys; sys.path.insert(0,'.')
//   from providers import list_providers
//   from hermes_cli.auth import PROVIDER_REGISTRY
//   out={p.name: p.base_url for p in list_providers() if p.base_url}
//   for k,v in PROVIDER_REGISTRY.items():
//       out.setdefault(k, v.inference_base_url or '')
//   print(out)"
//
// 键是 provider slug（`/api/env` 每条变量的 `provider` 字段），不是显示名——
// 显示名会随 i18n 和上游文案变，slug 不会。
//
// 维护约定：Hermes 升级后若某家换了地址，这里会显示旧值。它只用于**展示**，
// 不参与任何请求，所以错了不会把流量打到错误的地址，最坏是提示过时。
// 重新跑上面那条命令即可校准。快照时间：2026-07-25，Hermes 0.19.x。
const HERMES_BUILTIN_ENDPOINTS: Record<string, string> = {
  alibaba: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "alibaba-coding-plan": "https://coding-intl.dashscope.aliyuncs.com/v1",
  anthropic: "https://api.anthropic.com",
  arcee: "https://api.arcee.ai/api/v1",
  bedrock: "https://bedrock-runtime.us-east-1.amazonaws.com",
  copilot: "https://api.githubcopilot.com",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  deepseek: "https://api.deepseek.com/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  gmi: "https://api.gmi-serving.com/v1",
  huggingface: "https://router.huggingface.co/v1",
  kilocode: "https://api.kilo.ai/api/gateway",
  "kimi-coding": "https://api.moonshot.ai/v1",
  "kimi-coding-cn": "https://api.moonshot.cn/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  minimax: "https://api.minimax.io/anthropic",
  "minimax-cn": "https://api.minimaxi.com/anthropic",
  nous: "https://inference-api.nousresearch.com/v1",
  novita: "https://api.novita.ai/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  "ollama-cloud": "https://ollama.com/v1",
  "openai-api": "https://api.openai.com/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  openrouter: "https://openrouter.ai/api/v1",
  stepfun: "https://api.stepfun.ai/step_plan/v1",
  "tencent-tokenhub": "https://tokenhub.tencentmaas.com/v1",
  upstage: "https://api.upstage.ai/v1",
  vertex: "https://aiplatform.googleapis.com",
  xai: "https://api.x.ai/v1",
  xiaomi: "https://api.xiaomimimo.com/v1",
  zai: "https://api.z.ai/api/paas/v4",
};

/** provider slug → 内置接口地址；不认识的（azure-foundry / custom 这类要用户自填的）回空串。 */
export function builtinEndpointFor(slug: string): string {
  return HERMES_BUILTIN_ENDPOINTS[slug.trim().toLowerCase()] || "";
}
