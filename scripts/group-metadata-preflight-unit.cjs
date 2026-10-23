"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createFixture } = require("./fixtures/group-store-fixture.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

async function fixture(t, { groupError = null } = {}) {
  const f = createFixture(t);
  const view = await f.service.handle("group.get", { groupId: f.groupId });
  const calls = [];
  const backend = Object.assign(Object.create(ShoggothBackend.prototype), {
    paths: f.paths, readToken: () => "fixture-token", randomUUID,
    serviceStatusTimeoutMs: 1000,
    _generation: 1,
    requestService: async (_paths, request, options) => {
      calls.push({ method: request.method, timeoutMs: options.timeoutMs });
      if (request.method === "service.status") throw Object.assign(new Error("pending health probe"), { code: "REQUEST_TIMEOUT" });
      if (request.method === "group.get") {
        if (groupError) throw Object.assign(new Error("group read unavailable"), { code: groupError });
        return view;
      }
      throw new Error(`Unexpected mutation: ${request.method}`);
    },
  });
  return { f, backend, calls };
}

test("a readable group detail is independent of the short configuration-sync status probe", async t => {
  const { f, backend, calls } = await fixture(t);
  const view = await backend.getGroupChat(f.groupId);
  assert.equal(view.group.id, f.groupId);
  assert.equal(view.ownerScope, f.view().ownerScope);
  assert.deepEqual(calls, [{ method: "group.get", timeoutMs: 5000 }]);
});

test("a real group read failure is preserved instead of substituting cached or successful data", async t => {
  const { f, backend } = await fixture(t, { groupError: "SERVICE_RECOVERY_REQUIRED" });
  await assert.rejects(backend.getGroupChat(f.groupId), { code: "SERVICE_RECOVERY_REQUIRED" });
});
