"use strict";

const ENDPOINT = "https://mcp.shop.com/", RESOURCE = "https://mcp.shop.com", PROTOCOL = "2026-07-28";
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function readJson(response) {
  const limit = 4 * 1024 * 1024, chunks = []; let size = 0;
  if (Number(response.headers?.get?.("content-length") || 0) > limit) fail("OFFICIAL_SKILL_UNAVAILABLE");
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); fail("OFFICIAL_SKILL_UNAVAILABLE"); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
  } else { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > limit) fail("OFFICIAL_SKILL_UNAVAILABLE"); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("OFFICIAL_SKILL_UNAVAILABLE"); }
}
function createShopMcpClient({ fetch, getToken = () => null } = {}) {
  let nextId = 0;
  async function rpc(method, params = {}, { signal, anonymous = false } = {}) {
    signal?.throwIfAborted();
    const id = ++nextId, token = anonymous ? null : getToken();
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, "Mcp-Method": method };
    if (method === "tools/call") headers["Mcp-Name"] = params.name;
    if (["skills/get", "resources/read"].includes(method)) headers["Mcp-Name"] = params.uri;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try { response = await fetch(ENDPOINT, { method: "POST", redirect: "error", headers,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "shoggoth", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }) }); }
    catch (error) { if (signal?.aborted) throw error; fail("OFFICIAL_SKILL_UNAVAILABLE"); }
    if (response.status === 401) throw Object.assign(new Error("OFFICIAL_SKILL_AUTH_REQUIRED"), { code: "OFFICIAL_SKILL_AUTH_REQUIRED", shopNotDispatched: true });
    if (response.status === 403) fail("OFFICIAL_SKILL_ACCESS_DENIED");
    if (!response.ok) fail("OFFICIAL_SKILL_UNAVAILABLE");
    const message = await readJson(response);
    if (message?.jsonrpc !== "2.0" || message.id !== id || message.error || !message.result || typeof message.result !== "object") fail("OFFICIAL_SKILL_UNAVAILABLE");
    return message.result;
  }
  async function call(name, args, signal) {
    const result = await rpc("tools/call", { name, arguments: args }, { signal });
    let data = result.structuredContent;
    if (data === undefined) {
      try { data = JSON.parse(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n")); }
      catch { data = { content: result.content || [] }; }
    }
    return result.isError ? { ok: false, error: { code: "provider_error", details: data } } : { ok: true, data };
  }
  return { rpc, call };
}
module.exports = { ENDPOINT, RESOURCE, PROTOCOL, createShopMcpClient, readJson };
