"use strict";

// L2: production Service, MCP authentication/binding, SQLite, group scheduler,
// native sessions and transcripts. Only the model process and user choices are
// controlled. No installed Agent, user group or real Provider is used.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { authenticateMcpSession, createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { requestService } = require("../app/agent-service/client");

async function until(read, predicate, label, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const f = await startInspirationFixture({ agentCount: 3, groupControlledRuntime: true,
    serviceOptions: { prewarmMcpAuth: false } });
  let helper, session;
  try {
    const profiles = f.service.productStore.listAgentProfiles().filter(p => p.enabled);
    const profile = profiles[0];
    const control = async (action, context, params) => {
      const id = crypto.randomUUID(), directory = path.join(f.root, "group-control");
      const responsePath = path.join(directory, `${id}.response.json`);
      fs.writeFileSync(path.join(directory, `${id}.request.json`), JSON.stringify({ id, action,
        threadId: context.threadId, turnId: context.turnId, params }), { mode: 0o600 });
      const response = await until(() => {
        try { return JSON.parse(fs.readFileSync(responsePath, "utf8")); } catch { return null; }
      }, value => value !== null, action, process.env.GROUP_AGENT_CONFIRM_UI === "1" ? 15000 : 500);
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    };
    const contextFor = runId => until(() => f.service.workRunCoordinator.runContexts.get(runId),
      value => value?.threadId && value?.turnId && f.service.productStore.getWorkRun(runId)?.status === "running", "native run");
    const directKey = await f.backend.createSession(profile.agentId, { workspace: null });
    const direct = { session: { sessionKey: directKey.slice(directKey.lastIndexOf(":") + 1) } };
    const sendDirect = async operationId => {
      const { run } = await f.ipc("chat.send", { operationId, sessionKey: direct.session.sessionKey,
        prompt: "查看我加入的群，并在指定群里执行用户确认的安排。", createdAt: Date.now() });
      return contextFor(run.id);
    };
    let directContext = await sendDirect("group-agent-request");
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => Buffer.from(value).toString() };
    session = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, safeStorage });
    helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token, sessionExpiresAt: session.expiresAt,
      bindRuntimeCalls: true, requestService: (paths, request, options) => requestService(paths, request, { timeoutMs: 10000, ...options }) });
    await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} }, clientInfo: { name: "group-agent-access-l2", version: "1" } } });
    const listed = await helper({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    for (const suffix of ["list", "get", "history", "search", "dispatch", "prepare", "create", "members_add"]) {
      assert.ok(listed.result.tools.some(tool => tool.name === `group_chat_${suffix}`));
    }
    let confirmations = 0;
    let uiConfirmationShown = false;
    const call = async (suffix, args = {}, decision = "accept") => {
      const response = await helper({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
        params: { name: `group_chat_${suffix}`, arguments: args } }, { requestClient: async (method, params) => {
        assert.equal(method, "elicitation/create");
        if (params._meta?.["shoggoth/runtime-call-binding"]) return control("binding", directContext, params);
        confirmations++;
        if (suffix === "dispatch") {
          assert.ok(params.message.includes(args.instruction));
          assert.ok(params.message.includes(args.groupId));
          assert.ok(params.message.includes(args.targetMemberIds[0]));
        } else {
          assert.ok(params.message.includes("MCP 群聊隔离验收"));
          for (const member of args.members) assert.ok(params.message.includes(member.agentId));
        }
        if (process.env.GROUP_AGENT_CONFIRM_UI === "1" && !uiConfirmationShown && suffix === "create" && decision === "accept") {
          uiConfirmationShown = true;
          console.log(JSON.stringify({ confirmationUrl: `${f.url}/#/chat?backend=shoggoth&session=${encodeURIComponent(directKey)}`, agentName: profile.name,
            sessionKey: direct.session.sessionKey, phase: "confirm-group-creation" }));
          // Codex app-server adds mode when forwarding an MCP form request.
          return control("binding", directContext, { ...params, mode: "form" });
        }
        return { action: decision, ...(decision === "accept" ? { content: { confirm_product_action: "确认执行" } } : {}) };
      } });
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
      return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
    };
    const create = { action: "create", clientRequestId: "group-agent-group", name: "MCP 群聊隔离验收",
      purpose: "私聊发现、确认派发与结果回读",
      members: profiles.slice(0, 2).map(p => ({ backendId: "shoggoth", agentId: p.agentId })) };
    const creationPreview = await call("prepare", create);
    assert.equal((await call("list")).total, 0, "preparing never creates a group");
    const { action: _createAction, ...creationFields } = create;
    const creationArgs = { ...creationFields, ownerScope: creationPreview.ownerScope, previewDigest: creationPreview.previewDigest,
      source: "chat", sourceId: direct.session.sessionKey };
    await call("create", creationArgs, "decline");
    assert.equal((await call("list")).total, 0, "canceling never creates a group");
    const created = await call("create", creationArgs);
    assert.equal(created.status, "created");
    assert.deepEqual((await call("prepare", create)).receipt, created);
    assert.deepEqual(await call("create", creationArgs), created);
    assert.equal(confirmations, 2, "completed creation reads its receipt without asking or writing again");
    const add = { action: "add_members", clientRequestId: "group-agent-add", groupId: created.groupId,
      members: profiles.slice(2).map(p => ({ backendId: "shoggoth", agentId: p.agentId })) };
    const additionPreview = await call("prepare", add);
    const { action: _addAction, ...additionFields } = add;
    const added = await call("members_add", { ...additionFields, ownerScope: additionPreview.ownerScope,
      previewDigest: additionPreview.previewDigest, source: "chat", sourceId: direct.session.sessionKey });
    assert.equal(added.status, "members_added");
    await f.ipc("group.create", { operationId: "group-agent-unrelated", name: "其他成员的群", purpose: "核对计数范围",
      members: profiles.slice(1).map(p => ({ backendId: "shoggoth", agentId: p.agentId })) });
    const mine = await call("list");
    assert.equal(mine.total, 1); assert.equal(mine.currentAgent.agentId, profile.agentId);
    assert.equal((await call("list", { scope: "all" })).total, 2);
    const detail = await call("get", { groupId: created.groupId });
    assert.equal(detail.members.length, 3);
    const target = detail.group.currentMemberId;
    assert.equal(detail.members.find(m => m.id === target).agentId, profile.agentId);
    const args = { groupId: detail.group.id, ownerScope: detail.ownerScope,
      expectedRosterRevision: detail.group.rosterRevision, expectedPolicyVersion: detail.group.policyVersion,
      clientRequestId: "direct-user-request", targetMemberIds: [target], instruction: "在群内整理验收结论并回复。",
      source: "chat", sourceId: direct.session.sessionKey };
    await call("dispatch", args, "decline");
    assert.equal((await call("history", { groupId: args.groupId })).messages.filter(m => m.author.kind === "user").length, 0);
    const receipt = await call("dispatch", args);
    assert.equal(receipt.status, "submitted"); assert.equal(receipt.accepted, true);
    assert.equal(confirmations, 5);
    const repeated = await call("dispatch", args);
    assert.equal(repeated.messageSeq, receipt.messageSeq);
    assert.equal((await call("history", { groupId: args.groupId })).messages.filter(m => m.author.kind === "user").length, 1);
    assert.equal((await call("get", { groupId: args.groupId, clientRequestId: args.clientRequestId })).dispatch.status, "found");
    await control("complete", directContext);
    const turn = await until(() => f.service.groupChatStore.runningOpportunities().find(t => t.groupId === args.groupId),
      value => value?.runId, "selected group member starts");
    assert.equal(turn.memberId, target);
    const groupContext = await contextFor(turn.runId);
    await control("complete", groupContext);
    await until(() => f.service.groupChatStore.listMessages({ groupId: args.groupId, limit: 20 }).messages,
      messages => messages.some(m => m.author.memberId === target && m.body.includes("completed")), "published native result");
    directContext = await sendDirect("group-agent-read-result");
    const history = await call("history", { groupId: args.groupId });
    const answer = history.messages.find(m => m.author.memberId === target);
    assert.match(answer.body, /completed/);
    assert.equal((await call("search", { groupId: args.groupId, query: "completed" })).hits.length, 1);
    const full = await call("history", { groupId: args.groupId, messageSeq: answer.seq, digest: answer.fullResult.digest });
    assert.match(full.page.text, /completed/);
    assert.doesNotMatch(JSON.stringify(history), /internalSession|profileId|workspace|toolGrant/);
    await control("complete", directContext);
    console.log("PASS group Agent access L2: confirmed creation/addition/dispatch, cancel zero writes, durable receipt replay, native discovery/count, public detail/history/search, real scheduler and native transcript read-back");
    if (process.env.GROUP_AGENT_UI_FIXTURE === "1") {
      console.log(JSON.stringify({ url: f.url, groupId: args.groupId }));
      await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
    }
  } finally { helper?.close(); session?.close?.(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
