"use strict";

const { PluginMcpClient } = require("./plugin-mcp-client");
const { serviceError } = require("./security");

const ENDPOINT = "https://mcp.cloudflare.com/mcp";
const VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const TOKEN_ID = /^[a-f0-9]{32}$/u;
const MAX_RESPONSE_BYTES = 16 * 1024;

function invalid() {
  throw serviceError("CONNECTION_AUTH_REQUIRED", "Cloudflare 用户 API Token 验证失败");
}

async function boundedJson(response) {
  if (response.status !== 200 || !response.body?.getReader) invalid();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        invalid();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function verifyCloudflareBearer(accessToken, { fetchImpl = globalThis.fetch,
  connectMcp = PluginMcpClient.connectHttp, timeoutMs = 15_000 } = {}) {
  if (typeof accessToken !== "string" || accessToken.length < 1
    || Buffer.byteLength(accessToken) > 16_384 || !TOKEN.test(accessToken)
    || accessToken.startsWith("cfat_") || accessToken.startsWith("cfk_")
    || typeof fetchImpl !== "function" || typeof connectMcp !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) invalid();
  try {
    const identity = await boundedJson(await fetchImpl(VERIFY_URL, {
      method: "GET", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    }));
    if (identity?.success !== true || identity.result?.status !== "active"
      || typeof identity.result.id !== "string" || !TOKEN_ID.test(identity.result.id)) invalid();
    const principalIdentity = `cloudflare-token:${identity.result.id}`;
    const credentialProvider = async () => ({ accessToken, principalIdentity, authRevision: 1 });
    credentialProvider.assertCurrent = () => {};
    // Verification is against both the Cloudflare API and the exact hosted MCP
    // endpoint. A token that cannot initialize and enumerate tools is not a
    // usable plugin connection, even when its API status is active.
    const client = await connectMcp({ url: ENDPOINT, fetchImpl, connectionId: "cloudflare-probe",
      principalIdentity, authRevision: 1, credentialProvider,
      authorizeEgress: () => invalid(), timeoutMs });
    try {
      const tools = await client.listTools();
      if (!Array.isArray(tools) || !tools.some(tool => tool.name === "search")
        || !tools.some(tool => tool.name === "execute")) invalid();
    } finally { await client.close(); }
    return principalIdentity;
  } catch { invalid(); }
}

module.exports = { ENDPOINT, VERIFY_URL, verifyCloudflareBearer };
