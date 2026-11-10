#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createFixture } = require("./fixtures/hermes-agent-rename.cjs");

async function fixture(t) {
  const f = await createFixture();
  t.after(() => f.close());
  return f;
}

test("default display name reaches Agent list/detail and chat roster without changing identity", async t => {
  const f = await fixture(t);
  f.profiles[0].display_name = "  中文助理  ";
  f.profiles[1].display_name = "Writing Assistant";
  await f.backend._refreshAgentsFor(f.backend._defaultDash());
  assert.deepEqual(f.backend.getAgents().map(({ id, name }) => ({ id, name })), [
    { id: "hermes-default", name: "中文助理" },
    { id: "hermes-writer", name: "writer" },
  ]);
  assert.equal((await f.request()).body.agent.name, "中文助理");
  assert.equal((await f.request("")).body.agents.find(agent => agent.id === "hermes-default").name, "中文助理");
  assert.equal(f.backend.profileById.get("hermes-default"), "default");
});

test("default rename returns its existing ID and can reload the saved name repeatedly", async t => {
  const f = await fixture(t);
  const dashboard = f.backend.dashboards.get("default");
  for (const name of ["My Hermes", "中文助理", "writer", "default"]) {
    const response = await f.request("/hermes-default", "PUT", { name });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.result, { ok: true, id: "hermes-default" });
    assert.equal((await f.request()).body.agent.name, name);
    assert.equal(f.backend.profileById.get("hermes-default"), "default");
    assert.equal(f.backend.dashboards.get("default"), dashboard);
    assert.equal(f.backend.getAgents().length, 2);
  }
  assert.equal(f.writes.length, 4, "resetting a display name to the canonical name is a real write");
  assert.equal(f.state.notifications, 4, "chat consumers are notified after the name changes");
  assert.deepEqual(f.state.startedProfiles, [], "display-name changes keep the existing dashboard");
  assert.equal(f.backend.getAgents().find(agent => agent.id === "hermes-writer").name, "writer");
  // Re-reading the upstream source (as at startup) must retain the saved label.
  f.backend._installProfileRows([]);
  await f.backend._refreshAgentsFor(dashboard);
  assert.equal((await f.request()).body.agent.name, "default");
});

test("saving the existing editable name does not rename a profile or repeat a write", async t => {
  const f = await fixture(t);
  f.profiles[0].display_name = "中文助理";
  f.profiles[1].display_name = "Writing Assistant";
  await f.backend._refreshAgentsFor(f.backend._defaultDash());
  for (const [id, name] of [["hermes-default", "中文助理"], ["hermes-writer", "writer"]]) {
    assert.deepEqual((await f.request(`/${id}`, "PUT", { name })).body.result, { ok: true, id });
  }
  assert.equal(f.writes.length, 0);
});

test("a default rename with an older receipt still keeps the default ID", async t => {
  const f = await fixture(t);
  f.state.omitReceiptName = true;
  assert.deepEqual((await f.request("/hermes-default", "PUT", { name: "Assistant" })).body.result,
    { ok: true, id: "hermes-default" });
  assert.equal((await f.request()).body.agent.name, "Assistant");
});

test("ordinary profile rename retains canonical re-keying and rejects identity collisions", async t => {
  const f = await fixture(t);
  const rejected = await f.request("/hermes-writer", "PUT", { name: "default" });
  assert.notEqual(rejected.status, 200);
  assert.equal(f.writes.length, 0);
  let closed = 0, stopped = 0;
  f.backend.gwSockets.set("writer", { close() { closed++; } });
  f.backend.acpClients.set("writer", { stop() { stopped++; } });
  const renamed = await f.request("/hermes-writer", "PUT", { name: "Editor" });
  assert.deepEqual(renamed.body.result, { ok: true, id: "hermes-editor" });
  assert.equal(f.backend.profileById.get("hermes-editor"), "editor");
  assert.equal(f.backend.profileById.has("hermes-writer"), false);
  const detail = await f.request("/hermes-editor");
  assert.equal(detail.status, 200, "renamed profile must immediately have a dashboard for its detail");
  assert.equal(detail.body.agent.name, "editor");
  assert.deepEqual(f.state.startedProfiles, ["editor"]);
  assert.equal(f.backend.dashboards.has("writer"), false);
  assert.equal(f.backend.gwSockets.has("writer"), false);
  assert.equal(f.backend.acpClients.has("writer"), false);
  assert.equal(closed, 1);
  assert.equal(stopped, 1);
});

test("a rejected rename preserves the old name, routing and notification state", async t => {
  const f = await fixture(t);
  f.state.rejectRename = true;
  const response = await f.request("/hermes-default", "PUT", { name: "Rejected" });
  assert.notEqual(response.status, 200);
  assert.equal((await f.request()).body.agent.name, "default");
  assert.equal(f.backend.profileById.get("hermes-default"), "default");
  assert.equal(f.state.notifications, 0);
});

test("a profile slug change with the same normalized Agent ID still rebinds its dashboard", async t => {
  const f = await fixture(t);
  f.profiles[1].name = "foo-bar";
  f.backend.dashboards.delete("writer");
  f.backend.dashboards.set("foo-bar", { ...f.backend._defaultDash(), profile: "foo-bar" });
  await f.backend._refreshAgentsFor(f.backend._defaultDash());
  const response = await f.request("/hermes-foo-bar", "PUT", { name: "foo_bar" });
  assert.deepEqual(response.body.result, { ok: true, id: "hermes-foo-bar" });
  assert.deepEqual(f.state.startedProfiles, ["foo_bar"]);
  assert.equal(f.backend.dashboards.has("foo-bar"), false);
  assert.equal((await f.request("/hermes-foo-bar")).body.agent.profile, "foo_bar");
});

test("a renamed profile whose new dashboard fails to start does not report success", async t => {
  const f = await fixture(t);
  f.backend._spawnOrReuseDashboard = async () => { throw Error("fixture startup failed"); };
  const response = await f.request("/hermes-writer", "PUT", { name: "editor" });
  assert.notEqual(response.status, 200);
  assert.match(response.body.error, /dashboard/);
  assert.equal(f.backend.dashboards.has("writer"), false);
  assert.equal(f.backend.dashboards.has("editor"), false);
  assert.equal(f.backend.profileById.get("hermes-editor"), "editor", "preserve the confirmed rename for recovery");
  assert.equal(f.state.notifications, 0);
});

test("disconnecting while the renamed dashboard starts cannot publish a stale success", async t => {
  const f = await fixture(t);
  const start = f.backend._spawnOrReuseDashboard;
  f.backend._spawnOrReuseDashboard = async profile => {
    const dashboard = await start(profile);
    await f.backend.stop();
    return dashboard;
  };
  const response = await f.request("/hermes-writer", "PUT", { name: "editor" });
  assert.notEqual(response.status, 200);
  assert.equal(f.backend.dashboards.size, 0);
  assert.equal(f.state.notifications, 0);
});
