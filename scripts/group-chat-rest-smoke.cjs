"use strict";
// 群聊 REST 冒烟（隔离 L2）：生产 Service、ShoggothBackend、Registry、REST 与群驱动；
// 只有成员回合的执行器是脚本化的（内部会话仍由真实 chat.session.create 创建）。
// 发言机制：群主先答，一个接一个说，@ 了谁谁就插到下一位（docs/architecture/group-room-single-mechanism-2026-10-17.md）。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { AgentBackend } = require("../app/core/agent-backend");
const { GroupRuntimeRouter } = require("../app/group-runtime-router");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

function scriptedExecutor(state) {
  const runs = new Map();
  state.runs = runs;
  return {
    async ensureSession(binding) {
      const result = await state.fixture.ipc("chat.session.create", {
        operationId: `group-smoke-${binding.memberId}${binding.threadId === "main" ? "" : `-${binding.threadId}`}`,
        profileId: binding.profileId, workspace: null, createdAt: Date.now() });
      return result.session.sessionKey;
    },
    async start({ sessionKey, operationId, prompt }) {
      const profileId = state.fixture.service.chatSessionStore.getSession(sessionKey).profileId;
      const outcome = (await state.reply(profileId, prompt, { sessionKey, operationId })) ?? { text: "(pass)" };
      state.calls.push({ profileId, prompt });
      const run = { id: `run-${crypto.randomUUID()}`, source: "chat", sourceId: sessionKey, profileId,
        idempotencyKey: `shoggoth:chat-send:${operationId}`, errorCode: outcome.fail ?? null, text: outcome.text ?? null,
        status: outcome.hang ? "running" : outcome.fail ? "failed" : "completed" };
      runs.set(run.id, run);
      return run;
    },
    findRun() { return null; },
    getRun(runId) { return runs.get(runId) ?? null; },
    async abort({ runId }) {
      const run = runs.get(runId);
      state.aborted.push(runId);
      run.status = "canceled";
      setImmediate(() => state.fixture.service.groupChatDriver.onRunTerminal(run));
    },
    finalText(run) { return run.text; },
  };
}

const quiet = (detail) => !detail.round && detail.activeTurns.length === 0 && detail.queuedMemberIds.length === 0;

async function run() {
  const state = { fixture: null, calls: [], aborted: [], reply: () => null };
  const f = await startInspirationFixture({ agentCount: 3,
    serviceOptions: { groupChatExecutor: scriptedExecutor(state), prewarmMcpAuth: false } });
  state.fixture = f;
  const activities = [];
  f.registry.on("backend.sessionActivity", (event) => activities.push(event.activity));
  const api = async (method, path, body) => {
    const response = await fetch(`${f.url}/__api/group-chats${path}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const settle = async (groupId) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const { body } = await api("GET", `/detail?id=${groupId}`);
      if (quiet(body)) return body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("group round did not settle");
  };
  const history = async (groupId) => (await api("GET", `/messages?id=${groupId}&limit=200`)).body.messages;
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter((profile) => profile.enabled).slice(0, 3);
    assert.equal(profiles.length, 3);
    const [a, b, c] = profiles;
    assert.equal(a.id, DEFAULT_AGENT_PROFILE_ID, "the fixture lists the built-in Shoggoth first");
    const refs = profiles.map((profile) => ({ backendId: "shoggoth", agentId: profile.agentId }));

    assert.equal((await api("POST", "", { operationId: "g0", name: "x", purpose: "",
      members: [refs[0], { backendId: "elsewhere", agentId: "default" }] })).body.code, "GROUP_CHAT_MEMBER_UNSUPPORTED");
    assert.equal((await api("POST", "", { operationId: "g0b", name: "x", purpose: "",
      members: [refs[0], { backendId: "hermes", agentId: "default" }] })).body.code, "GROUP_CHAT_PROFILE_UNAVAILABLE",
    "an external member whose backend is not connected cannot join");
    assert.equal((await api("POST", "", { operationId: "g1", name: "x", purpose: "", members: [refs[0]] })).body.code,
      "GROUP_CHAT_MEMBER_LIMIT");
    // 内置 Shoggoth 不在第一位也是群主。
    const created = await api("POST", "", { operationId: "g2", name: "开发协作", purpose: "验证群聊", members: [refs[1], refs[0], refs[2]] });
    assert.equal(created.status, 200);
    const groupId = created.body.group.id;
    assert.deepEqual((await api("POST", "", { operationId: "g2", name: "开发协作", purpose: "验证群聊", members: [refs[1], refs[0], refs[2]] }))
      .body.group.id, groupId, "create is idempotent by operationId");
    const handle = Object.fromEntries(created.body.members.map((member) => [member.agentId, member.handle]));
    const memberId = Object.fromEntries(created.body.members.map((member) => [member.agentId, member.id]));
    assert.equal(created.body.group.ownerMemberId, memberId[a.agentId], "the built-in Shoggoth owns the group");
    assert.equal(created.body.currentOwnerId, memberId[a.agentId]);
    assert.ok(activities.some((activity) => activity.kind === "group.changed" && activity.groupId === groupId)
      || await new Promise((resolve) => setTimeout(() => resolve(activities.some((activity) =>
        activity.kind === "group.changed" && activity.groupId === groupId)), 1500)), "group.changed reaches Registry");

    // 没有 @：只有群主开口；群主没 @ 人，这一轮就结束。
    state.calls.length = 0;
    state.reply = () => ({ text: "大家好，我在。" });
    let sent = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m1", body: "大家好", mentions: [] });
    assert.equal(sent.status, 200);
    assert.ok(sent.body.discussionId, "a plain message opens a round");
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [a.id], "only the owner answers a plain message");
    assert.match(state.calls[0].prompt, /^\[Group "开发协作" · New user message\]/u);
    assert.match(state.calls[0].prompt, /You are the owner/u);
    assert.match(state.calls[0].prompt, /Group notice: 验证群聊/u);
    assert.match(state.calls[0].prompt, /user: 大家好/u);
    assert.deepEqual((await history(groupId)).map((message) => message.author.kind), ["user", "member"]);

    // 同 clientMessageId 重传只入库一次；内容不同的重传是冲突。
    state.calls.length = 0;
    sent = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m1", body: "大家好", mentions: [] });
    assert.equal(sent.body.duplicate, true);
    await settle(groupId);
    assert.equal(state.calls.length, 0);
    assert.equal((await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m1", body: "改了", mentions: [] }))
      .body.code, "GROUP_CHAT_MESSAGE_CONFLICT");

    // @ 接力：群主回复里 @B，B 接着说并看到群主的话；代码里的 @C 不算；C 不说话。
    state.calls.length = 0;
    state.reply = (profileId) => profileId === a.id
      ? { text: `方案 X。@${handle[b.agentId]} 请实现，示例 \`@${handle[c.agentId]}\` 不算` } : { text: "好的，我来实现。" };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m2", body: "看看这个问题", mentions: [] });
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [a.id, b.id]);
    assert.match(state.calls[1].prompt, new RegExp(`· ${created.body.members.find(m => m.agentId === a.agentId).displayName} invited you\\]`, "u"));
    assert.match(state.calls[1].prompt, /方案 X/u);
    assert.match(state.calls[1].prompt, /user: 看看这个问题/u, "the called member also sees the user's message");
    assert.match(state.calls[1].prompt, /Your queued position: 2\/2; 1 earlier slots; no members queued after you; invite others if the user requested it\./u);
    let messages = await history(groupId);
    assert.deepEqual(messages.map((message) => message.author.kind), ["user", "member", "user", "member", "member"]);
    assert.deepEqual(messages.at(-2).mentions.memberIds, [memberId[b.agentId]]);
    assert.deepEqual(messages.map((message) => message.seq), [1, 2, 3, 4, 5], "seq is the authoritative order");

    // 只有未知 @ 时谁也不叫；结构化 mentions 精确路由；没话说的 (pass) 不发消息。
    state.calls.length = 0;
    state.reply = () => ({ text: "(pass)" });
    sent = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m3", body: "@nobody 在吗", mentions: [] });
    await settle(groupId);
    assert.equal(state.calls.length, 0);
    assert.deepEqual(sent.body.message.mentions.unresolved, ["nobody"]);
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m4", body: "请看一下", mentions: [memberId[c.agentId]] });
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [c.id]);
    assert.equal((await history(groupId)).at(-1).author.kind, "user", "a pass posts nothing");

    // @all：群主第一，其余按名单；失败不当静默，句子里带 pass 的正文照常发布。
    state.calls.length = 0;
    state.reply = (profileId) => profileId === b.id ? { fail: "RUNTIME_FAILED" } : profileId === a.id
      ? { text: "I will pass this to review" } : { text: " PASS " };
    sent = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5", body: "@all 大家看看", mentions: [] });
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [a.id, b.id, c.id], "@all: the owner first, then the roster order");
    messages = (await history(groupId)).filter(message => message.seq > sent.body.message.seq);
    const failure = messages.find(message => message.system?.eventType === "turn_failed");
    assert.equal(failure.system.errorCode, "RUNTIME_FAILED");
    assert.equal(failure.system.memberId, memberId[b.agentId]);
    assert.ok(messages.some(message => message.body === "I will pass this to review"));

    // 重试：让刚才失败的成员补答，不产生新的用户消息；没失败的成员没有可重试的。
    state.calls.length = 0;
    state.reply = () => ({ text: "这次答上了" });
    assert.deepEqual([(await api("POST", `/turns/retry?id=${groupId}`, { memberId: memberId[a.agentId], operationId: "retry-a" })).status,
      (await api("POST", `/turns/retry?id=${groupId}`, { memberId: memberId[a.agentId], operationId: "retry-a" })).body.code],
    [409, "GROUP_CHAT_NOTHING_TO_RETRY"]);
    const usersBefore = (await history(groupId)).filter((message) => message.author.kind === "user").length;
    assert.equal((await api("POST", `/turns/retry?id=${groupId}`, { memberId: memberId[b.agentId], operationId: "retry-b" })).status, 200);
    assert.equal((await api("POST", `/turns/retry?id=${groupId}`, { memberId: memberId[b.agentId], operationId: "retry-b" })).status, 200,
      "a redelivered retry is the same operation");
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [b.id], "only the failed member is asked, once");
    assert.match(state.calls[0].prompt, /Retry your previous unsuccessful reply/u);
    messages = await history(groupId);
    assert.equal(messages.at(-1).body, "这次答上了");
    assert.equal(messages.filter((message) => message.author.kind === "user").length, usersBefore);

    // 引用回复：引用某位成员的话而没有 @，只请它回答；输入里写明回复的是哪句。
    state.calls.length = 0;
    const quotedSeq = messages.at(-1).seq;
    const reply = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5q", body: "展开说说", mentions: [], replyTo: quotedSeq });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.message.replyTo, { seq: quotedSeq, messageId: messages.at(-1).id,
      author: { kind: "member", memberId: memberId[b.agentId] }, excerpt: "这次答上了" });
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [b.id]);
    assert.match(state.calls[0].prompt, /user \(reply to [^"]+ "这次答上了"\): 展开说说/u);
    assert.deepEqual([(await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5x", body: "x", mentions: [], replyTo: 99999 })).status,
      (await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5y", body: "x", mentions: [], replyTo: "2" })).status], [404, 400]);

    // 附件经 REST：先传到媒体库，再随消息发出；没传完的附件被拒绝，只发附件不写字可以。
    state.calls.length = 0;
    const doc = Buffer.from("会议纪要：周三上线。\n");
    const note = { id: crypto.randomUUID(), name: "纪要.txt", mimeType: "text/plain", size: doc.length };
    const uploaded = await fetch(`${f.url}/__api/inspirations/media`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment: note, offset: 0, content: doc.toString("base64") }) });
    assert.equal(uploaded.status, 200);
    const refused = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5f", body: "看附件", mentions: [],
      attachments: [{ ...note, id: crypto.randomUUID() }] });
    assert.deepEqual([refused.status, refused.body.code], [400, "GROUP_CHAT_ATTACHMENT_INVALID"]);
    const withFile = await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5a", body: "", mentions: [memberId[c.agentId]],
      attachments: [note] });
    assert.equal(withFile.status, 200, JSON.stringify(withFile.body));
    assert.deepEqual(withFile.body.message.attachments, [note]);
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [c.id]);
    assert.match(state.calls[0].prompt, /\[Files: 纪要\.txt\]/u);
    assert.deepEqual((await history(groupId)).find((message) => message.id === withFile.body.message.id).attachments, [note]);

    // Dashboard 只收成员已发送的文件，用户输入附件不计产出；真实媒体读取可用于现有 Finder 入口。
    const dashboardFiles = async () => (await (await fetch(`${f.url}/__api/dashboard`)).json()).summary.groupArtifacts;
    assert.deepEqual((await dashboardFiles()).items, []);
    state.reply = (_profileId, _prompt, { sessionKey }) => {
      state.groupOutputSessionKey = sessionKey;
      const workspace = f.service.chatSessionStore.getSession(sessionKey).workspace;
      fs.writeFileSync(path.join(workspace, "群聊报告.txt"), "群聊产出验收\n");
      return { text: "完成了。\n附件：群聊报告.txt" };
    };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m5-output", body: "写报告并发文件", mentions: [] });
    await settle(groupId);
    const groupFiles = await dashboardFiles();
    assert.equal(groupFiles.supported, true);
    assert.equal(groupFiles.items.length, 1);
    assert.equal(groupFiles.items[0].attachment.name, "群聊报告.txt");
    assert.equal(groupFiles.items[0].groupId, groupId);
    assert.equal(groupFiles.items[0].backendId, "shoggoth");
    assert.equal(await (await fetch(`${f.url}/__api/inspirations/media?id=${groupFiles.items[0].attachment.id}`)).text(), "群聊产出验收\n");

    // Native public transcripts and saved group attachments share the actual
    // Service -> Backend -> Registry -> Dashboard route, with separate origins.
    const append = (session, kind, content) => f.service.transcriptStore.appendEvent({
      id: crypto.randomUUID(), profileId: session.profileId, sessionId: session.id,
      kind, content, occurredAt: Date.now(),
    });
    const recordWrite = (session, file) => {
      const toolCallId = crypto.randomUUID();
      append(session, "tool_call", { toolCallId, tool: { name: "write", displayArgs: { path: file } } });
      append(session, "tool_result", { toolCallId, tool: { success: true, status: "completed" } });
    };
    const nativeOutputs = [];
    for (const profile of [a, b]) {
      const { session } = await f.ipc("chat.session.create", { operationId: `dashboard-public-${profile.id}`,
        profileId: profile.id, workspace: null, createdAt: Date.now() });
      const output = path.join(session.workspace, `native-${profile.agentId}.md`);
      const input = path.join(session.workspace, `input-${profile.agentId}.txt`);
      fs.writeFileSync(output, "native generated file"); fs.writeFileSync(input, "user upload");
      append(session, "user", { text: "Produce a report", attachments: [{ path: input }] });
      recordWrite(session, output); recordWrite(session, input);
      nativeOutputs.push(output);
    }
    const hidden = f.service.chatSessionStore.getSession(state.groupOutputSessionKey);
    recordWrite(hidden, path.join(hidden.workspace, "群聊报告.txt"));
    const combined = (await (await fetch(`${f.url}/__api/dashboard`)).json()).summary;
    const nativeSection = combined.artifacts.find(section => section.backend === "shoggoth");
    assert.equal(nativeSection.supported, true); assert.notEqual(nativeSection.partial, true);
    assert.deepEqual(new Set(nativeSection.items.map(item => item.path)), new Set(nativeOutputs));
    assert.equal(combined.groupArtifacts.items.length, 1, "group output stays in its public attachment source");
    console.log("PASS Dashboard files: two native Agents plus published group files; uploads and hidden group session outputs excluded");

    // 互相 @ 有上限：个人上限同为 10，普通消息先到整轮 1 × 10 次的上限。
    state.calls.length = 0;
    state.reply = (profileId) => profileId === a.id ? { text: `@${handle[b.agentId]} 你说呢` }
      : profileId === b.id ? { text: `@${handle[a.agentId]} 你说呢` } : { text: "(pass)" };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m6", body: "开始", mentions: [] });
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId),
      [a.id, b.id, a.id, b.id, a.id, b.id, a.id, b.id, a.id, b.id], "ten total turns, then the round ends");

    // 停止全群：正在发言的被中止，迟到的结果不发布，也不叫被 @ 的成员。
    state.calls.length = 0;
    state.reply = (profileId) => profileId === a.id ? { hang: true } : { text: "(pass)" };
    const before = (await history(groupId)).length;
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m7", body: "长任务", mentions: [] });
    for (let attempt = 0; attempt < 100 && state.calls.length === 0; attempt++) await new Promise((r) => setTimeout(r, 20));
    let detail = (await api("POST", `/discussion/stop?id=${groupId}`)).body;
    detail = await settle(groupId);
    assert.equal(state.aborted.length, 1);
    assert.equal(detail.round, null);
    assert.equal((await history(groupId)).length, before + 1, "only the user message was added");

    // 单独停下一位成员：只中止它，群里留一行淡色事件。
    state.calls.length = 0;
    state.reply = (profileId) => profileId === c.id ? { hang: true } : { text: "(pass)" };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m7c", body: `@${handle[c.agentId]} 跑个长任务`, mentions: [] });
    for (let attempt = 0; attempt < 100 && state.calls.length === 0; attempt++) await new Promise((r) => setTimeout(r, 20));
    const running = (await api("GET", `/detail?id=${groupId}`)).body.activeTurns;
    assert.deepEqual(running.map((turn) => [turn.memberId, turn.floor]), [[memberId[c.agentId], true]]);
    assert.equal((await api("POST", `/members/stop?id=${groupId}`, { memberId: memberId[c.agentId] })).status, 200);
    await settle(groupId);
    assert.equal(state.aborted.length, 2);
    assert.equal((await history(groupId)).at(-1).system.eventType, "turn_stopped");

    // 改群主：之后的普通消息先交给新群主。
    state.calls.length = 0;
    state.reply = () => ({ text: "收到" });
    detail = (await api("GET", `/detail?id=${groupId}`)).body;
    const promoted = await api("PATCH", `/detail?id=${groupId}`, { expectedMetadataRevision: detail.group.metadataRevision,
      patch: { ownerMemberId: memberId[b.agentId] } });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.group.ownerMemberId, memberId[b.agentId]);
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m-owner", body: "现在谁先答？", mentions: [] });
    await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [b.id]);
    assert.equal((await api("PATCH", `/detail?id=${groupId}`, { expectedMetadataRevision: promoted.body.group.metadataRevision,
      patch: { ownerMemberId: "nobody" } })).body.code, "GROUP_CHAT_MEMBER_NOT_FOUND");

    // 改名不换群身份；移除成员写入系统消息；分页按 seq。
    detail = (await api("GET", `/detail?id=${groupId}`)).body;
    const renamed = await api("PATCH", `/detail?id=${groupId}`, { expectedMetadataRevision: detail.group.metadataRevision,
      patch: { name: "开发协作 2" } });
    assert.equal(renamed.body.group.id, groupId);
    assert.equal((await history(groupId)).at(-1).system.eventType, "renamed");
    assert.equal((await api("PATCH", `/detail?id=${groupId}`, { expectedMetadataRevision: 1, patch: { name: "y" } })).status, 409);
    const removed = await api("DELETE", `/members?id=${groupId}`, { expectedRosterRevision: renamed.body.group.rosterRevision,
      memberId: memberId[c.agentId] });
    assert.equal(removed.body.members.find((member) => member.id === memberId[c.agentId]).state, "removed");
    const page = await api("GET", `/messages?id=${groupId}&afterSeq=3&limit=2`);
    assert.deepEqual(page.body.messages.map((message) => message.seq), [4, 5]);
    assert.equal(page.body.hasMore, true);

    // 群内部会话不进入普通会话列表；先入群的 Agent 仍有默认私聊。
    const internal = [...f.service.groupChatStore.internalSessionKeys];
    assert.ok(internal.length >= 2);
    for (const profile of [a, b]) {
      const listed = await f.ipc("chat.session.list", { profileId: profile.id, cursor: null, limit: 100, includeArchived: true });
      const keys = listed.sessions.map((session) => session.sessionKey);
      assert.ok(keys.length > 0, "a visible default session exists");
      assert.ok(keys.every((key) => !internal.includes(key)), "internal group sessions stay hidden");
    }

    // 成员卡来自各自 IDENTITY/SOUL；输入里列出同伴角色；只读群工具能读同伴设定与更早的消息。
    const definitions = f.service.agentDefinitionStore;
    const writeDefinition = (profileId, documents) => definitions.update({ actor: "user", profileId,
      expectedRevision: definitions.get(profileId).manifest.revision, documents });
    writeDefinition(a.id, { IDENTITY: `# IDENTITY.md\n\n- Name: ${a.name}\n- 角色：负责源码阅读的研究员\n\n## 专长\n\n- 源码阅读\n- 方案对比\n`,
      SOUL: "# SOUL.md\n\n## 风格\n\n结论先行。\n<!-- 私密：不要给同伴看 -->\n" });
    const tools = (profileId, sessionKey, operationId, name, args) => f.service.groupChatService.callTool(name,
      { source: "chat", sourceId: sessionKey, ...args },
      { id: "tool-probe", source: "chat", sourceId: sessionKey, profileId, idempotencyKey: `shoggoth:chat-send:${operationId}` },
      profileId);
    const toolResults = {};
    state.calls.length = 0;
    state.reply = async (profileId, _prompt, turn) => {
      if (profileId === b.id) {
        toolResults.peer = await tools(b.id, turn.sessionKey, turn.operationId, "group_member_role_read", { member: `@${handle[a.agentId]}` });
        toolResults.removed = await tools(b.id, turn.sessionKey, turn.operationId, "group_member_role_read", { member: `@${handle[c.agentId]}` });
        toolResults.history = await tools(b.id, turn.sessionKey, turn.operationId, "group_messages_read", { afterSeq: 0, limit: 3 });
        toolResults.retired = await tools(b.id, turn.sessionKey, turn.operationId, "group_task", { action: "get", taskId: "x" });
        return { text: `@${handle[a.agentId]} 你负责什么？` };
      }
      return { text: "(pass)" };
    };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m-dir", body: "大家各自负责什么？", mentions: [] });
    detail = await settle(groupId);
    assert.deepEqual(state.calls.map((call) => call.profileId), [b.id, a.id]);
    assert.match(state.calls[0].prompt, /\(负责源码阅读的研究员\)/u, "the owner sees each peer's role in the member line");
    assert.doesNotMatch(state.calls[0].prompt, /私密/u);
    assert.doesNotMatch(state.calls[0].prompt, new RegExp(`${created.body.members.find(m => m.agentId === c.agentId).displayName} \\(`, "u"),
      "a removed member is not listed");
    assert.equal(toolResults.peer.ok, true);
    assert.match(toolResults.peer.text, /^# IDENTITY\.md/mu);
    assert.deepEqual(toolResults.removed, { ok: false, code: "access_revoked" }, "a removed member is no longer shared");
    assert.deepEqual(toolResults.history.messages.map((message) => message.seq), [1, 2, 3]);
    assert.equal(toolResults.retired.code, "GROUP_TOOL_RETIRED", "formal tasks are retired in group chats");
    await assert.rejects(() => f.service.groupChatService.callTool("group_member_role_read", { source: "chat", sourceId: "x", member: "a" },
      { id: "r", source: "chat", sourceId: "x", profileId: a.id, idempotencyKey: "shoggoth:chat-send:direct" }, a.id),
    { code: "MCP_TOOL_FORBIDDEN" }, "group tools refuse non-group runs");
    const roleRest = await api("GET", `/members/role?id=${groupId}&memberId=${memberId[a.agentId]}`);
    assert.equal(roleRest.body.ok, true);
    assert.doesNotMatch(roleRest.body.text, /私密/u);
    assert.deepEqual((await api("GET", `/members/role?id=${groupId}&memberId=${memberId[c.agentId]}`)).body,
      { ok: false, code: "access_revoked" });

    const search = await api("GET", `/messages/search?id=${groupId}&query=${encodeURIComponent("看看这个问题")}`);
    assert.equal(search.status, 200); assert.equal(search.body.hits.length, 1);
    assert.equal((await api("GET", `/messages/search?id=${groupId}&query=x&limit=21`)).body.code, "GROUP_CHAT_INVALID");

    const list = await api("GET", "");
    assert.equal(list.body.groups[0].group.id, groupId);
    assert.ok(list.body.internalSessions.length >= 2);
    assert.ok(list.body.internalSessions.every((session) => session.backendId === "shoggoth" && session.key.startsWith("agent:")));
    const latest = (await api("GET", `/detail?id=${groupId}`)).body;
    const deleted = await api("DELETE", `/detail?id=${groupId}`, { expectedMetadataRevision: latest.group.metadataRevision });
    assert.equal(deleted.body.status, "deleted");
    assert.deepEqual((await api("DELETE", `/detail?id=${groupId}`, { expectedMetadataRevision: latest.group.metadataRevision })).body, deleted.body);
    assert.equal((await api("POST", `/messages?id=${groupId}`, { clientMessageId: "m8", body: "还在吗", mentions: [] }))
      .body.code, "GROUP_CHAT_DELETED");
    assert.equal((await api("GET", "")).body.groups.length, 0);
    assert.deepEqual((await api("GET", "")).body.internalSessions, list.body.internalSessions,
      "deletion preserves internal session exclusion without touching other sessions");
    assert.equal((await api("GET", `/messages?id=${groupId}`)).body.code, "GROUP_CHAT_DELETED");
    console.log("PASS group chat REST: create/idempotency, owner answers first, resend, @ relay, routing, @all order, failure vs pass, retry, quote reply, attachments, call cap, stop all, stop one member, owner change, rename/remove, hidden sessions, member roles and read-only tools, search, delete");
  } finally {
    await f.close();
  }
}

// 真实原生执行器 + 假 Codex：内部会话、chat.send 前缀、终态回调与转录里的完整回答。
async function runNative() {
  const f = await startInspirationFixture({ agentCount: 2, codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL: "1", CODEX_FAKE_MODEL_CATALOG: "1" },
    serviceOptions: { prewarmMcpAuth: false } });
  const settled = async (groupId, label) => {
    for (let attempt = 0; ; attempt++) {
      if (quiet(await f.ipc("group.get", { groupId }))) return;
      assert.ok(attempt < 300, label);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter((profile) => profile.enabled).slice(0, 2);
    const members = profiles.map((profile) => ({ backendId: "shoggoth", agentId: profile.agentId }));
    const groups = [];
    const modelApi = async (method, suffix, body) => {
      const response = await fetch(`${f.url}/__api/group-chats/members/${suffix}`, { method,
        headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    for (const name of ["G1", "G2"]) {
      const created = await f.ipc("group.create", { operationId: `native-${name}`, name, purpose: "", members });
      groups.push(created.group.id);
      assert.equal(created.members[0].modelSelection, null);
      if (name === "G1") {
        const memberId = created.members[0].id, id = created.group.id;
        const models = await modelApi("GET", `models?id=${id}&memberId=${memberId}`);
        assert.equal(models.status, 200); assert(models.body.models.some(item => item.id === "fake-model" && item.provider === "codex"));
        const input = { memberId, expectedRosterRevision: created.group.rosterRevision, modelSelection: { model: "fake-model", provider: "codex" } };
        assert.equal((await modelApi("PATCH", `model?id=${id}`, { ...input, modelSelection: { ...input.modelSelection, provider: "foreign" } })).body.code, "GROUP_CHAT_MODEL_UNAVAILABLE");
        const saved = await modelApi("PATCH", `model?id=${id}`, input);
        assert.equal(saved.status, 200); assert.deepEqual(saved.body.members[0].modelSelection, input.modelSelection);
        assert.equal((await modelApi("PATCH", `model?id=${id}`, { ...input, modelSelection: null })).body.code, "GROUP_CHAT_REVISION_CONFLICT");
        assert.equal(f.service.workDispatcher.listRuns().length, 0, "catalog and policy edits do not start model turns");
      }
      await f.ipc("group.send", { groupId: created.group.id, clientMessageId: `${name}-u1`, body: "@all 你好", mentions: [], replyTo: null, attachments: [] });
    }
    for (const groupId of groups) {
      await settled(groupId, "native round settles");
      const { messages } = await f.ipc("group.history", { groupId, afterSeq: null, beforeSeq: null, limit: 50 });
      assert.deepEqual(messages.map((message) => message.author.kind), ["user", "member", "member"]);
      assert.ok(messages.slice(1).every((message) => /^completed \S+$/u.test(message.body)),
        "member reply is the final answer text read from the transcript");
    }
    const internal = [...f.service.groupChatStore.internalSessionKeys];
    assert.equal(internal.length, 4, "one session per member per group");
    const runs = f.service.workDispatcher.listRuns().filter((run) => /^shoggoth:chat-send:group-turn-/u.test(run.idempotencyKey || ""));
    assert.equal(runs.length, 4);
    assert.ok(runs.every((run) => run.status === "completed" && internal.includes(run.sourceId)));
    const selectedMember = f.service.groupChatStore.getGroup(groups[0]).members[0];
    const selectedSession = f.service.groupChatStore.getDiscussionBinding(groups[0], selectedMember.id).sessionKey;
    assert.equal(f.service.chatSessionStore.getSession(selectedSession).modelOverride, "fake-model");
    assert(internal.filter(key => key !== selectedSession).every(key => f.service.chatSessionStore.getSession(key).modelOverride === null), "other members and groups still inherit");
    for (const profile of profiles) {
      const listed = await f.ipc("chat.session.list", { profileId: profile.id, cursor: null, limit: 100, includeArchived: true });
      assert.ok(listed.sessions.every((session) => !internal.includes(session.sessionKey)));
    }
    // 真实写入成员内部会话的输入：群名、成员、发言顺序与规则，没有协议字段。
    const firstSession = f.service.chatSessionStore.getSession(internal[0]);
    const userText = f.service.transcriptStore.listEvents(firstSession.profileId, firstSession.id)
      .find((event) => event.kind === "user")?.content?.text ?? "";
    assert.match(userText, /^\[Group "G1"/u);
    assert.match(userText, /Current speaking queue:/u);
    assert.doesNotMatch(userText, /group_task|itemId|digest/u);
    const current = f.service.groupChatStore.getGroup(groups[0]);
    assert.equal((await modelApi("PATCH", `model?id=${groups[0]}`, { memberId: selectedMember.id,
      expectedRosterRevision: current.group.rosterRevision, modelSelection: null })).status, 200);
    // 群消息里的金额不是技能选择：「$84,024」这样的写法进了成员的回合输入，回合照常完成，
    // 不会被技能系统当成「选择名叫 84 的技能」而卡死整个原生运行队列（2026-10-12 正式环境事故）。
    const money = await f.ipc("group.send", { groupId: groups[0], clientMessageId: "money-1",
      body: "@all 行情：BTC 报 $84,024，ETH $2,754，SOL $110，还有 $1、$7、$83 这几档。大家怎么看？", mentions: [], replyTo: null, attachments: [] });
    await settled(groups[0], "a group message with dollar amounts must not hang the members' turns");
    const afterMoney = (await f.ipc("group.history", { groupId: groups[0], afterSeq: money.message.seq, beforeSeq: null, limit: 20 })).messages;
    assert.equal(f.service.chatSessionStore.getSession(selectedSession).modelOverride, null, "the next turn clears the prior override and inherits the Agent default");
    assert.deepEqual(afterMoney.map((message) => [message.author.kind, message.system?.eventType ?? null]),
      [["member", null], ["member", null]], "both native members answer; nobody fails on the dollar amounts");
    // 直接聊天里写了不存在的技能：只有这一条运行失败并给出原因，后面的运行照常，服务保持可用。
    const skillChat = await f.ipc("chat.session.create", { operationId: "skill-miss", profileId: profiles[0].id, workspace: null, createdAt: Date.now() });
    const missed = (await f.ipc("chat.send", { operationId: "skill-miss-send", sessionKey: skillChat.session.sessionKey,
      prompt: "用 $no-such-skill-xyz 处理一下", createdAt: Date.now() })).run;
    const next = (await f.ipc("chat.send", { operationId: "skill-miss-next", sessionKey: skillChat.session.sessionKey,
      prompt: "正常的一句话", createdAt: Date.now() })).run;
    for (let attempt = 0; ; attempt++) {
      const states = [missed, next].map((item) => f.service.workDispatcher.getRun(item.id)?.status);
      if (states[0] === "failed" && states[1] === "completed") break;
      assert.ok(attempt < 300, `a missing skill fails only its own run: ${states.join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(f.service.workDispatcher.getRun(missed.id).errorCode, "SKILL_NOT_FOUND");
    assert.equal((await f.ipc("service.status", {})).healthy, true, "the service is not poisoned by a skill selection error");
    // 图片与附件走真实的私聊附件通道：每位成员的内部会话各有一个路径，内容相同，且没有成倍占用磁盘。
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    const picture = { id: crypto.randomUUID(), name: "界面 截图.png", mimeType: "image/png", size: png.length };
    await f.ipc("inspiration.media.write", { attachment: picture, offset: 0, content: png.toString("base64") });
    const missing = { ...picture, id: crypto.randomUUID() };
    await assert.rejects(f.ipc("group.send", { groupId: groups[1], clientMessageId: "att-missing", body: "看图", mentions: [],
      replyTo: null, attachments: [missing] }), { code: "GROUP_CHAT_ATTACHMENT_INVALID" }, "an attachment must be fully uploaded first");
    await assert.rejects(f.ipc("group.send", { groupId: groups[1], clientMessageId: "att-empty", body: "  ", mentions: [],
      replyTo: null, attachments: [] }), { code: "GROUP_CHAT_INVALID" }, "an empty message needs at least an attachment");
    const everyone = f.service.groupChatStore.getGroup(groups[1]).members.map((member) => member.id);
    const sentPicture = await f.ipc("group.send", { groupId: groups[1], clientMessageId: "att-1", body: "", mentions: everyone,
      replyTo: null, attachments: [picture] });
    assert.deepEqual(sentPicture.message.attachments, [picture]);
    await settled(groups[1], "attachment round settles");
    const memberSessions = f.service.groupChatStore.getGroup(groups[1]).internalSessionKeys
      .map((key) => key.split(":").at(-1)).map((key) => f.service.chatSessionStore.getSession(key)).filter(Boolean);
    const savedPaths = [];
    for (const session of memberSessions) {
      const event = f.service.transcriptStore.listEvents(session.profileId, session.id)
        .filter((item) => item.kind === "user").at(-1);
      assert.deepEqual(event.content.attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })), [picture],
        "the member's own session records the attachment like a direct chat does");
      const saved = path.join(f.service.groupChatStore.paths.stateDir, "chat-attachments", session.sessionKey, picture.id, picture.name);
      assert.ok(fs.readFileSync(saved).equals(png), "the member can read the picture at its own session path");
      savedPaths.push(saved);
    }
    assert.equal(new Set(savedPaths).size, 2);
    console.log("PASS group chat native: hidden per-group sessions, group-turn runs one after another, final answer from transcript, plain-text input, member models, dollar amounts, attachments through the direct-chat channel");
  } finally {
    await f.close();
  }
}

// 外部成员：真实私有桥 + App 侧 group runner；只有 Hermes 后端与传输适配器是假的。
class FakeHermesBackend extends AgentBackend {
  get id() { return "hermes"; }
  get name() { return "Hermes"; }
  async start() { return true; }
  async stop() {}
  async getStatus() { return { id: "hermes", name: "Hermes", connected: true, info: {} }; }
  getAgents() { return []; }
  async listAgents() { return [{ id: "helper", name: "Hermes Helper" }]; }
  async getAgent(id) {
    if (id !== "helper") throw new Error("not found");
    return { id: "helper", name: "Hermes Helper", model: "fixture-model" };
  }
  async getGroupMemberModels(id) {
    assert.equal(id, "helper");
    return { models: [{ id: "group-model", name: "Group model", provider: "fixture" }], defaultModel: "fixture-model" };
  }
  async getAgentFile(_id, file) {
    return file === "SOUL.md"
      ? { name: file, content: "# SOUL.md\n\n负责资料检索与事实核对的助手。说话简洁。\n" }
      : { name: file, content: "", missing: true };
  }
}

function fakeHermesAdapter(state) {
  let sessions = 0;
  const runs = new Map();
  return {
    async prepare({ agentId, sessionKey, workspace, modelSelection }) {
      (state.modelSelections ??= []).push(modelSelection);
      return { sessionKey: sessionKey ?? `agent:${agentId}:group-fixture-${++sessions}`,
        workspace: workspace ?? state.workspace, mode: "gateway" };
    },
    start(input) {
      state.prompts.push(input.prompt);
      // 前若干次查询仍在回复（带草稿），之后完成。
      runs.set(input.runId, { checks: 0, final: { status: "completed", errorCode: null, attention: null,
        resultSummary: state.finalText?.(state.prompts.length) ?? `Hermes 收到：${state.prompts.length}` } });
      return { status: "running", resultSummary: null, errorCode: null, attention: null };
    },
    async inspect(input) {
      const run = runs.get(input.runId);
      if (!run) return { status: "running", resultSummary: null, errorCode: null, attention: null };
      run.checks += 1;
      return run.checks > state.draftChecks ? run.final : { status: "running", resultSummary: null, errorCode: null, attention: null };
    },
    fullResult(input) { return runs.get(input.runId)?.final?.resultSummary ?? null; },
    draft(runId) {
      const run = runs.get(runId);
      return run && run.checks <= state.draftChecks ? "Hermes 正在整理资料…" : null;
    },
    async respond() { return { status: "running", resultSummary: null, errorCode: null, attention: null }; },
    async cancel() { return { status: "canceled", resultSummary: null, errorCode: null, attention: null }; },
    reset() {},
  };
}

async function runExternal() {
  const state = { prompts: [], workspace: null, draftChecks: 30 };
  const f = await startInspirationFixture({
    extraBackends: [new FakeHermesBackend()],
    groupRunner: (registry) => new GroupRuntimeRouter({ localRunner: new ExternalInspirationRunner({ registry, adapterOptions: { sessionPurpose: "group" },
      adapters: { hermes: fakeHermesAdapter(state) } }), registry, isLocal: () => true }),
    serviceOptions: { prewarmMcpAuth: false, groupChatExternalPollMs: 50 },
    codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL: "1" },
  });
  state.workspace = f.root;
  const api = async (method, path, body) => {
    const response = await fetch(`${f.url}/__api/group-chats${path}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const settled = async (groupId, label, onDetail = () => {}) => {
    for (let attempt = 0; ; attempt++) {
      const detail = (await api("GET", `/detail?id=${groupId}`)).body;
      onDetail(detail);
      if (quiet(detail)) return detail;
      assert.ok(attempt < 400, label);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    const native = f.service.productStore.listAgentProfiles().find((profile) => profile.enabled);
    const created = await api("POST", "", { operationId: "mixed", name: "混合群", purpose: "",
      members: [{ backendId: "shoggoth", agentId: native.agentId }, { backendId: "hermes", agentId: "helper" }] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const groupId = created.body.group.id;
    const hermes = created.body.members.find((member) => member.backendId === "hermes");
    assert.equal(hermes.displayName, "Hermes Helper");
    assert.equal(hermes.card.role, "负责资料检索与事实核对的助手。", "external role falls back to SOUL when IDENTITY is missing");
    assert.equal(hermes.card.availability, "online");
    assert.equal((await api("GET", `/members/models?id=${groupId}&memberId=${hermes.id}`)).body.models[0].id, "group-model");
    const modelSelection = { model: "group-model", provider: "fixture" };
    assert.equal((await api("PATCH", `/members/model?id=${groupId}`, { memberId: hermes.id,
      expectedRosterRevision: created.body.group.rosterRevision, modelSelection })).status, 200);
    assert.equal(state.prompts.length, 0, "external catalog and settings do not start a model turn");
    assert.equal((await api("POST", "", { operationId: "bad", name: "x", purpose: "",
      members: [{ backendId: "shoggoth", agentId: native.agentId }, { backendId: "hermes", agentId: "nobody" }] })).body.code,
    "GROUP_CHAT_PROFILE_UNAVAILABLE");
    let sawDraft = false;
    for (const [index, body] of ["@all 大家好", "@hermes-helper 再说一句"].entries()) {
      if (index === 1) {
        const view = (await api("GET", `/detail?id=${groupId}`)).body;
        assert.equal((await api("PATCH", `/members/model?id=${groupId}`, { memberId: hermes.id,
          expectedRosterRevision: view.group.rosterRevision, modelSelection: null })).status, 200);
      }
      await api("POST", `/messages?id=${groupId}`, { clientMessageId: `x${index}`, body, mentions: [] });
      await settled(groupId, "mixed round settles", (detail) => {
        if (detail.activeTurns.some((turn) => turn.draft === "Hermes 正在整理资料…")) sawDraft = true;
      });
    }
    const messages = (await api("GET", `/messages?id=${groupId}&limit=50`)).body.messages;
    assert.deepEqual(state.modelSelections.slice(0, 2), [modelSelection, null], "federation passes the frozen group policy on each external turn");
    const authors = messages.filter((message) => message.author.kind === "member")
      .map((message) => created.body.members.find((member) => member.id === message.author.memberId).backendId);
    assert.deepEqual(authors, ["shoggoth", "hermes", "hermes"], "native owner first, then Hermes; @ targets Hermes only");
    assert.deepEqual(messages.filter((message) => message.author.kind === "member" && message.body.startsWith("Hermes"))
      .map((message) => message.body), ["Hermes 收到：1", "Hermes 收到：2"]);
    assert.equal(state.prompts.length, 2);
    assert.ok(sawDraft, "the Hermes reply draft reaches the group view through group.external.draft");
    assert.ok(!messages.some((message) => message.body.includes("正在整理")), "drafts never enter the group timeline");
    assert.match(state.prompts[0], /^\[Group "混合群"/u);
    assert.match(state.prompts[0], /Current speaking queue:/u);
    assert.doesNotMatch(state.prompts[0], /group_member_role_read|groupToken/u, "external members get no tool hints");
    const detail = (await api("GET", `/detail?id=${groupId}`)).body;
    assert.ok(detail.internalSessionKeys.includes("agent:helper:group-fixture-1"), "the Hermes group session is internal");
    assert.equal(detail.internalSessionKeys.filter((key) => key.startsWith("agent:helper:")).length, 1, "one Hermes session reused");
    // 成员随回复发送自己工作区里的文件，并引用一条消息：文件经真实的核对与入库，别人能读到。
    fs.writeFileSync(path.join(state.workspace, "结论.md"), "# 结论\n\n周三上线。\n");
    fs.writeFileSync(path.join(path.dirname(state.workspace), "outside.txt"), "工作区外的文件");
    state.draftChecks = 0;
    state.finalText = () => "回复 #1\n整理好了。\n附件：结论.md\n附件：../outside.txt";
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "x-file", body: "@hermes-helper 把结论发出来", mentions: [] });
    await settled(groupId, "attachment reply settles");
    const withFile = (await api("GET", `/messages?id=${groupId}&limit=50`)).body.messages.at(-1);
    assert.equal(withFile.body, "整理好了。\n附件：../outside.txt", "a path outside the member's workspace is never read");
    assert.deepEqual(withFile.attachments.map(({ name, mimeType, size }) => [name, mimeType, size]),
      [["结论.md", "text/markdown", Buffer.byteLength("# 结论\n\n周三上线。\n")]]);
    assert.equal(withFile.replyTo.seq, 1);
    const fetched = await fetch(`${f.url}/__api/inspirations/media?id=${withFile.attachments[0].id}`);
    assert.equal(await fetched.text(), "# 结论\n\n周三上线。\n", "the file is readable from the media store like a user attachment");
    const dashboard = (await (await fetch(`${f.url}/__api/dashboard`)).json()).summary;
    assert.equal(dashboard.groupArtifacts.supported, true);
    assert.deepEqual(dashboard.groupArtifacts.items.map(item => [item.backendId, item.agentId, item.groupId, item.attachment.id]),
      [["hermes", "helper", groupId, withFile.attachments[0].id]], "external group files retain their actual producing member");
    console.log("PASS group chat external: Hermes member via private bridge group runner, SOUL card fallback, session reuse, no tool hints, live draft, reply with a quoted message and a workspace file");
  } finally {
    await f.close();
  }
}

async function runNativeInteraction() {
  const f = await startInspirationFixture({ serviceOptions: { prewarmMcpAuth: false } });
  const api = async (method, path, body) => {
    const response = await fetch(`${f.url}/__api/group-chats${path}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const waitFor = async (groupId, predicate, label) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const detail = (await api("GET", `/detail?id=${groupId}`)).body;
      if (predicate(detail)) return detail;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out: ${label}`);
  };
  try {
    await f.ipc("agent.create", { operationId: "interaction-second-agent", backendId: "shoggoth",
      name: "Second Agent", defaultCwd: null, createdAt: Date.now() });
    const profiles = f.service.productStore.listAgentProfiles().filter((profile) => profile.enabled).slice(0, 2);
    const created = await api("POST", "", { operationId: "interaction", name: "审批群", purpose: "",
      members: profiles.map((profile) => ({ backendId: "shoggoth", agentId: profile.agentId })) });
    const groupId = created.body.group.id;
    const target = created.body.members[0];
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "i1", body: `@${target.handle} 请处理`, mentions: [] });
    const waiting = await waitFor(groupId, (detail) => detail.pendingInteractions?.length === 1, "interaction card");
    const card = waiting.pendingInteractions[0];
    assert.equal(card.memberId, target.id);
    assert.equal(card.status, "pending");
    assert.equal(waiting.activeTurns[0].releasedReason, "approval", "waiting for approval gives up the floor");
    const request = card.request;
    const response = request.fields.length === 0
      ? { choice: request.approvalChoices.find((choice) => choice !== "deny" && choice !== "cancel") }
      : { action: "submit", answers: Object.fromEntries(request.fields.map((field) => [field.id,
        field.options?.[0]?.value ?? field.options?.[0] ?? "ok"])) };
    const interactionTarget = { kind: "turn", opportunityId: card.opportunityId };
    assert.equal((await api("POST", `/interactions/respond?id=${groupId}`, { target: interactionTarget,
      requestId: "not-the-request", response, operationId: "bad" })).body.code, "GROUP_CHAT_INTERACTION_EXPIRED");
    const answered = await api("POST", `/interactions/respond?id=${groupId}`, { target: interactionTarget,
      requestId: request.requestId, response, operationId: "respond-1" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    await waitFor(groupId, (detail) => (detail.pendingInteractions ?? []).length === 0 && quiet(detail), "resumed turn");
    const messages = (await api("GET", `/messages?id=${groupId}&limit=20`)).body.messages;
    const reply = messages.find((message) => message.author.kind === "member");
    assert.ok(reply && /^completed \S+$/u.test(reply.body), `the resumed run publishes its answer: ${JSON.stringify(messages)}`);
    for (const answer of Object.values(response.answers ?? {})) {
      assert.ok(!messages.some((message) => message.body.includes(answer)), "answers are not copied into the public timeline");
    }
    assert.ok(!JSON.stringify(f.service.groupChatStore.getOpportunity(card.opportunityId)).includes("answers"),
      "answers are not stored in the group store");
    console.log("PASS group chat native interaction: MCP request becomes a group card and gives up the floor, the answer resumes the original run");
  } finally {
    await f.close();
  }
}

async function runFeatureSwitch() {
  const os = require("node:os");
  const { createConfigStore } = require("../app/core/config-store");
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcfg-"));
  const state = { fixture: null, calls: [], aborted: [], reply: () => null };
  const f = await startInspirationFixture({ agentCount: 2, configStore: createConfigStore(path.join(configDir, "config.json")),
    serviceOptions: { groupChatExecutor: scriptedExecutor(state), prewarmMcpAuth: false } });
  state.fixture = f;
  const request = async (method, url, body) => {
    const response = await fetch(`${f.url}${url}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const api = (method, suffix, body) => request(method, `/__api/group-chats${suffix}`, body);
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter((profile) => profile.enabled).slice(0, 2);
    const members = profiles.map((profile) => ({ backendId: "shoggoth", agentId: profile.agentId }));
    assert.equal((await request("GET", "/__api/config")).body.config.groupChatEnabled, true, "on by default");
    const created = await api("POST", "", { operationId: "sw1", name: "开关群", purpose: "", members });
    const groupId = created.body.group.id;
    state.reply = () => ({ hang: true });
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "s1", body: "@all 先聊着", mentions: [] });
    for (let attempt = 0; (await api("GET", `/detail?id=${groupId}`)).body.activeTurns.length < 1; attempt++) {
      assert.ok(attempt < 200, "the first member starts");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const before = (await api("GET", "/diagnostics")).body;
    assert.equal(before.enabled, true);
    assert.equal(before.schemaVersion, 10);
    assert.equal(before.driverRunning, true);
    assert.equal(before.groups.active, 1);
    assert.deepEqual([before.turns.running, before.turns.queued], [1, 1], "one speaks while the other waits its turn");
    assert.equal(JSON.stringify(before).includes("先聊着"), false, "diagnostics carry counts only");

    assert.equal((await request("PUT", "/__api/config", { groupChatEnabled: false })).body.config.groupChatEnabled, false);
    for (let attempt = 0; ; attempt++) {
      const detail = (await api("GET", `/detail?id=${groupId}`)).body;
      if (quiet(detail)) break;
      assert.ok(attempt < 200, "turning the feature off stops the running round");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state.aborted.length, 1);
    assert.equal(state.calls.length, 1, "the waiting member never starts");
    const listed = (await api("GET", "")).body;
    assert.equal(listed.enabled, false);
    assert.equal(listed.groups.length, 1, "groups are kept while the feature is off");
    assert.equal((await api("GET", `/messages?id=${groupId}&limit=20`)).body.messages[0].body, "@all 先聊着", "history stays readable");
    for (const [method, suffix, body] of [
      ["POST", "", { operationId: "sw2", name: "x", purpose: "", members }],
      ["POST", `/messages?id=${groupId}`, { clientMessageId: "s2", body: "还在吗", mentions: [] }],
    ]) {
      const refused = await api(method, suffix, body);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "GROUP_CHAT_DISABLED");
    }
    assert.equal((await api("POST", `/discussion/stop?id=${groupId}`)).status, 200, "stopping stays available");
    assert.equal((await api("GET", "/diagnostics")).body.enabled, false);

    await request("PUT", "/__api/config", { groupChatEnabled: true });
    state.reply = () => ({ text: "回来了" });
    assert.equal((await api("POST", `/messages?id=${groupId}`, { clientMessageId: "s3", body: "继续", mentions: [] })).status, 200);
    console.log("PASS group chat feature switch: diagnostics counts, disable stops activity and refuses new writes, data kept, re-enable resumes");
  } finally {
    await f.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

// 兼容：群库打不开（例如由更新版本写出）时只有群聊不可用，Service 与普通聊天照常。
async function runStoreUnavailable() {
  const { GroupChatStore } = require("../app/agent-service/group-chat-store");
  class NewerStore extends GroupChatStore {
    open() { throw Object.assign(new Error("newer schema"), { code: "GROUP_CHAT_STORE_CORRUPT" }); }
  }
  const f = await startInspirationFixture({ serviceOptions: { prewarmMcpAuth: false,
    groupChatStore: new NewerStore({ paths: { stateDir: "/nonexistent/state", trustedRoot: "/nonexistent" } }) } });
  try {
    const listed = await fetch(`${f.url}/__api/group-chats`);
    assert.equal(listed.status, 503);
    assert.equal((await listed.json()).code, "GROUP_CHAT_UNAVAILABLE");
    assert.equal((await fetch(`${f.url}/__api/group-chats/diagnostics`)).status, 503);
    const native = f.service.productStore.listAgentProfiles().find((profile) => profile.enabled);
    const session = await f.ipc("chat.session.create", { operationId: "plain-chat", profileId: native.id, workspace: null,
      createdAt: Date.now() });
    assert.ok(session.session.sessionKey, "ordinary chat sessions still work");
    console.log("PASS group chat store unavailable: only group chat degrades, the Service and ordinary chat keep working");
  } finally {
    await f.close();
  }
}

async function runReliability() {
  const state = { fixture: null, calls: [], aborted: [], readFailure: true, reply: () => ({ text: "" }) };
  const executor = scriptedExecutor(state);
  const read = executor.finalText;
  executor.finalText = (item) => state.readFailure && item.profileId === state.readFailureProfile ? "" : read(item);
  const f = await startInspirationFixture({ agentCount: 2,
    serviceOptions: { groupChatExecutor: executor, prewarmMcpAuth: false } });
  state.fixture = f;
  const api = async (method, route, body) => {
    const response = await fetch(`${f.url}/__api/group-chats${route}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const waitFor = async (readValue, predicate) => {
    for (let n = 0; n < 150; n++) { const value = await readValue(); if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 20)); }
    throw new Error("reliability fixture did not reach expected state");
  };
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter((profile) => profile.enabled).slice(0, 2);
    state.readFailureProfile = profiles[0].id;
    const members = profiles.map((profile) => ({ backendId: "shoggoth", agentId: profile.agentId }));
    const created = (await api("POST", "", { operationId: "d15", name: "完整回答", purpose: "", members })).body;
    const groupId = created.group.id;
    const other = (await api("POST", "", { operationId: "d15-other", name: "另一群", purpose: "", members })).body.group.id;
    const text = "完整回答🙂\n".repeat(9000) + "\u0001".repeat(20000) + "可追溯的尾部 271828";
    state.reply = (profileId) => ({ text: profileId === profiles[0].id ? text : "(pass)" });
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "result", body: "请回答", mentions: [created.members[0].id] });
    const pending = (await waitFor(() => api("GET", `/detail?id=${groupId}`),
      (value) => value.body.activeTurns[0]?.recovery?.type === "result")).body.activeTurns[0];
    assert.equal(state.calls.filter(call => call.profileId === profiles[0].id).length, 1);
    assert.equal((await api("POST", `/turns/retry?id=${groupId}`, { memberId: created.members[0].id, operationId: "no-replay" }))
      .body.code, "GROUP_CHAT_NOTHING_TO_RETRY", "a pending result is not retried as a new run");
    assert.equal((await api("POST", `/executions/reconcile?id=${other}`,
      { target: { kind: "turn", opportunityId: pending.opportunityId } })).body.code, "GROUP_CHAT_INTERACTION_EXPIRED");
    state.readFailure = false;
    assert.equal((await api("POST", `/executions/reconcile?id=${groupId}`,
      { target: { kind: "turn", opportunityId: pending.opportunityId } })).status, 200);
    const history = (await waitFor(() => api("GET", `/messages?id=${groupId}`), (value) => {
      assert.equal(value.status, 200, JSON.stringify(value.body));
      return value.body.messages.some((message) => message.author.kind === "member");
    })).body.messages;
    const message = history.find((item) => item.author.kind === "member");
    assert.equal(message.fullResult.bytes, Buffer.byteLength(text));
    const tailSearch = await api("GET", `/messages/search?id=${groupId}&query=271828`);
    assert.equal(tailSearch.status, 200); assert.equal(tailSearch.body.hits.length, 1);
    assert.equal(tailSearch.body.hits[0].message.fullResult.digest, message.fullResult.digest);
    assert.match(tailSearch.body.hits[0].snippet, /271828/);
    assert.equal((await api("GET", `/messages/search?id=${other}&query=271828`)).body.hits.length, 0);
    await waitFor(() => api("GET", `/detail?id=${groupId}`), value => quiet(value.body));
    const callsBeforeRead = state.calls.length;
    let offset = 0, collected = "";
    do {
      const response = await api("GET", `/messages/read?id=${groupId}&seq=${message.seq}&offset=${offset}&digest=${message.fullResult.digest}`);
      assert.equal(response.status, 200);
      collected += response.body.page.text; offset = response.body.page.nextOffset;
    } while (offset !== null);
    assert.equal(collected, text);
    assert.equal(state.calls.length, callsBeforeRead, "rereading does not call the model");
    assert.equal(state.calls.filter(call => call.profileId === profiles[0].id).length, 1,
      "reconciliation recovers the original answer without starting another model run");
    assert.equal((await api("GET", `/messages/read?id=${other}&seq=${message.seq}`)).body.code, "GROUP_CHAT_REPLY_NOT_FOUND");
    assert.equal((await api("GET", `/messages/read?id=${groupId}&seq=${message.seq}&digest=${"0".repeat(64)}`)).body.code,
      "GROUP_RESULT_MISMATCH");
    let toolPage;
    state.reply = async (profileId, _prompt, turn) => {
      toolPage = await f.service.groupChatService.callTool("group_messages_read", {
        source: "chat", sourceId: turn.sessionKey, messageSeq: message.seq, offset: 0, digest: message.fullResult.digest,
      }, { id: "reading-turn", source: "chat", sourceId: turn.sessionKey, profileId,
        idempotencyKey: `shoggoth:chat-send:${turn.operationId}` }, profileId);
      return { text: "已核对正文" };
    };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "read-tool", body: "核对完整正文", mentions: [created.members[1].id] });
    await waitFor(() => api("GET", `/detail?id=${groupId}`), (value) => quiet(value.body) && Boolean(toolPage));
    assert.equal(toolPage.page.digest, message.fullResult.digest);
    assert.ok(Buffer.byteLength(toolPage.page.text) <= 16 * 1024);
    state.reply = () => ({ text });
    for (let n = 0; n < 3; n++) {
      await api("POST", `/messages?id=${groupId}`, { clientMessageId: `long-${n}`, body: "继续", mentions: [created.members[0].id] });
      await waitFor(() => api("GET", `/detail?id=${groupId}`), (value) => quiet(value.body));
    }
    const forward = [], backward = [], forwardMessages = [];
    let afterSeq = 0, beforeSeq = null;
    for (;;) {
      const response = await api("GET", `/messages?id=${groupId}&afterSeq=${afterSeq}&limit=200`);
      assert.equal(response.status, 200); assert.ok(response.body.messages.length > 0);
      assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 64 * 1024);
      forward.push(...response.body.messages.map((item) => item.seq));
      forwardMessages.push(...response.body.messages);
      if (!response.body.hasMore) break;
      afterSeq = forward.at(-1);
    }
    for (;;) {
      const response = await api("GET", `/messages?id=${groupId}&limit=200${beforeSeq === null ? "" : `&beforeSeq=${beforeSeq}`}`);
      assert.equal(response.status, 200); assert.ok(response.body.messages.length > 0);
      backward.unshift(...response.body.messages.map((item) => item.seq));
      if (!response.body.hasMore) break;
      beforeSeq = backward[0];
    }
    assert.deepEqual(forward, backward, "bounded forward and backward history contain every message exactly once");
    assert.equal(new Set(forward).size, forward.length);
    assert.equal(forwardMessages.filter(item => item.author.kind !== "system").length, 10, "the five user/reply pairs remain intact");
    assert.equal((await api("GET", "")).status, 200, "group list stays readable with a long last answer");
    console.log("PASS group chat reliability REST: result pending, no retry, original-run reconciliation, immutable paged full answer, group isolation, MCP reread");
  } finally { await f.close(); }
}

async function runRoleDocuments() {
  const state = { fixture: null, calls: [], aborted: [], reply: () => ({ text: "已核对" }) };
  const f = await startInspirationFixture({ agentCount: 2,
    serviceOptions: { groupChatExecutor: scriptedExecutor(state), prewarmMcpAuth: false } });
  state.fixture = f;
  const api = async (method, suffix, body) => {
    const response = await fetch(`${f.url}/__api/group-chats${suffix}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter(profile => profile.enabled);
    const definitions = f.service.groupMemberDirectory.definitionStore;
    const original = definitions.get(profiles[0].id);
    definitions.update({ profileId: profiles[0].id, expectedRevision: original.manifest.revision, actor: "user",
      documents: { IDENTITY: "- 角色：公开核验员\n## 专长\n- 源码核验", SOUL: "公开角色🙂协作。\n".repeat(900) + "角色旧版尾部\n<!-- 私密备注 -->" } });
    const created = await api("POST", "", { operationId: "role-create", name: "角色分页", purpose: "隔离角色验收",
      members: profiles.map(profile => ({ backendId: "shoggoth", agentId: profile.agentId })) });
    assert.equal(created.status, 200);
    const groupId = created.body.group.id, target = created.body.members[0].id;
    let seenPage, latestPage, fullSeen = "";
    state.reply = async (profileId, _prompt, turn) => {
      const caller = { id: "role-reading-turn", source: "chat", sourceId: turn.sessionKey, profileId,
        idempotencyKey: `shoggoth:chat-send:${turn.operationId}` };
      const readRole = query => f.service.groupChatService.callTool("group_member_role_read",
        { source: "chat", sourceId: turn.sessionKey, member: target, ...query }, caller, profileId);
      seenPage = await readRole({});
      assert.equal(seenPage.ok, true); assert.ok(seenPage.nextCursor);
      const beforeEdit = definitions.get(profiles[0].id);
      definitions.update({ profileId: profiles[0].id, expectedRevision: beforeEdit.manifest.revision, actor: "user",
        documents: { SOUL: "公开角色新版乙。" } });
      await f.service.groupMemberDirectory.refresh(groupId);
      fullSeen = seenPage.text;
      let page = seenPage;
      while (page.nextCursor) { page = await readRole({ cursor: page.nextCursor }); assert.equal(page.ok, true); fullSeen += page.text; }
      latestPage = await readRole({ revision: "latest" });
      return { text: "已核对固定角色版本" };
    };
    await api("POST", `/messages?id=${groupId}`, { clientMessageId: "read-role", body: "核对同伴公开设定", mentions: [created.body.members[1].id] });
    for (let n = 0; n < 200; n++) {
      if (latestPage && quiet((await api("GET", `/detail?id=${groupId}`)).body)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(latestPage);
    assert.equal(state.calls.length, 1);
    assert.equal(crypto.createHash("sha256").update(fullSeen).digest("hex"), seenPage.exportDigest);
    assert.match(fullSeen, /角色旧版尾部/u); assert.doesNotMatch(fullSeen, /私密备注/u);
    assert.match(latestPage.text, /新版乙/u); assert.equal(latestPage.changedSinceSeen, true);
    const roleHistory = await api("GET", `/members/role-history?id=${groupId}&memberId=${target}&limit=1`);
    assert.equal(roleHistory.status, 200); assert.equal(roleHistory.body.snapshots.length, 1); assert.equal(roleHistory.body.hasMore, true);
    const earlier = await api("GET", `/members/role-history?id=${groupId}&memberId=${target}&limit=1&before=${roleHistory.body.nextCursor}`);
    assert.equal(earlier.status, 200); assert.equal(earlier.body.snapshots[0].id, seenPage.revisionId);
    const version = await api("GET", `/members/role?id=${groupId}&memberId=${target}&revision=${seenPage.revisionId}`);
    assert.equal(version.status, 200); assert.equal(version.body.text, seenPage.text);
    const corrupt = await api("GET", `/members/role?id=${groupId}&memberId=${target}&cursor=${encodeURIComponent(seenPage.nextCursor + "x")}`);
    assert.equal(corrupt.body.code, "invalid_cursor");
    console.log("PASS role REST: seen and latest, immutable complete pages, filtered history, source edits, MCP execution snapshot and cursor refusal");
  } finally { await f.close(); }
}

async function runLargeGroup() {
  const state = { fixture: null, calls: [], aborted: [], reply: () => ({ text: "(pass)" }) };
  const f = await startInspirationFixture({ agentCount: 32,
    serviceOptions: { groupChatExecutor: scriptedExecutor(state), prewarmMcpAuth: false } });
  state.fixture = f;
  const api = async (method, suffix, body) => {
    const response = await fetch(`${f.url}/__api/group-chats${suffix}`, { method,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter(profile => profile.enabled);
    const definitions = f.service.groupMemberDirectory.definitionStore;
    for (const profile of profiles) {
      const current = definitions.get(profile.id);
      definitions.update({ profileId: profile.id, expectedRevision: current.manifest.revision, actor: "user",
        documents: { IDENTITY: `- 角色：${"核对职责".repeat(20)}\n- 默认定位：${"只按当前授权处理".repeat(30)}\n## 专长\n`
          + Array.from({ length: 5 }, (_, index) => `- ${index} ${"核对版本证据".repeat(10)}`).join("\n"),
        SOUL: "结论先行并核对实际运行回执。".repeat(30) } });
    }
    const members = profiles.map(profile => ({ backendId: "shoggoth", agentId: profile.agentId }));
    assert.equal(members.length, 32);
    const created = await api("POST", "", { operationId: "large-create", name: "32 人群", purpose: "隔离容量验收", members });
    assert.equal(created.status, 200);
    const groupId = created.body.group.id;
    assert.equal(created.body.members.length, 32);
    const raw = await f.ipc("group.get", { groupId });
    assert.ok(raw.groupResponse, "the production Service uses pages for a large view");
    const detail = await api("GET", `/detail?id=${groupId}`);
    assert.equal(detail.status, 200); assert.equal(detail.body.members.length, 32);
    assert.equal((await api("GET", "")).body.groups[0].members.length, 32);
    assert.equal((await api("POST", "", { operationId: "too-many", name: "33 人", purpose: "", members: [...members, members[0]] })).status, 400);
    assert.equal((await api("POST", `/messages?id=${groupId}`, { clientMessageId: "large-message", body: "@all 每位成员按职责判断是否回答。", mentions: [] })).status, 200);
    for (let i = 0; i < 1500 && !(state.calls.length === 32 && quiet((await api("GET", `/detail?id=${groupId}`)).body)); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(state.calls.length, 32);
    assert.equal(new Set(state.calls.map(call => call.profileId)).size, 32);
    assert.ok(state.calls.every(call => /Current speaking queue:/u.test(call.prompt)));
    assert.match(state.calls.at(-1).prompt, /Your queued position: 32\/32; 31 earlier slots; no members queued after you; invite others if the user requested it\./u);
    assert.ok(state.calls.every(call => Buffer.byteLength(call.prompt) <= 36 * 1024), "the member line stays bounded in a large group");
    console.log("PASS large group REST: 32 members, complete paged state, @all one after another with bounded input, capacity refusal");
  } finally { await f.close(); }
}

async function runAll() {
  await run();
  await runNative();
  await runExternal();
  await runNativeInteraction();
  await runFeatureSwitch();
  await runStoreUnavailable();
  await runReliability();
  await runRoleDocuments();
  await runLargeGroup();
}

module.exports = { run: runAll, runNative, runRoleDocuments };
if (require.main === module) runAll().catch((error) => { console.error(error); process.exitCode = 1; });
