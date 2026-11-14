"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { createChatHistoryController } = require("../app/manage-ui/src/lib/chatHistoryRuntime.ts");

const key = "agent:fixture:existing";
const otherKey = "agent:fixture:another";
const flush = () => new Promise(resolve => setImmediate(resolve));
const defer = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
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

test("native first paint reuses only the verified session snapshot while history refreshes", async () => {
  const registry = new BackendRegistry();
  const backend = new ShoggothBackend({ paths: { stateDir: "/isolated/state" } });
  registry.register(backend);
  backend._state = "started";
  const profile = { id: "native-profile" };
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  const first = `agent:fixture:${a}`, second = `agent:fixture:${b}`;
  backend._profilesByAgent.set("fixture", profile);
  for (const id of [a, b]) backend._sessionsByKey.set(id, { profileId: profile.id, runtimeBindingId: "binding-a" });
  const identity = registry.getChatCacheScope("shoggoth", first);
  assert.match(identity?.cacheScope ?? "", /^[0-9a-f]{64}$/);
  assert.equal(identity.memoryOnly, true);
  assert.notDeepEqual(registry.getChatCacheScope("shoggoth", second), identity);
  assert.equal(registry.getChatCacheScope("shoggoth", `agent:another:${a}`), null);

  const calls = [], opens = [], commits = [], failures = [];
  const unexpected = () => assert.fail("native history never uses the persistent cache");
  const controller = createChatHistoryController({
    backendOfSession: () => "shoggoth", agentOfSession: () => "fixture",
    getCacheScope: async (owner, session) => {
      const value = registry.getChatCacheScope(owner, session);
      return value && { scope: value.cacheScope, memoryOnly: value.memoryOnly };
    },
    getCached: unexpected, putCached: unexpected, deleteCached: unexpected, clearCachedExcept: unexpected,
    prepare: async (_key, messages) => messages.map(message => ({ ...message, prepared: true })),
    requestCanonical: key => { const gate = defer(); calls.push({ key, gate }); return gate.promise; },
    isInFlight: () => false, commitOpen: (key, messages, visible) => opens.push({ key, messages, visible }),
    commitCanonical: (key, messages) => commits.push({ key, messages }),
    commitFailure: (_key, error) => failures.push(error.code),
  });
  const switchTo = async key => {
    await controller.open(key);
    assert.equal(calls.at(-1).key, key);
    return calls.at(-1).gate;
  };
  const opened = (key, id) => assert.deepEqual(opens.at(-1), {
    key, visible: !!id, messages: id ? [{ id, prepared: true }] : [],
  });

  const initial = await switchTo(first);
  opened(first);
  initial.resolve([{ id: "old" }]); await flush();
  const secondRead = await switchTo(second);
  opened(second);
  const refreshing = await switchTo(first);
  opened(first, "old");
  secondRead.resolve([{ id: "late second" }]); await flush();
  assert.deepEqual(commits.map(row => row.key), [first]);
  refreshing.resolve([{ id: "latest" }]); await flush();
  assert.equal(commits.at(-1).messages[0].id, "latest");

  const previousGeneration = await switchTo(first);
  opened(first, "latest");
  backend._sessionsByKey.get(a).runtimeBindingId = "binding-b";
  const beforeScopeRetry = calls.length;
  previousGeneration.resolve([{ id: "wrong binding" }]); await flush();
  opened(first);
  assert.equal(commits.at(-1).messages[0].id, "latest");
  assert.notDeepEqual(registry.getChatCacheScope("shoggoth", first), identity);

  assert.equal(calls.length, beforeScopeRetry + 1, "a changed source revalidates the same selection");
  calls.at(-1).gate.resolve([{ id: "new source" }]); await flush();
  const removedSource = await switchTo(first);
  opened(first, "new source");
  removedSource.reject(Object.assign(new Error("source changed"), { code: "TRANSCRIPT_SOURCE_CHANGED" }));
  await flush();
  opened(first);
  assert.deepEqual(failures, ["TRANSCRIPT_SOURCE_CHANGED"]);
  const recovered = await switchTo(first);
  opened(first);
  recovered.resolve([{ id: "new source" }]); await flush();
  const beforeDelete = await switchTo(first);
  opened(first, "new source");
  await controller.delete(first);
  beforeDelete.resolve([{ id: "late deleted" }]); await flush();
  const reopened = await switchTo(first);
  opened(first);
  reopened.resolve([]); await flush();
  assert.deepEqual(commits.at(-1).messages, []);
  backend._state = "stopped";
  assert.equal(registry.getChatCacheScope("shoggoth", first), null);
});

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
