"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { GroupRuntimeHost } = require("../app/group-runtime-host");
const { GroupRuntimeRouter } = require("../app/group-runtime-router");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { createGroupRuntimeMcpHandler } = require("../app/group-runtime-mcp-helper");

async function run() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-remote-rest-"))); fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "project"); fs.mkdirSync(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace }); fs.writeFileSync(path.join(workspace, "base.txt"), "base");
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd: workspace });
  const agent = { backendId: "hermes", agentId: "helper" }, ownerToken = crypto.randomBytes(32).toString("base64url"),
    runtimeToken = crypto.randomBytes(32).toString("base64url");
  const soul = "远端实施助手。\n\n" + "依据公开输入完成工作。\n".repeat(1800) + "\n私有凭据 sk-proj-" + "x".repeat(50);
  const backend = { getAgent: async () => ({ id: agent.agentId, name: "远端实施助手", model: "fixture" }),
    getAgentFile: async () => ({ content: soul, missing: false }) };
  const registry = { getBackend: () => backend };
  const state = { starts: [], errors: [] }, runs = new Map();
  let helper, f;
  const driver = {
    async prepare(input) { return { sessionKey: input.sessionKey ?? `agent:helper:${input.sessionId}`, workspace: input.workspace ?? workspace, mode: "gateway" }; },
    async start(input) {
      state.starts.push(input);
      runs.set(input.runId, { status: "completed", text: "远端成员的回答" });
      return { status: "running" };
    },
    async inspect(input) { const run = runs.get(input.runId); return run ? { status: run.status, resultSummary: run.text } : { status: "unknown" }; },
    fullResult(input) { return runs.get(input.runId)?.text ?? null; },
    async cancel() { return { status: "canceled" }; }, async respond() { return { status: "running" }; }, reset() {},
  };
  const host = new GroupRuntimeHost({ paths: { stateDir: path.join(root, "host"), trustedRoot: root }, registry, agent,
    ownerToken, runtimeToken, localWorkspace: workspace,
    runner: new ExternalInspirationRunner({ registry, adapters: { hermes: driver }, adapterOptions: { sessionPurpose: "group" } }) }).open();
  try {
    const address = await host.listen(), peer = { id: "remote-device", ...agent, hostId: host.hostId, token: ownerToken,
      baseUrl: `http://127.0.0.1:${address.port}/` };
    helper = createGroupRuntimeMcpHandler({ connection: { version: 1, ...agent, hostId: host.hostId, runtimeToken, baseUrl: peer.baseUrl } });
    assert.ok((await helper.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).result);
    f = await startInspirationFixture({ serviceOptions: { prewarmMcpAuth: false, groupChatExternalPollMs: 50,
 },
      groupRunner: registry => new GroupRuntimeRouter({ allowRemote: true, registry, localRunner: new ExternalInspirationRunner({ registry, adapterOptions: { sessionPurpose: "group" } }),
        getPeers: () => [peer], invokeTool: params => f.ipc("group.remote.tool", params) }),
      codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL: "1" } });
    const api = async (method, route, body) => {
      const response = await fetch(`${f.url}/__api/group-chats${route}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    const catalog = await api("GET", "/hosts"); assert.equal(catalog.status, 200); assert.equal(catalog.body.members[0].peerId, peer.id);
    assert.equal(catalog.body.members[0].groupTools, true);
    const proof = await api("POST", "/hosts/test", { peer }); assert.equal(proof.status, 200, JSON.stringify(proof.body)); assert.equal(proof.body.hostId, host.hostId);
    const wrongProof = await api("POST", "/hosts/test", { peer: { ...peer, hostId: crypto.randomUUID() } }); assert.notEqual(wrongProof.status, 200);
    const native = f.service.productStore.listAgentProfiles().find(profile => profile.enabled);
    const created = await api("POST", "", { operationId: "remote-group", name: "跨设备群", purpose: "验证宿主范围",
      members: [{ backendId: "shoggoth", agentId: native.agentId }, { ...agent, peerId: peer.id }] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { group, members } = created.body, remote = members.find(member => member.peerId);
    assert.equal(remote.peerId, peer.id); assert.equal(remote.card.groupTools, true);
    let cursor, source = "", role;
    do {
      const query = new URLSearchParams({ id: group.id, memberId: remote.id, ...(cursor ? { cursor } : {}) });
      role = await api("GET", `/members/role?${query}`); assert.equal(role.status, 200); assert.equal(role.body.ok, true);
      source += role.body.text; cursor = role.body.nextCursor;
    } while (cursor);
    assert.match(source, /依据公开输入完成工作/u); assert.ok(!source.includes("sk-proj-"));
    assert.equal(Buffer.byteLength(source), role.body.totalBytes); assert.equal(crypto.createHash("sha256").update(source).digest("hex"), role.body.exportDigest);
    await api("POST", `/messages?id=${group.id}`, { clientMessageId: "remote-turn", body: `@${remote.handle} 说说看`, mentions: [] });
    let messages = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      const detail = (await api("GET", `/detail?id=${group.id}`)).body;
      messages = (await api("GET", `/messages?id=${group.id}&limit=20`)).body.messages;
      if (!detail.round && !detail.activeTurns.length && messages.some(message => message.author.kind === "member")) break;
      if (state.errors.length) throw state.errors[0];
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.deepEqual(messages.filter(message => message.author.kind === "member").map(message => [message.author.memberId, message.body]),
      [[remote.id, "远端成员的回答"]]);
    assert.equal(state.starts.length, 1, "one turn, dispatched once through the paired host");
    assert.match(state.starts[0].prompt, /Current speaking queue:/u);
    assert.doesNotMatch(state.starts[0].prompt, /groupToken/u, "no group tool tokens are issued");
    console.log("PASS remote group REST: paired host identity, private relay MCP, scoped members and SOUL, one remote turn through the host with no duplicate dispatch");
  } finally { if (f) await f.close(); await host.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
