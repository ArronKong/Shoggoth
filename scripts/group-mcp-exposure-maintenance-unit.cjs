"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMcpStdioHandler, MCP_STDIO_PROTOCOL_VERSION, MCP_SERVICE_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { GroupNativeToolExposure } = require("../app/agent-service/group-native-tool-exposure");
async function fixture({ list = true, failRefresh = false } = {}) {
  let clock = 0, refreshes = 0, tick, cleared = 0;
  const oldToken = Buffer.alloc(32, 1).toString("base64url"), newToken = Buffer.alloc(32, 2).toString("base64url");
  const tokens = new Map([[oldToken, 300_000]]), methods = [];
  const binding = { runtimeProfileId: "runtime-a", runtimeAccountId: "runtime-a-account" };
  const exposure = new GroupNativeToolExposure({ now: () => clock });
  const handler = createMcpStdioHandler({ ...binding, reportGroupExposure: true,
    sessionToken: oldToken, sessionExpiresAt: 300_000, now: () => clock,
    setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval: () => { cleared++; },
    refreshSession: async () => { refreshes++; if (failRefresh) throw Error("private refresh failure");
      tokens.set(newToken, clock + 300_000);
      return { token: newToken, protocolVersion: MCP_SERVICE_PROTOCOL_VERSION, ...binding, profileId: "profile-a", expiresAt: clock + 300_000 }; },
    requestService: async (_paths, request) => { methods.push(request.method);
      assert.equal(request.method, "mcp.group.exposure");
      return exposure.record(request.params, { authorize: () => { if ((tokens.get(request.params.sessionToken) || 0) <= clock) throw Error("expired"); } }); },
  });
  await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
  if (list) await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  return { handler, exposure, binding, methods, setClock(n) { clock = n; },
    tick() { return tick?.(); }, counters() { return { refreshes, cleared, scheduled: Boolean(tick) }; } };
}

test("an idle connected Runtime keeps its observed group tools across the five-minute session expiry", async () => {
  const f = await fixture();
  try {
    assert.equal(f.exposure.capability(f.binding).collaborationActions, true);
    f.setClock(250_000); await f.handler.maintainGroupExposure();
    f.setClock(310_000);
    assert.equal(f.exposure.capability(f.binding).collaborationActions, true);
    assert.equal(f.counters().refreshes, 1);
    assert.ok(f.methods.every(method => method === "mcp.group.exposure"), "maintenance never invokes a product or model tool");
    assert.equal(f.counters().scheduled, true);
  } finally { f.handler.close(); }
  assert.equal(f.counters().cleared, 1);
  assert.equal(await f.handler.maintainGroupExposure(), false);
});

test("a configured helper without a consumed tools/list page performs no background authentication", async () => {
  const f = await fixture({ list: false });
  try {
    f.setClock(310_000); assert.equal(await f.handler.maintainGroupExposure(), false);
    assert.equal(f.counters().refreshes, 0); assert.equal(f.counters().scheduled, false);
    assert.equal(f.exposure.capability(f.binding).collaborationActions, false);
  } finally { f.handler.close(); }
});

test("failed renewal never fabricates proof after expiry, and close clears the scheduled heartbeat", async () => {
  const f = await fixture({ failRefresh: true });
  try {
    f.setClock(310_000); await assert.rejects(f.handler.maintainGroupExposure());
    assert.equal(f.exposure.capability(f.binding).collaborationActions, false);
  } finally { f.handler.close(); }
  assert.equal(f.counters().cleared, 1);
});
