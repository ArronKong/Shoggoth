"use strict";

// Deterministic Runtime transport for Inspiration's real Coordinator/Service tests.
class InspirationRuntime {
  constructor() {
    this.threads = [];
    this.listeners = new Set();
    this.handlers = new Map();
    this.turnStarts = 0;
    this.interrupts = 0;
    this.terminated = new Promise((resolve) => { this.terminate = resolve; });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  registerServerRequestHandler(method, handler) {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }
  emit(event) { for (const listener of this.listeners) listener(structuredClone(event)); }
  request(method, params) {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Missing Runtime handler: ${method}`);
    return handler(structuredClone(params), { method, id: 1 });
  }
  async accountRead() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; }
  async threadList(params) {
    return { data: structuredClone(this.threads.filter((thread) => thread.archived === params.archived)), nextCursor: null };
  }
  async threadStart(params) {
    const thread = { id: `inspiration-session-${this.threads.length + 1}`,
      threadSource: params.threadSource, archived: false, turns: [] };
    this.threads.push(thread);
    return { thread: structuredClone(thread) };
  }
  async threadRead(params) {
    const thread = this.threads.find((item) => item.id === params.threadId);
    if (!thread) throw Object.assign(new Error("Unknown Runtime session"), { code: "THREAD_NOT_FOUND" });
    return { thread: structuredClone(thread) };
  }
  threadResume(params) { return this.threadRead(params); }
  async threadInjectItems(params) {
    await this.threadRead(params);
    this.lastInjectedItems = structuredClone(params);
    return {};
  }
  async turnStart(params) {
    const thread = this.threads.find((item) => item.id === params.threadId);
    const turn = { id: `inspiration-turn-${++this.turnStarts}`, status: "inProgress", itemsView: "full",
      items: [{ type: "userMessage", id: `user-${this.turnStarts}`, clientId: params.clientUserMessageId }] };
    thread.turns.push(turn);
    return { turn: structuredClone(turn) };
  }
  async turnInterrupt() { this.interrupts += 1; return {}; }
  complete(run, text = "已整理出第一版方案。") {
    const thread = this.threads.find((item) => item.id === run.runtimeSessionRef?.sessionId);
    const turn = thread.turns.find((item) => item.id === run.runtimeTurnRef?.turnId);
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", phase: "final_answer", delivery: "sync", text });
    this.emit({ known: true, type: "text", method: "item/completed", threadId: thread.id,
      turnId: turn.id, itemId: `result-${turn.id}`, text });
    this.emit({ known: true, type: "complete", method: "turn/completed", threadId: thread.id,
      turnId: turn.id, status: "completed" });
  }
  ask(run, question = "主要给谁使用？") {
    return this.request("mcpServer/elicitation/request", { threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId, serverName: "inspiration-fixture", message: question,
      requestedSchema: { type: "object", properties: {
        audience: { type: "string", title: "使用对象", enum: ["family", "friends"],
          oneOf: [{ const: "family", title: "家人", description: "日常一起使用" },
            { const: "friends", title: "朋友", description: "分享给朋友" }] },
      }, required: ["audience"] } });
  }
  approve(run) {
    return this.request("item/commandExecution/requestApproval", { threadId: run.runtimeSessionRef?.sessionId,
      turnId: run.runtimeTurnRef?.turnId, itemId: "approval-command", command: "mkdir -p coffee-notes",
      cwd: run.workspace, reason: "创建咖啡记录目录" });
  }
}

module.exports = { InspirationRuntime };
