#!/usr/bin/env node
"use strict";

// Serves the actual packaged management UI from app.asar with synthetic,
// in-memory responses. This never starts Electron or opens product user data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const asar = require("@electron/asar");

const check = process.argv.includes("--check");
const appArgument = process.argv.slice(2).find((argument) => argument !== "--check");
const appPath = path.resolve(appArgument || path.join(__dirname,
  "../dist/mac-arm64/Shoggoth.app"));
const archive = path.join(appPath, "Contents/Resources/app.asar");
assert.ok(fs.statSync(archive).isFile(), `packaged ASAR is missing: ${archive}`);
const prefix = "/app/manage-ui/dist";
const entries = new Set(asar.listPackage(archive));
assert.ok(entries.has(`${prefix}/index.html`), "packaged management UI is missing");
const packagedHtml = asar.extractFile(archive, `${prefix.slice(1)}/index.html`).toString("utf8");
const script = packagedHtml.match(/<script type="module"[^>]*src="([^"]+)"/u)?.[1];
assert.ok(script && entries.has(`${prefix}${script}`), "packaged entry script is missing");

const backend = { id: "shoggoth", name: "Shoggoth", connectionMode: "builtin-service",
  disconnectable: false, agentLifecycle: { create: true, update: true, remove: false,
    archive: true, restore: true, readStates: true },
  surfaces: { chat: true, agents: true, models: true, skills: true, usage: true,
    oauth: true, dashboardRuns: true, agentHarness: true, cron: { kind: "native" },
    kanban: { kind: "native" }, nativeCapacity: true, runtimeBindings: true,
    runtimeStatus: true, sessionRuntimeSwitch: true, runtimeUsage: true } };
const agent = { id: "fixture-agent", name: "记忆验收 Agent", backendId: "shoggoth",
  runtime: "codex", model: "codex/fixture", lifecycleState: "active" };
const detail = { ...agent, files: [{ name: "MEMORY.md", size: 42, readOnly: true }] };
const item = (id, content, status, createdAt) => ({ id, profileId: agent.id,
  scope: "user", type: "semantic", content, sourceRefs: [`event-${id}`, `run-${id}`],
  confidence: 1, sensitivity: "normal", status, validFrom: 0, validUntil: null,
  supersedes: null, createdAt, updatedAt: createdAt });
const active = item("active", "用户偏好中文回复", "active", 1_000);
const forgotten = item("forgotten", "蓝色番茄计划", "deleted", 2_000);
const recalled = { ready: true, revision: 3, indexPending: false, code: null };
const requests = [];
const servedAssets = new Set();

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
function api(requestUrl, response) {
  const pathname = requestUrl.pathname;
  if (pathname === "/__api/config") return sendJson(response,
    { config: { gatewayUrl: "", token: "", disabledBackends: ["openclaw", "hermes"],
      setupCompletedAt: 1 } });
  if (pathname === "/__api/backends") return sendJson(response, { backends: [backend] });
  if (pathname === "/__api/shoggoth/status") return sendJson(response, { service: {
    healthy: true, pendingCommandsLocked: false, domainAvailability: { kanban: true, cron: true },
    startedAt: 1_000 }, background: { supported: false, reason: "unstable-install-location" } });
  if (pathname === "/__api/agents") return sendJson(response, { agents:
    requestUrl.searchParams.get("backend") === "shoggoth" ? [agent] : [] });
  if (pathname === `/__api/agents/${agent.id}`) return sendJson(response, { agent: detail });
  if (pathname === `/__api/agents/${agent.id}/definition`) return sendJson(response,
    { definition: { supported: false, current: { revision: 1, documents: {} },
      history: [], files: [] } });
  if (pathname === `/__api/agents/${agent.id}/memories`) {
    const items = requestUrl.searchParams.get("status") === "deleted" ? [forgotten] : [active];
    return sendJson(response, { memories: { supported: true, revision: 3, items,
      nextCursor: items.length, hasMore: false, recallPolicy: recalled } });
  }
  if (pathname === `/__api/agents/${agent.id}/memory-candidates`) return sendJson(response,
    { candidates: { revision: 1, items: [], nextCursor: null, hasMore: false,
      usage: { day: "2026-09-27", calls: 0, inputTokens: 0, outputTokens: 0 } } });
  if (pathname === `/__api/agents/${agent.id}/memory-explain`) {
    const old = requestUrl.searchParams.get("memoryId") === forgotten.id;
    return sendJson(response, { explanation: old
      ? { item: forgotten, withdrawalReason: "forgotten",
        evidence: { status: "verified_quote", origin: "conversation",
          sessionId: "fixture-session", eventId: "event-forgotten",
          quote: "请记住蓝色番茄计划", occurredAt: 2_000 } }
      : { item: active, withdrawalReason: null,
        evidence: { status: "verified_quote", origin: "conversation",
          sessionId: "fixture-session", eventId: "event-active",
          quote: "以后请用中文回复", occurredAt: 1_000 } } });
  }
  return sendJson(response, { error: "Synthetic fixture has no such endpoint" }, 404);
}

const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".webp": "image/webp" };
const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  requests.push(`${request.method} ${requestUrl.pathname}${requestUrl.search}`);
  if (request.method !== "GET") return sendJson(response, { error: "Fixture is read-only" }, 405);
  if (requestUrl.pathname === "/__fixture/requests") return sendJson(response, { requests });
  if (requestUrl.pathname.startsWith("/__api/")) return api(requestUrl, response);
  let pathname;
  try { pathname = decodeURIComponent(requestUrl.pathname); }
  catch { return response.writeHead(400).end(); }
  if (pathname.includes("..") || pathname.includes("\\") || pathname.includes("\0")) {
    return response.writeHead(400).end();
  }
  const file = pathname === "/" ? "/index.html" : pathname;
  const entry = `${prefix}${file}`;
  if (!entries.has(entry)) return response.writeHead(404).end();
  const body = asar.extractFile(archive, entry.slice(1));
  servedAssets.add(file);
  response.writeHead(200, { "Content-Type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
});

async function checkPackagedUi(url) {
  const moduleName = process.env.SHOGGOTH_PLAYWRIGHT_MODULE || "playwright";
  const { chromium } = require(moduleName);
  const executablePath = process.env.SHOGGOTH_CHROME_EXECUTABLE
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 },
    locale: "zh-CN", acceptDownloads: false, serviceWorkers: "block" });
  const origin = new URL(url).origin;
  const blocked = [];
  const pageErrors = [];
  try {
    await context.route("**/*", (route) => {
      const target = route.request().url();
      if (target.startsWith(`${origin}/`)) return route.continue();
      blocked.push(target);
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator('button[data-agent-id="fixture-agent"]').click({ timeout: 15_000 });
    await page.getByText("设定", { exact: true }).click({ timeout: 15_000 });
    const editor = page.locator('[aria-label="长期记忆编辑器"]');
    await editor.waitFor({ timeout: 15_000 });
    await editor.locator("textarea").last().waitFor();
    assert.ok((await editor.locator("textarea").evaluateAll((nodes) => nodes.map((node) => node.value)))
      .includes(active.content), "packaged editor did not display the active memory");
    await editor.getByRole("button", { name: "查看来源" }).click();
    await editor.getByText("以后请用中文回复", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "查看已删除记忆（仅供本人审计）" }).click();
    await editor.locator("textarea").last().waitFor();
    assert.ok((await editor.locator("textarea").evaluateAll((nodes) => nodes.map((node) => node.value)))
      .includes(forgotten.content), "packaged editor did not display the forgotten audit item");
    await editor.getByRole("button", { name: "查看来源" }).click();
    await editor.getByText("用户要求遗忘").waitFor();
    await editor.getByText("请记住蓝色番茄计划", { exact: true }).waitFor();
    assert.deepEqual(blocked, [], "fixture page attempted an off-origin request");
    assert.deepEqual(pageErrors, [], "packaged UI reported a runtime error");
    assert.ok(servedAssets.has("/index.html") && servedAssets.has(script)
      && [...servedAssets].some((file) => file.endsWith(".css")),
    "packaged HTML, entry JavaScript, or CSS was not loaded");
    assert.ok(requests.some((request) => request.includes("/memories") && request.includes("status=deleted")));
    assert.ok(requests.some((request) => request.includes("/memory-explain") && request.includes("memoryId=forgotten")));
    console.log("[shoggoth-packaged-memory-ui-fixture] PASS packaged UI active memory, source, forgotten audit, withdrawal reason");
  } finally {
    await context.close();
    await browser.close();
  }
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/#/agents`;
  console.log(`PACKAGED_MEMORY_UI_FIXTURE=${url}`);
  console.log(`PACKAGED_ASAR=${archive}`);
  if (!check) return;
  try { await checkPackagedUi(url); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); }
});
