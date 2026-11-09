"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { createChatHistoryController } = require("../app/manage-ui/src/lib/chatHistoryRuntime.ts");

const key = "agent:fixture:existing";
const otherKey = "agent:fixture:another";
const flush = () => new Promise(resolve => setImmediate(resolve));
function mockClock(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  return async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
}

function fixture({ readyAt = Infinity, unavailableCode = "SERVICE_UNAVAILABLE" } = {}) {
  const serviceReads = [], gatewayReads = [], commits = [], failures = [];
  const transport = { connected: true };
  const registry = new BackendRegistry();
  registry.register({
    id: "openclaw",
    ownsAgentId: id => id === "fixture",
    getHistoryPage: async (sessionKey) => {
      gatewayReads.push(sessionKey);
      return { messages: [{ id: sessionKey }], hasMore: false, nextCursor: null, sourceId: "fixture" };
    },
  });
  registry.setInspirationOwner(new ShoggothBackend({
    paths: {}, readToken: () => "fixture-token",
    requestService: async (_paths, request) => {
      assert.equal(request.method, "inspiration.session.get");
      serviceReads.push(request.params.sessionKey);
      if (request.params.sessionKey === key && Date.now() < readyAt) {
        throw Object.assign(new Error("Service not ready"), { code: unavailableCode });
      }
      return { origin: null };
    },
  }));
  const controller = createChatHistoryController({
    backendOfSession: () => "openclaw", agentOfSession: () => "fixture",
    getCached: async () => undefined, putCached: async () => {}, deleteCached: async () => {}, clearCachedExcept: async () => {},
    prepare: async (_key, messages) => messages,
    requestCanonical: async sessionKey => {
      if (!transport.connected) throw Object.assign(new Error("Socket not open"), { requestNotSent: true });
      return (await registry.getChatHistoryPage(sessionKey)).payload.messages;
    },
    isInFlight: () => false, commitOpen: () => {},
    commitCanonical: sessionKey => commits.push(sessionKey),
    commitFailure: (_key, error) => failures.push(error.code),
  });
  return { controller, serviceReads, gatewayReads, commits, failures, transport };
}

test("existing gateway history waits for cold local Service and then loads through its verified route", async (t) => {
  const advance = mockClock(t);
  const f = fixture({ readyAt: 18_500 });
  f.transport.connected = false;
  await f.controller.open(key);
  await flush();
  assert.deepEqual(f.serviceReads, [], "the first read was not sent before socket open");
  assert.deepEqual(f.failures, []);
  f.transport.connected = true;
  await f.controller.load(key);
  assert.deepEqual(f.serviceReads, [key]);
  assert.deepEqual(f.gatewayReads, [], "do not bypass the inspiration ownership check");
  assert.deepEqual(f.failures, [], "temporary startup failure is not a hard history error");
  for (let elapsed = 2_000; elapsed <= 20_000; elapsed += 2_000) {
    await advance(2_000);
  }
  assert.deepEqual(f.gatewayReads, [key]);
  assert.deepEqual(f.commits, [key]);
  assert.deepEqual(f.failures, []);
});

test("persistent unavailability ends the initial retry window with the original error", async (t) => {
  const advance = mockClock(t);
  const f = fixture();
  await f.controller.open(key);
  await flush();
  for (let elapsed = 2_000; elapsed <= 30_000; elapsed += 2_000) {
    assert.deepEqual(f.failures, []);
    await advance(2_000);
  }
  assert.deepEqual(f.failures, ["SERVICE_UNAVAILABLE"]);
  assert.deepEqual(f.gatewayReads, []);
  assert.equal(f.serviceReads.length, 16);
  await advance(60_000);
  assert.equal(f.serviceReads.length, 16);
});

test("a Service requiring explicit recovery is reported immediately", async (t) => {
  const advance = mockClock(t);
  const f = fixture({ unavailableCode: "SERVICE_RECOVERY_REQUIRED" });
  await f.controller.open(key);
  await flush();
  assert.deepEqual(f.failures, ["SERVICE_RECOVERY_REQUIRED"]);
  await advance(30_000);
  assert.deepEqual(f.serviceReads, [key]);
  assert.deepEqual(f.gatewayReads, []);
});

test("changing session or leaving the page cancels the old initial read retry", async (t) => {
  const advance = mockClock(t);
  const f = fixture();
  await f.controller.open(key);
  await flush();
  await f.controller.open(otherKey);
  await advance(2_000);
  assert.deepEqual(f.serviceReads, [key, otherKey]);
  assert.deepEqual(f.commits, [otherKey]);
  await f.controller.open(key);
  await flush();
  f.controller.cancelInitialReadRetry();
  await advance(30_000);
  assert.deepEqual(f.serviceReads, [key, otherKey, key]);
  assert.deepEqual(f.failures, []);
});
