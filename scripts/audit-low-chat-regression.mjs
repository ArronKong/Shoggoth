#!/usr/bin/env node

// R116 Task A2：聊天页低危缺陷专项回归。
// 状态清理、RPC 结算、compact 参数、重试附件与渲染身份直接执行生产 helper；
// ChatPage 闭包内的接线另做窄范围源码断言，避免只验证一份测试侧复制逻辑。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const helperFile = "app/manage-ui/src/lib/chatRuntime.ts";
const helperPath = path.join(root, helperFile);
const chatPath = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const esbuild = path.join(uiRoot, "node_modules/.bin/esbuild");
const chatSource = fs.readFileSync(chatPath, "utf8");
const results = [];

// 每个行为独立输出，RED 时可以确认失败来自目标缺陷，而不是脚本脚手架。
function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 深比较失败转成布尔值，保证单项退化显示 FAIL，而不是提前中止后续证据。
function isDeepEqual(actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

// 编译并加载真实 TypeScript helper；helper 尚未实现时返回 null，让 RED 以断言失败呈现。
function compileHelper() {
  if (!fs.existsSync(helperPath)) return { mod: null, cleanup() {} };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "r116-low-chat-"));
  const outfile = path.join(outDir, "chat-runtime.cjs");
  try {
    execFileSync(esbuild, [helperPath, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outfile}`], {
      stdio: "pipe",
    });
    return {
      mod: createRequire(import.meta.url)(outfile),
      cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }),
    };
  } catch {
    fs.rmSync(outDir, { recursive: true, force: true });
    return { mod: null, cleanup() {} };
  }
}

const compiled = compileHelper();
try {
  const runtime = compiled.mod;

  // BUG-019：session/roster 列表并发刷新只允许最后发起的一次提交。
  if (runtime?.createLatestRequestGuard) {
    const guard = runtime.createLatestRequestGuard();
    const older = guard.begin();
    const newer = guard.begin();
    check("BUG-019 latest request guard 拒绝旧刷新", !guard.isCurrent(older) && guard.isCurrent(newer));
    guard.invalidate();
    check("BUG-019 latest request guard 可在上下文切换时整体作废", !guard.isCurrent(newer));
  } else {
    check("BUG-019 latest request guard 拒绝旧刷新", false);
    check("BUG-019 latest request guard 可在上下文切换时整体作废", false);
  }

  // #12：建立新 socket 前，旧轮次的工具、思考、计划缓存必须一次清空。
  if (runtime?.clearLiveTurnState) {
    const tools = new Map([["agent:a:main", [{ id: "tool-1" }]]]);
    const thinking = new Map([["agent:a:main", "old thinking"]]);
    const plans = new Map([["agent:a:main", [{ content: "old plan", status: "pending" }]]]);
    runtime.clearLiveTurnState(tools, thinking, plans);
    check("#12 真实实时轮次状态转换会清空 tools/thinking/plan", tools.size === 0 && thinking.size === 0 && plans.size === 0);
  } else {
    check("#12 真实实时轮次状态转换会清空 tools/thinking/plan", false);
  }

  // #13：close 只结算属于该 socket 的 RPC；既清 timeout，也不能误伤新 socket 请求。
  if (runtime?.rejectPendingRpcForSocket && runtime?.takePendingRpc) {
    const oldSocket = { name: "old" };
    const newSocket = { name: "new" };
    const rejected = [];
    const cleared = [];
    const previousClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = (timer) => { cleared.push(timer); };
    try {
      const pending = new Map([
        ["old-1", { socket: oldSocket, timer: "timer-old-1", resolve() {}, reject(error) { rejected.push(error.message); } }],
        ["old-2", { socket: oldSocket, timer: "timer-old-2", resolve() {}, reject(error) { rejected.push(error.message); } }],
        ["new-1", { socket: newSocket, timer: "timer-new-1", resolve() {}, reject(error) { rejected.push(error.message); } }],
      ]);
      const count = runtime.rejectPendingRpcForSocket(pending, oldSocket, new Error("socket closed"));
      check(
        "#13 旧 socket close 立即 reject/clear 自身全部 RPC 与 timeout",
        count === 2 && rejected.length === 2 && cleared.includes("timer-old-1") && cleared.includes("timer-old-2") && !pending.has("old-1") && !pending.has("old-2"),
      );
      check(
        "#13 旧 socket close 不伤新 socket pending",
        pending.has("new-1") && !cleared.includes("timer-new-1"),
      );
      const settled = runtime.takePendingRpc(pending, "new-1", newSocket);
      check(
        "#13 正常响应也会同步移除 pending 并清 timeout",
        settled?.socket === newSocket && pending.size === 0 && cleared.includes("timer-new-1"),
      );
    } finally {
      globalThis.clearTimeout = previousClearTimeout;
    }
  } else {
    check("#13 旧 socket close 立即 reject/clear 自身全部 RPC 与 timeout", false);
    check("#13 旧 socket close 不伤新 socket pending", false);
    check("#13 正常响应也会同步移除 pending 并清 timeout", false);
  }

  // #14：非空参数 trim 后作为 instructions；空参数维持旧 `{key}` 契约。
  if (runtime?.buildCompactParams) {
    check(
      "#14 /compact trim 后透传 instructions",
      isDeepEqual(runtime.buildCompactParams("agent:a:main", "  保留最近决策  "), {
        key: "agent:a:main",
        instructions: "保留最近决策",
      }),
    );
    check(
      "#14 /compact 空参数保持只传 key",
      isDeepEqual(runtime.buildCompactParams("agent:a:main", "  \n "), { key: "agent:a:main" }),
    );
  } else {
    check("#14 /compact trim 后透传 instructions", false);
    check("#14 /compact 空参数保持只传 key", false);
  }

  // #15：把原 user message 的 data URL 图片转换成 sendChatMessage 当前附件形状。
  if (runtime?.retryChatAttachments) {
    let id = 0;
    const attachments = runtime.retryChatAttachments(
      ["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG", "https://example.com/not-embedded.png"],
      () => `retry-id-${++id}`,
    );
    check(
      "#15 重试图片转换为 ChatAttachment 且保留 MIME/dataUrl",
      attachments.length === 2 &&
        attachments[0].id === "retry-id-1" && attachments[0].mimeType === "image/png" && attachments[0].dataUrl === "data:image/png;base64,QUJD" &&
        attachments[1].name.endsWith(".jpg") && attachments[1].mimeType === "image/jpeg",
    );
  } else {
    check("#15 重试图片转换为 ChatAttachment 且保留 MIME/dataUrl", false);
  }

  // #16：稳定基础身份还必须在同级列表内消歧；局部 occurrence 不能受其它身份的 prepend 影响。
  if (runtime?.keyedChatMessages && runtime?.keyedChatGroups && runtime?.keyedChatChildren) {
    const identified = { id: "message-42", role: "user", ts: 100, parts: [{ type: "text", text: "hello" }] };
    const anonymous = { role: "assistant", ts: 200, model: "m", parts: [{ type: "text", text: "answer" }] };
    const anonymousClone = { ...anonymous, parts: anonymous.parts.map((part) => ({ ...part })) };
    const divider = { role: "system", parts: [], divider: { sealedAt: 50, fromReset: true } };
    const pendingA = { role: "assistant", pending: true, parts: [{ type: "text", text: "" }] };
    const pendingB = { role: "assistant", pending: true, parts: [{ type: "text", text: "" }] };
    const pendingKeys = runtime.keyedChatMessages([pendingA, pendingB]).map((entry) => entry.key);
    check("#16 两个 distinct pending message 同级 key 唯一", new Set(pendingKeys).size === 2);
    const liveBefore = runtime.keyedChatChildren(pendingA, "part", [{ type: "text", text: "first" }]);
    const liveAfter = runtime.keyedChatChildren(pendingA, "part", [
      { type: "plan", planEntries: [{ content: "work", status: "pending" }] },
      { type: "thinking", text: "reasoning" },
      { type: "toolCall", toolName: "read" },
      { type: "text", text: "first, then more text" },
    ]);
    check("流式文字增长、前插计划/思考/工具都不改文字节点 identity", liveBefore[0].key === liveAfter[3].key);
    const liveChanged = runtime.keyedChatChildren(pendingA, "part", [
      { type: "plan", planEntries: [{ content: "work", status: "completed" }] },
      { type: "thinking", text: "reasoning continues" },
      { type: "toolResult", toolName: "read", text: "done" },
      { type: "text", text: "first, then more text" },
    ]);
    check("流式计划/思考更新保留各自 identity", liveAfter[0].key === liveChanged[0].key && liveAfter[1].key === liveChanged[1].key);
    const repeatedLive = runtime.keyedChatChildren(pendingA, "part", [{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    check("同类型流式 part 仍按 occurrence 消歧", new Set(repeatedLive.map((entry) => entry.key)).size === 2);

    const anonymousBefore = runtime.keyedChatMessages([anonymous, anonymousClone]).map((entry) => entry.key);
    const prependedAnonymous = { ...anonymous, parts: anonymous.parts.map((part) => ({ ...part })) };
    const anonymousAfter = runtime.keyedChatMessages([prependedAnonymous, anonymous, anonymousClone]).slice(1).map((entry) => entry.key);
    check(
      "#16 同内容同时间匿名 message 同级唯一且 prepend 后 identity 不变",
      new Set(anonymousBefore).size === 2 && isDeepEqual(anonymousAfter, anonymousBefore),
    );

    const groupA = { role: "assistant", msgs: [anonymous] };
    const groupB = { role: "assistant", msgs: [anonymousClone] };
    const archiveGroup = { role: "system", msgs: [divider] };
    const prependedSameGroup = { role: "assistant", msgs: [prependedAnonymous] };
    const groupKeysBefore = runtime.keyedChatGroups([groupA, groupB]).map((entry) => entry.key);
    const groupKeysAfter = runtime.keyedChatGroups([archiveGroup, prependedSameGroup, groupA, groupB]).slice(2).map((entry) => entry.key);
    check(
      "#16 相同匿名 group 同级唯一且归档 prepend 不改旧 key",
      new Set(groupKeysBefore).size === 2 && isDeepEqual(groupKeysAfter, groupKeysBefore),
    );

    const duplicatePart = { type: "text", text: "same" };
    const duplicatePlan = { content: "same plan", status: "pending" };
    const childCases = [
      runtime.keyedChatChildren(anonymous, "part", [duplicatePart, { ...duplicatePart }]),
      runtime.keyedChatChildren(anonymous, "image", ["data:image/png;base64,QUJD", "data:image/png;base64,QUJD"]),
      runtime.keyedChatChildren(anonymous, "plan-entry", [duplicatePlan, { ...duplicatePlan }]),
      runtime.keyedChatChildren(anonymous, "quote", ["same quote", "same quote"]),
      runtime.keyedChatChildren(anonymous, "media", ["/__media/same.png", "/__media/same.png"]),
    ];
    check(
      "#16 重复 part/image/plan-entry/quote/media 的同级 key 均唯一",
      childCases.every((entries) => entries.length === 2 && entries[0].key !== entries[1].key),
    );
    check("#16 message id 仍优先成为渲染身份", runtime.keyedChatMessages([identified])[0]?.key.includes("message-42"));
  } else {
    check("#16 两个 distinct pending message 同级 key 唯一", false);
    check("#16 同内容同时间匿名 message 同级唯一且 prepend 后 identity 不变", false);
    check("#16 相同匿名 group 同级唯一且归档 prepend 不改旧 key", false);
    check("#16 重复 part/image/plan-entry/quote/media 的同级 key 均唯一", false);
    check("#16 message id 仍优先成为渲染身份", false);
  }
} finally {
  compiled.cleanup();
}

const fetchSessionsStart = chatSource.indexOf("const fetchAllSessions =");
const fetchSessionsEnd = chatSource.indexOf("const refreshSessions =", fetchSessionsStart);
const fetchSessionsSource = fetchSessionsStart >= 0 && fetchSessionsEnd > fetchSessionsStart
  ? chatSource.slice(fetchSessionsStart, fetchSessionsEnd)
  : "";
check(
  "BUG-019 sessions fetch 返回无副作用 snapshot",
  /Promise<SessionListSnapshot>/.test(fetchSessionsSource) &&
    !/setDefaultCtxTokens\(|degradedBackendsRef\.current\s*=|commitSessions\(/.test(fetchSessionsSource),
);
check("BUG-019 所有 session 列表提交收口到 refreshSessions", !/fetchAllSessions\(\)\s*\.then\(\(all\)\s*=>\s*commitSessions/.test(chatSource) && /const refreshSessions = useCallback/.test(chatSource));

// 组件闭包接线：helper 必须接到真实 socket/send/compact/retry/render 路径。
check(
  "#12 ChatPage 建立新 WebSocket 时清实时轮次残留",
  /clearLiveTurnState\(liveToolsRef\.current,\s*pendingThinkingRef\.current,\s*pendingPlanRef\.current\);[\s\S]{0,220}new WebSocket/.test(chatSource),
);
check(
  "#12 主动发送前仍保留按 session 清理",
  /liveToolsRef\.current\.delete\(key\)[\s\S]{0,140}pendingThinkingRef\.current\.delete\(key\)[\s\S]{0,140}pendingPlanRef\.current\.delete\(key\)/.test(chatSource),
);
const closeStart = chatSource.indexOf("ws.onclose =");
const closeEnd = chatSource.indexOf("ws.onerror =", closeStart);
const closeSource = closeStart >= 0 && closeEnd > closeStart ? chatSource.slice(closeStart, closeEnd) : "";
check(
  "#13 onclose 结算所属 socket RPC 且 stale close 有身份守卫",
  closeSource.includes("rejectPendingRpcForSocket(pending.current, ws") &&
    closeSource.includes("if (wsRef.current !== ws) return") &&
    closeSource.indexOf("if (wsRef.current !== ws) return") < closeSource.indexOf("setConnected(false)"),
);
check("#13 RPC response 使用 takePendingRpc 清 timeout", /takePendingRpc\(pending\.current,\s*String\(f\.id\),\s*ws\)/.test(chatSource));
check("#14 dispatchSlash 使用 args 构造 compact 参数", /send\("sessions\.compact",\s*buildCompactParams\(key,\s*args\)\)/.test(chatSource));
check(
  "#15 retryErrorGroup 同时重发原文本与转换后附件",
  /const atts\s*=\s*retryChatAttachments\(m\.images\s*\?\?\s*\[\]\)[\s\S]{0,180}sendChatMessage\(txt,\s*atts\)/.test(chatSource),
);
const threadStart = chatSource.indexOf("{keyedThreadGroups.map(");
const threadEnd = chatSource.indexOf("<div ref={bottomRef}", threadStart);
const threadSource = threadStart >= 0 && threadEnd > threadStart ? chatSource.slice(threadStart, threadEnd) : "";
check(
  "#16 普通线程 group/reset/message/part/image 不再使用裸数组下标 key",
  /messages:\s*keyedChatMessages\(group\.item\.msgs\)/.test(chatSource) &&
    /parts:\s*keyedChatChildren\(message\.item, "part", message\.item\.parts\)/.test(chatSource) &&
    threadSource.includes("keyedMessages.map") && threadSource.includes("keyedParts.map") &&
    threadSource.includes("keyedImages.map") && threadSource.includes("keyedFiles.map") &&
    !/key=\{(?:gi|mi|pi|ii|ei|qi)\}/.test(threadSource) && !/`\$\{mi\}-\$\{pi\}`/.test(threadSource),
);
check(
  "#16 普通与沉浸 shownGroups 共用同一组同级唯一身份",
  /const keyedShownGroups\s*=\s*useMemo\(\(\)\s*=>\s*keyedChatGroups\(shownGroups\)/.test(chatSource) &&
    /id:\s*groupRenderKey/.test(chatSource) && !/last\?\.id\s*\|\|\s*`g\$\{i\}`/.test(chatSource),
);

const failed = results.filter((result) => !result.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} pass`);
assert.equal(failed.length, 0, `${failed.length} 项聊天页低危回归失败`);
