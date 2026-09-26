#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const UI_ROOT = path.join(ROOT, "app/manage-ui");
const requireFromUi = createRequire(path.join(UI_ROOT, "package.json"));
const esbuild = requireFromUi("esbuild");
const { startStaticServer } = createRequire(import.meta.url)("../app/static-server.js");

const results = [];
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

async function compileTarget(relativePath, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoggoth-domain-ui-${name}-`));
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  return {
    mod: createRequire(outfile)(outfile),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Registry catalog 的静态首帧 fallback 必须包含发布策略允许的全部平级 backend。
{
  const compiled = await compileTarget("app/manage-ui/src/lib/backends.ts", "backends");
  try {
    const descriptors = compiled.mod.FALLBACK_BACKEND_DESCRIPTORS;
    const releasePolicy = JSON.parse(fs.readFileSync(path.join(ROOT, "app/release-policy.json"), "utf8"));
    const expectedBackends = [
      "openclaw", "hermes", "shoggoth", "codex", "grok-build", "antigravity",
      "pi", "claude-code", "deepseek-harness",
    ].filter((id) => !releasePolicy.disabledRuntimes.includes(id));
    check(
      "全局 backend fallback 包含发布策略允许的所有平级 runtime",
      compiled.mod.BACKENDS?.map((backend) => backend.id).join(",")
        === expectedBackends.join(","),
    );
    check(
      "native descriptor 统一声明 cron/kanban/agentHarness surfaces",
      compiled.mod.FALLBACK_BACKEND_DESCRIPTORS
        ?.filter((backend) => [
          "shoggoth", "codex", "grok-build", "antigravity", "pi", "claude-code",
          "deepseek-harness",
        ].includes(backend.id))
        .every((backend) => backend.surfaces.agentHarness
          && backend.surfaces.cron?.kind === "native"
          && backend.surfaces.kanban?.kind === "native"),
    );
    const protocolCompatible = {
      ...descriptors.find((backend) => backend.id === "hermes"),
      id: "future-hermes-compatible",
    };
    const pausedJob = { state: " Paused ", stateLabel: undefined };
    check(
      "Cron force-resume 判断按 descriptor protocol 而非 backend id",
      compiled.mod.cronForceRunResumesPaused?.(protocolCompatible, pausedJob) === true
        && compiled.mod.cronForceRunResumesPaused?.(
          descriptors.find((backend) => backend.id === "openclaw"),
          pausedJob,
        ) === false,
    );
    check(
      "Cron force-resume 仅对明确 paused 状态生效",
      compiled.mod.cronForceRunResumesPaused?.(protocolCompatible, { state: "scheduled" }) === false,
    );
  } finally {
    compiled.cleanup();
  }
}

// Agent 与 Usage 管理页由 descriptor capability 选 backend；harness 与 lifecycle 解耦。
{
  const agents = fs.readFileSync(path.join(UI_ROOT, "src/pages/AgentsPage.tsx"), "utf8");
  const usage = fs.readFileSync(path.join(UI_ROOT, "src/pages/UsagePage.tsx"), "utf8");
  check(
    "Agent 管理页按 agents surface 选择 backend",
    /useBackendState\("agents",\s*undefined,\s*\{\s*surface:\s*"agents"\s*\}\)/u.test(agents)
      && /<BackendTabs[^>]*surface="agents"/u.test(agents),
  );
  check(
    "native Agent lifecycle 由 descriptor capability 驱动",
    /surfaces\.agentHarness === true/u.test(agents)
      && /agentLifecycle\?\.create === true/u.test(agents)
      && /readOnly=\{!canUpdateAgent\}/u.test(agents)
      && !/agents\.archivedAgents|const doRestore|canRestoreAgent/u.test(agents),
  );
  check(
    "AI 助理两种详情均显示灵感便签并移除看板入口",
    (agents.match(/key: "inspiration", label: t\("agents.tabInspiration"\)/gu) || []).length === 2
      && !/tabKanban|getTaskBoard|getBoards/u.test(agents),
  );
  check(
    "灵感面板以 backend 和 AI 助理 ID 隔离并在切换时重建",
    /<AgentInspirationPanel key=\{`\$\{backend\}:\$\{detail.id\}`\} backendId=\{backend\} agentId=\{detail.id\}/u.test(agents),
  );
  check(
    "Token 用量页按 usage surface 选择 backend",
    /useBackendState\("usage",\s*undefined,\s*\{\s*surface:\s*"usage"\s*\}\)/u.test(usage)
      && /<BackendTabs[^>]*surface="usage"/u.test(usage),
  );
  check(
    "无每日活动信号时不误报该区间无用量",
    /bdLoading \|\| breakdown\?\.dailyActivity !== undefined/u.test(usage),
  );
}

// Cron prompt 正文必须通过 owning backend 的单项详情接口读取；聚合列表不能代替。
{
  const calls = [];
  const shoggoth = {
    id: "shoggoth",
    async getCronJob(id, options) {
      calls.push({ id, options });
      return {
        id,
        backendId: "shoggoth",
        agentId: "shoggoth-default",
        name: "Native detail",
        prompt: "authoritative prompt",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
      };
    },
  };
  const unsupported = { id: "legacy" };
  const registry = {
    backends: new Map([["shoggoth", shoggoth], ["legacy", unsupported]]),
    routeByCronId(id) {
      if (String(id).startsWith("shoggoth:")) return shoggoth;
      if (String(id).startsWith("legacy:")) return unsupported;
      return null;
    },
    aggregateCronJobs: async () => [],
  };
  const server = await startStaticServer(0, { registry });
  try {
    const id = "shoggoth:99999999-9999-4999-8999-999999999999";
    const response = await fetch(`${server.url}/__api/cron/jobs?id=${encodeURIComponent(id)}&action=detail`);
    const body = await response.json().catch(() => ({}));
    check("Cron detail route 返回权威 prompt", response.status === 200 && body.job?.prompt === "authoritative prompt");
    check("Cron detail route 强制 includePrompt", calls.length === 1 && calls[0].id === id && calls[0].options?.includePrompt === true);

    const unsupportedResponse = await fetch(`${server.url}/__api/cron/jobs?id=legacy%3Ajob&action=detail`);
    const unsupportedBody = await unsupportedResponse.json().catch(() => ({}));
    check("未实现 getCronJob 的外部后端固定 fail closed", unsupportedResponse.status === 501 && unsupportedBody.code === "CRON_DETAIL_UNSUPPORTED");
  } finally {
    await server.close();
  }
}

// API client 必须把 native board/retry/detail 的稳定绑定完整送到现有 REST 面。
{
  const compiled = await compileTarget("app/manage-ui/src/api/client.ts", "client");
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), method: init.method || "GET", body });
    if (String(url).includes("action=detail")) {
      return new Response(JSON.stringify({
        job: {
          id: "shoggoth:job",
          backendId: "shoggoth",
          agentId: "shoggoth-default",
          name: "Detail",
          prompt: "full prompt",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("/__api/tasks")) {
      const payload = String(url).includes("action=run") ? { result: {} } : { task: {} };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await compiled.mod.createTask("shoggoth", { title: "Native" }, "board-uuid");
    const create = requests.at(-1);
    check("createTask 把显式 native boardId 写入请求体", create.body?.boardId === "board-uuid" && create.body?.title === "Native");

    await compiled.mod.createTask("hermes", { title: "External" });
    const externalCreate = requests.at(-1);
    check("外部 createTask 未传 boardId 时请求体保持原样", externalCreate.body?.title === "External" && !Object.hasOwn(externalCreate.body, "boardId"));

    await compiled.mod.runTask("shoggoth", "card-uuid", undefined, "retry", { retryOf: "run-latest" });
    const retry = requests.at(-1);
    check("runTask retry 复用 action=run 并锁定 retryOf", retry.url.includes("action=run") && retry.body?.mode === "retry" && retry.body?.retryOf === "run-latest");

    await compiled.mod.runTask("openclaw", "card-external", "codex", "autonomous");
    const externalRun = requests.at(-1);
    check("外部 runTask 未传 retryOf 时请求体保持原样", externalRun.body?.engine === "codex" && externalRun.body?.mode === "autonomous" && !Object.hasOwn(externalRun.body, "retryOf"));

    const detail = typeof compiled.mod.getCronJobDetail === "function"
      ? await compiled.mod.getCronJobDetail("shoggoth:job")
      : null;
    const detailRequest = requests.at(-1);
    check("getCronJobDetail 使用 query id + detail action", detail?.prompt === "full prompt" && detailRequest.url.includes("action=detail") && detailRequest.url.includes("id=shoggoth%3Ajob"));
  } finally {
    globalThis.fetch = previousFetch;
    compiled.cleanup();
  }
}

// 页面纯策略：多板不猜、未知能力 fail closed、retry 锁最新一次允许的终态 run。
{
  const helperPath = "app/manage-ui/src/lib/shoggothDomainUi.ts";
  const exists = fs.existsSync(path.join(ROOT, helperPath));
  check("存在 Shoggoth domain UI 纯策略模块", exists);
  if (exists) {
    const compiled = await compileTarget(helperPath, "policy");
    try {
      const {
        nativeTaskCreateSpec,
        nativeTaskEditPlan,
        nativeBoardsForProfile,
        fallbackBoardIdentity,
        resolveNativeBoardId,
        usesExplicitBoardIdentity,
        nativeTaskCanMoveTo,
        nativeTaskRunCommand,
      } = compiled.mod;
      const boards = [
        { id: "board-a", slug: "alpha", name: "Alpha", total: 0 },
        { id: "board-b", slug: "beta", name: "Beta", total: 0 },
      ];
      check("Native 多板未选择时绝不猜 boardId", resolveNativeBoardId(boards, "") === null);
      check("Native 多板采用后端唯一 current board", resolveNativeBoardId([
        { ...boards[0], current: true }, boards[1],
      ], "") === "board-a");
      check("Native 建卡绑定当前所选 boardId", resolveNativeBoardId(boards, "beta") === "board-b");
      check("Native board UUID 深链解析为显式 boardId", resolveNativeBoardId(boards, "board-b") === "board-b");
      check("Native 重复 slug 深链不猜 profile board", resolveNativeBoardId([
        { id: "board-a", slug: "default", name: "A", total: 0 },
        { id: "board-b", slug: "default", name: "B", total: 0 },
      ], "default") === null);
      check("Native 单板可确定显式 boardId", resolveNativeBoardId(boards.slice(0, 1), "") === "board-a");
      const profileBoards = nativeBoardsForProfile?.([
        { id: "board-a", slug: "default", name: "A", total: 1, profileId: "profile-a" },
        { id: "board-b", slug: "default", name: "B", total: 1, profileId: "profile-b" },
        { slug: "missing-id", name: "Broken", total: 1, profileId: "profile-a" },
      ], "profile-a");
      check(
        "Native Agent 只选择当前 profile 且具显式 UUID 的板",
        profileBoards?.length === 1 && profileBoards[0].id === "board-a",
      );
      check("Native Agent 缺 profile 时 fail closed", nativeBoardsForProfile?.(boards, undefined).length === 0);
      check("显式 board identity 由返回数据能力识别", usesExplicitBoardIdentity?.([
        { id: "board-a", slug: "default", name: "A", total: 0, profileId: "profile-a" },
      ]) === true);
      check("普通 slug board 不误判成显式 identity", usesExplicitBoardIdentity?.(boards) === false);
      check("显式多板回退使用稳定 UUID 而非重复 slug", fallbackBoardIdentity?.([
        { id: "board-a", slug: "default", name: "A", total: 0, profileId: "profile-a" },
        { id: "board-b", slug: "default", name: "B", total: 0, profileId: "profile-b", current: true },
      ]) === "board-b");
      check("普通多板回退保持 slug 契约", fallbackBoardIdentity?.([
        { slug: "alpha", name: "A", total: 0 },
        { slug: "beta", name: "B", total: 0, current: true },
      ]) === "beta");
      check("Native done 在 manualComplete 未知时 fail closed", nativeTaskCanMoveTo?.({ moveTargets: ["done"] }, "done") === false);
      check("Native done 仅在 manualComplete 明确可用时开放", nativeTaskCanMoveTo?.({ moveTargets: ["done"], manualComplete: true }, "done") === true);
      check("Native 状态移动受 moveTargets 白名单约束", nativeTaskCanMoveTo?.({ moveTargets: ["queued"] }, "waiting") === false);
      const nativeCreate = nativeTaskCreateSpec?.({ title: "Native", body: "Body", column: "done" });
      check("Native 建卡固定落 backlog", nativeCreate?.column === "backlog" && nativeCreate?.title === "Native");
      const editPlan = nativeTaskEditPlan?.(
        { title: "Renamed", body: "Updated", column: "done" },
        { column: "running" },
      );
      check("Native 编辑把字段更新与 manual completion 分步", editPlan?.length === 2 && editPlan[0]?.title === "Renamed" && !Object.hasOwn(editPlan[0], "column") && editPlan[1]?.column === "done");
      check("未知 run capability fail closed", nativeTaskRunCommand({}, { runs: [] }, "run") === null);
      check("Native run 生成 autonomous command", nativeTaskRunCommand({ run: true }, { runs: [] }, "run")?.mode === "autonomous");
      const retry = nativeTaskRunCommand({ retry: true }, {
        runs: [
          { id: "run-old", status: "failed", finishedAt: 100 },
          { id: "run-new", status: "failed", finishedAt: 200 },
        ],
      }, "retry");
      check("Native retry 锁定最新允许终态 run", retry?.mode === "retry" && retry.retryOf === "run-new");
      const blocked = nativeTaskRunCommand({ retry: true }, {
        runs: [
          { id: "run-old", status: "failed", finishedAt: 100 },
          { id: "run-active", status: "running", startedAt: 300 },
        ],
      }, "retry");
      check("较新的 active run 存在时不允许 stale retry", blocked === null);
    } finally {
      compiled.cleanup();
    }
  }
}

// Kanban deep links prefer their actual backend and recover old hardcoded-backend links safely.
{
  const compiled = await compileTarget("app/manage-ui/src/lib/kanbanDeepLink.ts", "kanban-deep-link");
  try {
    const { findKanbanDeepLinkTask, resolveKanbanDeepLinkSource } = compiled.mod;
    const piSource = {
      backendId: "pi", backendName: "Pi", kind: "native", boardId: "pi-board",
      slug: "agent-pi", projectKey: "default", agentId: "shoggoth-pi", total: 1,
    };
    const projects = [{
      key: "default", name: "Default", total: 1, sources: [piSource],
    }];
    const legacyTarget = {
      project: "", backend: "shoggoth", board: "pi-board", task: "card-1",
    };
    const resolved = resolveKanbanDeepLinkSource(projects, legacyTarget);
    check(
      "旧 Kanban 深链按唯一 board 恢复实际 backend",
      resolved?.projectKey === "default" && resolved.backendId === "pi",
    );
    const tasks = [
      { id: "card-1", title: "Wrong", column: "ready", backendId: "shoggoth", sourceBoard: "other" },
      { id: "card-1", title: "Pi", column: "ready", backendId: "pi", sourceBoard: "pi-board" },
    ];
    check(
      "Kanban 深链打开实际 backend 的目标卡片",
      findKanbanDeepLinkTask(tasks, legacyTarget, resolved?.backendId)?.title === "Pi",
    );
    check(
      "重复 board 身份时旧 Kanban 深链不猜",
      resolveKanbanDeepLinkSource([
        ...projects,
        { key: "other", name: "Other", total: 0, sources: [{ ...piSource, backendId: "codex", projectKey: "other" }] },
      ], legacyTarget) === null,
    );
    const pageSource = fs.readFileSync(path.join(UI_ROOT, "src/pages/FederatedTasksPage.tsx"), "utf8");
    check(
      "联邦 Kanban 页面通过兼容解析器处理项目和卡片深链",
      pageSource.includes("resolveKanbanDeepLinkSource") && pageSource.includes("findKanbanDeepLinkTask"),
    );
  } finally {
    compiled.cleanup();
  }
}

// Native Cron 草稿转换直接执行，覆盖 schedule、线程策略和编辑计划。
{
  const formPath = "app/manage-ui/src/pages/cron/ShoggothCronForm.tsx";
  const exists = fs.existsSync(path.join(ROOT, formPath));
  check("存在通用 Native Cron 表单", exists);
  if (exists) {
    const compiled = await compileTarget(formPath, "cron-form");
    try {
      const {
        emptyNativeCronDraft,
        nativeCronInputFromDraft,
        emptyShoggothDraft,
        shoggothDraftFromJob,
        shoggothInputFromDraft,
        shoggothEditPlan,
        shoggothDraftWithThreadPolicy,
        validateShoggothDraft,
      } = compiled.mod;
      const codex = emptyNativeCronDraft("codex", "shoggoth-codex");
      const codexInput = nativeCronInputFromDraft({ ...codex, name: "Codex", prompt: "Build" });
      check("Native Cron 保留 descriptor 选择的 backend owner", codexInput.backendId === "codex" && codexInput.agentId === "shoggoth-codex");
      const empty = emptyShoggothDraft("shoggoth-default");
      check("Shoggoth Cron 默认策略保守", empty.agentId === "shoggoth-default" && empty.misfirePolicy === "latest" && empty.maxCatchUp === 1 && empty.overlapPolicy === "skip" && empty.threadPolicy === "new");

      const continuation = { ...empty, name: "Continue", prompt: "Resume", threadPolicy: "continue", threadId: "" };
      check("continue 自动复用任务固定上下文且不要求内部 threadId", validateShoggothDraft(continuation) === null && shoggothInputFromDraft(continuation).threadId === null);
      const fresh = shoggothInputFromDraft({ ...continuation, threadPolicy: "new", threadId: "must-clear" });
      check("new thread policy 强制清空 threadId", fresh.threadPolicy === "new" && fresh.threadId === null);
      const clearedDraft = shoggothDraftWithThreadPolicy?.({ ...continuation, threadId: "must-clear" }, "new");
      check("表单切换 new 会立即清空本地 threadId", clearedDraft?.threadPolicy === "new" && clearedDraft?.threadId === "");

      const atDraft = { ...empty, name: "Once", prompt: "Do it", schedKind: "at", atLocal: "2030-01-02T03:04:05" };
      const atInput = shoggothInputFromDraft(atDraft);
      check("Shoggoth at 计划转成 ISO", atInput.schedule.kind === "at" && atInput.schedule.at === new Date(atDraft.atLocal).toISOString());
      const tooShortEvery = { ...empty, name: "Frequent", prompt: "Do it", schedKind: "every", everyMin: 0.5 };
      check("Shoggoth every 小于 Store 一分钟下限会校验失败", typeof validateShoggothDraft(tooShortEvery) === "string");
      const boundedEvery = shoggothInputFromDraft(tooShortEvery);
      check("Shoggoth every 转换不会产生低于 Store 下限的请求", boundedEvery.schedule.kind === "every" && boundedEvery.schedule.everyMs === 60_000);

      const job = {
        id: "shoggoth:job",
        backendId: "shoggoth",
        agentId: "shoggoth-default",
        name: "Native",
        prompt: "authoritative prompt",
        enabled: false,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
        backendDetails: { raw: {
          workspace: "/project",
          misfirePolicy: "all-bounded",
          maxCatchUp: 3,
          overlapPolicy: "queue",
          threadPolicy: "continue",
          threadId: "thread-1",
        } },
      };
      const restored = shoggothDraftFromJob(job);
      check("Shoggoth Cron 权威详情完整回填", restored.prompt === "authoritative prompt" && restored.workspace === "/project" && restored.cronTz === "Asia/Shanghai" && restored.threadId === "thread-1");
      const edit = shoggothEditPlan(restored, job);
      check("Shoggoth Cron 编辑 patch 不夹带 backend/profile/enabled", !Object.hasOwn(edit.patch, "backendId") && !Object.hasOwn(edit.patch, "agentId") && !Object.hasOwn(edit.patch, "enabled") && edit.enabled === null);
      const enabledEdit = shoggothEditPlan({ ...restored, enabled: true }, job);
      check("Shoggoth Cron enabled 独立成第二步", enabledEdit.enabled === true && !Object.hasOwn(enabledEdit.patch, "enabled"));
      const formSource = fs.readFileSync(path.join(ROOT, formPath), "utf8");
      check("Shoggoth Cron 表单不暴露内部 threadId 输入", !formSource.includes('cronForm.shoggothThreadId'));
    } finally {
      compiled.cleanup();
    }
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} pass`);
assert.equal(failed.length, 0, `${failed.length} 项 Shoggoth domain UI 回归失败`);
