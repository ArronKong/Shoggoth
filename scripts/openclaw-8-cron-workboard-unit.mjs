import assert from "node:assert/strict";
import backendModule from "../app/core/openclaw-backend.js";

const { OpenClawBackend, normalizeOpenClawCronJob } = backendModule;

{
  const disabled = normalizeOpenClawCronJob({ id: "disabled", enabled: false, state: { lastRunStatus: "ok" } });
  assert.equal(disabled.stateLabel, "disabled", "调度停用不能被上次成功掩盖");
  assert.equal(disabled.lastStatus, "ok", "上次执行结果仍独立保留");
  assert.equal(normalizeOpenClawCronJob({ id: "enabled", enabled: true, state: { lastRunStatus: "error" } }).stateLabel, "scheduled");
  for (const kind of ["heartbeat", "skillCollectionReview"]) {
    const managed = normalizeOpenClawCronJob({ id: kind, enabled: true, payload: { kind } });
    assert.deepEqual(managed.actions, { edit: false, toggle: false, delete: false, run: true, reason: "system-managed" });
  }
  assert.deepEqual(normalizeOpenClawCronJob({ id: "client", payload: { kind: "agentTurn" } }).actions,
    { edit: true, toggle: true, delete: true, run: true }, "普通客户端任务保留所有操作");
}

{
  const normalized = normalizeOpenClawCronJob({
    id: "stream-job",
    name: "stream job",
    enabled: true,
    schedule: { kind: "stream", command: ["tail", "-f", "events.log"], mode: "line" },
    payload: { kind: "agentTurn", message: "handle event" },
    delivery: { mode: "announce" },
    state: {
      lastRunStatus: "ok",
      lastDeliveryStatus: "not-delivered",
      lastDeliveryError: "channel offline",
      streamStatus: "running",
    },
  });
  assert.equal(normalized.schedule.kind, "stream");
  assert.equal(normalized.scheduleDisplay, "持续流：tail -f events.log");
  assert.equal(normalized.backendDetails.deliveryStatus, "not-delivered");
  assert.equal(normalized.backendDetails.raw.lastDeliveryError, "channel offline");
  assert.equal(normalized.backendDetails.raw.streamStatus, "running");
}

{
  const normalized = normalizeOpenClawCronJob({
    id: "exit-job",
    enabled: true,
    schedule: { kind: "on-exit", command: "npm test", cwd: "/tmp/project" },
    payload: { kind: "systemEvent", text: "tests done" },
    state: {},
  });
  assert.equal(normalized.scheduleDisplay, "进程退出：npm test");
}

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  let call;
  backend.request = async (method, params) => {
    call = { method, params };
    return { ok: true, ran: true };
  };
  await backend.runCronJob("openclaw:job-1", "force");
  assert.deepEqual(call, { method: "cron.run", params: { id: "job-1" } });
}

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  const calls = [];
  backend.request = async (method, params) => {
    assert.equal(method, "cron.list");
    calls.push(params);
    if (params.offset === 0) {
      return {
        jobs: [
          { id: "job-1", name: "one", enabled: true, schedule: { kind: "every", everyMs: 1_000 }, state: {} },
          { id: "job-2", name: "two", enabled: true, schedule: { kind: "every", everyMs: 2_000 }, state: {} },
        ],
        snapshotRevision: "sha256:stable",
        total: 3,
        offset: 0,
        limit: 200,
        hasMore: true,
        nextOffset: 2,
      };
    }
    return {
      jobs: [
        { id: "job-3", name: "three", enabled: true, schedule: { kind: "every", everyMs: 3_000 }, state: {} },
      ],
      snapshotRevision: "sha256:stable",
      total: 3,
      offset: 2,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    };
  };
  const jobs = await backend.getCronJobs();
  assert.deepEqual(jobs.map((job) => job.id), ["openclaw:job-1", "openclaw:job-2", "openclaw:job-3"]);
  assert.deepEqual(calls, [
    { includeDisabled: true, limit: 200, offset: 0 },
    { includeDisabled: true, limit: 200, offset: 2 },
  ]);
}

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  backend.request = async (_method, params) => ({
    jobs: [{ id: params.offset === 0 ? "job-1" : "job-2", enabled: true, schedule: { kind: "every", everyMs: 1_000 }, state: {} }],
    snapshotRevision: "sha256:stable",
    total: 2,
    offset: params.offset,
    limit: 200,
    hasMore: params.offset === 0,
    nextOffset: params.offset === 0 ? 0 : null,
  });
  await assert.rejects(backend.getCronJobs(), /pagination did not advance/);
}

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  backend.request = async (_method, params) => ({
    jobs: [{ id: "job-1", enabled: true, schedule: { kind: "every", everyMs: 1_000 }, state: {} }],
    snapshotRevision: "sha256:stable",
    total: 2,
    offset: params.offset,
    limit: 200,
    hasMore: params.offset === 0,
    nextOffset: params.offset === 0 ? 1 : null,
  });
  await assert.rejects(backend.getCronJobs(), /duplicate job id/);
}

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  let requestCount = 0;
  backend.request = async (_method, params) => {
    requestCount += 1;
    const stableAttempt = requestCount > 2;
    return {
      jobs: [{
        id: params.offset === 0 ? "job-1" : "job-2",
        enabled: true,
        schedule: { kind: "every", everyMs: 1_000 },
        state: {},
      }],
      snapshotRevision: stableAttempt
        ? "sha256:stable"
        : params.offset === 0 ? "sha256:before" : "sha256:after",
      total: 2,
      offset: params.offset,
      limit: 200,
      hasMore: params.offset === 0,
      nextOffset: params.offset === 0 ? 1 : null,
    };
  };
  const jobs = await backend.getCronJobs();
  assert.deepEqual(jobs.map((job) => job.id), ["openclaw:job-1", "openclaw:job-2"]);
  assert.equal(requestCount, 4);
}

{
  const backend = new OpenClawBackend();
  const base = {
    id: "task-1",
    status: "completed",
    updatedAt: 200,
    deliveryStatus: "failed",
    runtime: "codex",
    startedAt: 100,
    endedAt: 190,
  };
  const succeeded = backend._wbNormalizeTask({ ...base, terminalOutcome: "succeeded" });
  assert.equal(succeeded.runtime, "codex");
  assert.equal(succeeded.deliveryStatus, "failed");
  assert.equal(succeeded.terminalOutcome, "succeeded");
  assert.equal(succeeded.startedAt, 100);
  assert.equal(succeeded.endedAt, 190);
  assert.equal(backend._wbLifecycle({}, new Map(), succeeded).state, "succeeded");

  const blocked = backend._wbNormalizeTask({ ...base, terminalOutcome: "blocked" });
  const lifecycle = backend._wbLifecycle({}, new Map(), blocked);
  assert.equal(lifecycle.state, "failed");
  assert.equal(lifecycle.targetStatus, "blocked");
}

{
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  const methods = [];
  backend.request = async (method) => {
    methods.push(method);
    if (method === "workboard.cards.list") {
      return {
        statuses: ["todo", "running", "review", "blocked"],
        cards: [{ id: "card-1", title: "card", status: "todo", position: 0, taskId: "task-1", metadata: {} }],
      };
    }
    if (method === "sessions.list") return { sessions: [] };
    if (method === "agents.list") return { agents: [] };
    if (method === "tasks.list") {
      return { tasks: [{ id: "task-1", status: "running", updatedAt: 10 }] };
    }
    if (method === "workboard.cards.update") throw new Error("read refresh must not mutate cards");
    throw new Error(`unexpected method ${method}`);
  };
  const board = await backend.getTaskBoard();
  assert.equal(methods.includes("workboard.cards.update"), false);
  const card = board.columns.flatMap((column) => column.tasks).find((item) => item.id === "card-1");
  assert.equal(card.column, "todo");
  assert.equal(card.wb.lifecycle.state, "running");
}

console.log("openclaw 8 cron/workboard: PASS");
