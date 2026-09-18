"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_CAPACITIES,
  IDEMPOTENCY_WINDOW_MS,
  MIN_EVERY_INTERVAL_MS,
  NATIVE_CRON_STORE_VERSION,
  NativeCronStore,
  computeNextOccurrence,
  validateContainer,
} = require("../app/agent-service/native-cron-store");

const PROFILE_ID = "profile-default";
const BASE_TIME = Date.UTC(2026, 7, 23, 8, 0, 0);
const BASE_CRON_NEXT = Date.UTC(2026, 7, 24, 1, 0, 0);

function uuidFactory() {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  };
}

function withRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cron-store-"));
  fs.chmodSync(root, 0o700);
  try {
    return run({ trustedRoot: root, stateDir: path.join(root, "state") });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createStore(paths, overrides = {}) {
  return new NativeCronStore({
    paths,
    profileExists: (profileId) => profileId === PROFILE_ID,
    now: () => BASE_TIME,
    randomUUID: uuidFactory(),
    ...overrides,
  });
}

function createInput(overrides = {}) {
  return {
    operationId: "create-job",
    name: "Morning review",
    enabled: true,
    profileId: PROFILE_ID,
    prompt: "Review the repository and report status.",
    workspace: "/tmp/project",
    schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Shanghai" },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: BASE_CRON_NEXT,
    createdAt: BASE_TIME,
    ...overrides,
  };
}

function expectCode(code, run) {
  assert.throws(run, (error) => error?.code === code);
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test("pins cron-parser as the sole Cron semantic dependency", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
  const installed = require("cron-parser/package.json");
  assert.equal(manifest.dependencies["cron-parser"], "5.4.0");
  assert.equal(lock.packages[""].dependencies["cron-parser"], "5.4.0");
  assert.equal(lock.packages["node_modules/cron-parser"].version, "5.4.0");
  assert.equal(installed.version, "5.4.0");
  assert.equal(MIN_EVERY_INTERVAL_MS, 60_000);
  assert.equal(NATIVE_CRON_STORE_VERSION, 2);
  assert.ok(IDEMPOTENCY_WINDOW_MS / MIN_EVERY_INTERVAL_MS < DEFAULT_CAPACITIES.operations);
});

test("uses cron-parser semantics to reject garbage, range errors, and impossible schedules", () => (
  withRoot((paths) => {
    const store = createStore(paths).open();
    ["this is not valid cron", "0 25 * * *", "0 0 31 2 *"].forEach((expr, index) => {
      expectCode("CRON_SCHEDULE_INVALID", () => store.createJob(createInput({
        operationId: `invalid-cron-${index + 1}`,
        schedule: { kind: "cron", expr, tz: "UTC" },
        nextRunAt: BASE_TIME + 1,
      })));
    });
    assert.equal(store.listJobs().length, 0);
    store.close();
  })
));

test("computes safe next occurrences including timezone DST gaps", () => {
  assert.equal(computeNextOccurrence(
    { kind: "at", at: BASE_TIME + 1 }, BASE_TIME,
  ), BASE_TIME + 1);
  assert.equal(computeNextOccurrence(
    { kind: "at", at: BASE_TIME }, BASE_TIME,
  ), null);
  assert.equal(computeNextOccurrence(
    { kind: "every", everyMs: 60_000, anchorMs: BASE_TIME - 5_000 }, BASE_TIME,
  ), BASE_TIME + 55_000);
  assert.equal(computeNextOccurrence(
    {
      kind: "every",
      everyMs: MIN_EVERY_INTERVAL_MS,
      anchorMs: Number.MAX_SAFE_INTEGER - 30_000,
    },
    Number.MAX_SAFE_INTEGER - 10_000,
  ), null);
  assert.equal(computeNextOccurrence(
    { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" },
    Date.UTC(2026, 2, 8, 5, 0, 0),
  ), Date.UTC(2026, 2, 8, 7, 30, 0));
  assert.equal(computeNextOccurrence(
    { kind: "cron", expr: "30 1 * * *", tz: "America/New_York" },
    Date.UTC(2026, 10, 1, 4, 0, 0),
  ), Date.UTC(2026, 10, 1, 5, 30, 0));
});

test("requires enabled jobs to store exactly the next schedule occurrence", () => withRoot((paths) => {
  const store = createStore(paths).open();
  expectCode("CRON_NEXT_RUN_INVALID", () => store.createJob(createInput({
    operationId: "wrong-at-next",
    schedule: { kind: "at", at: BASE_TIME + 120_000 },
    nextRunAt: BASE_TIME + 60_000,
  })));
  expectCode("CRON_NEXT_RUN_INVALID", () => store.createJob(createInput({
    operationId: "wrong-every-next",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: BASE_TIME - 5_000 },
    nextRunAt: BASE_TIME + 60_000,
  })));
  expectCode("CRON_NEXT_RUN_INVALID", () => store.createJob(createInput({
    operationId: "wrong-cron-next",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    nextRunAt: BASE_TIME + 60_000,
  })));
  expectCode("CRON_NEXT_RUN_INVALID", () => store.createJob(createInput({
    operationId: "enabled-without-next",
    nextRunAt: null,
  })));
  store.close();
}));

test("every 允许任意至少 60s 间隔并在 create/update 统一拒绝子分钟调度", () => (
  withRoot((paths) => {
    const store = createStore(paths).open();
    expectCode("CRON_SCHEDULE_INVALID", () => store.createJob(createInput({
      operationId: "create-sub-minute",
      schedule: { kind: "every", everyMs: 59_999, anchorMs: BASE_TIME },
      nextRunAt: BASE_TIME + 59_999,
    })));
    const job = store.createJob(createInput({
      operationId: "create-non-round-minute",
      schedule: { kind: "every", everyMs: 60_001, anchorMs: BASE_TIME },
      nextRunAt: BASE_TIME + 60_001,
    }));
    assert.equal(job.schedule.everyMs, 60_001);
    expectCode("CRON_SCHEDULE_INVALID", () => store.updateJob({
      operationId: "update-sub-minute",
      jobId: job.id,
      patch: {
        schedule: { kind: "every", everyMs: 30_000, anchorMs: BASE_TIME },
        nextRunAt: BASE_TIME + 30_000,
      },
      createdAt: BASE_TIME + 1,
    }));
    assert.equal(store.getJob(job.id).schedule.everyMs, 60_001);
    store.close();
  })
));

test("replays an identical create before consulting a changed profile resolver", () => (
  withRoot((paths) => {
    let available = true;
    let calls = 0;
    let now = BASE_TIME;
    const store = createStore(paths, {
      now: () => now,
      profileExists: (profileId) => {
        calls += 1;
        return available && profileId === PROFILE_ID;
      },
    }).open();
    const input = createInput();
    const created = store.createJob(input);
    available = false;
    now += 60_000;
    const callsBeforeReplay = calls;
    assert.deepEqual(store.createJob(input), created);
    assert.equal(calls, callsBeforeReplay);
    expectCode("CRON_REFERENCE_INVALID", () => store.createJob({
      ...input,
      operationId: "new-create-after-profile-removal",
    }));
    assert.equal(calls, callsBeforeReplay + 1);
    store.close();
  })
));

test("persists strict cron/every/at schedules and next fire across restart", () => withRoot((paths) => {
  const store = createStore(paths).open();
  const cron = store.createJob(createInput());
  const every = store.createJob(createInput({
    operationId: "create-every",
    name: "Every hour",
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: BASE_TIME },
    nextRunAt: BASE_TIME + 3_600_000,
  }));
  const at = store.createJob(createInput({
    operationId: "create-at",
    name: "One shot",
    schedule: { kind: "at", at: BASE_TIME + 120_000 },
    nextRunAt: BASE_TIME + 120_000,
  }));

  assert.equal(cron.schedule.tz, "Asia/Shanghai");
  assert.deepEqual(every.schedule, { kind: "every", everyMs: 3_600_000, anchorMs: BASE_TIME });
  assert.deepEqual(at.schedule, { kind: "at", at: BASE_TIME + 120_000 });
  assert.deepEqual(store.listJobs().map((job) => job.name), [
    "Morning review", "Every hour", "One shot",
  ]);
  assert.equal(fs.statSync(path.join(paths.stateDir, "native-cron.json")).mode & 0o777, 0o600);
  store.close();

  const reopened = createStore(paths).open();
  assert.deepEqual(reopened.getJob(cron.id), cron);
  assert.deepEqual(reopened.getJob(every.id), every);
  assert.deepEqual(reopened.getJob(at.id), at);
  reopened.close();
}));

test("updates schedule atomically and provides explicit enable/disable/next-fire mutations", () => (
  withRoot((paths) => {
    const store = createStore(paths).open();
    const job = store.createJob(createInput());
    expectCode("CRON_NEXT_RUN_INVALID", () => store.updateJob({
      operationId: "update-schedule-wrong-next",
      jobId: job.id,
      patch: {
        schedule: { kind: "cron", expr: "30 8 * * *", tz: "UTC" },
        nextRunAt: BASE_TIME + 120_000,
      },
      createdAt: BASE_TIME + 1,
    }));
    const updated = store.updateJob({
      operationId: "update-schedule",
      jobId: job.id,
      patch: {
        schedule: { kind: "cron", expr: "30 8 * * *", tz: "UTC" },
        nextRunAt: BASE_TIME + 30 * 60_000,
      },
      createdAt: BASE_TIME + 1,
    });
    assert.equal(updated.schedule.expr, "30 8 * * *");
    assert.equal(updated.nextRunAt, BASE_TIME + 30 * 60_000);

    const disabled = store.setJobEnabled({
      operationId: "disable-job",
      jobId: job.id,
      enabled: false,
      nextRunAt: null,
      createdAt: BASE_TIME + 2,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);
    expectCode("CRON_NEXT_RUN_INVALID", () => store.setJobNextRunAt({
      operationId: "disabled-next",
      jobId: job.id,
      nextRunAt: BASE_TIME + 180_000,
      createdAt: BASE_TIME + 3,
    }));

    expectCode("CRON_NEXT_RUN_INVALID", () => store.setJobEnabled({
      operationId: "enable-job-wrong-next",
      jobId: job.id,
      enabled: true,
      nextRunAt: BASE_TIME + 240_000,
      createdAt: BASE_TIME + 4,
    }));
    const enabled = store.setJobEnabled({
      operationId: "enable-job",
      jobId: job.id,
      enabled: true,
      nextRunAt: BASE_TIME + 30 * 60_000,
      createdAt: BASE_TIME + 4,
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.nextRunAt, BASE_TIME + 30 * 60_000);
    expectCode("CRON_NEXT_RUN_INVALID", () => store.setJobNextRunAt({
      operationId: "advance-next-wrong",
      jobId: job.id,
      nextRunAt: BASE_TIME + 300_000,
      createdAt: BASE_TIME + 5,
    }));
    const next = store.setJobNextRunAt({
      operationId: "advance-next",
      jobId: job.id,
      nextRunAt: BASE_TIME + 30 * 60_000,
      createdAt: BASE_TIME + 5,
    });
    assert.equal(next.nextRunAt, BASE_TIME + 30 * 60_000);
    store.close();
  })
));

test("derived update replays its immutable result after later update/tick/delete/restart/rollback", () => (
  withRoot((paths) => {
    let now = BASE_TIME;
    const options = { now: () => now };
    const store = createStore(paths, options).open();
    const job = store.createJob(createInput({
      schedule: { kind: "every", everyMs: 60_000, anchorMs: BASE_TIME },
      nextRunAt: BASE_TIME + 60_000,
    }));
    const input = {
      operationId: "derived-update",
      jobId: job.id,
      patch: {
        name: "Derived update",
        schedule: { kind: "at", at: BASE_TIME + 10 * 60_000 },
      },
      createdAt: BASE_TIME + 1,
    };
    const updated = store.updateJobDerived(input);
    assert.equal(updated.updatedAt, BASE_TIME + 1);
    assert.equal(updated.nextRunAt, BASE_TIME + 10 * 60_000);

    store.updateJob({
      operationId: "later-update",
      jobId: job.id,
      patch: { name: "Later state" },
      createdAt: BASE_TIME + 2,
    });
    store.setJobNextRunAt({
      operationId: "later-tick",
      jobId: job.id,
      nextRunAt: BASE_TIME + 10 * 60_000,
      createdAt: BASE_TIME + 3,
    });
    store.deleteJob({
      operationId: "later-delete",
      jobId: job.id,
      createdAt: BASE_TIME + 4,
    });
    now -= 10 * 60_000;
    assert.deepEqual(store.updateJobDerived(input), updated);
    expectCode("CRON_OPERATION_ID_CONFLICT", () => store.updateJobDerived({
      ...input,
      patch: { ...input.patch, name: "Changed replay" },
    }));
    store.close();

    const reopened = createStore(paths, options).open();
    assert.equal(reopened.getJob(job.id), null);
    assert.deepEqual(reopened.updateJobDerived(input), updated);
    reopened.close();
  })
));

test("derived enabled mutation replays after later state changes and derives disabled nextRunAt", () => (
  withRoot((paths) => {
    let now = BASE_TIME;
    const options = { now: () => now };
    const store = createStore(paths, options).open();
    const job = store.createJob(createInput({
      enabled: false,
      nextRunAt: null,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: BASE_TIME },
    }));
    const enableInput = {
      operationId: "derived-enable",
      jobId: job.id,
      enabled: true,
      createdAt: BASE_TIME + 1,
    };
    const enabled = store.setJobEnabledDerived(enableInput);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.nextRunAt, BASE_TIME + 60_000);

    store.updateJob({
      operationId: "later-enabled-update",
      jobId: job.id,
      patch: { name: "Later enabled state" },
      createdAt: BASE_TIME + 2,
    });
    store.setJobNextRunAt({
      operationId: "later-enabled-tick",
      jobId: job.id,
      nextRunAt: BASE_TIME + 60_000,
      createdAt: BASE_TIME + 3,
    });
    store.deleteJob({
      operationId: "later-enabled-delete",
      jobId: job.id,
      createdAt: BASE_TIME + 4,
    });
    now -= 10 * 60_000;
    assert.deepEqual(store.setJobEnabledDerived(enableInput), enabled);
    expectCode("CRON_OPERATION_ID_CONFLICT", () => store.setJobEnabledDerived({
      ...enableInput,
      enabled: false,
    }));
    store.close();

    const reopened = createStore(paths, options).open();
    assert.deepEqual(reopened.setJobEnabledDerived(enableInput), enabled);
    reopened.close();

    now = BASE_TIME;
    const disableStore = createStore(paths, options).open();
    const second = disableStore.createJob(createInput({
      operationId: "create-derived-disable",
      name: "Disable me",
    }));
    const disabled = disableStore.setJobEnabledDerived({
      operationId: "derived-disable",
      jobId: second.id,
      enabled: false,
      createdAt: BASE_TIME + 5,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);
    disableStore.close();
  })
));

test("derived mutations pin schedule/DST semantics and reject past at or invalid schedules with zero mutation", () => (
  withRoot((paths) => {
    const dstBase = Date.UTC(2026, 2, 8, 5, 0, 0);
    const store = createStore(paths, { now: () => dstBase }).open();
    const job = store.createJob(createInput({
      createdAt: dstBase,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: dstBase },
      nextRunAt: dstBase + 60_000,
    }));
    const dst = store.updateJobDerived({
      operationId: "derived-dst",
      jobId: job.id,
      patch: { schedule: { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" } },
      createdAt: dstBase,
    });
    assert.equal(dst.nextRunAt, Date.UTC(2026, 2, 8, 7, 30, 0));

    const beforeFailure = fs.readFileSync(path.join(paths.stateDir, "native-cron.json"));
    expectCode("CRON_SCHEDULE_INVALID", () => store.updateJobDerived({
      operationId: "derived-invalid-schedule",
      jobId: job.id,
      patch: { schedule: { kind: "cron", expr: "0 25 * * *", tz: "UTC" } },
      createdAt: dstBase + 1,
    }));
    assert.deepEqual(fs.readFileSync(path.join(paths.stateDir, "native-cron.json")), beforeFailure);
    expectCode("CRON_NEXT_RUN_INVALID", () => store.updateJobDerived({
      operationId: "derived-past-at",
      jobId: job.id,
      patch: { schedule: { kind: "at", at: dstBase } },
      createdAt: dstBase + 1,
    }));
    assert.deepEqual(fs.readFileSync(path.join(paths.stateDir, "native-cron.json")), beforeFailure);
    assert.deepEqual(store.getJob(job.id), dst);
    store.close();
  })
));

test("derived update validates the final thread policy binding atomically", () => withRoot((paths) => {
  const store = createStore(paths).open();
  const job = store.createJob(createInput());
  const automatic = store.updateJobDerived({
    operationId: "derived-thread-missing-id",
    jobId: job.id,
    patch: { threadPolicy: "continue" },
    createdAt: BASE_TIME + 1,
  });
  assert.equal(automatic.threadPolicy, "continue");
  assert.equal(automatic.threadId, null);

  const continued = store.updateJobDerived({
    operationId: "derived-thread-continue",
    jobId: job.id,
    patch: { threadPolicy: "continue", threadId: "thread-1" },
    createdAt: BASE_TIME + 2,
  });
  assert.equal(continued.threadId, "thread-1");
  const beforeSecondFailure = fs.readFileSync(path.join(paths.stateDir, "native-cron.json"));
  expectCode("CRON_JOB_INVALID", () => store.updateJobDerived({
    operationId: "derived-thread-stale-id",
    jobId: job.id,
    patch: { threadPolicy: "new" },
    createdAt: BASE_TIME + 3,
  }));
  assert.deepEqual(
    fs.readFileSync(path.join(paths.stateDir, "native-cron.json")),
    beforeSecondFailure,
  );
  store.close();
  const reopened = createStore(paths).open();
  assert.equal(reopened.getJob(job.id).threadPolicy, "continue");
  assert.equal(reopened.getJob(job.id).threadId, "thread-1");
  reopened.close();
}));

test("derived mutation commit uncertainty stays poisoned and committed ledger recovers on restart", () => (
  withRoot((paths) => {
    const original = createStore(paths).open();
    const job = original.createJob(createInput());
    original.close();

    let writes = 0;
    const uncertain = createStore(paths, {
      atomicWrite(filePath, serialized) {
        writes += 1;
        fs.writeFileSync(filePath, serialized, { mode: 0o600 });
        const error = new Error("commit acknowledgement lost");
        error.committedUncertain = true;
        throw error;
      },
    }).open();
    const input = {
      operationId: "derived-uncertain",
      jobId: job.id,
      patch: { name: "Possibly committed" },
      createdAt: BASE_TIME + 1,
    };
    expectCode("CRON_COMMIT_UNCERTAIN", () => uncertain.updateJobDerived(input));
    assert.equal(writes, 1);
    expectCode("CRON_COMMIT_UNCERTAIN", () => uncertain.updateJobDerived(input));
    assert.equal(writes, 1);
    uncertain.close();

    const recovered = createStore(paths).open();
    const replay = recovered.updateJobDerived(input);
    assert.equal(replay.name, "Possibly committed");
    assert.deepEqual(recovered.getJob(job.id), replay);
    recovered.close();
  })
));

test("exact replay compares durable ownership before clock failure while new operations fail closed", () => (
  withRoot((paths) => {
    let clockMode = "valid";
    let clockCalls = 0;
    const store = createStore(paths, {
      now() {
        clockCalls += 1;
        if (clockMode === "throw") throw new Error("raw-clock-secret-canary");
        return BASE_TIME;
      },
    }).open();
    const job = store.createJob(createInput());
    const input = {
      operationId: "derived-before-clock",
      jobId: job.id,
      patch: { name: "Clock independent replay" },
      createdAt: BASE_TIME + 1,
    };
    const first = store.updateJobDerived(input);
    store.deleteJob({
      operationId: "delete-before-clock-failure",
      jobId: job.id,
      createdAt: BASE_TIME + 2,
    });

    clockMode = "throw";
    const callsBeforeReplay = clockCalls;
    assert.deepEqual(store.updateJobDerived(input), first);
    assert.equal(clockCalls, callsBeforeReplay + 1);
    expectCode("CRON_OPERATION_ID_CONFLICT", () => store.updateJobDerived({
      ...input,
      patch: { name: "Changed while clock unavailable" },
    }));
    assert.equal(clockCalls, callsBeforeReplay + 1, "conflict ownership 必须在 clock getter 前确定");
    assert.throws(
      () => store.updateJobDerived({ ...input, operationId: "new-without-clock" }),
      (error) => error?.code === "CRON_TIMESTAMP_INVALID"
        && !JSON.stringify(error).includes("raw-clock-secret-canary"),
    );
    store.close();
  })
));

test("known mutation failure keeps durable and in-memory window state byte-identical", () => (
  withRoot((paths) => {
    let now = BASE_TIME;
    const store = createStore(paths, { now: () => now }).open();
    const job = store.createJob(createInput());
    const filePath = path.join(paths.stateDir, "native-cron.json");
    const beforeBytes = fs.readFileSync(filePath);
    const before = JSON.parse(beforeBytes.toString("utf8"));

    now += 24 * 60 * 60 * 1_000;
    expectCode("CRON_NEXT_RUN_INVALID", () => store.updateJobDerived({
      operationId: "known-failure-after-window-advance",
      jobId: job.id,
      patch: { schedule: { kind: "at", at: BASE_TIME } },
      createdAt: now,
    }));
    assert.deepEqual(fs.readFileSync(filePath), beforeBytes);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(after.revision, before.revision);
    assert.equal(after.idempotencyFloorMs, before.idempotencyFloorMs);

    now = BASE_TIME;
    const accepted = store.updateJobDerived({
      operationId: "proves-in-memory-floor-rollback",
      jobId: job.id,
      patch: { name: "Old-floor operation accepted" },
      createdAt: before.idempotencyFloorMs + 1,
    });
    assert.equal(accepted.name, "Old-floor operation accepted");
    store.close();
  })
));

test("mutation snapshots reject accessor and Proxy inputs without invoking user traps", () => (
  withRoot((paths) => {
    const store = createStore(paths).open();
    const job = store.createJob(createInput());
    let traps = 0;
    const accessorPatch = {};
    Object.defineProperty(accessorPatch, "name", {
      enumerable: true,
      get() {
        traps += 1;
        throw new Error("raw-accessor-secret-canary");
      },
    });
    assert.throws(
      () => store.updateJobDerived({
        operationId: "accessor-patch",
        jobId: job.id,
        patch: accessorPatch,
        createdAt: BASE_TIME + 1,
      }),
      (error) => error?.code === "CRON_OPERATION_INVALID"
        && !JSON.stringify(error).includes("raw-accessor-secret-canary"),
    );
    assert.equal(traps, 0);

    const accessorSchedule = { at: BASE_TIME + 60_000 };
    Object.defineProperty(accessorSchedule, "kind", {
      enumerable: true,
      get() {
        traps += 1;
        throw new Error("raw-schedule-secret-canary");
      },
    });
    expectCode("CRON_OPERATION_INVALID", () => store.updateJobDerived({
      operationId: "accessor-schedule",
      jobId: job.id,
      patch: { schedule: accessorSchedule },
      createdAt: BASE_TIME + 1,
    }));
    assert.equal(traps, 0);

    const hostile = new Proxy({}, {
      get() { traps += 1; throw new Error("raw-proxy-get-secret-canary"); },
      getPrototypeOf() { traps += 1; throw new Error("raw-proxy-prototype-secret-canary"); },
      ownKeys() { traps += 1; throw new Error("raw-proxy-ownkeys-secret-canary"); },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("raw-proxy-descriptor-secret-canary");
      },
    });
    expectCode("CRON_OPERATION_INVALID", () => store.updateJobDerived(hostile));
    expectCode("CRON_OPERATION_INVALID", () => store.updateJobDerived({
      operationId: "proxy-patch",
      jobId: job.id,
      patch: hostile,
      createdAt: BASE_TIME + 1,
    }));
    assert.equal(traps, 0);
    store.close();
  })
));

test("write error probes ignore accessor/Proxy traps and never leak raw messages", () => (
  withRoot((paths) => {
    const original = createStore(paths).open();
    const job = original.createJob(createInput());
    original.close();
    let traps = 0;
    const hostileError = {};
    for (const field of ["committed", "committedUncertain", "code", "message"]) {
      Object.defineProperty(hostileError, field, {
        enumerable: true,
        get() {
          traps += 1;
          throw new Error("raw-error-probe-secret-canary");
        },
      });
    }
    const store = createStore(paths, {
      atomicWrite() { throw hostileError; },
    }).open();
    assert.throws(
      () => store.updateJobDerived({
        operationId: "hostile-write-error",
        jobId: job.id,
        patch: { name: "Must fail safely" },
        createdAt: BASE_TIME + 1,
      }),
      (error) => error?.code === "CRON_WRITE_FAILED"
        && !JSON.stringify(error).includes("raw-error-probe-secret-canary"),
    );
    assert.equal(traps, 0);
    store.close();
  })
));

test("strict v1 migration writes v2 once and preserves legacy operation replay", () => (
  withRoot((paths) => {
    const seed = createStore(paths).open();
    const create = createInput();
    const created = seed.createJob(create);
    const legacyUpdate = {
      operationId: "legacy-update",
      jobId: created.id,
      patch: { name: "Legacy updated" },
      createdAt: BASE_TIME + 1,
    };
    const updated = seed.updateJob(legacyUpdate);
    seed.close();
    const filePath = path.join(paths.stateDir, "native-cron.json");
    const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
    legacy.version = 1;
    const legacyRevision = legacy.revision;
    fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    let writes = 0;
    const migrated = createStore(paths, {
      atomicWrite(target, serialized) {
        writes += 1;
        fs.writeFileSync(target, serialized, { mode: 0o600 });
      },
    }).open();
    assert.equal(writes, 1);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.revision, legacyRevision + 1);
    assert.deepEqual(migrated.updateJob(legacyUpdate), updated);
    migrated.close();
  })
));

test("failed v1 migration leaves original bytes intact and releases the writer lease", () => (
  withRoot((paths) => {
    const seed = createStore(paths).open();
    seed.createJob(createInput());
    seed.close();
    const filePath = path.join(paths.stateDir, "native-cron.json");
    const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
    legacy.version = 1;
    const originalBytes = Buffer.from(`${JSON.stringify(legacy)}\n`);
    fs.writeFileSync(filePath, originalBytes, { mode: 0o600 });

    const failed = createStore(paths, {
      atomicWrite() { throw new Error("migration write failed"); },
    });
    expectCode("CRON_WRITE_FAILED", () => failed.open());
    assert.deepEqual(fs.readFileSync(filePath), originalBytes);
    assert.equal(failed.opened, false);
    const recovered = createStore(paths).open();
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 2);
    recovered.close();
  })
));

test("v1 rejects derived operation kinds instead of treating them as same-version compatible", () => (
  withRoot((paths) => {
    const seed = createStore(paths).open();
    const job = seed.createJob(createInput());
    seed.updateJobDerived({
      operationId: "illegal-v1-derived",
      jobId: job.id,
      patch: { name: "Derived v2 only" },
      createdAt: BASE_TIME + 1,
    });
    seed.close();
    const filePath = path.join(paths.stateDir, "native-cron.json");
    const illegal = JSON.parse(fs.readFileSync(filePath, "utf8"));
    illegal.version = 1;
    const originalBytes = Buffer.from(`${JSON.stringify(illegal)}\n`);
    fs.writeFileSync(filePath, originalBytes, { mode: 0o600 });
    expectCode("CRON_STORE_CORRUPT", () => createStore(paths).open());
    assert.deepEqual(fs.readFileSync(filePath), originalBytes);
  })
));

test("finishes a one-time schedule only by disabling it and clearing nextRunAt", () => (
  withRoot((paths) => {
    const store = createStore(paths).open();
    const at = BASE_TIME + 120_000;
    const job = store.createJob(createInput({
      operationId: "create-one-time",
      schedule: { kind: "at", at },
      nextRunAt: at,
    }));
    const completed = store.setJobEnabled({
      operationId: "finish-one-time",
      jobId: job.id,
      enabled: false,
      nextRunAt: null,
      createdAt: at,
    });
    assert.equal(completed.enabled, false);
    assert.equal(completed.nextRunAt, null);
    store.close();
    const reopened = createStore(paths).open();
    assert.deepEqual(reopened.getJob(job.id), completed);
    reopened.close();
  })
));

test("keeps operationId results idempotent for 30 days and rejects conflicts/expired retries", () => (
  withRoot((paths) => {
    let now = BASE_TIME;
    const options = { now: () => now };
    const store = createStore(paths, options).open();
    const input = createInput();
    const first = store.createJob(input);
    assert.deepEqual(store.createJob(input), first);
    assert.equal(store.listJobs().length, 1);
    expectCode("CRON_OPERATION_ID_CONFLICT", () => store.createJob({ ...input, name: "Changed" }));
    store.close();

    const reopened = createStore(paths, options).open();
    assert.deepEqual(reopened.createJob(input), first);
    reopened.close();

    now += IDEMPOTENCY_WINDOW_MS + 1;
    const expired = createStore(paths, options).open();
    expectCode("CRON_OPERATION_EXPIRED", () => expired.createJob(input));
    assert.equal(expired.listJobs().length, 1);
    expired.close();
  })
));

test("stores immutable idempotency results even after later update and delete", () => withRoot((paths) => {
  const store = createStore(paths).open();
  const create = createInput();
  const created = store.createJob(create);
  store.updateJob({
    operationId: "rename-job",
    jobId: created.id,
    patch: { name: "Renamed" },
    createdAt: BASE_TIME + 1,
  });
  assert.deepEqual(store.createJob(create), created);
  assert.equal(store.deleteJob({
    operationId: "delete-job", jobId: created.id, createdAt: BASE_TIME + 2,
  }), null);
  assert.equal(store.getJob(created.id), null);
  assert.equal(store.deleteJob({
    operationId: "delete-job", jobId: created.id, createdAt: BASE_TIME + 2,
  }), null);
  assert.deepEqual(store.createJob(create), created);
  store.close();
}));

test("enforces one writer lease and releases it for the next process instance", () => withRoot((paths) => {
  const first = createStore(paths).open();
  const second = createStore(paths);
  expectCode("WRITER_LEASE_HELD", () => second.open());
  first.close();
  second.open();
  second.close();
}));

test("fails closed after commit-uncertain and accepts committed cleanup failures", () => (
  withRoot((paths) => {
    const uncertainWrite = () => {
      const error = new Error("directory fsync and rollback both failed");
      error.committedUncertain = true;
      throw error;
    };
    const poisoned = createStore(paths, { atomicWrite: uncertainWrite }).open();
    expectCode("CRON_COMMIT_UNCERTAIN", () => poisoned.createJob(createInput()));
    expectCode("CRON_COMMIT_UNCERTAIN", () => poisoned.listJobs());
    poisoned.close();

    const committedWrite = () => {
      const error = new Error("backup cleanup failed after commit");
      error.committed = true;
      throw error;
    };
    const committed = createStore(paths, { atomicWrite: committedWrite }).open();
    assert.equal(committed.createJob(createInput()).name, "Morning review");
    assert.equal(committed.listJobs().length, 1);
    committed.close();
  })
));

test("recovery uncertain 优先于 persisted matcher/引用检查并保留可关闭 poison 证据", () => (
  withRoot((paths) => {
    const original = createStore(paths).open();
    original.createJob(createInput());
    original.close();
    const target = path.join(paths.stateDir, "native-cron.json");
    const backup = `${target}.backup-${process.pid}-0123456789abcdef`;
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, 0o600);
    let matcherCalls = 0;
    let resolverCalls = 0;
    const poisoned = createStore(paths, {
      isSensitiveValue() {
        matcherCalls += 1;
        throw new Error("locked matcher must not run");
      },
      profileExists() {
        resolverCalls += 1;
        throw new Error("profile resolver must not run");
      },
    });
    poisoned.open();
    assert.equal(poisoned.opened, true);
    assert.equal(matcherCalls, 0);
    assert.equal(resolverCalls, 0);
    expectCode("CRON_COMMIT_UNCERTAIN", () => poisoned.listJobs());
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(backup), true);
    poisoned.close();
    assert.equal(poisoned.opened, false);
    const reacquired = createStore(paths).open();
    reacquired.close();
  })
));

test("rejects invalid timezone, schedules, references, timestamps, and extra schema fields", () => (
  withRoot((paths) => {
    const store = createStore(paths).open();
    const invalidSchedules = [
      { kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" },
      { kind: "cron", expr: "", tz: "UTC" },
      { kind: "cron", expr: "0 9 * * *", tz: "UTC", extra: true },
      { kind: "every", everyMs: 0, anchorMs: BASE_TIME },
      { kind: "every", everyMs: 1_000, anchorMs: BASE_TIME, extra: true },
      { kind: "at", at: -1 },
      { kind: "at", at: BASE_TIME, extra: true },
    ];
    invalidSchedules.forEach((schedule, index) => {
      expectCode("CRON_SCHEDULE_INVALID", () => store.createJob(createInput({
        operationId: `bad-schedule-${index + 1}`,
        schedule,
      })));
    });
    expectCode("CRON_OPERATION_INVALID", () => store.createJob({ ...createInput(), extra: true }));
    expectCode("CRON_REFERENCE_INVALID", () => store.createJob(createInput({ profileId: "missing" })));
    expectCode("CRON_JOB_INVALID", () => store.createJob(createInput({ workspace: "relative/path" })));
    expectCode("CRON_NEXT_RUN_INVALID", () => store.createJob(createInput({
      enabled: false, nextRunAt: BASE_TIME + 1,
    })));
    expectCode("CRON_TIMESTAMP_INVALID", () => store.createJob(createInput({
      createdAt: BASE_TIME + 5 * 60_000 + 1,
    })));
    expectCode("CRON_JOB_INVALID", () => store.updateJob({
      operationId: "bad-patch",
      jobId: "00000000-0000-4000-8000-000000000001",
      patch: { unknown: true },
      createdAt: BASE_TIME,
    }));
    store.close();
  })
));

test("enforces entity/operation capacity without partial writes", () => withRoot((paths) => {
  assert.ok(DEFAULT_CAPACITIES.jobs > 1);
  const store = createStore(paths, { capacities: { jobs: 1, operations: 3 } }).open();
  const first = store.createJob(createInput());
  expectCode("CRON_CAPACITY", () => store.createJob(createInput({
    operationId: "second", name: "Second",
  })));
  assert.deepEqual(store.listJobs(), [first]);
  store.close();
}));

test("enforces operation capacity independently without applying the rejected mutation", () => (
  withRoot((paths) => {
    const store = createStore(paths, { capacities: { jobs: 2, operations: 2 } }).open();
    const job = store.createJob(createInput());
    store.updateJob({
      operationId: "rename-one",
      jobId: job.id,
      patch: { name: "Renamed once" },
      createdAt: BASE_TIME + 1,
    });
    expectCode("CRON_CAPACITY", () => store.updateJob({
      operationId: "rename-two",
      jobId: job.id,
      patch: { name: "Must not persist" },
      createdAt: BASE_TIME + 2,
    }));
    assert.equal(store.getJob(job.id).name, "Renamed once");
    store.close();
  })
));

test("rejects sensitive fields and values before persistence", () => withRoot((paths) => {
  const store = createStore(paths, {
    isSensitiveValue: (value) => value.includes("secret-canary"),
  }).open();
  expectCode("CRON_SENSITIVE_VALUE", () => store.createJob(createInput({
    prompt: "do not persist secret-canary",
  })));
  expectCode("CRON_SENSITIVE_FIELD", () => store.createJob({
    ...createInput(), apiKey: "redacted",
  }));
  assert.equal(store.listJobs().length, 0);
  store.close();
}));

test("rechecks persisted values for secrets before accepting a restart", () => withRoot((paths) => {
  const original = createStore(paths).open();
  original.createJob(createInput({ prompt: "persisted-secret-canary" }));
  original.close();
  expectCode("CRON_SENSITIVE_VALUE", () => createStore(paths, {
    isSensitiveValue: (value) => value.includes("secret-canary"),
  }).open());
}));

test("returns an existing idempotent result when wall clock moves backwards", () => withRoot((paths) => {
  let now = BASE_TIME;
  const store = createStore(paths, { now: () => now }).open();
  const input = createInput();
  const created = store.createJob(input);
  now -= 10 * 60_000;
  assert.deepEqual(store.createJob(input), created);
  store.close();
}));

test("fails closed on unknown or malformed persisted schema", () => withRoot((paths) => {
  const store = createStore(paths).open();
  store.createJob(createInput());
  store.close();
  const filePath = path.join(paths.stateDir, "native-cron.json");
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  payload.unknown = true;
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  expectCode("CRON_STORE_CORRUPT", () => createStore(paths).open());

  const clean = {
    version: NATIVE_CRON_STORE_VERSION,
    revision: 0,
    idempotencyFloorMs: 0,
    jobs: {},
    operations: {},
  };
  assert.deepEqual(validateContainer(clean), clean);
  expectCode("CRON_STORE_CORRUPT", () => validateContainer({ ...clean, jobs: [] }));
  const unknownOperation = {
    operationId: "unknown-kind",
    kind: "future_mutation",
    fingerprint: "0".repeat(64),
    createdAt: BASE_TIME,
    resultType: "none",
    result: null,
  };
  expectCode("CRON_STORE_CORRUPT", () => validateContainer({
    ...clean,
    operations: { [unknownOperation.operationId]: unknownOperation },
  }));
}));

test("reopen 对旧版子分钟 every Job fail closed 而不静默执行", () => withRoot((paths) => {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const jobId = "00000000-0000-4000-8000-000000009999";
  const legacy = {
    version: 1,
    revision: 0,
    idempotencyFloorMs: 0,
    jobs: {
      [jobId]: {
        id: jobId,
        name: "Legacy sub-minute",
        enabled: true,
        profileId: PROFILE_ID,
        prompt: "Must not run silently",
        workspace: null,
        schedule: { kind: "every", everyMs: 1_000, anchorMs: 0 },
        misfirePolicy: "latest",
        maxCatchUp: 1,
        overlapPolicy: "skip",
        threadPolicy: "new",
        threadId: null,
        nextRunAt: 1_000,
        createdAt: 1,
        updatedAt: 1,
      },
    },
    operations: {},
  };
  fs.writeFileSync(
    path.join(paths.stateDir, "native-cron.json"),
    `${JSON.stringify(legacy)}\n`,
    { mode: 0o600 },
  );
  const store = createStore(paths);
  try {
    expectCode("CRON_STORE_CORRUPT", () => store.open());
  } finally {
    if (store.opened) store.close();
  }
}));

let passed = 0;
for (const entry of tests) {
  entry.run();
  passed += 1;
  console.log(`ok ${passed} - ${entry.name}`);
}
console.log(`[shoggoth-cron-store-unit] PASS ${passed}/${tests.length}`);
