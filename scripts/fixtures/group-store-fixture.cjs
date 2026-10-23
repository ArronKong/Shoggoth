"use strict";
// 真实群库 + 群 Service 的最小夹具：成员回合的执行器是脚本化的，可选接上生产驱动。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../../app/agent-service/group-chat-store");
const { GroupChatService } = require("../../app/agent-service/group-chat-service");

function createFixture(t, { limits = {}, members = 3, productionDriver = false, realtime = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-store-"))); fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let clock = 1000, counter = 0, store = null, driver = null;
  // Register cleanup before database/lease allocation so failed setup cannot
  // leave a private directory for every subsequent test case.
  t.after(() => { driver?.stop?.(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = () => new GroupChatStore({ paths, limits, now: () => realtime ? Date.now() : ++clock }).open();
  store = open();
  let fence = store.advanceDriverFence();
  const { groupId } = store.createGroup({ operationId: "create", name: "群聊验收", purpose: "",
    members: Array.from({ length: members }, (_, index) => ({ backendId: "shoggoth", agentId: `agent-${index}`,
      profileId: `profile-${index}`, displayName: `M${index}` })) });
  const roster = store.getGroup(groupId).members;
  store.applyMemberCards({ groupId, updates: roster.map(member => ({ memberId: member.id,
    card: { availability: "online", runtime: "controlled-runtime", groupTools: true } })) });
  const runs = new Map(), sessions = new Map(), started = [], errors = [];
  const executor = {
    async ensureSession(binding) { const key = `session-${binding.memberId}`; sessions.set(key, binding.profileId); return key; },
    async start({ sessionKey, operationId, prompt }) {
      const run = { id: `native-${++counter}`, profileId: sessions.get(sessionKey), source: "chat", sourceId: sessionKey,
        idempotencyKey: `shoggoth:chat-send:${operationId}`, status: "running", text: null };
      runs.set(run.id, run); started.push({ run, prompt }); return run;
    },
    findRun() { return null; }, getRun: id => runs.get(id) ?? null, async abort() {}, finalText: run => run.text,
  };
  driver = productionDriver ? new (require("../../app/agent-service/group-chat-driver").GroupChatDriver)({ store, executor,
    setTimer: () => ({}), clearTimer() {}, onError: error => errors.push(error) })
    : { get fence() { return fence; }, wake() {}, async abortAll() {}, draftFor() { return null; } };
  const service = new GroupChatService({ get store() { return store; }, driver,
    productStore: { listAgentProfiles: () => [] } });
  const settle = async () => { for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve)); };
  return { root, paths, groupId, roster, service, driver, executor, runs, started, errors, settle,
    get store() { return store; }, get fence() { return fence; },
    view: () => store.getGroup(groupId),
    send: (body = "研究、核对并给出答案", extra = {}) => store.appendUserMessage({ groupId, clientMessageId: `u-${++counter}`,
      body, mentionMemberIds: [], ...extra }),
    messages: () => store.listMessages({ groupId, afterSeq: null, beforeSeq: null, limit: 200 }).messages,
    advance(ms) { clock += ms; },
    async startDriver() { await driver.start(); fence = driver.fence; },
    async finishRun(run, status = "completed", text = null, errorCode = null) {
      Object.assign(run, { status, text, errorCode }); driver.onRunTerminal(run); await settle();
    },
    reopen() { store.close(); store = open(); service.store = store; fence = store.getDriverFence(); },
  };
}
module.exports = { createFixture };
