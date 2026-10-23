"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createFixture } = require("./fixtures/group-store-fixture.cjs");
const { DEFAULT_TOOL_REGISTRY, McpProductToolController, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
const { GROUP_CHAT_AGENT_TOOL_DEFINITIONS, GROUP_CHAT_AGENT_WRITE_TOOLS } = require("../app/agent-service/group-chat-agent-tools");
const { createMcpStdioHandler, MCP_STDIO_PROTOCOL_VERSION, EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS } = require("../app/shoggoth-mcp-helper");
const { sha256 } = require("../app/group-result-content");

function fixture(t, options = {}) {
  const f = createFixture(t, options);
  const profiles = new Map(f.roster.map(member => [member.profileId, { id: member.profileId,
    agentId: member.agentId, backendId: "shoggoth", name: member.displayName, enabled: true }]));
  f.service.productStore = { getAgentProfile: id => profiles.get(id), listAgentProfiles: () => [...profiles.values()] };
  f.authority = { profileId: f.roster[0].profileId };
  f.query = (name, args = {}, authority = f.authority) => f.service.agentAccess.query(`group_chat_${name}`, args, authority);
  f.dispatchArgs = (extra = {}) => {
    const detail = f.query("get", { groupId: f.groupId });
    return { groupId: f.groupId, ownerScope: detail.ownerScope, expectedRosterRevision: detail.group.rosterRevision,
      expectedPolicyVersion: detail.group.policyVersion, clientRequestId: "request-one", targetMemberIds: [f.roster[0].id],
      instruction: "请在群里汇报问题的处理结果，交付后停止。", source: "chat", sourceId: "direct-session", ...extra };
  };
  f.dispatch = (args = f.dispatchArgs(), authority = f.authority) => f.service.agentAccess.dispatch(args, authority,
    f.service.agentAccess.prepareDispatch(args, authority, "run-direct"));
  f.newGroup = (name, members = f.roster) => f.store.createGroup({ operationId: crypto.randomUUID(), name, purpose: "查群测试",
    members: members.map(({ backendId, agentId, profileId, displayName }) => ({ backendId, agentId, profileId, displayName })) }).groupId;
  return f;
}
function controllerFixture(f) {
  const ledger = new Map();
  const run = { id: "run-direct", source: "chat", sourceId: "direct-session", profileId: f.authority.profileId,
    status: "running", idempotencyKey: "shoggoth:chat-send:direct", workspace: null };
  const productStore = { ...f.service.productStore, addRunNote() {},
    lookupMcpToolCall(input) {
      const existing = ledger.get(`${input.profileId}:${input.callId}`) ?? null;
      if (existing && (existing.name !== input.name || existing.fingerprint !== input.fingerprint)) {
        throw Object.assign(new Error("call conflict"), { code: "MCP_TOOL_CALL_CONFLICT" });
      }
      return existing;
    },
    beginMcpToolCall(input) {
      const key = `${input.profileId}:${input.callId}`;
      const call = { ...input, id: key, status: "pending", operationId: `mcp-v1-${sha256(key).slice(0, 48)}` };
      ledger.set(key, call); return call;
    },
    completeMcpToolCall({ id, outcome }) { const call = ledger.get(id); Object.assign(call, { status: "completed", result: outcome }); return call; },
  };
  const methods = names => Object.fromEntries(names.map(name => [name, () => null]));
  const dependencies = { productStore, domainController: methods(["handle"]),
    kanbanStore: methods(["getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts"]),
    kanbanRunService: methods(["requestCompletionFromAgent"]), cronStore: methods(["getJob"]),
    workDispatcher: { getRun: id => id === run.id ? { ...run } : null },
    getRuntimeContext: (profileId, selector) => profileId === run.profileId && selector.source === run.source && selector.sourceId === run.sourceId
      ? { profileId, runId: run.id, source: run.source, sourceId: run.sourceId } : null,
    getGroupChatService: () => f.service, artifactRoot: f.root, notificationSender: async () => {}, isSensitiveValue: () => false };
  const create = () => new McpProductToolController(dependencies);
  const controller = create();
  const authority = (extra = {}) => ({ ...f.authority, callId: crypto.randomUUID(), ...extra });
  return { controller, run, ledger, productStore, create, authority,
    call: (name, args, extra) => controller.handle(`group_chat_${name}`, args, authority(extra)) };
}
function insert(f, seq, body, { full = true, author = { kind: "member", memberId: f.roster[0].id } } = {}) {
  const message = { id: `message-${seq}`, groupId: f.groupId, seq, threadId: "main", author,
    body: full ? body.slice(0, 64) : body, createdAt: 1000 + seq,
    mentions: { memberIds: [], broadcast: false, unresolved: [] },
    origin: { runId: "PRIVATE-RUN", sessionKey: "PRIVATE-SESSION", discussionId: "discussion-one" },
    ...(full ? { fullResult: { bytes: Buffer.byteLength(body), digest: sha256(body) } } : {}) };
  f.store.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(message.id, f.groupId, seq, message.id, JSON.stringify(message));
  if (full) f.store.db.prepare("INSERT INTO message_results VALUES(?,?,?,?)").run(message.id, body, sha256(body), Buffer.byteLength(body));
}

test("group tools expose native and external catalogs with confirmation on every mutation", () => {
  for (const { name } of GROUP_CHAT_AGENT_TOOL_DEFINITIONS) {
    assert.ok(DEFAULT_TOOL_REGISTRY.mcpDefinitions().some(tool => tool.name === name));
    assert.ok(EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS.some(tool => tool.name === name));
    assert.equal(DEFAULT_TOOL_REGISTRY.get(name).risk, GROUP_CHAT_AGENT_WRITE_TOOLS.includes(name) ? "confirm" : "read");
  }
  assert.equal(validateMcpProductToolArguments("group_chat_list", {}), true);
  assert.equal(validateMcpProductToolArguments("group_chat_list", { scope: "member", memberBackendId: "hermes", memberAgentId: "default" }), true);
  for (const [name, args] of [
    ["list", { scope: "member", memberAgentId: "default" }], ["list", { scope: "mine", profileId: "pretend" }],
    ["history", { groupId: "g", afterSeq: 0, beforeSeq: 2 }], ["history", { groupId: "g", messageSeq: 1, limit: 20 }],
    ["history", { groupId: "g", messageSeq: 1, offset: 1 }], ["history", { groupId: "g", offset: 0 }],
    ["search", { groupId: "g", query: "text", authorKind: "user", memberId: "m" }],
    ["get", { groupId: "g", privateSession: "s" }], ["list", { limit: 21 }], ["list", Object.create({ scope: "all" })],
  ]) assert.equal(validateMcpProductToolArguments(`group_chat_${name}`, args), false, JSON.stringify(args));
  let invoked = false; const getter = {}; Object.defineProperty(getter, "scope", { enumerable: true, get() { invoked = true; return "all"; } });
  assert.equal(validateMcpProductToolArguments("group_chat_list", getter), false); assert.equal(invoked, false);
});

function createRequest(f, extra = {}) {
  return { action: "create", clientRequestId: "create-request", name: "对话新建群", purpose: "明确名单",
    members: f.roster.slice(0, 2).map(({ backendId, agentId }) => ({ backendId, agentId })), ...extra };
}
async function mutationArgs(f, request) {
  const preview = await f.query("prepare", request);
  assert.equal(preview.state, "prepared");
  const { action, ...input } = request;
  return { ...input, ownerScope: preview.ownerScope, previewDigest: preview.previewDigest, source: "chat", sourceId: "direct-session" };
}

test("management schemas reject ambiguous, duplicated, forged and partial requests; dispatch supports the full roster", t => {
  const f = fixture(t), request = createRequest(f);
  assert.equal(validateMcpProductToolArguments("group_chat_prepare", request), true);
  for (const extra of [{ members: request.members.slice(0, 1) }, { groupId: f.groupId }, { members: [request.members[0], request.members[0]] },
    { members: [{ ...request.members[0], profileId: "forged" }, request.members[1]] }, { action: "remove_members" }, { source: "chat" }]) {
    assert.equal(validateMcpProductToolArguments("group_chat_prepare", { ...request, ...extra }), false);
  }
  assert.equal(validateMcpProductToolArguments("group_chat_dispatch", f.dispatchArgs({ targetMemberIds: Array.from({ length: 32 }, (_, i) => `m-${i}`) })), true);
  assert.equal(validateMcpProductToolArguments("group_chat_dispatch", f.dispatchArgs({ targetMemberIds: Array.from({ length: 33 }, (_, i) => `m-${i}`) })), false);
});

test("read-only preview, confirmed creation, atomic member addition and group dispatch form a complete flow", async t => {
  const f = fixture(t), c = controllerFixture(f), request = createRequest(f);
  const before = f.query("list", { scope: "all" }).total;
  const args = await mutationArgs(f, request);
  assert.equal(f.query("list", { scope: "all" }).total, before);
  await assert.rejects(c.call("create", args), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  const created = await c.call("create", args, { confirmation: true });
  assert.equal(created.status, "created"); assert.equal(created.memberIds.length, 2);
  assert.equal(f.query("list", { scope: "all" }).total, before + 1);
  const add = { action: "add_members", clientRequestId: "add-request", groupId: created.groupId,
    members: [f.roster[2]].map(({ backendId, agentId }) => ({ backendId, agentId })) };
  const added = await c.call("members_add", await mutationArgs(f, add), { confirmation: true });
  assert.equal(added.status, "members_added");
  const group = f.query("get", { groupId: created.groupId });
  assert.equal(group.members.length, 3);
  assert.equal(f.store.listMessages({ groupId: created.groupId, afterSeq: null, beforeSeq: null, limit: 20 }).messages.some(m => m.author.kind === "user"), false);
  const sent = await c.call("dispatch", f.dispatchArgs({ groupId: created.groupId, clientRequestId: "new-group-message",
    expectedRosterRevision: group.group.rosterRevision, targetMemberIds: group.members.map(m => m.id) }), { confirmation: true });
  assert.equal(sent.status, "submitted");
  assert.equal(f.query("history", { groupId: created.groupId }).messages.filter(m => m.author.kind === "user").length, 1);
  assert.doesNotMatch(JSON.stringify(await f.query("prepare", request)), /profileId|workspace|runtimeSession/);
});

test("management receipt survives a lost outer reply, reopening and ordinary operation expiry", async t => {
  const f = fixture(t), c = controllerFixture(f), request = createRequest(f), args = await mutationArgs(f, request);
  const auth = c.authority({ confirmation: true }), complete = c.productStore.completeMcpToolCall;
  c.productStore.completeMcpToolCall = () => { throw Object.assign(Error("lost outer reply"), { code: "MCP_TOOL_COMMIT_UNCERTAIN" }); };
  await assert.rejects(c.controller.handle("group_chat_create", args, auth), { code: "MCP_TOOL_COMMIT_UNCERTAIN" });
  const prior = await f.query("prepare", request); assert.equal(prior.state, "completed");
  const count = f.query("list", { scope: "all" }).total;
  c.productStore.completeMcpToolCall = complete;
  assert.deepEqual(await c.create().handle("group_chat_create", args, auth), prior.receipt);
  f.reopen();
  assert.deepEqual((await f.query("prepare", request)).receipt, prior.receipt);
  assert.deepEqual(await c.create().handle("group_chat_create", args, c.authority({ confirmation: true })), prior.receipt);
  assert.equal(f.query("list", { scope: "all" }).total, count);
  f.advance(31 * 86400000); f.newGroup("触发普通回执清理");
  assert.deepEqual((await f.query("prepare", request)).receipt, prior.receipt);
  await assert.rejects(f.query("prepare", { ...request, name: "同一请求改名" }), { code: "GROUP_CHAT_OPERATION_CONFLICT" });
  const other = await f.query("prepare", request, { profileId: f.roster[1].profileId });
  assert.equal(other.state, "prepared", "other caller cannot read or inherit this receipt");
});

test("changed identities, roster, owner, lease and group-run sources cannot consume a management preview", async t => {
  const f = fixture(t), c = controllerFixture(f), request = createRequest(f), args = await mutationArgs(f, request);
  const count = f.query("list", { scope: "all" }).total;
  for (const idempotencyKey of ["shoggoth:chat-send:group-turn-owned", "shoggoth:chat-send:federation-send-owned"]) {
    c.run.idempotencyKey = idempotencyKey;
    await assert.rejects(c.call("create", args, { confirmation: true }), { code: "MCP_TOOL_FORBIDDEN" });
  }
  c.run.idempotencyKey = "shoggoth:chat-send:direct";
  await assert.rejects(c.call("create", { ...args, sourceId: "foreign" }, { confirmation: true }), { code: "MCP_TOOL_NOT_FOUND" });
  await assert.rejects(c.call("create", { ...args, ownerScope: "wrong" }, { confirmation: true }), { code: "MCP_TOOL_STATE_CONFLICT" });
  const resolve = f.service.resolveAgentAccessMembers.bind(f.service);
  f.service.resolveAgentAccessMembers = async refs => (await resolve(refs)).map(member => ({ ...member, displayName: "changed" }));
  await assert.rejects(c.call("create", args, { confirmation: true }), { code: "MCP_TOOL_STATE_CONFLICT" });
  f.service.resolveAgentAccessMembers = resolve;
  const binding = await f.service.agentAccess.prepareManagement("group_chat_create", args, f.authority, "run-direct");
  await assert.rejects(f.service.agentAccess.manage("group_chat_create", args, f.authority, binding,
    () => { throw Object.assign(Error("revoked"), { code: "HOST_CAPABILITY_REVOKED" }); }), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(f.query("list", { scope: "all" }).total, count);
  const created = await c.call("create", args, { confirmation: true });
  const add = { action: "add_members", clientRequestId: "add-changed", groupId: created.groupId,
    members: [request.members[0]] };
  await assert.rejects(f.query("prepare", add), { code: "GROUP_CHAT_MEMBER_DUPLICATE" });
  add.members = [f.roster[2]].map(({ backendId, agentId }) => ({ backendId, agentId }));
  const addArgs = await mutationArgs(f, add);
  f.store.setMemberModel({ groupId: created.groupId, expectedRosterRevision: 1, memberId: created.memberIds[0],
    modelSelection: { model: "test", provider: "test" } });
  await assert.rejects(c.call("members_add", addArgs, { confirmation: true }), { code: "MCP_TOOL_STATE_CONFLICT" });
  assert.equal(f.query("get", { groupId: created.groupId }).members.length, 2);
});

test("batch membership and receipt roll back together if a later member cannot be added", async t => {
  const f = fixture(t, { members: 5 }), request = createRequest(f);
  const args = await mutationArgs(f, request), c = controllerFixture(f);
  const created = await c.call("create", args, { confirmation: true });
  const add = { action: "add_members", clientRequestId: "atomic-add", groupId: created.groupId,
    members: f.roster.slice(2, 4).map(({ backendId, agentId }) => ({ backendId, agentId })) };
  const preview = await f.service.agentAccess.managementPreview(add, f.authority);
  const existing = (await f.service.resolveAgentAccessMembers(request.members))[0];
  const input = { operationId: preview.operationId, request: preview.request, ownerScope: preview.public.ownerScope,
    previewDigest: preview.public.previewDigest, rosterRevision: preview.groupState.rosterRevision,
    policyVersion: preview.groupState.policyVersion, members: [preview.members[0], existing] };
  assert.throws(() => f.store.applyAgentManagement(input), { code: "GROUP_CHAT_MEMBER_DUPLICATE" });
  assert.equal(f.store.lookupAgentManagement(preview.operationId, preview.request), null);
  assert.equal(f.query("get", { groupId: created.groupId }).members.length, 2);
  const receipt = f.store.applyAgentManagement({ ...input, members: preview.members });
  assert.equal(receipt.memberIds.length, 2);
  assert.equal(f.query("get", { groupId: created.groupId }).members.length, 4);
  assert.deepEqual(f.store.applyAgentManagement({ ...input, members: preview.members }), receipt);
});

test("management resolves external identities and refuses unavailable or changed members during confirmation", async t => {
  const f = fixture(t), c = controllerFixture(f);
  f.service.getFederationClient = () => ({ request: async (name, args) => {
    assert.equal(name, "agent.get");
    return { agent: { id: args.agentId, name: `${args.backendId} 的同名助理` } };
  } });
  const request = createRequest(f, { members: [{ backendId: "openclaw", agentId: "default" }, { backendId: "hermes", agentId: "default" }] });
  const args = await mutationArgs(f, request);
  const before = f.query("list", { scope: "all" }).total;
  f.service.getFederationClient = () => null;
  await assert.rejects(c.call("create", args, { confirmation: true }), { code: "MCP_TOOL_UNAVAILABLE" });
  assert.equal(f.query("list", { scope: "all" }).total, before);
  const native = createRequest(f, { clientRequestId: "disable-during-confirmation" }), nativeArgs = await mutationArgs(f, native);
  const handler = createMcpStdioHandler({ runtimeProfileId: "fixture", runtimeAccountId: "fixture-account",
    sessionToken: Buffer.alloc(32, 1).toString("base64url"), requestService: async (_paths, { params }) =>
      c.controller.handle(params.name, params.arguments, { ...f.authority, callId: params.callId, ...(params.confirmation ? { confirmation: true } : {}) }) });
  t.after(() => handler.close());
  await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "fixture", version: "1" } } });
  const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "group_chat_create", arguments: nativeArgs } },
    { requestClient: async () => {
      f.service.productStore.getAgentProfile(f.roster[1].profileId).enabled = false;
      return { action: "accept", content: { confirm_product_action: "确认执行" } };
    } });
  assert.equal(result.result.isError, true);
  assert.equal(f.query("list", { scope: "all" }).total, before);
  f.service.productStore.getAgentProfile(f.roster[1].profileId).enabled = true;
  const binding = await f.service.agentAccess.prepareManagement("group_chat_create", nativeArgs, f.authority, "run-direct");
  const resolve = f.service.resolveAgentAccessMembers.bind(f.service);
  f.service.resolveAgentAccessMembers = async refs => {
    const members = await resolve(refs);
    f.service.productStore.getAgentProfile(f.roster[1].profileId).enabled = false;
    return members;
  };
  await assert.rejects(f.service.agentAccess.manage("group_chat_create", nativeArgs, f.authority, binding),
    { code: "GROUP_CHAT_PROFILE_UNAVAILABLE" });
  assert.equal(f.query("list", { scope: "all" }).total, before);
});

test("actual helper confirms authoritative management names, cancels without writes and reads an existing receipt without reapproval", async t => {
  const f = fixture(t), c = controllerFixture(f), request = createRequest(f), args = await mutationArgs(f, request);
  const count = f.query("list", { scope: "all" }).total;
  const handler = createMcpStdioHandler({ runtimeProfileId: "fixture", runtimeAccountId: "fixture-account",
    sessionToken: Buffer.alloc(32, 1).toString("base64url"), requestService: async (_paths, { params }) =>
      c.controller.handle(params.name, params.arguments, { ...f.authority, callId: params.callId, ...(params.confirmation ? { confirmation: true } : {}) }) });
  t.after(() => handler.close());
  await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
    capabilities: { elicitation: {} }, clientInfo: { name: "fixture", version: "1" } } });
  let asks = 0;
  const call = async action => handler({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
    params: { name: "group_chat_create", arguments: args } }, { requestClient: async (_method, params) => {
      asks++; assert.ok(params.message.includes("对话新建群"));
      assert.ok(params.message.includes("M0")); assert.ok(params.message.includes("M1"));
      return { action, ...(action === "accept" ? { content: { confirm_product_action: "确认执行" } } : {}) };
    } });
  assert.equal((await call("decline")).result.structuredContent.canceled, true);
  assert.equal(f.query("list", { scope: "all" }).total, count);
  const result = await call("accept"); assert.equal(result.result.isError, false);
  const replay = await call("accept"); assert.deepEqual(replay.result.structuredContent, result.result.structuredContent);
  assert.equal(asks, 2); assert.equal(f.query("list", { scope: "all" }).total, count + 1);
});

test("membership, archived counts, duplicate names and explicit external member lookup", t => {
  const f = fixture(t);
  const twin = f.newGroup("群聊验收"), unrelated = f.newGroup("其他群", f.roster.slice(1));
  let list = f.query("list"); assert.equal(list.total, 2); assert.equal(list.scope, "mine");
  assert.equal(f.query("list", { scope: "all" }).total, 3);
  const first = f.query("list", { scope: "all", query: "群聊验收", limit: 1 });
  const second = f.query("list", { scope: "all", query: "群聊验收", limit: 1, afterId: first.nextAfterId });
  assert.equal(first.total, 2); assert.equal(second.nextAfterId, null);
  assert.notEqual(first.groups[0].id, second.groups[0].id);
  const group = f.store.getGroup(twin).group;
  f.store.updateGroup({ groupId: twin, expectedMetadataRevision: group.metadataRevision, patch: { status: "archived" } });
  assert.equal(f.query("list").total, 1); assert.equal(f.query("list", { includeArchived: true }).total, 2);
  const ext = { ...f.authority, federationClient: "hermes" };
  list = f.query("list", {}, ext); assert.equal(list.total, 2); assert.equal(list.currentAgent, null);
  assert.ok(list.groups.every(item => item.joined === null && item.currentMemberId === null));
  assert.equal(f.query("list", { scope: "mine" }, ext).code, "current_member_unknown");
  assert.equal(f.query("list", { scope: "member", memberBackendId: "shoggoth", memberAgentId: f.roster[0].agentId }, ext).total, 1);
  assert.equal(f.query("get", { groupId: unrelated }).group.currentMemberId, null);
  const current = f.view().group;
  f.store.removeMember({ groupId: f.groupId, memberId: f.roster[0].id, expectedRosterRevision: current.rosterRevision });
  assert.equal(f.query("list").total, 0, "removed membership is not joined");
  assert.equal(f.query("get", { groupId: f.groupId }).removedMemberCount, 1);
});

test("count and pagination do not inherit the sidebar 500 group cap", t => {
  const f = fixture(t), base = f.view().group;
  // Bulk fixture records: no execution is admitted and no real database is used.
  f.store.db.exec("BEGIN");
  const columns = f.store.db.prepare("PRAGMA table_info(groups)").all().map(item => item.name);
  const row = f.store.db.prepare("SELECT * FROM groups WHERE id=?").get(f.groupId);
  const sql = `INSERT INTO groups(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`;
  for (let i = 0; i < 501; i++) {
    const id = `bulk-${String(i).padStart(4, "0")}`, data = { ...base, id, name: "分页群" };
    f.store.db.prepare(sql).run(...columns.map(column => column === "id" ? id : column === "data" ? JSON.stringify(data) : row[column]));
  }
  f.store.db.exec("COMMIT");
  let afterId, seen = [];
  do {
    const page = f.query("list", { scope: "all", ...(afterId ? { afterId } : {}) });
    assert.equal(page.total, 502); seen.push(...page.groups.map(item => item.id)); afterId = page.nextAfterId;
  } while (afterId);
  assert.equal(seen.length, 502); assert.equal(new Set(seen).size, 502);
});

test("group detail exports public roles and state without private sessions, paths or approvals", t => {
  const f = fixture(t);
  f.store.applyMemberCards({ groupId: f.groupId, updates: [{ memberId: f.roster[0].id,
    card: { role: "工程师", specialties: ["测试"], privateField: "PRIVATE-CANARY", workspace: "/private/secret" } }] });
  f.store.ensureMemberBinding({ groupId: f.groupId, memberId: f.roster[0].id });
  const result = f.query("get", { groupId: f.groupId });
  assert.equal(result.group.currentMemberId, f.roster[0].id); assert.equal(result.members[0].role, "工程师");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CANARY|private\/secret|profileId|internalSession|toolGrant|workspace/);
});

test("history pages keep chronological order, UTF-8 full reads and public authors; search finds long tails", t => {
  const f = fixture(t), full = "前文😀".repeat(6000) + "可搜索的尾部结论";
  insert(f, 1, full); insert(f, 2, "另一个较长正文".repeat(4000)); insert(f, 3, "用户消息", { author: { kind: "user" } });
  let page = f.query("history", { groupId: f.groupId, limit: 2 });
  assert.deepEqual(page.messages.map(m => m.seq), [2, 3]); assert.equal(page.nextBeforeSeq, 2);
  page = f.query("history", { groupId: f.groupId, beforeSeq: page.nextBeforeSeq });
  assert.deepEqual(page.messages.map(m => m.seq), [1]); assert.equal(page.messages[0].author.name, "M0");
  assert.equal(page.messages[0].excerpt, true); assert.equal(page.messages[0].partial, false);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE-RUN|PRIVATE-SESSION|profileId|originKey/);
  const hit = f.query("search", { groupId: f.groupId, query: "尾部结论" }).hits[0];
  assert.equal(hit.message.seq, 1); assert.match(hit.snippet, /尾部结论/);
  let offset = 0, text = "", reads = 0;
  do {
    const read = f.query("history", { groupId: f.groupId, messageSeq: 1, offset, digest: hit.message.fullResult.digest });
    text += read.page.text; offset = read.page.nextOffset; reads++;
  } while (offset !== null);
  assert.ok(reads > 1); assert.equal(text, full);
  assert.throws(() => f.query("history", { groupId: f.groupId, messageSeq: 1, digest: "f".repeat(64) }), { code: "GROUP_RESULT_MISMATCH" });
  insert(f, 4, "旧的节选", { full: false });
  assert.equal(f.query("history", { groupId: f.groupId, messageSeq: 4 }).partial, true);
  assert.equal(f.query("search", { groupId: f.groupId, query: "不存在" }).partial, true);
});

test("JSON-expanded history stays bounded and backward pagination cannot skip messages", t => {
  const f = fixture(t); for (let seq = 1; seq <= 8; seq++) insert(f, seq, "\u0001".repeat(24000) + `尾${seq}`);
  let beforeSeq, seen = [];
  do {
    const page = f.query("history", { groupId: f.groupId, limit: 20, ...(beforeSeq ? { beforeSeq } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
    seen.unshift(...page.messages.map(m => m.seq)); beforeSeq = page.nextBeforeSeq;
  } while (beforeSeq !== null);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("confirmed request reaches the selected member's real group run and publishes the actual result", async t => {
  const f = fixture(t, { productionDriver: true }); await f.startDriver();
  const args = f.dispatchArgs(); const receipt = f.dispatch(args); await f.settle();
  assert.equal(receipt.accepted, true); assert.equal(receipt.status, "submitted");
  assert.equal(f.started.length, 1); assert.equal(f.started[0].run.profileId, f.roster[0].profileId);
  assert.match(f.started[0].prompt, /请在群里汇报问题的处理结果/);
  await f.finishRun(f.started[0].run, "completed", "处理结果：已完成隔离检查。");
  const history = f.query("history", { groupId: f.groupId });
  assert.ok(history.messages.some(message => message.author.memberId === f.roster[0].id && message.body.includes("已完成隔离检查")));
  const count = f.messages().length;
  assert.deepEqual(f.dispatch(args), receipt); assert.equal(f.messages().length, count);
  f.reopen();
  assert.deepEqual(f.dispatch(args), receipt, "same request is not sent again after reopening the SQLite store");
  const lookup = f.query("get", { groupId: f.groupId, clientRequestId: args.clientRequestId }).dispatch;
  assert.equal(lookup.status, "found"); assert.equal(lookup.messageSeq, receipt.messageSeq);
  assert.throws(() => f.dispatch({ ...args, instruction: "changed same request" }), { code: "MCP_TOOL_STATE_CONFLICT" });
});

test("stale roster/owner/policy, extra mentions, revoked lease and archived groups never enqueue", t => {
  const f = fixture(t), args = f.dispatchArgs();
  for (const extra of [{ ownerScope: "ga1:wrong" }, { expectedPolicyVersion: args.expectedPolicyVersion + 1 },
    { expectedRosterRevision: args.expectedRosterRevision + 1 }, { targetMemberIds: ["foreign-member"] },
    { instruction: `@${f.roster[1].handle} do something else` }, { instruction: "@all unexpected broadcast" }]) {
    assert.throws(() => f.dispatch({ ...args, ...extra }), { code: "MCP_TOOL_STATE_CONFLICT" });
  }
  const binding = f.service.agentAccess.prepareDispatch(args, f.authority, "run-direct");
  assert.throws(() => f.service.agentAccess.dispatch(args, f.authority, binding, () => {
    throw Object.assign(new Error("revoked"), { code: "HOST_CAPABILITY_REVOKED" });
  }), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(f.messages().length, 0);
  f.store.removeMember({ groupId: f.groupId, memberId: f.roster[0].id, expectedRosterRevision: args.expectedRosterRevision });
  const afterRemove = f.messages().length;
  assert.throws(() => f.service.agentAccess.dispatch(args, f.authority, binding), { code: "MCP_TOOL_STATE_CONFLICT" });
  assert.equal(f.messages().length, afterRemove);
  const group = f.view().group;
  f.store.updateGroup({ groupId: f.groupId, expectedMetadataRevision: group.metadataRevision, patch: { status: "archived" } });
  assert.throws(() => f.dispatch({ ...args, targetMemberIds: [f.roster[1].id] }), { code: "MCP_TOOL_STATE_CONFLICT" });
});

test("dispatches sent while a round is running join it in order and cancel nothing", t => {
  const f = fixture(t), first = f.dispatch();
  const second = f.dispatch(f.dispatchArgs({ clientRequestId: "second-request", targetMemberIds: [f.roster[1].id] }));
  const append = f.dispatch(f.dispatchArgs({ clientRequestId: "append-request", requestMode: "append",
    discussionId: first.discussionId, instruction: "补充原请求的验收条件。" }));
  assert.equal(second.discussionId, first.discussionId, "one round per group: a later request joins the running round");
  assert.equal(append.discussionId, first.discussionId);
  const order = f.view().round.order;
  assert.deepEqual(order.map(turn => turn.memberId), [f.roster[0].id, f.roster[1].id]);
  assert.ok(order.every(turn => turn.state === "queued"), "earlier speakers are not cancelled");
  assert.equal(f.messages().filter(message => message.author.kind === "user").length, 3);
});

test("lost outer ledger completion reconciles the committed group send without executing twice", async t => {
  const f = fixture(t), c = controllerFixture(f), args = f.dispatchArgs();
  const auth = c.authority({ confirmation: true });
  const complete = c.productStore.completeMcpToolCall;
  c.productStore.completeMcpToolCall = () => { throw Object.assign(new Error("fixture lost commit receipt"), { code: "MCP_TOOL_COMMIT_UNCERTAIN" }); };
  await assert.rejects(c.controller.handle("group_chat_dispatch", args, auth), { code: "MCP_TOOL_COMMIT_UNCERTAIN" });
  assert.equal(f.messages().filter(message => message.author.kind === "user").length, 1);
  c.productStore.completeMcpToolCall = complete;
  const restored = await c.create().handle("group_chat_dispatch", args, auth);
  assert.equal(restored.accepted, true);
  assert.equal(f.messages().filter(message => message.author.kind === "user").length, 1);
});

test("controller enforces confirmation, direct native run, external identity and live read permissions", async t => {
  const f = fixture(t), c = controllerFixture(f), args = f.dispatchArgs();
  await assert.rejects(c.call("dispatch", args), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  for (const idempotencyKey of ["shoggoth:chat-send:group-turn-owned", "shoggoth:chat-send:group-task-owned", "shoggoth:chat-send:federation-send-owned"]) {
    c.run.idempotencyKey = idempotencyKey;
    await assert.rejects(c.call("dispatch", args, { confirmation: true }), { code: "MCP_TOOL_FORBIDDEN" });
  }
  c.run.idempotencyKey = "shoggoth:chat-send:direct";
  await assert.rejects(c.call("dispatch", { ...args, sourceId: "other-session" }, { confirmation: true }), { code: "MCP_TOOL_NOT_FOUND" });
  const auth = c.authority({ confirmation: true });
  const receipt = await c.controller.handle("group_chat_dispatch", args, auth);
  c.run.status = "completed";
  assert.deepEqual(await c.controller.handle("group_chat_dispatch", args, auth), receipt, "durable exact replay is a receipt, not new work");
  const external = { ...f.authority, federationClient: "hermes", confirmation: true };
  await assert.rejects(c.controller.handle("group_chat_dispatch", args, { ...external, callId: crypto.randomUUID() }), { code: "MCP_TOOL_FORBIDDEN" });
  const { source, sourceId, ...externalArgs } = f.dispatchArgs({ clientRequestId: "external-request", targetMemberIds: [f.roster[1].id] });
  const extReceipt = await c.controller.handle("group_chat_dispatch", externalArgs, { ...external, callId: crypto.randomUUID() });
  assert.equal(extReceipt.accepted, true);
  assert.equal(f.query("get", { groupId: f.groupId, clientRequestId: "external-request" }).dispatch.status, "not_found");
  assert.equal(f.query("get", { groupId: f.groupId, clientRequestId: "external-request" }, external).dispatch.status, "found");
  const readAuthority = c.authority();
  assert.equal((await c.controller.handle("group_chat_list", {}, readAuthority)).total, 1);
  const group = f.view().group;
  f.store.updateGroup({ groupId: f.groupId, expectedMetadataRevision: group.metadataRevision, patch: { status: "archived" } });
  assert.equal((await c.controller.handle("group_chat_list", {}, readAuthority)).total, 0, "same read callId refreshes mutable App state");
  c.controller.permissionEngine.setProfileOverride(f.authority.profileId, "group_chat_list", "deny");
  await assert.rejects(c.controller.handle("group_chat_list", {}, readAuthority), { code: "MCP_TOOL_FORBIDDEN" });
});

test("actual MCP helper shows authoritative group/recipients and complete instruction; cancellation makes zero writes", async t => {
  const f = fixture(t), c = controllerFixture(f), args = f.dispatchArgs();
  for (const action of ["unsupported", "decline", "accept"]) {
    const invoked = [];
    const handler = createMcpStdioHandler({ runtimeProfileId: "fixture-runtime", runtimeAccountId: "fixture-account",
      sessionToken: Buffer.alloc(32, 1).toString("base64url"),
      requestService: async (_paths, request) => {
        const { name, arguments: arguments_, callId, confirmation } = request.params;
        invoked.push(name); return c.controller.handle(name, arguments_, { ...f.authority, callId, ...(confirmation ? { confirmation: true } : {}) });
      } });
    t.after(() => handler.close());
    await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: action === "unsupported" ? {} : { elicitation: {} }, clientInfo: { name: "fixture", version: "1" } } });
    const response = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "group_chat_dispatch", arguments: args } },
      { requestClient: async (method, params) => {
        assert.equal(method, "elicitation/create"); assert.ok(params.message.includes(args.instruction));
        assert.ok(params.message.includes("群聊验收")); assert.ok(params.message.includes(f.roster[0].id));
        assert.ok(!params.message.includes(f.roster[1].id));
        return { action, ...(action === "accept" ? { content: { confirm_product_action: "确认执行" } } : {}) };
      } });
    assert.equal(invoked.filter(name => name === "group_chat_dispatch").length, action === "accept" ? 1 : 0);
    assert.equal(f.messages().filter(message => message.author.kind === "user").length, action === "accept" ? 1 : 0);
    assert.equal(response.result.isError, action === "unsupported"); handler.close();
  }
});
