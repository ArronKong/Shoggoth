"use strict";

const crypto = require("node:crypto");

// 外部成员的群工具令牌（群聊开发计划 D2）：每个回合 / 任务尝试签发一次，随本轮输入下发；
// 工具调用带上它，宿主据此确定群、成员与轮次。群库只存摘要；回合或尝试结束即失效。
// 形如 gt1.<t|k>.<回合或尝试 id>.<32 字节随机数 base64url>：t=讨论回合，k=任务尝试。
const GROUP_TOOL_GRANT_PATTERN = "^gt1\\.[tk]\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$";
const GRANT = new RegExp(GROUP_TOOL_GRANT_PATTERN, "u");
const GRANT_ANYWHERE = /gt1\.[tk]\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/gu;
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const KIND_CODES = Object.freeze({ turn: "t", task: "k" });

const digestOf = (secret) => crypto.createHash("sha256").update(secret, "utf8").digest("hex");

function createGrantToken(kind, refId) {
  const bytes = crypto.randomBytes(32);
  const secret = bytes.toString("base64url");
  bytes.fill(0);
  return { token: `gt1.${KIND_CODES[kind]}.${refId}.${secret}`, digest: digestOf(secret) };
}

/** @returns {{kind: "turn" | "task", refId: string, digest: string} | null} */
function parseGrantToken(token) {
  if (typeof token !== "string" || !GRANT.test(token)) return null;
  const [, code, refId, secret] = token.split(".");
  return { kind: code === "t" ? "turn" : "task", refId, digest: digestOf(secret) };
}

function sameDigest(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
}

/** 公开文本里出现的令牌一律隐去，不让它进群时间线。 */
function redactGrantTokens(text) {
  return typeof text === "string" ? text.replace(GRANT_ANYWHERE, "[群工具令牌已隐去]") : text;
}

module.exports = {
  GRANT_TTL_MS, GROUP_TOOL_GRANT_PATTERN, createGrantToken, parseGrantToken, redactGrantTokens, sameDigest,
};
