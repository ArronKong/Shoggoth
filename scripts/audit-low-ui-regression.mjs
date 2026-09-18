#!/usr/bin/env node

// R116 Task A1：管理端低危问题的定向回归。
// 可独立执行的 helper 会被真实编译运行；React 生命周期则检查关键守卫是否接入页面。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const esbuild = path.join(uiRoot, "node_modules/.bin/esbuild");

const files = {
  tasks: "app/manage-ui/src/pages/TasksPage.tsx",
  settings: "app/manage-ui/src/pages/SettingsPage.tsx",
  settingsPreferences: "app/manage-ui/src/pages/settings/SettingsPreferences.tsx",
  agents: "app/manage-ui/src/pages/AgentsPage.tsx",
  agentModelHook: "app/manage-ui/src/pages/agents/useAgentModelSettings.ts",
  agentMainModel: "app/manage-ui/src/pages/agents/AgentMainModelField.tsx",
  immersive: "app/manage-ui/src/pages/immersive/ImmersiveChat.tsx",
  avatar: "app/manage-ui/src/components/AgentAvatar.tsx",
  cron: "app/manage-ui/src/pages/CronPage.tsx",
  backends: "app/manage-ui/src/lib/backends.ts",
  cronForm: "app/manage-ui/src/pages/cron/OpenClawCronForm.tsx",
  calendar: "app/manage-ui/src/pages/CronCalendar.tsx",
  notify: "app/manage-ui/src/lib/notify.ts",
  chat: "app/manage-ui/src/pages/ChatPage.tsx",
  zh: "app/manage-ui/src/i18n/locales/zh-CN.ts",
  en: "app/manage-ui/src/i18n/locales/en.ts",
};

const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), "utf8")]),
);

const results = [];

// 每项都输出独立证据，便于 RED 时确认缺陷而非脚本自身报错。
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 将实际 TypeScript 模块打包成隔离的 CommonJS 文件，避免测试复制生产逻辑。
function compileModule(relativePath, name) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `r116-${name}-`));
  const out = path.join(outDir, `${name}.cjs`);
  execFileSync(esbuild, [
    path.join(root, relativePath),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${out}`,
  ], { stdio: "pipe" });
  return { mod: createRequire(import.meta.url)(out), outDir };
}

{
  const compiled = compileModule("app/manage-ui/src/lib/agent-create-error.ts", "agent-create");
  try {
    const classify = compiled.mod?.classifyAgentCreateError;
    const idFromName = compiled.mod?.openclawAgentIdFromName;
    const workspaceFor = compiled.mod?.openclawWorkspacePlaceholder;
    check("Agents 识别 OpenClaw main 保留名", classify?.("openclaw", "main", '"main" is reserved') === "openclaw-main-reserved");
    check("Agents 识别 Hermes profile 名错误", classify?.("hermes", "中文", "Invalid profile name '中文'. Must match [a-z0-9]") === "hermes-name-unsupported");
    check("OpenClaw 名称生成 agent id", idFromName?.("Travel Planner") === "travel-planner");
    check("OpenClaw 中文名转拼音 agent id", idFromName?.("测试") === "ceshi");
    check("OpenClaw workspace placeholder 随名称预填", workspaceFor?.("测试") === "~/.openclaw/agents/ceshi");
  } finally {
    fs.rmSync(compiled.outDir, { recursive: true, force: true });
  }
}

{
  const compiled = compileModule("app/manage-ui/src/lib/openclaw-emojis.ts", "openclaw-emojis");
  try {
    const groups = compiled.mod?.OPENCLAW_EMOJI_GROUPS;
    const catalog = Array.isArray(groups) ? groups.flatMap((group) => group.emojis || []) : [];
    check("OpenClaw emoji 选择器有八类", Array.isArray(groups) && groups.length === 8);
    check("OpenClaw emoji 选择器覆盖至少 200 项", catalog.length >= 200);
  } finally {
    fs.rmSync(compiled.outDir, { recursive: true, force: true });
  }
}

check("OpenClaw 创建不再把 workspace 当必填", !/workspaceRequired/.test(source.agents));
check("OpenClaw 创建表单使用名称派生的 workspace placeholder", /openclawWorkspacePlaceholder/.test(source.agents));
check("OpenClaw 创建表单不展示 emoji", !/<Field label=\{t\("agents.emoji"\)\}>/.test(source.agents));
check("OpenClaw 概览表单使用 EmojiField", /<EmojiField[\s\S]{0,180}form\.emoji/.test(source.agents));
check("中英文均提供 Emoji 分类文案", /pickEmoji:/.test(source.zh) && /emojiCat:/.test(source.zh) && /pickEmoji:/.test(source.en) && /emojiCat:/.test(source.en));

// 从页面源码提取一个导出的纯函数并单独编译，避免挂载整页时被浏览器顶层依赖干扰。
function compileExportedFunction(sourceText, functionName, name) {
  const marker = `export function ${functionName}(`;
  const start = sourceText.indexOf(marker);
  if (start < 0) return { mod: null, outDir: null };
  // 当前唯一目标位于页面默认组件之前；按模块边界截取，避免把 TS 类型里的
  // 对象大括号误认成函数体，导致测试脚手架先于行为断言崩溃。
  const componentStart = sourceText.indexOf("\nexport default function SettingsPage", start);
  if (componentStart < 0) return { mod: null, outDir: null };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `r116-${name}-`));
  const entry = path.join(outDir, `${name}.ts`);
  const out = path.join(outDir, `${name}.cjs`);
  fs.writeFileSync(entry, sourceText.slice(start, componentStart), "utf8");
  execFileSync(esbuild, [entry, "--bundle", "--platform=node", "--format=cjs", `--outfile=${out}`], {
    stdio: "pipe",
  });
  return { mod: createRequire(import.meta.url)(out), outDir };
}

// #1：详情请求必须有代际守卫，旧请求不能关闭或覆盖新 Drawer。
check("Tasks openView 使用详情请求代际", /detailReqRef\s*=\s*useRef\(0\)/.test(source.tasks));
check("Tasks openView 只让当前代际写 detail", /seq\s*===\s*detailReqRef\.current[^\n]*setDetail/.test(source.tasks));
check("Tasks close 会使在途详情请求失效", /const close\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,180}detailReqRef\.current\s*\+=\s*1/.test(source.tasks));
check("Tasks reloadDetail 领取同一详情请求代际", /const reloadDetail\s*=\s*async[\s\S]{0,260}seq\s*=\s*\+\+detailReqRef\.current/.test(source.tasks));
check("Tasks reloadDetail 同时校验代际和目标任务", /seq\s*===\s*detailReqRef\.current\s*&&\s*detailTargetRef\.current\s*===\s*targetId[^\n]*setDetail/.test(source.tasks));

// #3/#4：英文界面不得残留报告中的中文文案，切板失败必须反馈且不保留假选择。
for (const literal of [
  "已调度：认领", "没有可调度的就绪任务", "看板 slug 不能为空", "未指派",
  "项需关注", "优先级 ${tk.priority}", "子任务完成", "需指派", "(无标题)", "条评论",
]) {
  check(`Tasks 用户文案已国际化：${literal}`, !source.tasks.includes(literal));
}
// R360：切板改成官方语义——它只是**本页的浏览视角**，不再 POST /boards/:slug/switch
// 去改服务端 current（那会把某个开着终端的 CLI 会话的活动板抢走，官方 #20879 明令
// 禁止）。于是「等服务端成功」「失败反馈」两条不再适用；代际控制器仍在，继续保证
// 快速连点 B→C 时只有最后一次生效。
check("Tasks 切板不写服务端 current", !/const onSelectBoard[\s\S]{0,400}await switchBoard/.test(source.tasks));
check("Tasks 切板同时清筛选与选区", /const onSelectBoard[\s\S]{0,400}setActiveBoard\(slug\)[\s\S]{0,200}clearSelection\(\)/.test(source.tasks));
check("Tasks 切板使用生产代际控制器", /createBoardSwitchController/.test(source.tasks) && /boardSwitchControllerRef/.test(source.tasks));
check("Tasks 仅让当前切板目标更新选择", /boardSwitchController\.isCurrent\(ticket,\s*slug\)[\s\S]{0,120}setActiveBoard\(slug\)/.test(source.tasks));
check("Tasks 切后端会同步作废在途切板", /const onBackendChange[\s\S]{0,180}boardSwitchController\.invalidate\(\)[\s\S]{0,100}setBackend/.test(source.tasks));
check("Tasks 卸载会作废在途切板", /boardSwitchController\.mount\(\)[\s\S]{0,160}boardSwitchController\.unmount\(\)/.test(source.tasks));

// #5/#6：列表刷新剔除消失 id；头像失败回退且 id 变化后会重试。
check("Tasks 列表刷新会按可见 id 修剪批量选择", /visibleTaskIds/.test(source.tasks) && /visibleTaskIds\.has\(id\)/.test(source.tasks));
check("Tasks 卡片使用共享头像的失败回退", /function CardAvatar[\s\S]{0,100}<AgentAvatarView agentId=\{id\}/.test(source.tasks) && /onError=\{\(\) => setState\("fallback"\)/.test(source.avatar));
check("共享头像在 URL 变化后重试", /<AvatarImage key=\{src\}/.test(source.avatar));

// #20-#22：连接测试防乱序、延迟刷新可取消、主题预览离页/刷新回滚。
check("Settings 连接测试使用生产生命周期 guard", /createSettingsLifecycleGuard/.test(source.settings) && /lifecycleGuard\.beginTest\(key\)/.test(source.settings));
check("Settings 仅当前测试代际写结果", /lifecycleGuard\.isTestCurrent\(testTicket\)/.test(source.settings));
check("Settings 保存后的 refresh timer 有 ref", /saveRefreshTimerRef\s*=\s*useRef/.test(source.settings));
check("Settings 卸载清理保存后的 refresh timer", /clearTimeout\(saveRefreshTimerRef\.current\)/.test(source.settings));
check("Settings 记录已保存主题", /savedThemeRef\s*=\s*useRef/.test(source.settings));
check("Settings 卸载回滚未保存主题预览", /applyTheme\(savedThemeRef\.current\)/.test(source.settings));
check("Settings 仅成功读取配置后建立主题基线", /themeLoadedRef\s*=\s*useRef\(false\)/.test(source.settings) && /themeLoadedRef\.current\s*=\s*true/.test(source.settings));
check("Settings 主题选择在无可靠基线时禁用", /disabled=\{loading\s*\|\|\s*configFailed\s*\|\|\s*saving\}/.test(source.settings) && /disabled=\{disabled\s*\|\|\s*!themeLoaded\}/.test(source.settingsPreferences));
check("Settings 卸载只在主题基线可靠时回滚", /themeLoadedRef\.current\s*&&\s*savedThemeRef\.current/.test(source.settings));
check("Settings refresh 记录组件 mounted 状态", /lifecycleGuard\.mount\(\)/.test(source.settings) && /lifecycleGuard\.isMounted\(\)/.test(source.settings));
check("Settings refresh 每次领取请求代际", /refreshTicket\s*=\s*lifecycleGuard\.beginRefresh\(\)/.test(source.settings));
check("Settings refresh 异步落状态前校验挂载与代际", /isCurrentRefresh/.test(source.settings) && /lifecycleGuard\.isRefreshCurrent\(refreshTicket\)/.test(source.settings));
check("Settings 卸载时作废 refresh 代际", /lifecycleGuard\.unmount\(\)/.test(source.settings));
check("Settings refresh 递增 config test epoch 并清可见结果", /lifecycleGuard\.beginRefresh\(\)/.test(source.settings) && /setTests\(\{\}\)/.test(source.settings));
check("Settings 连接测试同时校验 key seq 与 config epoch", /lifecycleGuard\.beginTest\(key\)/.test(source.settings) && /isCurrentTest/.test(source.settings));
check("Settings 不清空测试序号 Map 导致序号重用", !/testReqSeqRef\.current\.clear\(/.test(source.settings));
check("BUG-022 Settings 注册 dirty/busy navigation guard", /useNavigationGuard\(\{[\s\S]{0,220}dirty[\s\S]{0,120}busy:\s*saving/.test(source.settings));
{
  const connectionActions = source.settings.slice(source.settings.indexOf("const toggleBackendConnection"), source.settings.indexOf("const runTest"));
  check("BUG-022 Settings 切换连接只保存连接状态并保留表单草稿",
    /updateConfig\(\{ disabledBackends: next \}\)/.test(connectionActions)
      && /cfgRef\.current = \{ \.\.\.cfgRef\.current, disabledBackends: saved\.disabledBackends \}/.test(connectionActions)
      && /savedConfigRef\.current\.disabledBackends = \[\.\.\.saved\.disabledBackends\]/.test(connectionActions)
      && !/requestNavigation\(|\brefresh\(|location\.reload\(/.test(connectionActions));
}
{
  const compiled = compileExportedFunction(source.settings, "runSavedRefreshIfCurrent", "settings-saved-refresh");
  try {
    const runSavedRefreshIfCurrent = compiled.mod?.runSavedRefreshIfCurrent;
    let refreshes = 0;
    const refresh = () => { refreshes += 1; };
    runSavedRefreshIfCurrent?.(true, "saved", "edited-after-save", refresh);
    check("BUG-022 Settings 保存后再次编辑会跳过延迟 refresh", typeof runSavedRefreshIfCurrent === "function" && refreshes === 0);
    runSavedRefreshIfCurrent?.(true, "saved", "saved", refresh);
    check("BUG-022 Settings 保存后未再编辑会执行延迟 refresh", refreshes === 1);
    runSavedRefreshIfCurrent?.(false, "saved", "saved", refresh);
    check("BUG-022 Settings 卸载后会跳过延迟 refresh", refreshes === 1);
  } finally {
    if (compiled.outDir) fs.rmSync(compiled.outDir, { recursive: true, force: true });
  }
}
check(
  "BUG-022 Settings timer 捕获保存快照并读取最新 cfg ref",
  /cfgRef\.current\s*=\s*cfg/.test(source.settings) &&
    /const savedEditableSnapshot\s*=\s*editableSnapshot\(cfg\)/.test(source.settings) &&
    /runSavedRefreshIfCurrent\(\s*lifecycleGuard\.isMounted\(\),\s*savedEditableSnapshot,\s*editableSnapshot\(cfgRef\.current\)/.test(source.settings),
);
check("BUG-023 Agents 聚合 overview/setup dirty guard", /useNavigationGuard\(\{[\s\S]{0,220}(?:overviewDirty[\s\S]{0,100}fileDirty|fileDirty[\s\S]{0,100}overviewDirty)/.test(source.agents));
check("BUG-023 Agents 内部 agent/tab/file 切换经共享 navigation request", /requestNavigation\(\(\)\s*=>\s*selectAgent/.test(source.agents) && /requestNavigation\(\(\)\s*=>\s*setTab/.test(source.agents) && /requestNavigation\(\(\)\s*=>\s*void openFile/.test(source.agents));
check("BUG-002 Agent 文件读取绑定目标代际", /fileRequestGuardRef/.test(source.agents) && /fileRequestGuard\.begin\(/.test(source.agents) && /fileRequestGuard\.isCurrent\(/.test(source.agents));
check("BUG-002 Agent 保存前复核加载目标", /saveFile[\s\S]{0,500}fileTargetKey\(/.test(source.agents));
check("BUG-018 默认参数回滚使用 profile 与逐字段 confirmed baseline", /defaultMutationGuardRef/.test(source.agentModelHook) && /confirm\([^)]*field/.test(source.agentModelHook) && /rollbackValue\([^)]*field/.test(source.agentModelHook));
check("BUG-020 主模型 provider 切换校验目录 membership", /selectMainProvider/.test(source.agentModelHook) && /models\.includes\(prev\)/.test(source.agentModelHook) && /mainSelectionValid/.test(source.agentModelHook));
check("BUG-020 Apply 同时受目录 membership 门控", /disabled=\{[^}]*!mainSelectionValid/.test(source.agentMainModel));
check("BUG-021 API key 激活用独立 activation token 跨 load 提交", /activationSeqRef/.test(source.agentModelHook) && /activationSeq\s*===\s*activationSeqRef\.current/.test(source.agentModelHook));

// #35：客户端保存前必须按 Hermes 最终 agent id 识别大小写、空格与标点碰撞。
{
  const compiled = compileExportedFunction(source.settings, "validateRemoteProfilesForSave", "settings-remote-profile");
  try {
    const validateProfiles = compiled.mod?.validateRemoteProfilesForSave;
    check("Settings 导出可执行的 remote profile 保存校验", typeof validateProfiles === "function");
    const collisionPairs = [
      ["Alpha Team", "alpha-team"],
      ["ALPHA TEAM", " alpha team "],
      ["Alpha.Team", "alpha_team"],
      ["!!!", "---"],
    ];
    const { agentIdForProfile } = createRequire(import.meta.url)(path.join(root, "app/core/hermes-backend.js"));
    check(
      "Settings 碰撞向量与真实 Hermes agentIdForProfile 一致",
      collisionPairs.every(([first, second]) => agentIdForProfile(first) === agentIdForProfile(second)),
    );
    const detectsAll = typeof validateProfiles === "function" && collisionPairs.every(([first, second]) =>
      validateProfiles([
        { profile: first, baseUrl: "http://first" },
        { profile: second, baseUrl: "http://second" },
      ])?.kind === "duplicate-profile"
    );
    check("Settings 保存前识别大小写/空格/标点归一碰撞", detectsAll);
    check(
      "Settings validateRemotes 使用归一碰撞结果并给出重复提示",
      /validateRemoteProfilesForSave\(cfg\.hermesRemotes\)/.test(source.settings) &&
        /settings\.remoteDuplicateProfile/.test(source.settings),
    );
  } finally {
    if (compiled.outDir) fs.rmSync(compiled.outDir, { recursive: true, force: true });
  }
}

// #23 页面侧：输入立即更新，但后端 query/cache key 只消费短防抖后的值。
check("Cron 搜索 query 使用短防抖", /debouncedQuery/.test(source.cron) && /setTimeout[\s\S]{0,180}setDebouncedQuery/.test(source.cron));
check("Cron 请求和缓存键使用 requestFilters", /JSON\.stringify\(requestFilters\)/.test(source.cron) && /listCronJobs\(requestFilters\)/.test(source.cron));

// #39/#40/#42：头像 URL 安全且有回退；Cron 动作按 job 并发；日历时钟持续更新。
check("沉浸头像 URL 编码 agent id", /<AgentAvatarView agentId=\{activeAgentId\}/.test(source.immersive) && /encodeURIComponent\(props.agentId\)/.test(source.avatar));
check("沉浸头像加载失败显示 fallback", /onError=\{\(\) => setState\("fallback"\)/.test(source.avatar));
check("沉浸头像在 agent/version 变化后重试", /<AgentAvatarView agentId=\{activeAgentId\} version=\{avatarVersion\}/.test(source.immersive) && /<AvatarImage key=\{src\}/.test(source.avatar));
check("Cron busy 使用按 job Set", /busyIdsRef\s*=\s*useRef<Set<string>>/.test(source.cron));
check("Cron 同一 job 在途时拒绝重复动作", /busyIdsRef\.current\.has\(id\)/.test(source.cron));
check("Cron 动作完成只移除自身 busy", /busyIdsRef\.current\.delete\(id\)/.test(source.cron));
check("Cron 详情动作使用生产 selection controller", /createCronSelectionController/.test(source.cron) && /selectionControllerRef/.test(source.cron));
check("Cron 详情动作完成后重新核对当前目标", /selectionController\.currentForAction\(id\)/.test(source.cron));
check("Cron 详情动作使用当前目标和当前 runs filters", /loadRunsFor\(current\.job,\s*current\.filters\)/.test(source.cron));
check(
  "Cron force-resume 语义由 descriptor 协议能力驱动",
  /descriptor\?\.surfaces\.cron\?\.kind\s*===\s*"hermes"[\s\S]{0,180}\[job\.state,\s*job\.stateLabel\][\s\S]{0,180}===\s*"paused"/.test(source.backends)
    && !/job\.backendId\s*===\s*"hermes"/.test(source.cron)
    && !/job\.backendId\s*===\s*"hermes"/.test(source.agents),
);
{
  const runBody = source.cron.match(
    /const runCronFromUi = async \(job: UnifiedCronJob, reloadRuns = false\) => \{([\s\S]*?)\n  \};/,
  )?.[1] || "";
  const confirmIndex = runBody.indexOf("await confirm({");
  const cancelIndex = runBody.indexOf("if (!okToRun) return;");
  const runIndex = runBody.indexOf('runCronJob(job.id, "force")');
  check(
    "Cron 暂停且 force-resume 的任务确认后才触发运行",
    runBody.includes("if (runWillResumePaused(job))") &&
      confirmIndex >= 0 && cancelIndex > confirmIndex && runIndex > cancelIndex,
  );
}
check(
  "Cron 列表和详情复用暂停 force-resume 运行确认入口",
  /runCronFromUi\(job\)/.test(source.cron)
    && /runCronFromUi\(selected, true\)/.test(source.cron)
    && /runWillResumePaused\(job\) \? "cron\.runAndEnable" : "cron\.run"/.test(source.cron)
    && /runWillResumePaused\(selected\) \? "cron\.runAndEnable" : "cron\.runNow"/.test(source.cron),
);
{
  const runBody = source.agents.match(
    /const runAgentCron = async \(job: UnifiedCronJob\) => \{([\s\S]*?)\n  \};/,
  )?.[1] || "";
  const confirmIndex = runBody.indexOf("await confirm({");
  const cancelIndex = runBody.indexOf("if (!okToRun) return;");
  const runIndex = runBody.indexOf('runCronJob(job.id, "force")');
  check(
    "Agents Cron 入口同样确认暂停 force-resume 的运行并启用语义",
    runBody.includes("if (runWillResumePaused(job))")
      && confirmIndex >= 0 && cancelIndex > confirmIndex && runIndex > cancelIndex
      && /runAgentCron\(j\)/.test(source.agents)
      && /runWillResumePaused\(j\) \? "cron\.runAndEnable" : "agents\.run"/.test(source.agents),
  );
}
check(
  "Cron 暂停 Hermes 运行语义和状态表头提供中英文文案",
  /runAndEnable:\s*"运行并启用"/.test(source.zh) &&
    /runAndEnableConfirm:[^\n]*恢复后续调度/.test(source.zh) &&
    /colState:\s*"调度状态"/.test(source.zh) &&
    /colLastStatus:\s*"最近运行结果"/.test(source.zh) &&
    /runAndEnable:\s*"Run and enable"/.test(source.en) &&
    /runAndEnableConfirm:[^\n]*resume future scheduling/.test(source.en) &&
    /colState:\s*"Schedule status"/.test(source.en) &&
    /colLastStatus:\s*"Latest run result"/.test(source.en),
);
check("CronCalendar 当前时间保存在可更新 state", /const \[now, setNow\]\s*=\s*useState/.test(source.calendar));
check("CronCalendar 安排下一分钟刷新并清理 timer", /nextCalendarClockDelay/.test(source.calendar) && /clearTimeout\(timer\)/.test(source.calendar));

// 日历只在真正跨日且 cursor 原先跟随旧“今天”时推进视图；分钟 tick 不得重置交互状态。
{
  const { mod, outDir } = compileModule(files.calendar, "cron-calendar");
  try {
    const shouldFollow = mod.shouldFollowCalendarDay;
    const previous = new Date(2026, 6, 13, 23, 59, 30);
    check("CronCalendar 导出跨日跟随判定", typeof shouldFollow === "function");
    check("CronCalendar 同日分钟 tick 不移动 cursor", typeof shouldFollow === "function" && shouldFollow(previous, new Date(2026, 6, 13, 23, 59, 59), previous) === false);
    check("CronCalendar 跨日且 cursor 跟随旧今天时推进", typeof shouldFollow === "function" && shouldFollow(previous, new Date(2026, 6, 14, 0, 0, 1), previous) === true);
    check("CronCalendar 用户浏览其它日期时跨日不抢视图", typeof shouldFollow === "function" && shouldFollow(previous, new Date(2026, 6, 14, 0, 0, 1), new Date(2026, 6, 1)) === false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

// #41：直接执行表单转换，确认非整分钟 everyMs 编辑后原值不变。
{
  const { mod, outDir } = compileModule(files.cronForm, "cron-form");
  try {
    const job = {
      id: "precision-job",
      name: "precision",
      backendId: "openclaw",
      enabled: true,
      schedule: { kind: "every", everyMs: 90_001, anchorMs: 1_800_000_123 },
    };
    const draft = mod.openClawDraftFromJob(job);
    const input = mod.openClawInputFromDraft(draft);
    check("OpenClaw everyMs 非整分钟往返保持 90001ms", input.schedule.everyMs === 90_001);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

// #46：直接执行通知 helper，权限拒绝/API 缺失都返回 false，成功创建返回 true。
{
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNotification = globalThis.Notification;
  globalThis.window = { openclawDesktop: undefined, focus() {} };
  globalThis.document = { hasFocus: () => false };
  const { mod, outDir } = compileModule(files.notify, "notify");
  try {
    globalThis.Notification = class DeniedNotification {
      static permission = "denied";
      static requestPermission = async () => "denied";
    };
    check("Web 通知权限拒绝返回 false", (await mod.fireNotification({ category: "chat", title: "t", body: "b", force: true })) === false);

    delete globalThis.Notification;
    check("Web Notification API 缺失返回 false", (await mod.fireNotification({ category: "chat", title: "t", body: "b", force: true })) === false);

    let created = 0;
    globalThis.Notification = class GrantedNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor() { created += 1; }
    };
    check("Web 通知成功创建返回 true", (await mod.fireNotification({ category: "chat", title: "t", body: "b", force: true })) === true && created === 1);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousNotification === undefined) delete globalThis.Notification; else globalThis.Notification = previousNotification;
  }
}

// 测试通知按钮必须消费 helper 结果并给成功/失败反馈。
check("Settings 测试通知等待发送结果", /await fireNotification/.test(source.settingsPreferences));
check("Settings 测试通知有成功反馈", /settings\.notifTestOk/.test(source.settingsPreferences) && /notifTestOk/.test(source.en));
check("Settings 测试通知有失败反馈", /settings\.notifTestFailed/.test(source.settingsPreferences) && /notifTestFailed/.test(source.en));

// Model identity stays backend-neutral in ChatPage. Missing provider may only be
// inferred from one backend-scoped catalog candidate; the proxy owns transport adaptation.
check(
  "Chat 模型继承仅从当前 backend 唯一候选推断 provider",
  /function inheritedModelChoice\([\s\S]{0,520}m\.backendId === backendId[\s\S]{0,220}candidates\.length === 1 \? candidates\[0\] : undefined/.test(source.chat),
);
const changeModelStart = source.chat.indexOf("const changeModel = useCallback(");
const changeModelEnd = source.chat.indexOf("// Fast mode toggle", changeModelStart);
const changeModelSource = source.chat.slice(changeModelStart, changeModelEnd);
const newSessionStart = source.chat.indexOf('case "new": {');
const newSessionEnd = source.chat.indexOf('case "reset":', newSessionStart);
const newSessionSource = source.chat.slice(newSessionStart, newSessionEnd);
check(
  "Chat changeModel 统一发送结构化模型 hints",
  /model:\s*modelId/.test(changeModelSource)
    && /modelProvider:\s*provider/.test(changeModelSource)
    && /acpProviderRef/.test(changeModelSource)
    && !/backendId\s*===\s*["'](?:hermes|openclaw)["']/.test(changeModelSource),
);
check(
  "Chat /new 统一发送结构化模型 hints",
  /model:\s*active\.model/.test(newSessionSource)
    && /modelProvider:\s*inheritedProvider/.test(newSessionSource)
    && /acpProviderRef/.test(newSessionSource)
    && !/backendId\s*===\s*["'](?:hermes|openclaw)["']/.test(newSessionSource),
);
const failed = results.filter((result) => !result.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} pass`);
assert.equal(failed.length, 0, `${failed.length} 项低危 UI 回归失败`);
