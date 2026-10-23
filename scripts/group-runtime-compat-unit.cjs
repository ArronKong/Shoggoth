"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { requestGroupHost } = require("../app/group-runtime-host-client");
const { validateGroupExternalCapabilitiesParams, validateGroupExternalCapabilitiesResult } = require("../app/external-inspiration-protocol");
const { groupCapabilities } = require("../app/agent-service/group-capabilities");

async function endpoint(t, reply) {
  const hostId = crypto.randomUUID(), calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const frame = JSON.parse(Buffer.concat(chunks)); calls.push(frame);
    const value = reply(frame, hostId); if (value === null) return;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const peer = { id: "peer", hostId, backendId: "hermes", agentId: "helper",
    token: crypto.randomBytes(32).toString("base64url"), baseUrl: `http://127.0.0.1:${server.address().port}/` };
  return { peer, calls };
}

test("v2 client negotiates legacy Host only after explicit parser rejection, with new actions/activity unavailable", async t => {
  const f = await endpoint(t, (frame, hostId) => frame.version === 2
    ? { version: 1, id: frame.id, hostId, ok: false, error: { code: "GROUP_HOST_REQUEST_INVALID" } }
    : { version: 1, id: frame.id, hostId, ok: true, result: { version: 1, hostId, backendId: "hermes", agentId: "helper",
      groupTools: true, workspaces: true, artifacts: true } });
  const value = await requestGroupHost(f.peer, "host.capabilities", { backendId: "hermes", agentId: "helper" });
  assert.equal(value.version, 1); assert.equal(value.capabilities, undefined);
  assert.deepEqual(f.calls.map(frame => frame.version), [2, 1]);
  const identity = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId: "hermes", agentId: "helper",
    sessionKey: "agent:helper:group", workspace: "/private/tmp", mode: "gateway", hostId: crypto.randomUUID() };
  await assert.rejects(requestGroupHost(f.peer, "group.external.activity", identity,
    { groupId: crypto.randomUUID(), ownerId: crypto.randomUUID(), epoch: 1 }), error => error.code === "GROUP_HOST_TOOL_UNSUPPORTED");
  assert.equal(f.calls.length, 2, "unsupported activity is explicit and creates no extra Host operation");
});

test("uncertain execution dispatch times out once and never retries or downgrades", async t => {
  const f = await endpoint(t, () => null);
  const identity = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), backendId: "hermes", agentId: "helper",
    sessionKey: "agent:helper:group", workspace: "/private/tmp", mode: "gateway", hostId: crypto.randomUUID(),
    prompt: "fixture", operationId: "start-fixture" };
  await assert.rejects(requestGroupHost(f.peer, "group.external.start", identity,
    { groupId: crypto.randomUUID(), ownerId: crypto.randomUUID(), epoch: 1 }, { timeoutMs: 25 }), error => error.code === "GROUP_HOST_TIMEOUT");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].version, 2);
});

test("private App bridge capability extensions require explicit v2 opt-in while accepting legacy responses", () => {
  const input = { backendId: "hermes", agentId: "helper" };
  assert.ok(validateGroupExternalCapabilitiesParams(input));
  assert.ok(validateGroupExternalCapabilitiesParams({ ...input, protocolVersion: 2 }));
  assert.equal(validateGroupExternalCapabilitiesParams({ ...input, protocolVersion: 3 }), false);
  assert.ok(validateGroupExternalCapabilitiesResult({ groupTools: true }));
  assert.ok(validateGroupExternalCapabilitiesResult(groupCapabilities({ protocolVersion: 2,
    collaborationSupport: true, groupTools: true, collaborationActions: true, source: "external-binding" })));
});
