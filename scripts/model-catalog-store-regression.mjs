#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { build } from "../app/manage-ui/node_modules/esbuild/lib/main.js";

// Node 18 没有浏览器 CustomEvent；测试用最小兼容实现保留 detail 语义。
if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

// 从真实 TypeScript 入口内存打包后导入，连同其 API 边界依赖一起验证。
async function loadStoreModule() {
  const sourcePath = path.resolve("app/manage-ui/src/model-catalog-store.ts");
  fs.accessSync(sourcePath);
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const output = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

// 可枚举的内存 Storage，行为足以覆盖浏览器 localStorage 契约。
class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

// 模拟隐私模式/配额耗尽：所有持久化写入失败，但读取接口仍合法存在。
class FailingWriteStorage extends MemoryStorage {
  setItem() { throw new DOMException("quota", "QuotaExceededError"); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000;
const revisions = {
  one: "1".repeat(64),
  two: "2".repeat(64),
  three: "3".repeat(64),
  late: "4".repeat(64),
};

function model(backendId, id) {
  return { id, name: id.toUpperCase(), provider: "alpha", backendId };
}

function snapshot(backendId, catalogRevision, id, verifiedAt = NOW) {
  return { backendId, catalogRevision, models: [model(backendId, id)], verifiedAt };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

let storeModule;
try {
  storeModule = await loadStoreModule();
} catch (error) {
  console.error(`model catalog store regression: FAIL\n- load: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const { createModelCatalogStore } = storeModule;

test("v2 内容与 current 指针分离，每个 backend 仅保留最近两个 revision", () => {
  const storage = new MemoryStorage();
  const store = createModelCatalogStore({ storage, events: new EventTarget(), now: () => NOW });
  store.publishApplied(snapshot("openclaw", revisions.one, "one", NOW - 20));
  store.publishApplied(snapshot("openclaw", revisions.two, "two", NOW - 10));
  store.publishApplied(snapshot("openclaw", revisions.three, "three", NOW));

  assert.equal(store.read("openclaw").catalogRevision, revisions.three);
  const keys = [...storage.values.keys()].filter((key) => key.includes(".entry.openclaw."));
  assert.equal(keys.length, 2);
  assert.equal(keys.some((key) => key.endsWith(revisions.one)), false);
  assert.equal(storage.getItem("shoggoth.models.v2.current.openclaw"), revisions.three);
});

test("legacy v1 只作为 placeholder，verified revalidate 后移除且不覆盖 v2", async () => {
  const legacyKey = "shoggoth.chat.models.v1.hermes";
  const storage = new MemoryStorage({
    [legacyKey]: JSON.stringify({ models: [model("hermes", "legacy")], verifiedAt: NOW - 100 }),
  });
  const store = createModelCatalogStore({ storage, events: new EventTarget(), now: () => NOW });
  const legacy = store.read("hermes");
  assert.equal(legacy.legacyPlaceholder, true);
  assert.equal(legacy.models[0].id, "legacy");

  const verified = await store.revalidate("hermes", async () => ({
    catalogRevision: revisions.one,
    models: [model("hermes", "fresh")],
    unchanged: false,
  }));
  assert.equal(verified.models[0].id, "fresh");
  assert.equal(storage.getItem(legacyKey), null);
  assert.equal(store.read("hermes").legacyPlaceholder, undefined);
});

test("过期、未来、非法时间与损坏 v2 同步清理且不能被事件重新持久化", () => {
  for (const [label, verifiedAt] of [["expired", NOW - DAY], ["future", NOW + 1], ["nan", "bad"]]) {
    const currentKey = `shoggoth.models.v2.current.${label}`;
    const entryKey = `shoggoth.models.v2.entry.${label}.${revisions.one}`;
    const storage = new MemoryStorage({
      [currentKey]: revisions.one,
      [entryKey]: JSON.stringify(snapshot(label, revisions.one, "m", verifiedAt)),
    });
    const events = new EventTarget();
    const store = createModelCatalogStore({ storage, events, now: () => NOW });
    assert.equal(store.read(label), null);
    assert.equal(storage.getItem(currentKey), null);
    assert.equal(storage.getItem(entryKey), null);

    events.dispatchEvent(new CustomEvent("models:changed", {
      detail: snapshot(label, revisions.two, "stale-event", NOW - DAY),
    }));
    assert.equal(store.read(label), null);
  }

  const malformed = new MemoryStorage({
    "shoggoth.models.v2.current.openclaw": revisions.one,
    [`shoggoth.models.v2.entry.openclaw.${revisions.one}`]: JSON.stringify({
      ...snapshot("hermes", "not-a-revision", "", NOW),
      models: [{ id: "", provider: "alpha", backendId: "hermes" }],
    }),
  });
  const store = createModelCatalogStore({ storage: malformed, events: new EventTarget(), now: () => NOW });
  assert.equal(store.read("openclaw"), null);
  assert.equal(malformed.length, 0);
});

test("publishApplied 原子落盘并且每次只广播一个完整事件", () => {
  const storage = new MemoryStorage();
  const events = new EventTarget();
  const received = [];
  events.addEventListener("models:changed", (event) => received.push(event.detail));
  const store = createModelCatalogStore({ storage, events, now: () => NOW });
  store.publishApplied(snapshot("openclaw", revisions.one, "applied"));

  assert.equal(received.length, 1);
  assert.equal(received[0].backendId, "openclaw");
  assert.equal(received[0].catalogRevision, revisions.one);
  assert.equal(received[0].models[0].id, "applied");
  assert.equal(store.read("openclaw").models[0].id, "applied");
});

test("Storage 写失败仍保留内存 winner 并广播给常驻 Chat", () => {
  const events = new EventTarget();
  const received = [];
  events.addEventListener("models:changed", (event) => received.push(event.detail));
  const store = createModelCatalogStore({ storage: new FailingWriteStorage(), events, now: () => NOW });
  store.publishApplied(snapshot("openclaw", revisions.one, "memory-only"));
  assert.equal(received.length, 1);
  assert.equal(received[0].models[0].id, "memory-only");
  assert.equal(store.read("openclaw").models[0].id, "memory-only");
});

test("迟到 revalidate CAS 失败时返回 apply winner，不返回或广播 loser", async () => {
  const storage = new MemoryStorage();
  const events = new EventTarget();
  const store = createModelCatalogStore({ storage, events, now: () => NOW });
  store.publishApplied(snapshot("openclaw", revisions.one, "initial", NOW - 10));
  const eventsSeen = [];
  const unsubscribe = store.subscribe("openclaw", (value) => eventsSeen.push(value.catalogRevision));

  let resolveFetch;
  const pending = store.revalidate("openclaw", () => new Promise((resolve) => { resolveFetch = resolve; }));
  store.publishApplied(snapshot("openclaw", revisions.three, "winner"));
  resolveFetch({ catalogRevision: revisions.late, models: [model("openclaw", "loser")], unchanged: false });
  const resolved = await pending;

  assert.equal(resolved.catalogRevision, revisions.three);
  assert.equal(resolved.models[0].id, "winner");
  assert.equal(store.read("openclaw").catalogRevision, revisions.three);
  assert.deepEqual(eventsSeen, [revisions.three]);
  unsubscribe();
});

test("unchanged 沿用本地 revision；本地不存在时无条件重试", async () => {
  const store = createModelCatalogStore({ storage: new MemoryStorage(), events: new EventTarget(), now: () => NOW });
  store.publishApplied(snapshot("hermes", revisions.one, "known", NOW - 10));
  const knownCalls = [];
  const known = await store.revalidate("hermes", async (revision) => {
    knownCalls.push(revision);
    return { catalogRevision: revisions.one, unchanged: true };
  });
  assert.equal(known.models[0].id, "known");
  assert.deepEqual(knownCalls, [revisions.one]);

  const empty = createModelCatalogStore({ storage: new MemoryStorage(), events: new EventTarget(), now: () => NOW });
  const retryCalls = [];
  const fresh = await empty.revalidate("openclaw", async (revision) => {
    retryCalls.push(revision);
    if (retryCalls.length === 1) return { catalogRevision: revisions.two, unchanged: true };
    return { catalogRevision: revisions.two, models: [model("openclaw", "retried")], unchanged: false };
  });
  assert.deepEqual(retryCalls, [undefined, undefined]);
  assert.equal(fresh.models[0].id, "retried");
});

const failures = [];
for (const { name, run } of tests) {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error.stack || error}`);
  }
}

if (failures.length) {
  console.error(`model catalog store regression: FAIL (${tests.length - failures.length}/${tests.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`model catalog store regression: PASS (${tests.length}/${tests.length})`);
}
