#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const port = 41874;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitFor(check, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

const server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: uiRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
await waitFor(async () => {
  try { return (await fetch(baseUrl)).ok; } catch { return false; }
}, "Vite 服务启动", 10_000);

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const store = await import("/src/model-catalog-store.ts");
    localStorage.clear();
    const revision = (value) => value.repeat(64);
    const snapshot = (backendId, catalogRevision, id) => ({
      backendId,
      catalogRevision,
      verifiedAt: Date.now(),
      models: [{ id, name: id, provider: "alpha", backendId }],
    });

    store.publishAppliedModelCatalog(snapshot("openclaw", revision("1"), "old-model"));
    const events = [];
    const unsubscribe = store.subscribeModelCatalog("openclaw", (next) => events.push(next.models[0]?.id));
    store.publishAppliedModelCatalog(snapshot("openclaw", revision("2"), "renamed-model"));

    let resolveLate;
    const pending = store.revalidateModelCatalog("openclaw", () => new Promise((resolve) => { resolveLate = resolve; }));
    store.publishAppliedModelCatalog(snapshot("openclaw", revision("3"), "apply-winner"));
    resolveLate({
      catalogRevision: revision("4"),
      unchanged: false,
      models: [{ id: "late-loser", name: "late-loser", provider: "alpha", backendId: "openclaw" }],
    });
    const resolved = await pending;
    unsubscribe();

    store.publishAppliedModelCatalog(snapshot("hermes", revision("9"), "hermes-only"));
    return {
      events,
      resolvedId: resolved.models[0]?.id,
      openclawId: store.readModelCatalog("openclaw")?.models[0]?.id,
      hermesId: store.readModelCatalog("hermes")?.models[0]?.id,
    };
  });

  assert.deepEqual(result.events, ["renamed-model", "apply-winner"]);
  assert.equal(result.resolvedId, "apply-winner", "迟到 GET 的 Promise 结果也必须返回 apply winner");
  assert.equal(result.openclawId, "apply-winner");
  assert.equal(result.hermesId, "hermes-only", "backend current pointer 必须隔离");

  // 源码接线锁定 Models 只在 applied catalog 路径发布，Chat 订阅后无需重建 session。
  const modelsPage = fs.readFileSync(path.join(uiRoot, "src/pages/ModelsPage.tsx"), "utf8");
  const editor = fs.readFileSync(path.join(uiRoot, "src/pages/models/ModelEditorDrawer.tsx"), "utf8");
  const chat = fs.readFileSync(path.join(uiRoot, "src/pages/ChatPage.tsx"), "utf8");
  assert.match(modelsPage, /publishAppliedModelCatalog\(catalog\)/);
  assert.match(editor, /if\s*\(result\.status\s*===\s*"applied"\)\s*await finishApplied\(result\)/);
  assert.match(chat, /subscribeModelCatalog\(backend/);
  assert.match(chat, /setModels\(snapshot\.models\)/);
  assert.doesNotMatch(chat, /MODEL_CACHE_KEY_PREFIX|writeModelCache\(/);

  console.log("models chat catalog regression: PASS");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  if (server.exitCode && server.exitCode !== 0) process.stderr.write(serverLog);
}
