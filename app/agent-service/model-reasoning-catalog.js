"use strict";

const effortId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(value);

// An explicit empty list and an explicit negative both override local compatibility data.
function declaredReasoningOptions(model) {
  const capability = model?.capabilities;
  const reasoning = capability?.reasoning ?? model?.reasoning;
  if (model?.reasoning === false || capability?.reasoning === false || reasoning?.supported === false
    || model?.supports_reasoning === false || capability?.supports_reasoning === false) return [];
  const efforts = capability?.supported_efforts ?? model?.supported_efforts ?? model?.supported_reasoning_efforts
    ?? reasoning?.supported_efforts ?? model?.supportedReasoningEfforts;
  if (!Array.isArray(efforts)) return null;
  const canDisable = capability?.can_disable_reasoning ?? model?.can_disable_reasoning ?? reasoning?.can_disable_reasoning;
  const required = canDisable === false || reasoning?.mandatory === true || model?.mandatory === true;
  const options = [...new Set(efforts.map(effort => effort?.reasoningEffort ?? effort).filter(effortId))];
  return (required ? options.filter(effort => effort !== "none" && effort !== "off") : options).slice(0, 16);
}

const MIMO_TOGGLE_MODELS = new Set(["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]);
const RADEON_DEEPSEEK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
// https://amd-aim.github.io/radeon-cloud-docs/models/overview/#supported-reasoning_effort-values
const RADEON_EFFORTS = new Map([
  ["DeepSeek-V4-Flash", RADEON_DEEPSEEK],
  ["DeepSeek-V4-Flash-Vision-Exp", RADEON_DEEPSEEK],
  ["DeepSeek-V4.1-Flash", RADEON_DEEPSEEK],
  ["GLM-5.3-Flash", ["low", "medium", "high"]],
  ["Qwen3.8-27B", ["low", "medium", "xhigh"]],
  ["Qwen3.8-Flash-Next", ["none", "low", "medium", "xhigh"]],
  ["MiMo-V2.6-Flash", []], // Radeon documents that thinking is always on.
]);
// https://docs.volcengine.com/docs/ark/responses-api-deep-thinking?lang=zh
const ARK_EFFORTS = new Map([
  ["deepseek-v4.1-flash", ["none", "low", "high", "max"]],
  ["deepseek-v4-1-flash-261017", ["none", "low", "high", "max"]],
  ["deepseek-v4-1-flash-260910", ["none", "low", "high", "max"]],
  ["deepseek-v4-1-flash-economy-261017", ["none", "low", "high", "max"]],
  ["glm-5.3-flash", ["low", "high", "max"]],
  ["glm-5-3-flash-260828", ["low", "high", "max"]],
  ["kimi-k3.1-pro", ["low", "high", "max"]],
  ["kimi-k3-1-pro-261024", ["low", "high", "max"]],
  ["doubao-seed-2.1-lite", ["none", "low", "medium", "high"]],
  ["doubao-seed-2-1-lite-260915", ["none", "low", "medium", "high"]],
]);

function knownEndpointReasoningOptions(baseUrl, model, transport = "responses") {
  let url;
  try { url = new URL(baseUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const { hostname } = url;
  const root = url.pathname.replace(/\/+$/u, "");
  if (transport === "responses" && ["", "/v1"].includes(root)
    && (hostname === "xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com"))
    && MIMO_TOGGLE_MODELS.has(model)) {
    // https://mimo.mi.com/docs/en-US/api/chat/responses-post
    // All enabled effort values have the same effect. Use one representative.
    return ["none", "high"];
  }
  // Radeon publishes these values for Chat Completions. The Responses catalog
  // must supply its own metadata for that transport.
  if (transport === "chat-completions" && hostname === "developer.amd.com.cn" && root === "/radeon/api/v1") {
    const options = RADEON_EFFORTS.get(model);
    return options ? [...options] : null;
  }
  if (transport === "responses" && hostname === "ark.cn-beijing.volces.com" && ["/api/v3", "/api/plan/v3"].includes(root)) {
    const options = ARK_EFFORTS.get(model);
    return options ? [...options] : null;
  }
  if (hostname === "api.deepseek.com" && ["", "/v1"].includes(root)
    && (["deepseek-flash", "deepseek-v4-pro"].includes(model)
      || transport === "chat-completions" && ["deepseek-v4-flash", "deepseek-v4.1-flash"].includes(model))) {
    // https://api-docs.deepseek.com/guides/thinking_mode/
    return ["none", "low", "high", "max"];
  }
  return null;
}

module.exports = { declaredReasoningOptions, effortId, knownEndpointReasoningOptions };
