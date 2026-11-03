"use strict";

// Synthetic DTOs for the production GroupChatPanel. These are UI examples,
// never replayed prompts or observations of a live account.
const groupId = "group-message-stop-preview";
const now = Date.parse("2026-11-02T11:08:00+08:00");
const memberSpecs = [["opencode", "OpenCode", "shoggoth"], ["antigravity", "Antigravity", "shoggoth"],
  ["maya", "Maya", "openclaw"], ["shrimp", "虾长老", "openclaw"], ["default", "default", "hermes"],
  ["deepseek", "DeepSeek", "shoggoth"], ["shoggoth", "Shoggoth", "shoggoth"]];
const members = memberSpecs.map(([id, displayName, backendId], position) => ({ id, groupId, displayName, backendId,
  agentId: id, profileId: backendId === "shoggoth" ? id : null, handle: displayName.toLowerCase(), state: "active",
  position, joinedSeq: 0, leftSeq: null }));
const first = "我来负责把稿子和 HTML 交付，先让各位领取板块。我先核对最近两天 AI 领域的事件。";
const second = "材料已够用，我先把可交付的 HTML 做出来。";
const defaultQueue = ["maya", "default", "opencode", "deepseek"];
const copy = value => JSON.parse(JSON.stringify(value));
const message = (seq, memberId, body, { partial = false, streaming = false, turn = memberId, ...extra } = {}) => ({
  id: `message-${seq}`, groupId, seq, threadId: "main", createdAt: now + seq * 35_000, revision: seq,
  author: memberId === "user" ? { kind: "user" } : { kind: "member", memberId }, body,
  mentions: { memberIds: [], broadcast: false, unresolved: [] },
  ...(memberId !== "user" ? { origin: { opportunityId: `turn-${turn}`, runId: `run-${turn}`,
    discussionId: "discussion-preview", partial, streaming, textItemId: `segment-${seq}` } } : {}), ...extra,
});
const user = () => message(1, "user", "帮我整理一份最近 2 天的 AI 新闻 HTML，你们自己分工。");
const context = () => [user(), message(2, "opencode", "HTML 初稿已准备好。@虾长老 请继续核对技术部分，之后由 @Maya 接着整理。")];
const activity = (id, phase) => ({ groupId, memberId: id, opportunityId: `turn-${id}`, discussionId: "discussion-preview",
  runId: `run-${id}`, taskId: null, attemptId: null, executionGeneration: `preview:${id}`, phase,
  title: "", eventSeq: 1, streamGeneration: `stream:${id}`, observedAt: now + 300_000,
  lastProgressAt: now + 300_000, recentTools: [], tool: null });
const turn = (id, options = {}) => ({ opportunityId: `turn-${id}`, memberId: id, discussionId: "discussion-preview",
  startedAt: now + 300_000, floor: true, released: false, releasedReason: null, individualMessages: true,
  activity: activity(id, options.phase || "running"), ...options });
const stoppingTurn = (id, reason = "GROUP_EXECUTION_STOP_UNCONFIRMED") => turn(id, {
  stopping: true, activity: activity(id, "stopping"),
  recovery: { type: "execution", reason, since: now + 600_000, cancelRequested: true },
});
const stoppedSpeechTurn = (id, reason) => ({ ...stoppingTurn(id, reason), floor: false, released: true,
  releasedReason: "stopped", releasedAt: now + 600_000 });
const system = (seq, eventType, memberId, errorCode) => ({ ...message(seq, "user", ""), author: { kind: "system" },
  system: { eventType, memberId, ...(errorCode ? { errorCode } : {}) } });
function snapshot(messages, activeTurns = [], queuedMemberIds = [], extra = {}) {
  const active = activeTurns.length > 0 || queuedMemberIds.length > 0;
  const { view: viewPatch, ...flags } = extra;
  return { messages, view: { ownerScope: "preview-owner", group: { id: groupId, name: "测试群", purpose: "", status: "active",
    createdAt: now, updatedAt: now + 600_000, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1,
    controlEpoch: 1, lastSeq: messages.length, messageRevision: messages.length, ownerMemberId: "opencode" },
  currentOwnerId: "opencode", members, activeTurns, queuedMemberIds, internalSessionKeys: [], pendingInteractions: [],
  round: active ? { id: "discussion-preview", causeMessageId: "message-1", order: [
    ...activeTurns.map(item => ({ opportunityId: item.opportunityId, memberId: item.memberId, state: "running",
      released: item.released, releasedReason: item.releasedReason, errorCode: null })),
    ...queuedMemberIds.map(id => ({ opportunityId: `next-${id}`, memberId: id, state: "queued", released: false,
      releasedReason: null, errorCode: null })),
  ] } : null, ...viewPatch }, ...flags };
}
const step = (label, note, data) => ({ label, note, data });
const flowing = (id, body) => [...context(), message(3, id, body, { partial: true, streaming: true })];
const memberStopped = () => [...context(), system(3, "turn_stopped", "shrimp")];
const backgroundMessages = () => [...context(),
  message(3, "shrimp", "我先核对技术细节，整理完成后补充。", { partial: true }),
  message(4, "maya", "我继续整理汇总部分。", { partial: true, streaming: true })];
const backgroundStopped = () => [...backgroundMessages(), system(5, "turn_stopped", "shrimp")];
const failureMessages = () => [...context(), system(3, "turn_failed", "shrimp", "OPENCLAW_SESSION_ARCHIVED")];
const bothWorking = () => snapshot([
  user(), message(2, "opencode", "HTML 还在继续整理。@虾长老 请先核对技术部分。", { partial: true }),
], [turn("shrimp"), idleTurn("opencode")], ["maya", "default", "deepseek"]);
const idleTurn = (id, options = {}) => turn(id, { floor: false, released: true, releasedReason: "idle",
  releasedAt: now + 420_000, activity: activity(id, "reconciling"),
  recovery: { type: "execution", reason: "GROUP_EXTERNAL_RUN_LOST", since: now + 300_000, cancelRequested: false }, ...options });
const originalReturned = () => [...context(), message(3, "maya", "技术核对的原任务暂时无法查询，我先汇总不依赖它结果的其他部分。", { partial: true }),
  message(4, "shrimp", "技术核对已完成。这是刚才原任务的结果，可以接着合入 HTML。")];
function stoppingGroup() {
  const data = bothWorking(); data.view.activeTurns = [stoppingTurn("shrimp"), stoppingTurn("opencode")];
  data.view.activeTurns[1].floor = false; data.view.activeTurns[1].released = true;
  data.view.queuedMemberIds = []; data.view.round = null; return data;
}

const scenes = [
  { id: "messages", title: "消息只显示一次", caption: "从过程说明到最终回复", steps: [
    step("第一段说明", "第一段公开说明只出现一次，OpenCode 仍在工作，加载动画单独显示。",
      snapshot([user(), message(2, "opencode", first, { partial: true })], [turn("opencode")], ["antigravity", "shrimp", "maya"])),
    step("第二段说明", "两段说明各有一条独立气泡和时间；工具前的过程记录不会再插入相同文字。",
      snapshot([user(), message(2, "opencode", first, { partial: true }), message(3, "opencode", second, { partial: true })],
        [turn("opencode")], ["antigravity", "shrimp", "maya"])),
    step("最终回复", "结束时保留两条过程说明，并追加最终回复。不会再把历史读回的过程说明重复发出。",
      snapshot([user(), message(2, "opencode", first, { partial: true }), message(3, "opencode", second, { partial: true }),
        message(4, "opencode", "稿件与 HTML 初稿已整理完成。@Antigravity 请接着核对来源。")], [turn("antigravity")], ["shrimp", "maya"])),
    step("下一位接话", "Antigravity 开始输出；OpenCode 已经发出的三条消息继续保留原来的顺序。",
      snapshot([user(), message(2, "opencode", first, { partial: true }), message(3, "opencode", second, { partial: true }),
        message(4, "opencode", "稿件与 HTML 初稿已整理完成。@Antigravity 请接着核对来源。"),
        message(5, "antigravity", "我来继续核对原始来源和日期。", { partial: true, streaming: true })], [turn("antigravity", { phase: "text" })], ["shrimp", "maya"])),
  ] },
  { id: "archive", title: "归档后恢复虾长老", caption: "先换会话，再继续回答", steps: [
    step("轮到虾长老", "轮到虾长老时，群聊显示等待气泡；Maya 等成员在后面排队。", snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("更换内部会话", "系统确认旧会话已归档且无活动运行，先换新的群内部会话。当前界面在这个短暂阶段仍显示等待气泡，没有额外的“正在恢复”提示。",
      snapshot(context(), [turn("shrimp", { phase: "preparing" })], defaultQueue)),
    step("虾长老继续回答", "新会话准备好后仍由虾长老回答，不会因为这次归档直接跳过它。",
      snapshot(flowing("shrimp", "我已接着看到了群里的分工，现在继续核对技术部分。"), [turn("shrimp", { phase: "text" })], defaultQueue)),
    step("完成后 Maya 接话", "虾长老完成这一回合，发言位交给队列中的 Maya。",
      snapshot([...context(), message(3, "shrimp", "技术部分已整理好，@Maya 请继续汇总。")], [turn("maya")], ["default", "opencode", "deepseek"])),
  ] },
  { id: "failure", title: "明确失败后继续", caption: "结束失败回合，推进队列", steps: [
    step("正在启动", "这里演示准备后状态发生变化，启动请求又被明确拒绝的情况。", snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("失败，Maya 接棒", "虾长老这一回合结束并释放发言位，Maya 立即进入回答。灰色失败提示和错误码使用现有界面的实际文案。",
      snapshot(failureMessages(), [turn("maya")], ["default", "opencode", "deepseek"])),
    step("Maya 开始输出", "下一位已开始发言，失败提示保留在群历史中，虾长老的加载气泡已经消失。",
      snapshot([...failureMessages(), message(4, "maya", "我先继续整理已经收到的内容，完成汇总后再交给下一位。", { partial: true, streaming: true })],
        [turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
  ] },
  { id: "idle-yield", title: "异常持续两分钟让位", caption: "异常才跳过，后台自动查询", steps: [
    step("查询异常未满两分钟", "虾长老的原任务状态持续无法查询，已经 1 分 59 秒；系统自动查询原任务。只有状态异常才进入这段计时，正常慢任务不会进入。",
      snapshot(context(), [turn("shrimp", { activity: activity("shrimp", "reconciling"),
        recovery: { type: "execution", reason: "GROUP_EXTERNAL_RUN_LOST", since: now + 300_000, cancelRequested: false } })], defaultQueue)),
    step("异常满两分钟，Maya 开始", "状态异常持续满两分钟且没有有效进展，才让位给 Maya。异常说明和没有正文的头像名称占位都不显示；原任务后台查询，不中止、不重发。有真实回复时，停止图标保留在原消息下。",
      snapshot(context(), [idleTurn("shrimp"), turn("maya")], ["default", "opencode", "deepseek"])),
    step("后台自动查询", "这里无法确认虾长老是否还在执行，所以不会宣称它正常运行。Maya 已收到前一任务状态不明的说明，先处理不依赖缺失结果的部分；无需人工核对。",
      snapshot(flowing("maya", "技术核对的原任务暂时无法查询，我先汇总不依赖它结果的其他部分。"),
        [idleTurn("shrimp"), turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
    step("自动读到原结果", "系统后来自动查询到原任务完成，才把原结果发回群里。原任务可能一直在执行，也可能早已完成只是回执丢失；原请求始终没有重发。",
      snapshot(originalReturned(), [turn("maya")], ["default", "opencode", "deepseek"])),
    step("下一位继续", "Maya 完成本回合后由 default 接话。原任务结果保留一条，不会重新发送同一请求。",
      snapshot([...originalReturned(), message(5, "maya", "已收到技术核对结果，汇总完成。@default 请继续检查。")],
        [turn("default")], ["opencode", "deepseek"])),
  ] },
  { id: "active-progress", title: "正常慢任务继续等", caption: "没有输出也不提前交棒", steps: [
    step("正常开始处理", "正常运行的任务按原顺序完成后再交棒。两分钟规则只用于启动回执不明或状态持续无法查询等异常。",
      snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("三分钟没有新文字", "运行状态仍可正常查询，三分钟没有文字只是速度较慢，不作为卡死证据。继续等待虾长老，Maya 尚未启动。",
      snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("正常工具执行十分钟", "任务正在正常执行工具，即使十分钟没有新增输出也继续等待。默认的工具 15 秒主动让位已取消，避免打断上下文的先后依赖。",
      snapshot(context(), [turn("shrimp", { phase: "tool" })], defaultQueue)),
    step("完整结果后再交棒", "虾长老完成并发出完整结果后，Maya 才开始，启动上下文包含刚才的结果。正常慢任务不会显示异常让位提示。",
      snapshot([...context(), message(3, "shrimp", "技术核对已完成，以下是完整结论。@Maya 请接着汇总。")], [turn("maya")], ["default", "opencode", "deepseek"])),
  ] },
  { id: "member-stop", title: "只停虾长老", caption: "气泡底部的停止图标", steps: [
    step("气泡聚焦后点击停止图标", "鼠标移到虾长老的当前气泡上，复制、删除之后会出现同尺寸的停止图标；没有“停止”文字。键盘焦点进入气泡时也显示。没有文字的加载气泡同样保留图标入口。输入框里不再显示成员状态条。", snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("点击后立即让位", "停止被受理就结束虾长老本次发言，Maya 立即开始。没有“等待确认停止”的气泡；系统在后台取消和查询原任务，其他成员队列保留。",
      snapshot(memberStopped(), [stoppedSpeechTurn("shrimp"), turn("maya")], ["default", "opencode", "deepseek"])),
    step("后台清理不挡发言", "即使取消回执还没到，Maya 也已开始输出。虾长老的旧任务在后台自动处理，不显示停止确认卡，也不会把停止后才到的内容补进群聊。",
      snapshot([...memberStopped(), message(4, "maya", "我继续处理汇总部分，先按现有材料往下整理。", { partial: true, streaming: true })],
        [stoppedSpeechTurn("shrimp"), turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
    step("原任务退出，Maya 继续", "原任务确认退出后只结束后台清理，不重复插入停止记录，不打断 Maya。后续发给虾长老的新消息可以继续执行。",
      snapshot([...memberStopped(), message(4, "maya", "我继续处理汇总部分，先按现有材料往下整理。", { partial: true, streaming: true })],
        [turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
  ] },
  { id: "background-stop", title: "停止后台原任务", caption: "下一位继续当前回合", steps: [
    step("Maya 发言，后台自动查询", "虾长老因状态异常持续两分钟已让位。点击虾长老气泡下方的“停止”，只停止这条原任务。",
      snapshot(backgroundMessages(), [idleTurn("shrimp"), turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
    step("停止后移除状态气泡", "虾长老的停止确认转到后台自动处理，原来的异常气泡立即消失。只保留结束本次发言的轻提示；Maya 当前回合和其他成员队列保持不变。",
      snapshot(backgroundStopped(), [stoppedSpeechTurn("shrimp"),
        turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
    step("清理结束，界面不跳动", "后台任务确认退出后不追加提示或结果，Maya 继续当前回合。停止前已经发出的内容和结束发言记录保持原来的位置。",
      snapshot(backgroundStopped(),
        [turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
  ] },
  { id: "group-stop", title: "停止整轮群聊", caption: "右下角大停止按钮", steps: [
    step("点击大停止按钮", "这里有虾长老当前发言、OpenCode 之前因状态异常已让位，另外三位正在排队。可以直接点击右下角的大停止按钮。", bothWorking()),
    step("正在提交停止", "点击后按钮置灰，界面显示“正在请求停止讨论…”。这一帧模拟停止接口尚未返回，后面的队列还可能暂时留在画面里。",
      { ...bothWorking(), pendingRequest: true }),
    step("后台确认退出", "停止已受理，队列清空。系统在后台确认原运行退出；聊天区保留已有消息，不显示逐成员停止确认气泡，也不留下单独头像名称。", stoppingGroup()),
    step("整轮已停止", "运行全部确认结束后，加载和停止提示消失，输入框恢复发送按钮。现有消息保留，不会自动启动下一位，也不会额外插入一个当前产品没有的“停止成功”气泡。",
      snapshot(bothWorking().messages)),
  ] },
  { id: "stop-pending", title: "停止异常也不占位", caption: "单成员清理留在后台", steps: [
    step("准备停止", "这一条演示单成员取消接口暂时失联或迟迟不返回。", snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("回执未到，下一位已开始", "即使原运行还没确认停止，发言位也已经释放。不显示停止确认气泡，系统自动查询原身份，不重发任务，不把取消失败误报为模型已退出。",
      snapshot(memberStopped(), [stoppedSpeechTurn("shrimp", "GROUP_EXTERNAL_RUN_LOST"), turn("maya")], ["default", "opencode", "deepseek"])),
    step("自动处理，群聊继续", "原任务清理不占群发言位，也不显示人工核对按钮。同一成员的新任务仍按实际运行状态排队，避免旧任务未退出时重叠写入；其他可运行成员继续。",
      snapshot([...memberStopped(), message(4, "maya", "我先继续完成当前可以处理的内容。", { partial: true, streaming: true })],
        [stoppedSpeechTurn("shrimp", "GROUP_EXTERNAL_RUN_LOST"), turn("maya", { phase: "text" })], ["default", "opencode", "deepseek"])),
  ] },
  { id: "start-pending", title: "启动状态不明", caption: "让位并继续核对原运行", steps: [
    step("等待启动结果", "如果发生断线或回执丢失，系统还不知道请求有没有被接受，就不能按明确拒绝处理。", snapshot(context(), [turn("shrimp")], defaultQueue)),
    step("后台查询启动结果", "启动回执可能在断线中丢失。系统按原身份后台查询，聊天中不显示启动回执说明、空白气泡或单独头像名称。有真实回复时保留原消息下的停止图标；不直接判断失败，也不重发任务。",
      snapshot(context(), [turn("shrimp", { activity: activity("shrimp", "reconciling"),
        recovery: { type: "execution", reason: "GROUP_EXTERNAL_START_UNCONFIRMED", since: now + 390_000, cancelRequested: false } })], defaultQueue)),
    step("异常满两分钟后让位", "启动回执不明持续两分钟，且没有新的有效进展，才让位给 Maya；正常运行只是慢不会走到这里。系统后台自动查询原任务，后来读到原结果时正常交回，不自动重发。共享工作区仍遵守资源排队。",
      snapshot(context(), [idleTurn("shrimp", { activity: activity("shrimp", "reconciling"),
        recovery: { type: "execution", reason: "GROUP_EXTERNAL_START_UNCONFIRMED", since: now + 390_000, cancelRequested: false } }),
        turn("maya")], ["default", "opencode", "deepseek"])),
  ] },
];

function getSnapshot(sceneId, index) {
  const scene = scenes.find(item => item.id === sceneId) || scenes[0];
  const selected = scene.steps[Math.max(0, Math.min(scene.steps.length - 1, Number(index) || 0))];
  return { ...copy(selected.data), sceneId: scene.id, label: selected.label };
}
const sceneMenu = scenes.map(({ id, title, caption, steps }) => ({ id, title, caption,
  steps: steps.map(({ label, note }) => ({ label, note })) }));
module.exports = { groupId, scenes, sceneMenu, getSnapshot, first, second };
