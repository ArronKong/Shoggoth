"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { probeClient, capabilitySummary } = require("./antigravity-acp-capability-probe.cjs");

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const frames = [];
  child.stdin.on("data", (chunk) => frames.push(...String(chunk).trim().split("\n").map(JSON.parse)));
  const client = probeClient(child, 100);
  t.after(() => client.close());
  return { child, client, frames, send: (message) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`) };
}

test("ACP isolated probe cannot send a prompt or authenticate and cancels every permission request", async (t) => {
  const f = fixture(t);
  for (const method of ["authenticate", "session/prompt", "session/set_mode", "fs/write_text_file"]) {
    assert.throws(() => f.client.request(method, {}));
  }
  assert.equal(f.frames.length, 0);
  const initializing = f.client.request("initialize", { protocolVersion: 1 });
  f.send({ id: 1, result: { protocolVersion: 1 } });
  assert.deepEqual(await initializing, { result: { protocolVersion: 1 } });
  f.send({ id: "permission", method: "session/request_permission", params: { secret: "not-in-diagnostic" } });
  assert.deepEqual(f.frames.at(-1).result, { outcome: { outcome: "cancelled" } });
  f.send({ id: "write", method: "fs/write_text_file", params: { path: "/must-not-write" } });
  assert.equal(f.frames.at(-1).error.code, -32601);
  assert.ok(!JSON.stringify(f.client.metadata).includes("not-in-diagnostic"));
  assert.ok(!JSON.stringify(f.client.metadata).includes("/must-not-write"));
});

test("ACP isolated probe classifies auth errors without retaining their prose", async (t) => {
  const f = fixture(t);
  const request = f.client.request("session/new", { cwd: "/fixture", mcpServers: [] });
  f.send({ id: 1, error: { code: -32000, message: "Authentication required /private/secret token=secret" } });
  assert.deepEqual(await request, { error: { code: -32000, authRequired: true, unsupported: false } });
});

test("ACP isolated probe bounds malformed/oversized frames and settles process loss", async (t) => {
  for (const mode of ["bad-json", "oversized", "closed"]) {
    const f = fixture(t);
    const request = f.client.request("initialize", {});
    const rejected = assert.rejects(request, { code: mode === "closed" ? "ACP_PROCESS_CLOSED" : "ACP_PROTOCOL_INVALID" });
    if (mode === "closed") f.child.emit("close");
    else f.child.stdout.write(mode === "bad-json" ? "invalid\n" : "x".repeat(1024 * 1024 + 1));
    await rejected;
  }
});

test("ACP advertisement is only a capability summary, never a production-readiness verdict", () => {
  assert.deepEqual(capabilitySummary({ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.1.1" },
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, mcpCapabilities: { http: true } },
    authMethods: [{ id: "oauth-personal" }] }), {
    protocolVersion: 1, agentName: "antigravity-acp", agentVersion: "1.1.1", loadSession: true,
    sessionList: true, mcpHttp: true, mcpSse: false, authMethods: ["oauth-personal"],
  });
});
