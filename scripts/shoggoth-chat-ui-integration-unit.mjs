#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const appPath = path.join(ROOT, "app/manage-ui/src/App.tsx");
const helperPath = path.join(ROOT, "app/manage-ui/src/lib/chatBackend.ts");
const serviceRestartPath = path.join(ROOT, "app/manage-ui/src/lib/agentServiceRestart.ts");
const chatPagePath = path.join(ROOT, "app/manage-ui/src/pages/ChatPage.tsx");
const chatCssPath = path.join(ROOT, "app/manage-ui/src/pages/ChatPage.css");
const turnTimelinePath = path.join(ROOT, "app/manage-ui/src/lib/turnTimeline.ts");
const historyRuntimePath = path.join(ROOT, "app/manage-ui/src/lib/chatHistoryRuntime.ts");
const gatewayErrorsPath = path.join(ROOT, "app/manage-ui/src/lib/gatewayErrors.ts");
const immersiveChatPath = path.join(ROOT, "app/manage-ui/src/pages/immersive/ImmersiveChat.tsx");
const kanbanPath = path.join(ROOT, "app/manage-ui/src/pages/immersive/ImmersiveKanbanPanel.tsx");
const profilePath = path.join(ROOT, "app/manage-ui/src/pages/immersive/ImmersiveProfilePanel.tsx");

assert.equal(fs.existsSync(helperPath), true, "聊天 UI 必须有统一的 backend 分类模块");
assert.equal(fs.existsSync(serviceRestartPath), true, "App 必须有 Agent Service 重启状态判定模块");

const helperSource = fs.readFileSync(helperPath, "utf8");
const helperJavaScript = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: helperPath,
}).outputText;
const identityPath = path.join(ROOT, "app/manage-ui/src/lib/nativeBackendIdentity.ts");
const identityCode = ts.transpileModule(fs.readFileSync(identityPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const identityModule = { exports: {} };
vm.runInNewContext(identityCode, { module: identityModule, exports: identityModule.exports,
  require: () => JSON.parse(fs.readFileSync(path.join(ROOT, "app/native-backend-catalog.json"), "utf8")) });
const helperModule = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${helperJavaScript}\n})(module, module.exports);`, {
  module: helperModule,
  exports: helperModule.exports,
  require: () => identityModule.exports,
});
const {
  backendOfAgent,
  backendOfAgentRows,
  backendOfSessionRows,
  resolveBackendOwner,
  isLiveChatState,
  mergeLiveText,
  projectSteeredLiveText,
  supportsBackendAttachments,
  supportsBackendSlash,
  upsertPromptEntry,
} = helperModule.exports;

const turnTimelineSource = fs.readFileSync(turnTimelinePath, "utf8");
const turnTimelineJavaScript = ts.transpileModule(turnTimelineSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: turnTimelinePath,
}).outputText;
const turnTimelineModule = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${turnTimelineJavaScript}\n})(module, module.exports);`, {
  module: turnTimelineModule,
  exports: turnTimelineModule.exports,
});
const {
  canonicalToolName,
  categorizeTool,
  toolLabelKey,
  summarizeArgs,
  stepsFromParts,
} = turnTimelineModule.exports;

assert.equal(canonicalToolName("commandExecution"), "exec",
  "原生命令工具必须归并到可理解的终端命令标签");
assert.equal(canonicalToolName("fileChange"), "file_change",
  "原生文件工具必须归并到文件修改标签");
assert.equal(canonicalToolName("Web search:"), "web_search",
  "Grok 的带空格标题必须归并到网页搜索");
assert.equal(canonicalToolName("search_web"), "web_search",
  "Antigravity 的反向命名必须归并到网页搜索");
assert.equal(canonicalToolName("run_command"), "exec",
  "Antigravity 的命令名必须归并到终端命令");
assert.equal(canonicalToolName("search_replace"), "edit",
  "Grok 的替换工具必须归并到编辑文件");
assert.equal(categorizeTool("webSearch"), "gather");
assert.equal(toolLabelKey("Web search:"), "turnLab.tools.web_search");
assert.equal(toolLabelKey("linear/create_issue"), "turnLab.tools.mcp",
  "未知 server/tool 名称必须显示外部工具标签，而不是退化成内部标识符");
assert.equal(summarizeArgs("command", { command: "npm test" }), "npm test");
assert.equal(summarizeArgs("command", { command: "/bin/zsh -lc \"pwd && sleep 5\"" }),
  "pwd && sleep 5", "折叠行必须隐藏已知 shell 启动包装");
assert.equal(summarizeArgs("read_file", {
  file_path: "/Users/example/Library/Application Support/Shoggoth/shoggoth-core/workspaces/agent-id/trajectory-display-test.txt",
}), "trajectory-display-test.txt", "原生私有工作区路径必须缩成相对文件名");
assert.equal(summarizeArgs("linear/create_issue", { title: "修复登录" }), "修复登录");
assert.equal(summarizeArgs("unknown_tool", { payload: { code: "implementation" } }), "",
  "没有人类主字段时折叠行不能倾倒对象代码");
assert.equal(summarizeArgs("Web search:", { query: "native agent trajectory" }),
  'for "native agent trajectory"', "原生 Web Search 必须按统一格式显示实际查询词");
const nativeSteps = stepsFromParts([
  { type: "plan", planEntries: [{ content: "核对代码", status: "completed" }] },
  { type: "toolCall", toolName: "command", toolArgs: { command: "npm test" } },
  { type: "toolResult", toolName: "command", text: "tests passed", durationS: 0.42 },
]);
assert.equal(nativeSteps[0].kind, "plan");
assert.equal(nativeSteps[1].canonicalName, "exec");
assert.equal(nativeSteps[1].output, "tests passed");
assert.equal(nativeSteps[1].durationS, 0.42);
const nativeSearchSteps = stepsFromParts([
  { type: "toolCall", toolName: "Web search:" },
  { type: "toolResult", toolName: "Web search:", toolArgs: { query: "native agent trajectory" }, text: "" },
]);
assert.deepEqual(nativeSearchSteps[0].args, { query: "native agent trajectory" });
assert.equal(nativeSearchSteps[0].output, "",
  "没有实际结果摘要时不能回退显示 completed/status JSON");

assert.equal(mergeLiveText("已恢复到较新文本", "已恢复"), "已恢复到较新文本",
  "历史观察器重放旧累计前缀时不能把文本重复拼接");
assert.equal(mergeLiveText("已恢复", "已恢复到较新文本"), "已恢复到较新文本",
  "新的累计 delta 必须替换旧前缀");
assert.equal(mergeLiveText("incremental ", "chunk"), "incremental chunk",
  "非累计后端的增量 chunk 仍保持兼容");
const cumulativeSteerProjection = projectSteeredLiveText("旧回答", "旧回答新回答", "旧回答");
assert.equal(cumulativeSteerProjection.accumulated, "旧回答新回答");
assert.equal(cumulativeSteerProjection.visible, "新回答",
  "steer 后的新气泡必须切掉 Runtime 累计文本的旧前缀");
const resetSteerProjection = projectSteeredLiveText("", "重置后的新回答", "旧回答");
assert.equal(resetSteerProjection.accumulated, "重置后的新回答");
assert.equal(resetSteerProjection.visible, "重置后的新回答",
  "Runtime 在 steer 后重置累计器时不得误切新文本");

const existingPrompt = { id: "local-1", requestId: "request-1", kind: "approval", question: "旧问题" };
const replayedPrompt = { id: "local-2", requestId: "request-1", kind: "approval", question: "新问题" };
const dedupedPrompts = upsertPromptEntry([existingPrompt], replayedPrompt);
assert.equal(dedupedPrompts.length, 1, "同 requestId 的重连 prompt 必须 upsert，不能重复显示卡片");
assert.equal(dedupedPrompts[0].id, "local-1", "重放更新内容时保留本地卡片 identity");
assert.equal(dedupedPrompts[0].question, "新问题");

assert.equal(backendOfAgent("shoggoth-codex"), "shoggoth", "原生命名空间离线时不得回退到 OpenClaw");
assert.equal(backendOfAgent("hermes-default"), "openclaw", "旧行只允许回退 OpenClaw");
assert.equal(backendOfAgent("main"), "openclaw");
assert.equal(resolveBackendOwner("codex", "shoggoth-codex"), "shoggoth");
assert.equal(resolveBackendOwner("grok-build", "shoggoth-grok"), "shoggoth");
assert.equal(resolveBackendOwner("antigravity", "shoggoth-antigravity"), "shoggoth");
assert.equal(resolveBackendOwner("pi", "shoggoth-pi"), "shoggoth");
assert.equal(resolveBackendOwner("claude-code", "shoggoth-claude-code"), "shoggoth");
assert.equal(resolveBackendOwner(
  "deepseek-harness", "shoggoth-deepseek-harness",
), "shoggoth");
assert.equal(backendOfSessionRows([{ key: "agent:shoggoth-codex:main", backendId: "codex" }], "agent:shoggoth-codex:main"), "shoggoth");
const hermesSessionRows = [{
  key: "agent:hermes-default:main",
  backendId: "hermes",
  agentId: "hermes-default",
}];
assert.deepEqual(
  {
    sessionOwner: backendOfSessionRows(hermesSessionRows, "agent:hermes-default:main"),
    agentOwner: backendOfAgentRows(hermesSessionRows, "hermes-default"),
    hiddenWhenOpenClawDisabled: new Set(["openclaw"]).has(
      backendOfAgentRows(hermesSessionRows, "hermes-default"),
    ),
  },
  { sessionOwner: "hermes", agentOwner: "hermes", hiddenWhenOpenClawDisabled: false },
  "禁用 OpenClaw 不得隐藏已声明归属的 Hermes agent",
);
for (const state of ["delta", "interim", "thinking", "plan", "status", "prompt"]) {
  assert.equal(isLiveChatState(state), true, `${state} 必须恢复 UI in-flight 状态`);
}
for (const state of ["final", "error", "aborted", "promptExpire", undefined]) {
  assert.equal(isLiveChatState(state), false, `${String(state)} 不能复活 UI in-flight 状态`);
}
assert.equal(supportsBackendAttachments("shoggoth", undefined), false,
  "Shoggoth 能力未返回前必须禁止附件，不能先读入文件");
assert.equal(supportsBackendAttachments("shoggoth", { attachments: {} }), false,
  "Shoggoth 显式空附件能力必须隐藏所有入口");
assert.equal(supportsBackendAttachments("shoggoth", { attachments: { image: {} } }), true,
  "只有后端明确声明后 Shoggoth 才能开启附件");
assert.equal(supportsBackendAttachments("openclaw", undefined), true,
  "既有 OpenClaw 能力加载期间仍保留 image baseline");
assert.equal(supportsBackendSlash("shoggoth", undefined), false,
  "Shoggoth 能力未返回前不得回退到 OpenClaw 斜杠命令");
assert.equal(supportsBackendSlash("shoggoth", { attachments: {}, slash: false }), false,
  "Shoggoth slash=false 必须关闭命令菜单与本地命令分派");
assert.equal(supportsBackendSlash("shoggoth", { attachments: {}, slash: true }), true);
assert.equal(supportsBackendSlash("openclaw", undefined), true,
  "OpenClaw 继续使用既有本地斜杠命令");
assert.equal(supportsBackendSlash("openclaw", {
  attachments: { image: {}, pdf: {}, file: {} },
  gatewayPolicy: true,
}), true, "OpenClaw 能力加载完成后仍必须保留客户端内置斜杠命令");

const serviceRestartSource = fs.readFileSync(serviceRestartPath, "utf8");
const serviceRestartJavaScript = ts.transpileModule(serviceRestartSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: serviceRestartPath,
}).outputText;
const serviceRestartModule = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${serviceRestartJavaScript}\n})(module, module.exports);`, {
  module: serviceRestartModule,
  exports: serviceRestartModule.exports,
});
const { INITIAL_AGENT_SERVICE_RESTART_STATE, observeAgentService } = serviceRestartModule.exports;
let serviceObservation = observeAgentService(INITIAL_AGENT_SERVICE_RESTART_STATE, { healthy: true, startedAt: 100 });
assert.equal(serviceObservation.notice, null, "首次观察到健康 Service 不能误报重启");
serviceObservation = observeAgentService(serviceObservation.state, { healthy: false });
assert.equal(serviceObservation.notice, "recovering", "已知健康 Service 失联时应提示正在恢复");
serviceObservation = observeAgentService(serviceObservation.state, { healthy: false });
assert.equal(serviceObservation.notice, null, "同一次恢复窗口不能重复提示");
serviceObservation = observeAgentService(serviceObservation.state, { healthy: true, startedAt: 200 });
assert.equal(serviceObservation.notice, "restarted", "Service startedAt 变化时应提示已重启");

const appSource = fs.readFileSync(appPath, "utf8");
assert.match(appSource, /observeAgentService\(agentServiceRestartState\.current,\s*status\.service,\s*status\.background\)/,
  "App 壳层必须消费 Agent Service 重启判定结果");
assert.match(appSource, /toast\.error\(t\("common\.agentServiceRecovering"\)\)/,
  "App 壳层必须以红色 toast 显示 Agent Service 异常");
assert.match(appSource, /common\.agentServiceRestarted/,
  "App 壳层必须显示 Agent Service 重启完成提示");

const gatewayErrorsSource = fs.readFileSync(gatewayErrorsPath, "utf8");
const gatewayErrorsJavaScript = ts.transpileModule(gatewayErrorsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: gatewayErrorsPath,
}).outputText;
const gatewayErrorsModule = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${gatewayErrorsJavaScript}\n})(module, module.exports);`, {
  module: gatewayErrorsModule,
  exports: gatewayErrorsModule.exports,
});
assert.equal(
  gatewayErrorsModule.exports.translateGatewayError("CODEX_PROMPT_TIMEOUT", (key) => key),
  "chat.gwErrors.inputTimeout",
  "输入超时的 durable 错误码在历史重载后也必须显示明确说明",
);

const chatPage = fs.readFileSync(chatPagePath, "utf8");
const chatCss = fs.readFileSync(chatCssPath, "utf8");
const immersiveChat = fs.readFileSync(immersiveChatPath, "utf8");
assert.match(chatPage, /import\s*\{[^}]*\bbackendOfSessionRows\b[^}]*\}\s*from\s*"\.\.\/lib\/chatBackend"/);
assert.doesNotMatch(chatPage, /function\s+backendOf\s*\(/, "ChatPage 不得保留二分类副本");
assert.match(chatPage, /backendOfSessionRows\(sessionsRef\.current,\s*key,\s*agentOf\(key\)\)/);
assert.match(chatPage, /backendOfSession\(activeKey\)\s*===\s*"openclaw"/);
assert.match(chatPage, /if\s*\(sk\s*&&\s*isLiveChatState\(p\.state\)\)\s*markInFlight\(sk,\s*true\)/,
  "重连 watcher 的首个非终态事件必须重新锁定 composer");
assert.match(chatPage, /return\s*\[\.\.\.out,\s*\{\s*role:\s*"assistant"[^}]*pending:\s*true/s,
  "重连后的首个 text delta 必须能创建 pending assistant 气泡");
assert.match(chatPage, /return\s+s\.agentName\s*\|\|\s*chatAgentDisplayName/,
  "会话头应优先展示 Service Profile 的用户可见名称");
assert.match(chatPage, /const\s+name\s*=\s*rep\.agentName\s*\|\|\s*chatAgentDisplayName/,
  "Agent 列表应显示 Shoggoth Profile 名称而不是 UUID agentId");
assert.doesNotMatch(chatPage, /agentId\.startsWith\("shoggoth-"\)/,
  "opaque native agent id 不得用于 owner 或品牌推断");
assert.match(chatPage, /kind\s*===\s*"image"\s*&&\s*!atts\.image/,
  "显式 attachments={} 时必须在 FileReader 前拒绝图片");
assert.match(chatPage, /supportsActiveAttachments\s*&&[\s\S]*?fileInputRef\.current\?\.click\(\)/,
  "无附件能力时不得展示可点击的附件入口");
assert.match(chatPage, /supportsBackendAttachments\(activeBackend,\s*activeCaps\)/,
  "附件默认值必须按 backend fail closed，而不是全局 image baseline");
assert.match(chatPage, /if \(nativeAgent\) return mergeNativeSlashCommands\(server \|\| \[\]\)/,
  "原生斜杠菜单必须合并 CLI 目录与应用命令");
assert.match(chatPage, /if \(supportsBackendSlash\(backend,\s*chatCapsRef\.current\[ag\]\)\) return SLASH_COMMANDS;\s*return \[\]/,
  "外部后端的默认斜杠菜单必须按 backend capability 门禁");
assert.match(chatPage, /supportsAttachments=\{supportsActiveAttachments\}/,
  "沉浸 composer 必须复用同一附件能力门禁");
assert.match(chatPage, /slashMenu=\{slashMenuNode\}\s*slashOpen=\{slashOpen\}/,
  "沉浸 composer 必须复用同一斜杠菜单和打开状态");
assert.match(chatPage, /commitOpenedHistory[\s\S]*?supportsBackendAttachments\(backendOfSession\(key\),\s*chatCapsRef\.current\[agentOf\(key\)\]\)[\s\S]*?setComposerAttachments\(\[\]\)/,
  "切入无附件能力的会话时必须清掉上一会话残留附件");
assert.match(chatPage, /if\s*\(attachments\.length\s*&&\s*key\s*&&\s*!supportsBackendAttachments\(/,
  "submit 必须二次门禁既有附件，不能只隐藏附件按钮");
assert.match(chatPage, /const nativeModelSelectionDisabled\s*=\s*activeBackendDescriptor\?\.surfaces\.agentHarness\s*===\s*true\s*&&\s*activeRunInFlight/,
  "Native 模型切换只应在发送或活动 Run 期间禁用");
assert.match(chatPage, /const\s+activeRunInFlight\s*=\s*sending\s*\|\|\s*\(activeKey\s*\?\s*runningKeys\.has\(activeKey\)\s*:\s*false\)/,
  "重连事件恢复 runningKeys 后必须重新显示停止键");
assert.match(chatPage, /canSteerActiveChat\(\s*activeCaps,\s*runStatusBySessionRef\.current\.get\(activeKey\),\s*0\s*\)/,
  "运行中发送键必须由 Runtime steer 能力与精确 running 状态共同门禁");
assert.match(chatPage, /await\s+send\("chat\.steer",\s*\{\s*sessionKey:\s*key,\s*message:\s*text\s*\}\)/,
  "支持 steering 的运行中文本必须追加当前 turn");
assert.match(chatPage, /case\s+"steer":[\s\S]*?if\s*\(nativeAgent\)[\s\S]*?await\s+sendSteeringMessage\(key,\s*args\)/,
  "原生 /steer 必须复用 chat.steer 而不是 OpenClaw 的 deliver=false 兼容协议");
assert.match(chatPage, /if\s*\(shouldSteer\)\s*\{\s*await\s+sendSteeringMessage\(key,\s*outgoing\);\s*return;/,
  "steering 成功路径不得同时进入待发队列");
assert.match(chatPage, /\{activeRunInFlight\s*\?\s*\(/,
  "普通 composer 的停止键必须使用统一运行态");
assert.match(chatPage, /sending=\{activeRunInFlight\}/,
  "沉浸 composer 必须使用统一运行态");
assert.match(chatPage, /canSteer=\{activeCanSteer\}/,
  "沉浸 composer 必须复用同一 steering 能力门禁");
assert.match(immersiveChat, /sending\s*&&\s*canSteer[\s\S]*?chat\.steerCurrentTurn/,
  "沉浸 composer 运行中必须同时保留追加与停止入口");
assert.match(chatPage, /catch\s*\(error\)\s*\{[\s\S]*?setError\([\s\S]*?return;[\s\S]*?\}\s*markInFlight\(key,\s*false\)/,
  "chat.abort 失败时必须保留运行态并显示错误");
assert.match(chatPage, /disabled=\{nativeModelSelectionDisabled\}/,
  "普通模型菜单必须在 Native runtime 空闲时可切换");
assert.match(chatPage, /modelSelectionDisabled=\{nativeModelSelectionDisabled\}/,
  "沉浸模式必须复用同一空闲门禁");
assert.match(chatPage, /activeCaps\?\.permissions\?\.options/,
  "权限选择器必须从当前后端能力读取选项，不能写死全局列表");
assert.match(chatPage, /<ChatPermissionMenu[\s\S]*?options=\{permissionOptions\}[\s\S]*?disabled=\{activeRunInFlight\}/,
  "普通 composer 必须在固定工具栏位置渲染后端自适应权限选择器");
assert.match(chatPage, /permissionOptions=\{permissionOptions\}[\s\S]*?permissionSelectionDisabled=\{activeRunInFlight\}/,
  "沉浸 composer 必须复用同一权限选项和运行态门禁");
assert.match(immersiveChat, /<ChatPermissionMenu[\s\S]*?appearance="dark"/,
  "沉浸 composer 必须渲染权限选择器并使用暗色弹层");
assert.match(chatPage, /activeCaps\?\.modelScope[\s\S]*?model\.modelScopes\?\.includes\(activeCaps\.modelScope/,
  "共享 Shoggoth 模型目录必须优先按当前 Agent Profile 隔离");
assert.match(chatPage, /activeCaps\?\.modelProvider[\s\S]*?models\.filter\(\(model\)\s*=>\s*model\.provider\s*===\s*activeCaps\.modelProvider\)/,
  "没有 profile scope 的旧后端能力仍按 provider/runtime 过滤");
assert.match(chatPage, /models=\{selectableModels\}/,
  "普通与沉浸模型菜单必须消费已按 Agent 隔离的目录");
assert.match(chatPage, /modelCaps\?\.modelScope[\s\S]*?model\.modelScopes\?\.includes\(modelCaps\.modelScope\)[\s\S]*?scopedProvider/,
  "无显式 provider 的模型切换必须同时受当前 Agent Profile 与 provider 边界约束");
assert.match(chatPage, /if\s*\(!switched\s*&&\s*activeKeyRef\.current\s*===\s*key\)\s*setPickedModel\(null\)/,
  "模型切换失败必须回滚选择器的乐观状态");
assert.match(chatPage, /upsertPromptEntry\(arr,/,
  "重连 prompt 必须按 requestId 去重，而不是盲目 push");
assert.match(chatPage, /const \[promptAttentionByKey, setPromptAttentionByKey\] = useState/,
  "待审批状态必须是响应式数据，不能只存在 ref 里");
assert.match(chatPage, /const replacePendingPrompts = useCallback[\s\S]*?chatPromptAttentionOf\(entries\)/,
  "prompt 卡与左侧状态必须通过同一同步入口更新");
assert.match(chatPage, /const approvalKey = g\.foreground\.find[\s\S]*?const inputKey = g\.foreground\.find/,
  "Agent 行必须优先展示前台会话中的待审批状态");
assert.match(chatPage, /openSession\(g\.attentionKey \|\| g\.previewKey/,
  "点击待审批 Agent 必须直达持有交互卡的会话");
const agentsChangedIndex = chatPage.indexOf('f.event === "agents.changed"');
assert.notEqual(agentsChangedIndex, -1, "聊天页必须处理 agents.changed");
const agentsChangedBranch = chatPage.slice(agentsChangedIndex, agentsChangedIndex + 1_500);
assert.match(agentsChangedBranch, /refreshSessions\(\)/,
  "后台发现联邦目标会话后必须刷新列表，待审批 Agent 才能出现");
assert.match(chatPage, /st === "approval" \|\| st === "input"[\s\S]*?chat-agent__attention-dot/,
  "待处理状态必须替换思考动效并显示独立标识");
assert.match(chatCss, /\.chat-agent__attention-dot[\s\S]*?background:\s*#f59e0b/,
  "待审批标识必须使用醒目的静态琥珀色圆点");
assert.match(chatPage, /className="chat-aside__search"[\s\S]*?setGlobalSearchOpen\(true\)/,
  "全局搜索入口必须位于聊天标题区域并打开弹窗");
assert.match(chatPage, /searchGlobalChats\(q,\s*\{[\s\S]*?limit:\s*GLOBAL_SEARCH_PAGE_SIZE[\s\S]*?offset:\s*0[\s\S]*?signal:\s*controller\.signal/,
  "聊天搜索必须通过全局搜索客户端聚合所有 agent");
assert.match(chatPage, /IntersectionObserver[\s\S]*?globalSearchSentinelRef[\s\S]*?loadMoreGlobalSearch/,
  "全局搜索必须通过结果列表底部哨兵滚动加载后续分页");
assert.match(chatPage, /ensureSessionRow\(hit\.key,\s*hit\.ts,\s*\{[\s\S]*?backendId:\s*hit\.backendId[\s\S]*?openSession\(hit\.key\)/,
  "点击全局搜索结果必须先写入 backend ownership，再打开对应会话");
assert.match(chatPage, /setPendingSearchJump\(\{\s*\.\.\.hit,\s*query:\s*data\.query,\s*token\s*\}\)[\s\S]*?openSession\(hit\.key\)/,
  "点击搜索结果必须保留消息锚点直到会话历史完成加载");
assert.match(chatPage, /findChatSearchGroupKey\(keyedShownGroups,\s*pendingSearchJump\)/,
  "搜索跳转必须把 messageId 或 Hermes 摘要解析为真实渲染组");
assert.match(chatPage, /send\("chat\.history",\s*\{[\s\S]*?sessionId:\s*target\.sessionId[\s\S]*?messageId:\s*target\.messageId/,
  "普通尾页没有命中时必须按物理 sessionId/messageId 加载目标历史窗口");
assert.doesNotMatch(chatPage, /searchScope|crossSearch|chat-search__scope/,
  "ChatPage 不得保留单 agent 搜索范围或旧跨会话搜索状态");
assert.doesNotMatch(immersiveChat, /searchOpen|searchQuery|IconSearch/,
  "沉浸聊天不得保留单 agent 搜索入口");
assert.match(immersiveChat, /disabled=\{modelSelectionDisabled\}/,
  "沉浸模型菜单必须尊重页面传入的忙状态");

const historyRuntime = fs.readFileSync(historyRuntimePath, "utf8");
assert.match(historyRuntime, /ChatBackendId/);
assert.doesNotMatch(historyRuntime, /"hermes"\s*\|\s*"openclaw"/,
  "历史/发送门禁类型必须容纳 shoggoth，而不是把它伪装成 openclaw");
const historyRuntimeJavaScript = ts.transpileModule(historyRuntime, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: historyRuntimePath,
}).outputText;
const historyRuntimeModule = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${historyRuntimeJavaScript}\n})(module, module.exports);`, {
  module: historyRuntimeModule,
  exports: historyRuntimeModule.exports,
});
const { canSendSession } = historyRuntimeModule.exports;
const readinessFor = (backend, { connected = true, connectedBackends = [backend], readyAgentIds = ["shoggoth-default"] } = {}) => ({
  backendOfSession: () => backend,
  agentOfSession: () => "shoggoth-default",
  connected,
  connectedBackends: new Set(connectedBackends),
  readyAgentIds: new Set(readyAgentIds),
});
assert.equal(canSendSession("agent:main:main", readinessFor("openclaw", {
  connected: false,
  connectedBackends: [],
  readyAgentIds: [],
})), true, "OpenClaw 必须继续沿用既有断线队列语义");
for (const backend of [
  "hermes", "shoggoth", "codex", "grok-build", "antigravity", "pi", "claude-code",
  "deepseek-harness",
]) {
  assert.equal(canSendSession("agent:shoggoth-default:thread", readinessFor(backend, { connected: false })), false,
    `${backend} 在 WebSocket 未连接时必须阻止发送`);
  assert.equal(canSendSession("agent:shoggoth-default:thread", readinessFor(backend, { connectedBackends: [] })), false,
    `${backend} 不在 connectedBackends 时必须阻止发送`);
  assert.equal(canSendSession("agent:shoggoth-default:thread", readinessFor(backend, { readyAgentIds: ["other-agent"] })), false,
    `${backend} 必须精确匹配当前 agent readiness`);
  assert.equal(canSendSession("agent:shoggoth-default:thread", readinessFor(backend)), true,
    `${backend} 三项 readiness 均满足时必须恢复发送`);
}

const zhLocale = fs.readFileSync(path.join(ROOT, "app/manage-ui/src/i18n/locales/zh-CN.ts"), "utf8");
const enLocale = fs.readFileSync(path.join(ROOT, "app/manage-ui/src/i18n/locales/en.ts"), "utf8");
assert.match(zhLocale, /backendRecovering:\s*"正在恢复 \{\{backend\}\}…"/,
  "Native 恢复态必须按 backend 名称呈现");
assert.match(enLocale, /backendRecovering:\s*"Recovering \{\{backend\}\}…"/,
  "英文恢复提示必须按 backend 名称呈现");
assert.match(zhLocale, /approval:\s*"等待审批"[\s\S]*?input:\s*"等待输入"/,
  "中文必须区分审批和输入请求");
assert.match(enLocale, /approval:\s*"Awaiting approval"[\s\S]*?input:\s*"Awaiting input"/,
  "英文必须区分审批和输入请求");
assert.match(chatPage, /const\s+activeRecoveryHint\s*=/,
  "后端恢复期间必须保留消息区的中性恢复提示");
for (const [label, source] of [["普通", chatPage], ["沉浸", immersiveChat]]) {
  assert.doesNotMatch(source, /chat-composer__connecting|chat-connecting-hint|\bconnectingHint\b/,
    `${label} composer 不得为任何 backend 渲染连接状态`);
}
assert.match(chatPage, /historyError\s*&&\s*activeRecoveryHint[\s\S]*?chat-empty[\s\S]*?activeRecoveryHint/,
  "后端恢复窗口的历史失败必须显示中性恢复提示，不能先渲染通用错误");
assert.match(chatPage, /historyError\s*&&\s*!activeRecoveryHint[\s\S]*?historyLoadFailed/,
  "后端已就绪后仍失败时必须保留真实历史错误与手动重试入口");

for (const target of [kanbanPath, profilePath]) {
  const source = fs.readFileSync(target, "utf8");
  assert.match(source, /backendId:\s*string/);
  assert.doesNotMatch(source, /backendOfAgent/);
  assert.doesNotMatch(source, /const\s+backendOf\s*=/, `${path.basename(target)} 不得保留二分类副本`);
}

console.log("shoggoth chat UI integration: PASS");
