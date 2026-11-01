"use strict";
const http = require("node:http");
const { serviceError } = require("./security");
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 1024 * 1024;
function validOAuthToken(value) {
  // Tokens are opaque: Workers OAuth Provider, for example, uses user:grant:secret.
  // Preserve visible ASCII verbatim while rejecting whitespace, controls and oversized headers.
  return typeof value === "string" && value.length > 0 && value.length <= 16384 && /^[\x21-\x7e]+$/u.test(value);
}
function validatedQuerySecrets(value = {}) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => key !== "key")
    || Object.values(value).some(entry => !validOAuthToken(entry))) throw serviceError("MCP_SECRET_INVALID", "MCP Query 凭据无效");
  return { ...value };
}
function validatedQueryCredentials(transport, value = {}) {
  const query = validatedQuerySecrets(value);
  if (!Object.keys(query).length) return query;
  // This provider documents only query authentication. Keep the credential out
  // of the stored endpoint and bind injection to its reviewed HTTPS paths.
  if (transport?.kind !== "remote" || transport.protocol !== "streamable-http"
    || !["https://mcp.didichuxing.com/mcp-servers", "https://mcp.didichuxing.com/mcp-servers-sandbox"].includes(transport.url)) {
    throw serviceError("MCP_SERVER_URL_INVALID", "MCP Query 凭据与服务地址不匹配");
  }
  return query;
}
function querySecretVariants(query = {}) {
  return [...new Set(Object.values(query || {}).filter(value => typeof value === "string" && value.length).flatMap(value => {
    const encoded = [encodeURIComponent(value), new URLSearchParams({ key: value }).toString().slice(4)];
    return [value, ...encoded, ...encoded.map(text => text.replace(/%[A-F0-9]{2}/gu, part => part.toLowerCase()))];
  }))];
}
function endpointOf(value) {
  let url;
  try { url = new URL(value); } catch { throw serviceError("MCP_SERVER_URL_INVALID", "MCP URL 无效"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.hash) throw serviceError("MCP_SERVER_URL_INVALID", "MCP 连接需要 HTTPS 或本机回环地址");
  return url;
}
function boundedJson(value, maxBytes = MAX_RESPONSE_BYTES) {
  let json;
  try { json = JSON.stringify(value); } catch {}
  if (typeof json !== "string") throw serviceError("MCP_SERVER_RESPONSE_INVALID", "MCP 响应不是有效 JSON");
  if (Buffer.byteLength(json) > maxBytes) throw serviceError("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP 响应超过容量上限");
  return JSON.parse(json);
}
function boundedHttpResponse(response) {
  if (!response || !Number.isInteger(response.status) || !response.headers) throw serviceError("MCP_SERVER_RESPONSE_INVALID", "MCP HTTP 响应无效");
  const limit = (response.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream") ? MAX_STREAM_BYTES : MAX_RESPONSE_BYTES;
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > limit) {
    void response.body?.cancel().catch(() => {});
    throw serviceError("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP HTTP 响应超过容量上限");
  }
  if (!response.body) return response;
  let bytes = 0;
  return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw serviceError("MCP_SERVER_RESPONSE_TOO_LARGE", "MCP HTTP 响应超过容量上限");
    controller.enqueue(chunk);
  } })), { status: response.status, statusText: response.statusText, headers: response.headers });
}
function validatedHeaders(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw serviceError("MCP_SECRET_INVALID", "MCP Header 无效");
  for (const [name, entry] of Object.entries(value)) {
    try { http.validateHeaderName(name); http.validateHeaderValue(name, entry); } catch { throw serviceError("MCP_SECRET_INVALID", "MCP Header 无效"); }
    if (typeof entry !== "string" || entry.length > 16384 || ["host", "content-length", "connection", "transfer-encoding"].includes(name.toLowerCase())) throw serviceError("MCP_SECRET_INVALID", "MCP Header 无效");
  }
  return value;
}
module.exports = { endpointOf, boundedJson, boundedHttpResponse, validatedHeaders, validOAuthToken, validatedQuerySecrets, validatedQueryCredentials, querySecretVariants, MAX_RESPONSE_BYTES, MAX_STREAM_BYTES };
