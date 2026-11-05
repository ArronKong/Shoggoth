"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createChatReadStateStore } = require("../app/core/chat-read-state-store");
const { createConfigStore } = require("../app/core/config-store");
const { startStaticServer } = require("../app/static-server");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const a = "agent:alpha:main", b = "agent:alpha:cron:reminder";

test("first app start freezes the cutoff before any client; restart and browser changes preserve it", t => {
  const root = fixture(t);
  const store = createChatReadStateStore({ trustedRoot: root, now: () => 1000 });
  store.ensure();
  assert.ok(fs.existsSync(store.filePath), "startup persists without a browser visit");
  const first = store.read();
  assert.equal(first.since, 1000);
  assert.deepEqual(first.read, {});
  const reopened = createChatReadStateStore({ trustedRoot: root, now: () => 9000 });
  assert.deepEqual(reopened.read(), first);
  const other = createChatReadStateStore({ trustedRoot: root, directory: "other-install", now: () => 2000 });
  assert.notEqual(other.read().installationId, first.installationId);
  assert.throws(() => other.merge({ installationId: first.installationId, read: { [a]: 3000 } }),
    { code: "CHAT_READ_STATE_STALE" });
});

test("two clients merge per-session reads monotonically, preserving unseen newer replies", t => {
  const store = createChatReadStateStore({ trustedRoot: fixture(t), now: () => 1000 });
  const first = store.read(), id = first.installationId;
  assert.deepEqual(store.merge({ installationId: id, read: { [a]: 1000 } }), first);
  store.merge({ installationId: id, read: { [a]: 2000 } });
  const merged = store.merge({ installationId: id, read: { [a]: 1500, [b]: 2500 } });
  assert.deepEqual(merged.read, { [a]: 2000, [b]: 2500 });
  assert.equal(merged.revision, 2);
  assert.deepEqual(store.merge({ installationId: id, read: { [a]: 1500 } }), merged,
    "lost/repeated receipt has no extra effect");
  for (const read of [{ invalid: 2000 }, { [a]: -1 }, { [a]: Infinity },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`agent:a:${i}`, 3000]))]) {
    assert.throws(() => store.merge({ installationId: id, read }), { code: "CHAT_READ_STATE_INVALID" });
  }
  assert.throws(() => store.merge({ installationId: id, since: 1, read: {} }), { code: "CHAT_READ_STATE_INVALID" });
  assert.deepEqual(store.read(), merged);
});

test("damaged or missing live state never silently resets the first-launch cutoff", t => {
  const root = fixture(t), store = createChatReadStateStore({ trustedRoot: root, now: () => 1000 });
  store.ensure();
  fs.writeFileSync(store.filePath, "broken");
  assert.throws(() => store.read());
  assert.throws(() => createChatReadStateStore({ trustedRoot: root, now: () => 9000 }).ensure());
  assert.equal(fs.readFileSync(store.filePath, "utf8"), "broken");
  fs.unlinkSync(store.filePath);
  assert.throws(() => store.read(), { code: "ENOENT" });
  assert.ok(!fs.existsSync(store.filePath));
});

test("real REST shares reads, rejects foreign writes and stale installations, and preserves config", async t => {
  const root = fixture(t), configStore = createConfigStore(path.join(root, "config.json"));
  configStore.ensure();
  const beforeConfig = fs.readFileSync(configStore.path);
  const store = createChatReadStateStore({ trustedRoot: root, now: () => 1000 });
  const server = await startStaticServer(0, { registry: {}, configStore, chatReadStateStore: store, homeDir: root });
  t.after(() => server.close());
  const request = async (input, origin = server.url, query = "") => {
    const r = await fetch(server.url + "/__api/chat-read-state" + query, input === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(input),
    });
    const text = await r.text();
    return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : { error: text } };
  };
  const first = (await request()).body.state;
  assert.equal(first.since, 1000);
  const input = { installationId: first.installationId, read: { [a]: 2000 } };
  assert.equal((await request(input, "https://other.invalid")).status, 403);
  assert.equal((await request(input, null)).status, 403);
  assert.equal((await request({ ...input, installationId: "old" })).status, 409);
  assert.equal((await request({ ...input, since: 1 })).status, 400);
  assert.equal((await request(input)).status, 200);
  const secondClient = (await request()).body.state;
  assert.deepEqual(secondClient.read, { [a]: 2000 });
  const query = "?" + new URLSearchParams({ installationId: secondClient.installationId, revision: String(secondClient.revision) });
  assert.equal((await request(undefined, undefined, query)).body.state, null);
  assert.deepEqual(fs.readFileSync(configStore.path), beforeConfig);
  fs.writeFileSync(store.filePath, "fixture private corruption");
  const broken = await request();
  assert.equal(broken.status, 503);
  assert.ok(!JSON.stringify(broken).includes("fixture private"));
});
