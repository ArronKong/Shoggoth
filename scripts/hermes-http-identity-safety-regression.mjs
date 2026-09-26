#!/usr/bin/env node

// BUG-011 / BUG-015 / BUG-029 定向回归：profile ID 碰撞 fail-closed、
// HTTP 总 deadline/响应字节上限，以及附件 MIME/filename 元数据保留。

import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const hermes = require("../app/core/hermes-backend.js");
const { HermesBackend } = hermes;
const testHttp = hermes.__test?.http;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let profiles = [
  { name: "source", model: "m" },
  { name: "foo-bar", model: "m" },
];
let writes = 0;
const modelSets = [];
const aggregateCalls = { model: 0, usage: 0, models: 0, sessions: 0, cron: 0, board: 0 };
const server = http.createServer((req, res) => {
  if (req.url === "/api/profiles" && req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ profiles }));
    return;
  }
  if (req.url === "/api/profiles" && req.method === "POST") {
    writes += 1;
    res.end("{}");
    return;
  }
  if (req.url?.startsWith("/api/profiles/") && req.method === "PATCH") {
    writes += 1;
    res.end("{}");
    return;
  }
  if (req.url === "/api/model/info") {
    aggregateCalls.model += 1;
    res.end(JSON.stringify({ model: "m", provider: "p" }));
    return;
  }
  if (req.url === "/api/model/set" && req.method === "POST") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      modelSets.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.end("{}");
    });
    return;
  }
  if (req.url?.startsWith("/api/analytics/usage")) {
    aggregateCalls.usage += 1;
    res.end(JSON.stringify({ daily: [{ day: "2026-08-30", input_tokens: 1 }], by_model: [], tools: [] }));
    return;
  }
  if (req.url?.startsWith("/api/analytics/models")) {
    aggregateCalls.models += 1;
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  if (req.url?.startsWith("/api/sessions")) {
    aggregateCalls.sessions += 1;
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }
  if (req.url?.startsWith("/api/cron/jobs?")) {
    aggregateCalls.cron += 1;
    res.end(JSON.stringify([{ id: "job-1", name: "job" }]));
    return;
  }
  if (req.url?.startsWith("/api/plugins/kanban/board")) {
    aggregateCalls.board += 1;
    res.end(JSON.stringify({ latest_event_id: 0, columns: [] }));
    return;
  }
  if (req.url === "/slow") {
    res.write("a");
    const timer = setInterval(() => res.write("b"), 10);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (req.url === "/oversized") {
    res.write(Buffer.alloc(12));
    res.end(Buffer.alloc(12));
    return;
  }
  if (req.url === "/declared-oversized") {
    res.setHeader("content-length", "17");
    res.end(Buffer.alloc(17));
    return;
  }
  if (req.url === "/exact") {
    res.end(Buffer.alloc(16, 1));
    return;
  }
  if (req.url?.startsWith("/api/plugins/kanban/attachments/")) {
    const attachmentId = decodeURIComponent(req.url.split("/").pop().split("?")[0]);
    if (attachmentId === "a1") {
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf");
    } else if (attachmentId === "plain") {
      res.setHeader("content-type", "text/plain");
      res.setHeader("content-disposition", 'attachment; filename="plain report.txt"');
    } else if (attachmentId === "bad") {
      res.setHeader("content-disposition", "attachment; filename*=UTF-8''%E0%A4%A; filename=backup.txt");
    }
    res.end(Buffer.from("pdf"));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  const dash = { profile: "default", baseUrl, token: "t", proc: null, spawned: false };
  be.dashboards.set("default", dash);

  await be._refreshAgentsFor(dash);
  let createError = null;
  await be.createAgent({ name: "foo_bar" }).catch((err) => { createError = err; });
  check(
    "create 在发请求前稳定拒绝归一化 ID 碰撞",
    createError?.code === "ERR_HERMES_PROFILE_ID_COLLISION" && writes === 0,
    `${createError?.code || createError?.message || "no error"}; writes=${writes}`,
  );
  let renameError = null;
  await be.updateAgent("hermes-source", { name: "foo_bar" }).catch((err) => { renameError = err; });
  check(
    "rename 在发请求前稳定拒绝归一化 ID 碰撞",
    renameError?.code === "ERR_HERMES_PROFILE_ID_COLLISION" && writes === 0,
    `${renameError?.code || renameError?.message || "no error"}; writes=${writes}`,
  );

  profiles = [{ name: "foo_bar" }, { name: "foo-bar" }];
  await be._refreshAgentsFor(dash);
  check("导入碰撞 profile 时不做 last-wins 路由", !be.profileById.has("hermes-foo-bar"));
  const status = await be.getStatus();
  check(
    "导入碰撞通过结构化状态可诊断",
    Array.isArray(status.info.profileIdentityCollisions) && status.info.profileIdentityCollisions.length === 1,
  );

  be.dashboards = new Map([
    ["foo_bar", { profile: "foo_bar", baseUrl, token: "t", proc: null, spawned: false }],
    ["foo-bar", { profile: "foo-bar", baseUrl, token: "t", proc: null, spawned: false }],
  ]);
  let collisionScopeError = null;
  await be.setActiveModel("p/m", { scope: "hermes-foo-bar", provider: "p" })
    .catch((err) => { collisionScopeError = err; });
  check(
    "碰撞 scope 的 setActiveModel fail-closed 且不误写 default",
    collisionScopeError?.code === "ERR_HERMES_UNKNOWN_AGENT_SCOPE" && modelSets.length === 0,
    `${collisionScopeError?.code || collisionScopeError?.message}; writes=${modelSets.length}`,
  );
  let unknownScopeError = null;
  await be.setActiveModel("p/m", { scope: "hermes-missing", provider: "p" })
    .catch((err) => { unknownScopeError = err; });
  check(
    "未知 scope 的 setActiveModel fail-closed 且不误写 default",
    unknownScopeError?.code === "ERR_HERMES_UNKNOWN_AGENT_SCOPE" && modelSets.length === 0,
    `${unknownScopeError?.code || unknownScopeError?.message}; writes=${modelSets.length}`,
  );
  let unlockedScopeError = null;
  await be._setActiveModelUnlocked("p/m", { scope: "hermes-missing", provider: "p" })
    .catch((err) => { unlockedScopeError = err; });
  check(
    "unlocked 写路径同样拒绝未知 scope",
    unlockedScopeError?.code === "ERR_HERMES_UNKNOWN_AGENT_SCOPE" && modelSets.length === 0,
    `${unlockedScopeError?.code || unlockedScopeError?.message}; writes=${modelSets.length}`,
  );
  const active = await be.getActiveModel();
  check(
    "碰撞 profile 不进入 active model 聚合且不发 HTTP",
    Object.keys(active.byScope).length === 0 && aggregateCalls.model === 0,
    `scopes=${Object.keys(active.byScope).length}; calls=${aggregateCalls.model}`,
  );
  const usage = await be._fetchUsageAnalytics("7d");
  const extras = await be._fetchUsageExtras("7d");
  check(
    "碰撞 profile 不进入 usage 聚合且不发 HTTP",
    usage.daily.size === 0
      && usage.byModel.size === 0
      && usage.bySource.size === 0
      && extras.top.length === 0
      && aggregateCalls.usage === 0
      && aggregateCalls.models === 0
      && aggregateCalls.sessions === 0,
    `usage=${aggregateCalls.usage}; models=${aggregateCalls.models}; sessions=${aggregateCalls.sessions}`,
  );
  const cron = await be.getCronJobs();
  check(
    "碰撞 profile 不进入 cron list 且不发 HTTP",
    cron.length === 0 && aggregateCalls.cron === 0,
    `jobs=${cron.length}; calls=${aggregateCalls.cron}`,
  );
  const activities = await be.getRecentKanbanActivities({ sinceMs: 0 });
  check(
    "碰撞 profile 不进入 Kanban 活动聚合且不发 HTTP",
    activities.supported === true && activities.items.length === 0 && aggregateCalls.board === 0,
    `items=${activities.items.length}; boardCalls=${aggregateCalls.board}`,
  );
  const oldHermesHome = process.env.HERMES_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-hermes-collision-"));
  try {
    for (const profile of ["foo_bar", "foo-bar"]) {
      fs.mkdirSync(path.join(tempHome, "profiles", profile, "output"), { recursive: true });
    }
    process.env.HERMES_HOME = tempHome;
    const roots = await be._artifactRoots();
    check(
      "碰撞 profile 不进入 artifact roots（含 Kanban workspace）",
      roots.length === 0 && aggregateCalls.board === 0,
      `roots=${roots.length}; boardCalls=${aggregateCalls.board}`,
    );
  } finally {
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  be.dashboards = new Map([
    ["default", { profile: "default", baseUrl, token: "default-model-token", proc: null, spawned: false }],
  ]);
  const defaultWrite = await be.setActiveModel("p/m", { provider: "p" });
  check(
    "省略 scope 仍只写 default dashboard",
    defaultWrite.scope === "default"
      && modelSets.length === 1
      && modelSets[0].authorization === "Bearer default-model-token"
      && modelSets[0].body?.scope === "main"
      && modelSets[0].body?.model === "p/m",
    `writes=${modelSets.length}; auth=${modelSets[0]?.authorization || "none"}`,
  );

  check("测试 HTTP 边界 helper 可用", !!testHttp);
  if (testHttp) {
    const exact = await testHttp.httpRaw("GET", `${baseUrl}/exact`, { timeoutMs: 200, maxResponseBytes: 16 });
    check("响应恰好等于 byte cap 时成功", exact.data.length === 16);

    let capError = null;
    await testHttp.httpRaw("GET", `${baseUrl}/oversized`, { timeoutMs: 200, maxResponseBytes: 16 })
      .catch((err) => { capError = err; });
    check("chunked 响应超过 byte cap 时中止", capError?.code === "HERMES_RESPONSE_TOO_LARGE", capError?.message);

    let declaredCapError = null;
    await testHttp.httpGet(`${baseUrl}/declared-oversized`, { timeoutMs: 200, maxResponseBytes: 16 })
      .catch((err) => { declaredCapError = err; });
    check(
      "Content-Length 超 cap 时在读取正文前拒绝",
      declaredCapError?.code === "HERMES_RESPONSE_TOO_LARGE",
      declaredCapError?.message,
    );

    const started = Date.now();
    let deadlineError = null;
    await testHttp.httpGet(`${baseUrl}/slow`, { timeoutMs: 45, maxResponseBytes: 1024 })
      .catch((err) => { deadlineError = err; });
    const elapsed = Date.now() - started;
    check(
      "持续滴流也受总 deadline 限制",
      deadlineError?.code === "HERMES_HTTP_DEADLINE_EXCEEDED" && elapsed < 250,
      `${deadlineError?.code}; ${elapsed}ms`,
    );
  }

  const attachment = await be.readTaskAttachment("a1");
  check("附件保留上游 MIME", attachment.contentType === "application/pdf", attachment.contentType);
  check("附件解析 RFC 5987 UTF-8 filename", attachment.filename === "测试.pdf", attachment.filename);
  const plain = await be.readTaskAttachment("plain");
  check("附件解析普通 quoted filename", plain.filename === "plain report.txt", plain.filename);
  check("普通附件保留 MIME", plain.contentType === "text/plain", plain.contentType);
  const missing = await be.readTaskAttachment("missing");
  check(
    "附件头缺失时使用安全 fallback",
    missing.filename === "attachment-missing" && missing.contentType === "application/octet-stream",
    `${missing.filename}; ${missing.contentType}`,
  );
  const malformed = await be.readTaskAttachment("bad");
  check("畸形 filename* 不抛并回退普通 filename", malformed.filename === "backup.txt", malformed.filename);
  await be.stop();
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const failed = results.filter((row) => !row.pass).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
