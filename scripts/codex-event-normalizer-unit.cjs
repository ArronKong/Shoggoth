#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  accountRateLimitRetryAt,
  normalizeCodexEvent,
} = require("../app/agent-service/codex-event-normalizer");

const ids = { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" };

function assertBase(event, type) {
  assert.equal(event.known, true);
  assert.equal(event.type, type);
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.turnId, "turn-1");
}

function testTextReasoningAndPlan() {
  const text = normalizeCodexEvent({
    method: "item/agentMessage/delta",
    params: { ...ids, delta: "hello" },
  });
  assertBase(text, "text_delta");
  assert.equal(text.itemId, "item-1");
  assert.equal(text.delta, "hello");

  for (const method of ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta"]) {
    const reasoning = normalizeCodexEvent({ method, params: { ...ids, delta: "thought" } });
    assertBase(reasoning, "reasoning_delta");
    assert.equal(reasoning.delta, "thought");
  }

  const plan = normalizeCodexEvent({
    method: "turn/plan/updated",
    params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "inspect", status: "inProgress" }] },
  });
  assertBase(plan, "plan");
  assert.deepEqual(plan.plan, [{ step: "inspect", status: "inProgress" }]);
}

function testToolLifecycleAcrossKinds() {
  const tools = [
    { type: "commandExecution", command: "printf ok", aggregatedOutput: "ok" },
    { type: "fileChange", changes: [{ path: "a.txt", kind: "update" }] },
    { type: "mcpToolCall", server: "files", tool: "read", arguments: { path: "a" }, result: { ok: true } },
    { type: "dynamicToolCall", namespace: "plugin", tool: "run", arguments: { value: 1 }, contentItems: [] },
    { type: "webSearch", query: "codex", results: [] },
  ];
  for (const item of tools) {
    const started = normalizeCodexEvent({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: `${item.type}-1`, status: "inProgress", ...item } },
    });
    assertBase(started, "tool_start");
    assert.equal(started.toolCallId, `${item.type}-1`);
    assert.equal(started.tool.kind, item.type);
    if (item.type === "webSearch") assert.equal(started.tool.input, "codex");

    const completed = normalizeCodexEvent({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: `${item.type}-1`, status: "completed", ...item } },
    });
    assertBase(completed, "tool_result");
    assert.equal(completed.toolCallId, `${item.type}-1`);
    assert.equal(completed.tool.kind, item.type);
    if (item.type === "webSearch") assert.deepEqual(completed.tool.output, []);
  }

  const update = normalizeCodexEvent({
    method: "item/commandExecution/outputDelta",
    params: { ...ids, delta: "partial" },
  });
  assertBase(update, "tool_update");
  assert.equal(update.toolCallId, "item-1");
  assert.equal(update.delta, "partial");
}

function testCompletedMessagePhasesSealOnlyFinishedItems() {
  for (const phase of ["commentary", "final_answer"]) {
    const params = { ...ids, item: { type: "agentMessage", id: "item-1", text: "hello", phase } };
    const completed = normalizeCodexEvent({ method: "item/completed", params });
    assertBase(completed, "text");
    assert.equal(completed.text, "hello");
    assert.equal(completed.phase, phase, "completed Codex message boundaries must reach the live chat bridge");
    const started = normalizeCodexEvent({ method: "item/started", params });
    assert.equal(started.phase, undefined, "an initial snapshot must not seal a still streaming item");
  }
  for (const phase of [undefined, null, "future-phase"]) {
    const message = normalizeCodexEvent({ method: "item/completed", params: {
      ...ids, item: { type: "agentMessage", id: "item-1", text: "legacy answer", phase },
    } });
    assert.equal(message.text, "legacy answer");
    assert.equal(message.phase, undefined, "legacy and unknown phases retain the existing text fallback");
  }
}

function testStatusApprovalPromptCompleteAndError() {
  const started = normalizeCodexEvent({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
  });
  assertBase(started, "status");
  assert.equal(started.status, "inProgress");

  const approval = normalizeCodexEvent({
    id: "request-1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "rm no" },
  });
  assertBase(approval, "approval");
  assert.equal(approval.requestId, "request-1");
  assert.equal(approval.toolCallId, "item-1");

  for (const method of ["item/tool/requestUserInput", "mcpServer/elicitation/request"]) {
    const prompt = normalizeCodexEvent({
      id: 55,
      method,
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", questions: [] },
    });
    assertBase(prompt, "prompt");
    assert.equal(prompt.requestId, 55);
  }

  const completed = normalizeCodexEvent({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assertBase(completed, "complete");
  assert.equal(completed.status, "completed");

  const failed = normalizeCodexEvent({
    method: "error",
    params: { ...ids, error: { code: "MODEL_FAILED", message: "Bearer secret-value-should-not-leak" } },
  });
  assertBase(failed, "error");
  assert.equal(failed.errorCode, "MODEL_FAILED");
  assert.equal(JSON.stringify(failed).includes("secret-value-should-not-leak"), false);
}

function testUnknownIsBoundedAndSecretFree() {
  const secret = "registered-secret-value";
  const unknown = normalizeCodexEvent({
    id: "request-unknown",
    method: `future/${secret}`,
    params: {
      ...ids,
      toolCallId: "tool-1",
      token: secret,
      payload: "x".repeat(100_000),
    },
  }, { registeredSecrets: [secret], maxDiagnosticBytes: 256 });
  assert.deepEqual({
    known: unknown.known,
    type: unknown.type,
    method: unknown.method,
    threadId: unknown.threadId,
    turnId: unknown.turnId,
    itemId: unknown.itemId,
    toolCallId: unknown.toolCallId,
    requestId: unknown.requestId,
  }, {
    known: false,
    type: "diagnostic",
    method: "future/[REDACTED]",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    toolCallId: "tool-1",
    requestId: "request-unknown",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(unknown)) <= 256);
  assert.equal(JSON.stringify(unknown).includes(secret), false);
  assert.equal(Object.hasOwn(unknown, "params"), false);

  const multibyte = normalizeCodexEvent({
    method: `future/${"密".repeat(1_000)}`,
    params: ids,
  }, { maxDiagnosticBytes: 128 });
  assert.ok(Buffer.byteLength(JSON.stringify(multibyte)) <= 128);
}

function testKnownEventsUseBoundedJsonSafeSecretFreeSnapshots() {
  const secret = "registered-known-event-secret";
  const circular = {
    argument: `prefix-${secret}-suffix`,
    output: "x".repeat(2 * 1024 * 1024),
    values: Array.from({ length: 10_000 }, (_, index) => ({ index, secret })),
  };
  circular.self = circular;
  const events = [
    normalizeCodexEvent({
      method: "item/completed",
      params: {
        ...ids,
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          status: "completed",
          server: "fixture",
          tool: "run",
          arguments: circular,
          result: circular,
          error: { message: secret },
        },
      },
    }, { registeredSecrets: [secret] }),
    normalizeCodexEvent({
      id: "approval-bounded",
      method: "item/commandExecution/requestApproval",
      params: {
        ...ids,
        command: `printf ${secret}`,
        commandActions: [circular],
        cwd: `/tmp/${secret}`,
        reason: secret,
      },
    }, { registeredSecrets: [secret] }),
    normalizeCodexEvent({
      method: "item/commandExecution/outputDelta",
      params: { ...ids, delta: `${secret}${"y".repeat(2 * 1024 * 1024)}`, progress: circular },
    }, { registeredSecrets: [secret] }),
  ];
  for (const event of events) {
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(secret), false);
    assert.ok(Buffer.byteLength(serialized) <= 64 * 1024, "known event snapshot must stay byte bounded");
  }
  assert.equal(events[1].type, "approval");
  assert.match(events[1].command, /\[REDACTED\]/);
}

function testPromptEventsRetainSafeUiFields() {
  const secret = "registered-prompt-secret";
  const input = normalizeCodexEvent({
    id: 55,
    method: "item/tool/requestUserInput",
    params: {
      ...ids,
      isBlocking: true,
      questions: [{
        id: "choice",
        header: "Choose",
        question: `Use ${secret}?`,
        options: [{ label: "Yes", description: secret }],
      }],
    },
  }, { registeredSecrets: [secret] });
  assert.equal(input.type, "prompt");
  assert.equal(input.isBlocking, true);
  assert.equal(input.questions[0].id, "choice");
  assert.equal(JSON.stringify(input).includes(secret), false);

  const elicitation = normalizeCodexEvent({
    id: "elicit-1",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "fixture",
      mode: "form",
      message: `Provide ${secret}`,
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string", description: secret } },
      },
    },
  }, { registeredSecrets: [secret] });
  assert.equal(elicitation.type, "prompt");
  assert.equal(elicitation.serverName, "fixture");
  assert.equal(elicitation.mode, "form");
  assert.equal(elicitation.requestedSchema.type, "object");
  assert.equal(JSON.stringify(elicitation).includes(secret), false);
}

function testKnownEventFinalJsonBytesAreHardBoundedAfterEscaping() {
  const controls = "\0\u0001\n\r\t".repeat(30_000);
  const approval = normalizeCodexEvent({
    id: "approval-controls",
    method: "item/commandExecution/requestApproval",
    params: { ...ids, command: controls, cwd: controls, reason: controls, grantRoot: controls },
  });
  const approvalJson = JSON.stringify(approval);
  assert.ok(Buffer.byteLength(approvalJson) <= 64 * 1024);
  assert.equal(approval.type, "approval");
  assert.equal(typeof approval.command, "string");

  const prompt = normalizeCodexEvent({
    id: "prompt-controls",
    method: "item/tool/requestUserInput",
    params: {
      ...ids,
      isBlocking: true,
      questions: [{
        id: "safe-id",
        header: controls,
        question: controls,
        options: [{ label: controls, description: controls }],
      }],
    },
  });
  const promptJson = JSON.stringify(prompt);
  assert.ok(Buffer.byteLength(promptJson) <= 64 * 1024);
  assert.equal(prompt.questions[0].id, "safe-id");
  assert.equal(prompt.isBlocking, true);
  assert.deepEqual(JSON.parse(promptJson), prompt, "hard bound must not corrupt JSON or UTF-8");
}

function testExplicitShortRegisteredSecretsAreAlwaysRedacted() {
  const secret = "abcd";
  const known = normalizeCodexEvent({
    id: `approval-${secret}`,
    method: "item/commandExecution/requestApproval",
    params: { ...ids, command: `prefix-${secret}-suffix`, reason: secret },
  }, { registeredSecrets: [secret] });
  const unknown = normalizeCodexEvent({
    method: `future/${secret}`,
    params: { ...ids, value: secret },
  }, { registeredSecrets: [secret] });
  assert.equal(JSON.stringify(known).includes(secret), false);
  assert.equal(JSON.stringify(unknown).includes(secret), false);
  assert.match(known.command, /\[REDACTED\]/u);
  assert.equal(unknown.method, "future/[REDACTED]");

  assert.throws(
    () => normalizeCodexEvent({ method: "thread/started", params: ids }, { registeredSecrets: ["abc"] }),
    (error) => error?.code === "RPC_REGISTERED_SECRET_INVALID",
  );

  const collidingSecrets = ["REDACTED", "FILTERED", "abcd"];
  const collision = normalizeCodexEvent({
    id: "collision",
    method: "item/commandExecution/requestApproval",
    params: { ...ids, command: "[REDACTED]-[FILTERED]-abcd" },
  }, { registeredSecrets: collidingSecrets });
  const collisionJson = JSON.stringify(collision);
  for (const registered of collidingSecrets) assert.equal(collisionJson.includes(registered), false);

  const structuralCollision = normalizeCodexEvent({
    method: "thread/started",
    params: ids,
  }, { registeredSecrets: ["true"] });
  assert.deepEqual(structuralCollision, {}, "final JSON scan must use a secret-free minimal fallback");
}

function testConfiguredSnapshotLimitCountsTheEntireFinalJson() {
  const limitedPlan = normalizeCodexEvent({
    method: "turn/plan/updated",
    params: { ...ids, plan: Array.from({ length: 128 }, (_, index) => Number.MAX_VALUE - index) },
  }, { maxSnapshotBytes: 1_024 });
  const planJson = JSON.stringify(limitedPlan);
  assert.ok(Buffer.byteLength(planJson) <= 1_024);
  assert.deepEqual(JSON.parse(planJson), limitedPlan);

  const numericObject = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`numeric-field-${index}`, index]),
  );
  const limitedError = normalizeCodexEvent({
    method: "error",
    params: { ...ids, error: { code: "LIMITED", ...numericObject } },
  }, { maxSnapshotBytes: 1_024 });
  assert.ok(Buffer.byteLength(JSON.stringify(limitedError)) <= 1_024);

  const prompt = normalizeCodexEvent({
    id: "prompt-minimum-identity",
    method: "item/tool/requestUserInput",
    params: {
      ...ids,
      isBlocking: true,
      questions: [{
        id: "identity",
        header: "Header",
        question: "Question",
        options: Array.from({ length: 128 }, (_, index) => ({
          label: `label-${index}`,
          description: `description-${index}`,
        })),
      }],
    },
  }, { maxSnapshotBytes: 1_024 });
  assert.ok(Buffer.byteLength(JSON.stringify(prompt)) <= 1_024);
  assert.equal(prompt.type, "prompt");
  assert.equal(prompt.method, "item/tool/requestUserInput");
  assert.equal(prompt.requestId, "prompt-minimum-identity");
  assert.equal(prompt.questions[0].id, "identity");

  assert.throws(
    () => normalizeCodexEvent({ method: "thread/started", params: ids }, { maxSnapshotBytes: 128 }),
    (error) => error?.code === "CODEX_EVENT_SNAPSHOT_LIMIT_INVALID",
  );
}

function testAccountNotificationsAreStableBoundedSummaries() {
  const secret = "raw-account-error-secret";
  const failed = normalizeCodexEvent({
    method: "account/login/completed",
    params: {
      loginId: "login-1",
      success: false,
      error: `remote failure ${secret}`,
      onboardingEntrypoint: null,
      futureRawField: secret,
    },
  }, { registeredSecrets: [secret] });
  assert.deepEqual(failed, {
    known: true,
    type: "account_login",
    method: "account/login/completed",
    loginIdDisplay: "login-1",
    status: "failed",
    errorCode: "ACCOUNT_LOGIN_FAILED",
  });
  assert.equal(JSON.stringify(failed).includes(secret), false);

  const unicode = normalizeCodexEvent({
    method: "account/login/completed",
    params: { loginId: "😀".repeat(30), success: true },
  });
  assert.equal(Buffer.byteLength(unicode.loginIdDisplay, "utf8") <= 96, true);
  assert.equal(unicode.loginIdDisplay.isWellFormed(), true);

  const updated = normalizeCodexEvent({
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "plus", futureRawField: secret },
  }, { registeredSecrets: [secret] });
  assert.deepEqual(updated, {
    known: true,
    type: "account_updated",
    method: "account/updated",
    authMode: "chatgpt",
    planType: "plus",
  });
  assert.equal(JSON.stringify(updated).includes(secret), false);
}

function testStructuredAccountRateLimitBackoff() {
  const now = Date.now();
  const primaryResetSeconds = Math.ceil((now + 60_000) / 1_000);
  const secondaryResetSeconds = Math.ceil((now + 120_000) / 1_000);
  const exhausted = normalizeCodexEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, resetsAt: primaryResetSeconds },
        secondary: { usedPercent: 101, resetsAt: secondaryResetSeconds },
        spendControlReached: false,
        individualLimit: null,
      },
      error: "Retry-After: 999999999",
    },
  });
  assert.deepEqual(exhausted, {
    known: true,
    type: "account_unavailable",
    method: "account/rateLimits/updated",
    retryAt: secondaryResetSeconds * 1_000,
    errorCode: "RUNTIME_QUOTA_EXHAUSTED",
  });

  const sparse = accountRateLimitRetryAt({
    rateLimitReachedType: "workspace_member_usage_limit_reached",
    primary: { usedPercent: 42, resetsAt: primaryResetSeconds },
    secondary: { usedPercent: 73, resetsAt: secondaryResetSeconds },
  }, now);
  assert.equal(sparse, primaryResetSeconds * 1_000);

  const harmless = normalizeCodexEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        rateLimitReachedType: null,
        primary: { usedPercent: 99.9, resetsAt: primaryResetSeconds },
        secondary: null,
      },
      retryAt: secondaryResetSeconds * 1_000,
      message: "rate limit reached",
    },
  });
  assert.deepEqual(harmless, {
    known: true,
    type: "account_rate_limits",
    method: "account/rateLimits/updated",
  });
  assert.equal(accountRateLimitRetryAt({
    rateLimitReachedType: "rate_limit_reached",
    primary: { usedPercent: 100, resetsAt: Math.floor(now / 1_000) - 1 },
  }, now), null);
  assert.equal(accountRateLimitRetryAt({
    rateLimitReachedType: "forged",
    primary: { usedPercent: 1, resetsAt: primaryResetSeconds },
    retryAt: secondaryResetSeconds * 1_000,
  }, now), null);
}

function testExhaustedPlanWithCreditsRemainsAvailable() {
  const now = Date.now();
  const resetsAt = Math.ceil((now + 4 * 24 * 60 * 60 * 1000) / 1000);
  const snapshot = {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: "1000" },
    spendControlReached: false,
    individualLimit: null,
    rateLimitReachedType: null,
  };
  const event = (rateLimits) => normalizeCodexEvent({
    method: "account/rateLimits/updated", params: { rateLimits },
  });
  for (const credits of [snapshot.credits, { hasCredits: true, unlimited: false, balance: null },
    { hasCredits: false, unlimited: true, balance: null }]) {
    const value = { ...snapshot, credits };
    assert.equal(accountRateLimitRetryAt(value, now), null, "available credits must bypass exhausted plan windows");
    assert.deepEqual(event(value), {
      known: true, type: "account_available", method: "account/rateLimits/updated",
    });
  }
  for (const credits of [null, undefined, [], {},
    { hasCredits: "true", unlimited: "true", balance: "1000" }]) {
    assert.equal(accountRateLimitRetryAt({ ...snapshot, credits }, now), null,
      "unknown credit state cannot prove that plan exhaustion blocks usage");
    assert.equal(event({ ...snapshot, credits }).type, "account_rate_limits");
  }
  assert.equal(accountRateLimitRetryAt({ ...snapshot,
    credits: { hasCredits: false, unlimited: false, balance: "0" } }, now), resetsAt * 1000);
  for (const rateLimitReachedType of ["rate_limit_reached", "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]) {
    assert.equal(event({ ...snapshot, rateLimitReachedType }).type, "account_unavailable",
      "an explicit backend restriction takes precedence over credits");
  }
  const spendReset = Math.ceil((now + 60_000) / 1000);
  assert.equal(accountRateLimitRetryAt({ ...snapshot, spendControlReached: true,
    individualLimit: { resetsAt: spendReset } }, now), spendReset * 1000,
  "credits do not bypass spend control or make it wait for an unrelated plan reset");
  for (const spendControlReached of [null, undefined]) {
    assert.equal(event({ ...snapshot, spendControlReached }).type, "account_rate_limits",
      "sparse spend-control metadata cannot clear an existing cooldown");
  }
  assert.equal(event({ ...snapshot, rateLimitReachedType: undefined }).type, "account_rate_limits");
  assert.equal(event({ ...snapshot, credits: null,
    primary: { usedPercent: 0, resetsAt }, secondary: null }).type, "account_available",
  "a complete reset snapshot can recover quota backoff without spending credits");
  assert.equal(event({ ...snapshot, credits: null,
    primary: { usedPercent: 0, resetsAt }, secondary: undefined }).type, "account_rate_limits");
  assert.deepEqual(event({ credits: { hasCredits: false, unlimited: false },
    primary: { usedPercent: 100, resetsAt: null } }), {
    known: true, type: "account_unavailable", method: "account/rateLimits/updated",
    retryAt: null, errorCode: "RUNTIME_QUOTA_EXHAUSTED",
  }, "a missing reset must not hide confirmed quota exhaustion");
  assert.equal(event({ spendControlReached: true, individualLimit: null }).errorCode,
    "RUNTIME_SPENDING_LIMIT_REACHED");
  assert.equal(event({ rateLimitReachedType: "workspace_owner_credits_depleted" }).errorCode,
    "RUNTIME_QUOTA_EXHAUSTED");
  assert.equal(event({ rateLimitReachedType: "rate_limit_reached",
    primary: { usedPercent: 20, resetsAt } }).type, "account_backoff",
  "a generic transient limit without quota exhaustion still queues");
  assert.equal(event({ credits: { hasCredits: false, unlimited: false },
    primary: { usedPercent: 100, resetsAt: Math.floor(now / 1000) - 1 } }).type, "account_rate_limits",
  "an already expired usage window cannot reject new work");
}

function testPublicThreadUsageIsExactStableAndSecretFree() {
  const first = normalizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 1_500,
          inputTokens: 1_000,
          cachedInputTokens: 400,
          cacheWriteInputTokens: 100,
          outputTokens: 500,
          reasoningOutputTokens: 200,
        },
        last: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 10,
          outputTokens: 50,
          reasoningOutputTokens: 20,
        },
        modelContextWindow: 200_000,
      },
    },
  });
  assertBase(first, "usage");
  assert.deepEqual(first.usage, {
    totalTokens: 150,
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 10,
    outputTokens: 50,
    reasoningOutputTokens: 20,
  });
  assert.match(first.responseId, /^thread-usage-[a-f0-9]{64}$/u);

  const duplicate = normalizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 1_500,
          inputTokens: 1_000,
          cachedInputTokens: 400,
          cacheWriteInputTokens: 100,
          outputTokens: 500,
          reasoningOutputTokens: 200,
        },
        last: first.usage,
        modelContextWindow: 200_000,
      },
    },
  });
  assert.equal(duplicate.responseId, first.responseId, "重复公开通知必须得到同一个幂等键");

  const next = normalizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 1_650,
          inputTokens: 1_100,
          cachedInputTokens: 440,
          cacheWriteInputTokens: 110,
          outputTokens: 550,
          reasoningOutputTokens: 220,
        },
        last: first.usage,
        modelContextWindow: 200_000,
      },
    },
  });
  assert.notEqual(next.responseId, first.responseId, "同一 turn 的下一次上游响应必须独立记录");
}

function testInternalRawUsageIsDiagnosticOnlyAndSecretFree() {
  const secret = "raw-response-secret";
  const usage = normalizeCodexEvent({
    method: "rawResponse/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      responseId: `response-${secret}`,
      usage: {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
        outputTokens: 50,
        reasoningOutputTokens: 20,
      },
      futureRawField: secret,
    },
  }, { registeredSecrets: [secret] });
  assertBase(usage, "raw_usage");
  assert.deepEqual(usage.usage, {
    totalTokens: 150,
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 10,
    outputTokens: 50,
    reasoningOutputTokens: 20,
  });
  assert.equal(usage.responseId, "response-[REDACTED]");
  assert.equal(JSON.stringify(usage).includes(secret), false);

  const absent = normalizeCodexEvent({
    method: "rawResponse/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      responseId: "response-null",
      usage: null,
    },
  });
  assertBase(absent, "raw_usage");
  assert.equal(absent.usage, null);
}

function main() {
  const tests = [
    testTextReasoningAndPlan,
    testCompletedMessagePhasesSealOnlyFinishedItems,
    testToolLifecycleAcrossKinds,
    testStatusApprovalPromptCompleteAndError,
    testUnknownIsBoundedAndSecretFree,
    testKnownEventsUseBoundedJsonSafeSecretFreeSnapshots,
    testPromptEventsRetainSafeUiFields,
    testKnownEventFinalJsonBytesAreHardBoundedAfterEscaping,
    testExplicitShortRegisteredSecretsAreAlwaysRedacted,
    testConfiguredSnapshotLimitCountsTheEntireFinalJson,
    testAccountNotificationsAreStableBoundedSummaries,
    testStructuredAccountRateLimitBackoff,
    testExhaustedPlanWithCreditsRemainsAvailable,
    testPublicThreadUsageIsExactStableAndSecretFree,
    testInternalRawUsageIsDiagnosticOnlyAndSecretFree,
  ];
  for (const test of tests) {
    test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`codex event normalizer unit: ${tests.length}/${tests.length}\n`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
