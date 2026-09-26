"use strict";

const { serviceError } = require("./security");

const IDENTITY_URL = "https://api.github.com/user";
const MAX_IDENTITY_BYTES = 16 * 1024;
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;

function invalid() {
  throw serviceError("CONNECTION_AUTH_REQUIRED", "GitHub 账号验证失败，请检查令牌后重试");
}

async function verifyGitHubBearer(accessToken, { fetchImpl = globalThis.fetch,
  timeoutMs = 15_000 } = {}) {
  if (typeof accessToken !== "string" || accessToken.length < 1
    || Buffer.byteLength(accessToken) > 16_384 || !TOKEN.test(accessToken)
    || typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 100 || timeoutMs > 30_000) invalid();
  try {
    const response = await fetchImpl(IDENTITY_URL, {
      method: "GET", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}` },
    });
    if (response.status !== 200 || !response.body?.getReader) invalid();
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_IDENTITY_BYTES) {
          await reader.cancel().catch(() => {});
          invalid();
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const identity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!identity || !Number.isSafeInteger(identity.id) || identity.id < 1) invalid();
    return `github:${identity.id}`;
  } catch { invalid(); }
}

module.exports = { verifyGitHubBearer };
