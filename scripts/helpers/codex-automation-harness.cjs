"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { JsonlProductStore } = require("../../app/agent-service/product-store");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { ensureBuiltinCliAgentProfiles } = require("../../app/agent-service/builtin-cli-profiles");
const { createWorkDispatcher } = require("../../app/agent-service/work-run");
const { WorkRunCoordinator } = require("../../app/agent-service/work-run-coordinator");
const { RunExecutionStore } = require("../../app/agent-service/run-execution-store");
const { CodexRuntimePool } = require("../../app/agent-service/codex-runtime-pool");
const { CodexRuntimeAdapter } = require("../../app/agent-service/codex-runtime-adapter");
const { CodexAutomationController } = require("../../app/agent-service/codex-automation-controller");
const { captureExecutionProviderRoute, assertExecutionProviderRouteCurrent } = require("../../app/agent-service/execution-provider-route");
const { OWNER, ACCOUNT_ID } = require("../../app/agent-service/codex-automation-store");
const { validateParams, validateResult } = require("../../app/agent-service/codex-automation-protocol");

class AutomationHost {
  constructor() { this.threads = []; this.subscribers = new Set(); this.handlers = new Map(); this.turnStarts = 0; this.terminated = new Promise(resolve => { this.terminate = resolve; }); }
  async initialize() { return {}; }
  async stop() { this.terminate(); }
  subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  registerServerRequestHandler(name, fn) { this.handlers.set(name, fn); return () => this.handlers.delete(name); }
  request(name, params) { return this.handlers.get(name)(structuredClone(params), { method: name, id: 1 }); }
  async accountRead() { return { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true }; }
  async modelList() { return { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture model", isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }], nextCursor: null }; }
  async threadList({ archived = false }) { return { data: this.threads.filter(t => !!t.archived === archived).map(t => structuredClone(t)), nextCursor: null }; }
  async threadStart(params) {
    this.startParams = structuredClone(params);
    const thread = { id: crypto.randomUUID(), threadSource: params.threadSource, archived: false, turns: [] };
    this.threads.push(thread); return { thread: structuredClone(thread) };
  }
  async threadRead({ threadId }) {
    const thread = this.threads.find(t => t.id === threadId); if (!thread) throw new Error("missing fixture thread");
    return { thread: structuredClone(thread) };
  }
  async threadResume(params) { return this.threadRead(params); }
  async threadInjectItems() { return {}; }
  async turnStart(params) {
    this.turnStarts++; this.turnParams = structuredClone(params);
    const turn = { id: crypto.randomUUID(), status: "inProgress", itemsView: "full", items: [{ type: "userMessage", id: crypto.randomUUID(), clientId: params.clientUserMessageId }] };
    this.threads.find(t => t.id === params.threadId).turns.push(turn); return { turn: structuredClone(turn) };
  }
  finish(turnId, text = "AUTOMATION_RESULT", status = "completed") {
    const thread = this.threads.find(t => t.turns.some(turn => turn.id === turnId));
    const turn = thread.turns.find(t => t.id === turnId); turn.status = status;
    if (text) turn.items.push({ type: "agentMessage", id: crypto.randomUUID(), phase: "final_answer", delivery: "sync", text });
    for (const fn of this.subscribers) fn({ known: true, type: "complete", method: "turn/completed", threadId: thread.id, turnId, status });
  }
  async turnInterrupt({ turnId }) { this.finish(turnId, null, "interrupted"); return {}; }
}
async function waitUntil(predicate, label, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`${label} timed out`);
}
function mockHome(root) {
  const home = path.join(root, "home"); fs.mkdirSync(path.join(home, "sqlite"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, "sqlite", "codex-dev.db"));
  db.exec(`CREATE TABLE automations(id TEXT PRIMARY KEY,status TEXT,account_id TEXT,user_id TEXT,installation_id TEXT,last_run_at INTEGER,next_run_at INTEGER,updated_at INTEGER);
    CREATE TABLE automation_runs(thread_id TEXT PRIMARY KEY,automation_id TEXT,status TEXT,thread_title TEXT,source_cwd TEXT,inbox_title TEXT,inbox_summary TEXT,created_at INTEGER,updated_at INTEGER,archived_assistant_message TEXT,archived_reason TEXT);`);
  db.close(); return home;
}
async function createHarness({ live = false, home: suppliedHome } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-auto-")));
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: root, cacheRoot: path.join(root, "cache") });
  const productStore = new JsonlProductStore({ paths }); productStore.open();
  ensureBuiltinCliAgentProfiles(productStore, new Set([ACCOUNT_ID]), { isSeeded: () => false, markSeeded() {} });
  productStore.putAgentProfile({ ...productStore.getAgentProfile(OWNER.id), name: "Renamed owner",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" } });
  const home = suppliedHome || (live ? path.join(os.homedir(), ".codex") : mockHome(root));
  const host = live ? null : new AutomationHost();
  const pool = live ? new CodexRuntimePool({ paths, hostOptions: { repoRoot: path.resolve(__dirname, "../.."), packageVersion: "automation-live-proof" },
    runtimeAccountLookup: id => productStore.getRuntimeAccount(id) }) : { get: async () => host, stopAll: async () => {} };
  const { CodexAutomationWorkRunStore, createAutomationWorkRunStore } = require("../../app/agent-service/codex-automation-work-run-store");
  const automationStore = new CodexAutomationWorkRunStore({ productStore, paths }); automationStore.open();
  const dispatcher = createWorkDispatcher({ store: createAutomationWorkRunStore({ productStore, automationStore }) });
  const key = crypto.randomBytes(32);
  const cryptoBroker = {
    async encrypt(input) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(input), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    async decrypt(input) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12));
      cipher.setAuthTag(input.subarray(12, 28)); return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]); },
  };
  const executionStore = new RunExecutionStore({ paths, cryptoBroker });
  const unexpected = () => { throw new Error("Automation must not enter chat binding or PendingCommandInbox"); };
  const inbox = { isLocked: () => false, list: () => [], get: () => null, enqueue: unexpected, transition: unexpected };
  const chatSessionStore = { getSession: () => null, listPendingBindings: () => [], requestBinding: unexpected, completeBinding: unexpected, recoverBinding: unexpected };
  const makeCoordinator = () => new WorkRunCoordinator({ paths, productStore, dispatcher, runtimePool: pool, inbox, chatSessionStore,
    runExecutionStore: executionStore, recoverOrphanedDomainRuns: true,
    captureExecutionProviderRoute: (profile, modelRef) => captureExecutionProviderRoute({ productStore, profile, modelRef }),
    assertExecutionProviderRouteCurrent: contract => assertExecutionProviderRouteCurrent(contract, { productStore }), assertSecretSafe: () => true, sanitizeSummary: value => value, terminalRetryDelaysMs: [] });
  let coordinator = makeCoordinator(); await coordinator.open();
  const adapter = new CodexRuntimeAdapter({ runtimePool: pool });
  const controller = new CodexAutomationController({ productStore, dispatcher, coordinator, paths, adapter, home });
  const call = async (name, params) => { const method = `codex.automation.${name}`;
    return validateResult(method, await controller.handle(method, validateParams(method, params))); };
  return { root, paths, home, host, pool, adapter, dispatcher, productStore, automationStore, controller, call,
    get coordinator() { return coordinator; },
    async rebuild() { await coordinator.close(); automationStore.close(); automationStore.open(); coordinator = makeCoordinator(); controller.coordinator = coordinator; await coordinator.open(); },
    async close() { await coordinator.close(); await pool.stopAll(); automationStore.close(); productStore.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
module.exports = { AutomationHost, mockHome, createHarness, waitUntil };
