import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TranscriptStore, transcriptEventId } = require("../app/agent-service/transcript-store");
const { createChatServiceController } = require("../app/agent-service/chat-service-controller");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-background-chat-"));
fs.chmodSync(root, 0o700);
try {
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const profile = {
    id: "profile-1", backendId: "shoggoth", agentId: "shoggoth-profile-1", name: "Shoggoth",
    runtime: "codex", runtimeProfileId: "shoggoth-profile-1",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, providerRef: null,
    defaultModel: null, defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 0 }, isDefault: true, enabled: true,
    createdAt: 1, updatedAt: 1,
  };
  const session = {
    id: "33333333-3333-4333-8333-333333333333",
    sessionKey: "11111111-1111-4111-8111-111111111111",
    profileId: profile.id,
    runtimeSessionId: "runtime-session-1",
    codexThreadId: "runtime-session-1",
    workspace: null,
    title: null,
    modelOverride: null,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  };
  const transcriptStore = new TranscriptStore({ paths, now: () => 100 });
  transcriptStore.open();
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("user", "one"), runId: "run-1", kind: "user",
    content: { text: "question" }, runtimeRef: null, contextExcluded: false, occurredAt: 10,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("status", "turn-started"), runId: "run-1", kind: "status",
    content: { transcriptType: "status", method: "turn/started", status: "inProgress" },
    runtimeRef: null, contextExcluded: false, occurredAt: 11,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("reasoning", "empty"), runId: "run-1", kind: "status",
    content: { transcriptType: "reasoning", method: "item/started", reasoning: [] },
    runtimeRef: null, contextExcluded: false, occurredAt: 12,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("reasoning", "visible"), runId: "run-1", kind: "status",
    content: { transcriptType: "reasoning", method: "item/completed", reasoning: ["inspect"] },
    runtimeRef: null, contextExcluded: false, occurredAt: 13,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("plan", "visible"), runId: "run-1", kind: "status",
    content: {
      transcriptType: "plan", method: "turn/plan/updated",
      plan: [{ step: "Inspect repository", status: "completed" }, { step: "Apply fix", status: "inProgress" }],
    },
    runtimeRef: null, contextExcluded: false, occurredAt: 13,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("tool", "failed-start"), runId: "run-1", kind: "tool_call",
    content: {
      transcriptType: "tool.start", method: "item/started",
      tool: {
        kind: "mcpToolCall", name: "shoggoth/cron_run_now", status: "inProgress",
        displayArgs: { jobId: "job-1" },
      },
    },
    runtimeRef: null, contextExcluded: false, occurredAt: 14,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("tool", "failed-result"), runId: "run-1", kind: "tool_result",
    content: {
      transcriptType: "tool.result", method: "item/completed",
      tool: {
        kind: "mcpToolCall", name: "shoggoth/cron_run_now", status: "failed",
        resultSummary: "permission denied", durationMs: 250,
      },
    },
    runtimeRef: null, contextExcluded: false, occurredAt: 15,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("tool", "completed-start"), runId: "run-1", kind: "tool_call",
    content: {
      transcriptType: "tool.start", method: "item/started",
      tool: { kind: "mcpToolCall", name: "shoggoth/cron_list", status: "inProgress" },
    },
    runtimeRef: null, contextExcluded: false, occurredAt: 16,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("tool", "completed-result"), runId: "run-1", kind: "tool_result",
    content: {
      transcriptType: "tool.result", method: "item/completed",
      tool: { kind: "mcpToolCall", name: "shoggoth/cron_list", status: "completed" },
    },
    runtimeRef: null, contextExcluded: false, occurredAt: 17,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("assistant", "one"), runId: "run-1", kind: "assistant",
    content: { text: "durable answer", transcriptType: "text" },
    runtimeRef: {
      runtime: "codex", runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
      sessionId: "runtime-session-1", turnId: "runtime-turn-1",
    },
    contextExcluded: false,
    occurredAt: 20,
  });
  transcriptStore.appendEvent({
    profileId: profile.id, sessionId: session.id,
    id: transcriptEventId("error", "one"), runId: "run-1", kind: "error",
    content: {
      transcriptType: "terminal", status: "interrupted", errorCode: "CODEX_PROMPT_TIMEOUT",
    },
    runtimeRef: null, contextExcluded: false, occurredAt: 21,
  });
  const runtimeHome = path.join(paths.stateDir, "runtimes", "codex", profile.runtimeProfileId);
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeHome, "thread"), "cache", { mode: 0o600 });
  fs.rmSync(runtimeHome, { recursive: true, force: true });

  const chatSessionStore = {
    listSessions: () => [structuredClone(session)],
    getSession: (key) => key === session.sessionKey ? structuredClone(session) : null,
    createSession() { throw new Error("unexpected createSession"); },
    listPendingRemoteOperations: () => [],
  };
  const coordinator = {
    listRuns: () => [],
    getRun: () => null,
    send() { throw new Error("unexpected send"); },
    subscribeRun() { throw new Error("unexpected subscribe"); },
  };
  const controller = createChatServiceController({
    paths,
    productStore: {
      listAgentProfiles: () => [structuredClone(profile)],
      getAgentProfile: (id) => id === profile.id ? structuredClone(profile) : null,
    },
    chatSessionStore,
    transcriptStore,
    coordinator,
    runtimePool: { get() { throw new Error("Runtime home must not be read"); } },
    cursorSecret: Buffer.alloc(32, 7),
  });
  await controller.open();
  const history = await controller.handle("chat.history", {
    sessionKey: session.sessionKey,
    cursor: null,
    limit: 100,
  }, "response-1");
  assert.equal(history.hasMore, false);
  const messages = history.messages.map((item) => item.payload.message);
  assert.deepEqual(messages.map((message) => [message.role, message.content[0].type]), [
    ["user", "text"],
    ["assistant", "thinking"],
    ["assistant", "plan"],
    ["assistant", "toolCall"],
    ["toolResult", "toolResult"],
    ["assistant", "toolCall"],
    ["toolResult", "toolResult"],
    ["assistant", "text"],
    ["system", "text"],
  ]);
  assert.equal(messages[1].content[0].thinking, "inspect");
  assert.deepEqual(messages[2].content[0].planEntries, [
    { content: "Inspect repository", status: "completed" },
    { content: "Apply fix", status: "in_progress" },
  ]);
  assert.equal(messages[3].content[0].toolName, "shoggoth/cron_run_now");
  assert.deepEqual(messages[3].content[0].arguments, { jobId: "job-1" });
  assert.equal(messages[4].content[0].content, "permission denied");
  assert.equal(messages[4].content[0].durationS, 0.25);
  assert.equal(messages[4].content[0].is_error, true);
  assert.equal(messages[5].content[0].toolName, "shoggoth/cron_list");
  assert.equal(messages[6].content[0].is_error, false);
  assert.equal(messages[7].content[0].text, "durable answer");
  assert.equal(messages[8].content[0].text, "CODEX_PROMPT_TIMEOUT");
  assert.equal(messages.some((message) => (
    message.content.some((part) => typeof part.text === "string" && part.text.startsWith("{"))
  )), false, "结构化 Transcript 事件不得降级成 JSON 错误文本");
  const pagedIds = [];
  let cursor = null;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const page = await controller.handle("chat.history", {
      sessionKey: session.sessionKey,
      cursor,
      limit: 3,
    }, `response-page-${pageIndex}`);
    pagedIds.unshift(...page.messages.map((item) => item.id));
    if (!page.hasMore) break;
    assert.notEqual(page.nextCursor, null);
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
  }
  assert.deepEqual(pagedIds, history.messages.map((item) => item.id),
    "过滤生命周期事件后分页不得丢失或重复可见消息");
  await controller.close();
  transcriptStore.close();
  console.log("ok - UI/Runtime 退出且 Codex home 删除后，chat.history 仍由 Shoggoth Transcript 返回");
  console.log("1 background chat regression passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
