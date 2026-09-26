#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const INTERACTION_COUNT = 1_000;
const RSS_GROWTH_BUDGET_BYTES = 512 * 1024 * 1024;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "profile-capacity";
const AGENT_ID = "shoggoth-capacity";
const SESSION_KEY = `agent:${AGENT_ID}:${SESSION_ID}`;

const profile = {
  id: PROFILE_ID,
  backendId: "shoggoth",
  agentId: AGENT_ID,
  name: "Capacity",
  runtime: "codex",
  runtimeProfileId: "runtime-capacity",
  runtimeAccountId: "fixture-runtime-account",
  providerRef: "fixture",
  defaultModel: "fixture/model",
  defaultCwd: null,
  permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
  isDefault: true,
  enabled: true,
  createdAt: 100,
  updatedAt: 100,
};

const session = {
  id: SESSION_ID,
  sessionKey: SESSION_ID,
  profileId: PROFILE_ID,
  codexThreadId: null,
  workspace: "/tmp/shoggoth-interaction-capacity",
  title: "Capacity",
  modelOverride: null,
  permissionMode: null,
  status: "draft",
  createdAt: 100,
  updatedAt: 100,
};

function page(field, values) {
  return { [field]: values, nextCursor: null, hasMore: false };
}

function run(index, status) {
  return {
    id: `run-${index}`,
    source: "chat",
    sourceId: SESSION_ID,
    idempotencyKey: `interaction-${index}`,
    profileId: PROFILE_ID,
    workspace: session.workspace,
    status,
    codexThreadId: "thread-capacity",
    codexTurnId: `turn-${index}`,
    eventSeq: status === "waiting_input" ? 1 : 2,
    waitingRequestId: status === "waiting_input" ? `request-${index}` : null,
    startedAt: 100 + index,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
  };
}

let uuidSequence = 0;
let responseCount = 0;
const backend = new ShoggothBackend({
  paths: { tokenPath: "/private/fixture.token" },
  readToken: () => "fixture-client-token",
  requestService: async (_paths, request) => {
    if (request.method === "service.status") {
      return { healthy: true, pendingCommandsLocked: false, mcpCredentialsLocked: false };
    }
    if (request.method === "profile.list") return page("profiles", [profile]);
    if (request.method === "chat.session.list") return page("sessions", [session]);
    if (request.method === "run.input.respond") {
      const index = Number(request.params.runId.slice("run-".length));
      assert.equal(request.params.requestId, `request-${index}`);
      assert.deepEqual(request.params.answers, { choice: index % 2 === 0 ? "alpha" : "beta" });
      responseCount += 1;
      return {
        requestId: request.params.requestId,
        state: "responded",
        run: run(index, "running"),
      };
    }
    throw new Error(`unexpected Service request: ${request.method}`);
  },
  randomUUID: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
  now: () => 1_000,
  delay: () => Promise.resolve(),
  readinessIntervalMs: 0,
});

(async () => {
  const rssBefore = process.memoryUsage().rss;
  try {
    assert.equal(await backend.start(), true);
    for (let index = 0; index < INTERACTION_COUNT; index += 1) {
      const waitingRun = run(index, "waiting_input");
      const context = {
        key: SESSION_KEY,
        sessionKey: SESSION_ID,
        run: waitingRun,
        hooks: {},
      };
      const event = {
        runId: waitingRun.id,
        streamId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        seq: 1,
        type: "prompt",
        payload: {
          requestId: waitingRun.waitingRequestId,
          method: "mcpServer/elicitation/request",
          kind: "mcp_elicitation",
          serverName: "shoggoth",
          mode: "form",
          message: `Choose ${index}`,
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                title: "Choice",
                description: "Choose one\nAlpha: First\nBeta: Second",
                enum: ["alpha", "beta"],
                enumNames: ["Alpha", "Beta"],
              },
            },
            required: ["choice"],
          },
        },
      };
      await backend._consumeEvent(
        context,
        { text: "", reasoning: "", settled: false, lastStatus: null },
        event,
      );
      await backend.respondChatPrompt(SESSION_KEY, {
        requestId: waitingRun.waitingRequestId,
        action: "submit",
        answers: { choice: index % 2 === 0 ? "alpha" : "beta" },
      });
      assert.equal(backend._promptByRequest.size, 0);
    }
    backend._clearSessionRuntime(SESSION_ID);
    assert.equal(responseCount, INTERACTION_COUNT);
    assert.equal(backend._promptByRequest.size, 0);
    assert.equal(backend._activeBySession.size, 0);
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    assert.ok(rssGrowth <= RSS_GROWTH_BUDGET_BYTES,
      `1k interaction RSS growth ${rssGrowth} exceeded 512 MiB`);
    console.log(`PASS 1k interaction create/respond; RSS growth=${rssGrowth}; residual maps=0`);
  } finally {
    await backend.stop().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
