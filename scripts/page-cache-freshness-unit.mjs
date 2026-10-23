import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const uiRoot = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const React = require("react");
const { create, act } = require("react-test-renderer");
const ts = require("typescript");
let now = 1_000;
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(uiRoot, "src/lib/usePageCache.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module, exports: module.exports, require,
  Date: class extends Date { static now() { return now; } }, Error,
});
const { usePageCache, invalidatePageCache } = module.exports;
const settle = (fn) => act(async () => { fn?.(); await new Promise(setImmediate); });

function fixture() {
  const requests = [];
  let latest, renderer;
  function Page({ resource = "models:openclaw", enabled = true }) {
    latest = usePageCache(resource, () => new Promise((resolve, reject) => requests.push({ resource, resolve, reject })),
      { staleTime: 30_000, enabled });
    return React.createElement("output", {}, latest.data);
  }
  return {
    requests, get current() { return latest; },
    mount: (props) => settle(() => { renderer = create(React.createElement(Page, props)); }),
    update: (props) => settle(() => renderer.update(React.createElement(Page, props))),
    unmount: () => settle(() => renderer.unmount()),
  };
}

test("returning to a fresh model page renders immediately without another read", async () => {
  invalidatePageCache();
  const page = fixture();
  await page.mount();
  await settle(() => page.requests[0].resolve("configured"));
  await page.unmount();
  now += 29_999;
  await page.mount();
  assert.equal(page.current.data, "configured");
  assert.equal(page.current.loading, false);
  assert.equal(page.requests.length, 1);
  await page.unmount();
});

test("navigation during a slow first read shares the in-flight request", async () => {
  invalidatePageCache();
  const page = fixture();
  await page.mount();
  await page.unmount();
  await page.mount();
  assert.equal(page.requests.length, 1);
  await settle(() => page.requests[0].resolve("loaded once"));
  assert.equal(page.current.data, "loaded once");
  assert.equal(page.current.loading, false);
  await page.unmount();
});

test("stale reads retain the visible snapshot, failures can be retried on revisit", async () => {
  invalidatePageCache();
  const page = fixture();
  await page.mount();
  await settle(() => page.requests[0].resolve("previous"));
  await page.unmount();
  now += 30_001;
  await page.mount();
  assert.equal(page.current.data, "previous");
  assert.equal(page.current.loading, false);
  assert.equal(page.requests.length, 2);
  await settle(() => page.requests[1].reject(new Error("offline")));
  assert.equal(page.current.data, "previous");
  assert.equal(page.current.error, "offline");
  await page.unmount();
  await page.mount();
  await settle(() => page.requests[2].resolve("reconnected"));
  assert.equal(page.current.error, null);
  assert.equal(page.current.data, "reconnected");
  await page.unmount();
});

test("inactive panes do not fetch and adopt reads completed while hidden", async () => {
  invalidatePageCache();
  const page = fixture();
  await page.mount({ enabled: false });
  assert.equal(page.requests.length, 0);
  await page.update({ enabled: true });
  await page.update({ enabled: false });
  await settle(() => page.requests[0].resolve("hidden result"));
  await page.update({ enabled: true });
  assert.equal(page.current.data, "hidden result");
  assert.equal(page.current.loading, false);
  assert.equal(page.requests.length, 1);
  await page.unmount();
});

test("manual refresh bypasses freshness and a saved snapshot defeats a late GET", async () => {
  invalidatePageCache();
  const page = fixture();
  await page.mount();
  await settle(() => page.requests[0].resolve("before"));
  await settle(() => { void page.current.refresh(); });
  assert.equal(page.requests.length, 2);
  await settle(() => page.current.replace("after deletion"));
  await settle(() => page.requests[1].resolve("stale endpoint"));
  assert.equal(page.current.data, "after deletion");
  await page.unmount();
  await page.mount();
  assert.equal(page.current.data, "after deletion");
  assert.equal(page.requests.length, 2);
  await page.unmount();
});

test("backend and connection changes never reuse the previous scope", async () => {
  invalidatePageCache();
  const page = fixture();
  await page.mount();
  await page.update({ resource: "models:hermes" });
  await settle(() => page.requests[0].resolve("openclaw"));
  assert.equal(page.current.data, undefined);
  await settle(() => page.requests[1].resolve("old hermes"));
  await settle(() => invalidatePageCache());
  assert.equal(page.current.data, undefined);
  assert.equal(page.current.loading, true);
  await settle(() => page.requests[2].resolve("new connection"));
  assert.equal(page.current.data, "new connection");
  await page.unmount();
});
