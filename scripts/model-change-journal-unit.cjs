#!/usr/bin/env node
"use strict";

// ModelChangeJournal 单测：所有文件均位于本测试创建的 mkdtemp 目录，退出时只清理这些目录。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ModelChangeJournalError,
  createEntry,
  createModelChangeJournal,
  isNonTerminalStatus,
} = require("../app/core/model-change-journal");

const tests = [];
const ownedDirectories = new Set();
const DEAD_PID = 2147483647;

/** 注册一个串行执行的单元测试，便于锁与 fake clock 用例保持确定性。 */
function test(name, run) {
  tests.push({ name, run });
}

/** 创建由当前测试拥有的临时目录及 journal 路径。 */
function tmpFile(name = "journal.json") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-model-change-journal-"));
  ownedDirectories.add(directory);
  return path.join(directory, name);
}

/** 生成满足恢复必填字段的最小 operation entry。 */
function entry(operationId, now = 1000, overrides = {}) {
  return createEntry({
    operationId,
    requestDigest: `request-${operationId}`,
    previewTokenDigest: `preview-${operationId}`,
    backendId: "openclaw",
    providerKey: "provider-a",
    kind: "rename",
    source: { provider: "provider-a", modelId: "old" },
    target: { provider: "provider-a", modelId: "new" },
    fingerprints: { config: "config-1" },
    ...overrides,
  }, now);
}

/** 生成固定 step schema，测试只覆盖 registry 明确声明的模型引用字段。 */
function referenceStep(scannerId, store, referenceKey, diff, startedAt = 1000) {
  return {
    scannerId,
    store,
    referenceKey,
    stage: "migrate-references",
    before: diff,
    after: diff,
    undo: diff,
    writeStatus: "verified",
    readback: diff,
    error: null,
    startedAt,
    finishedAt: startedAt + 1,
  };
}

/** 构造可手动推进的 interval clock，验证长阶段锁续租而不等待真实时间。 */
function fakeClock() {
  let current = 0;
  let nextId = 1;
  const intervals = new Map();
  return {
    now: () => current,
    timers: {
      setInterval(callback, delay) {
        const id = nextId++;
        intervals.set(id, { callback, delay, nextAt: current + delay });
        return id;
      },
      clearInterval(id) {
        intervals.delete(id);
      },
    },
    async advance(duration) {
      const target = current + duration;
      while (true) {
        let candidateId = null;
        let candidate = null;
        for (const [id, interval] of intervals) {
          if (interval.nextAt <= target && (!candidate || interval.nextAt < candidate.nextAt)) {
            candidateId = id;
            candidate = interval;
          }
        }
        if (!candidate) break;
        current = candidate.nextAt;
        candidate.callback();
        if (intervals.has(candidateId)) candidate.nextAt += candidate.delay;
        await Promise.resolve();
      }
      current = target;
      await Promise.resolve();
    },
  };
}

test("不存在文件时为空，原子写后重开保留阶段、步骤与 0600 权限", async () => {
  const file = tmpFile();
  const first = createModelChangeJournal(file, { now: () => 1001 });
  assert.equal(first.get("missing"), null);
  assert.deepEqual(first.listPending(), []);

  await first.withExclusiveLock("writer", async () => {
    first.begin(entry("op-persist", 1000, {
      modelDiff: { before: { id: "old" }, after: { id: "new" } },
    }));
    first.recordStep("op-persist", {
      scannerId: "openclaw.sessions.v1",
      store: "sessions",
      referenceKey: "session:1",
      stage: "migrate-references",
      before: { model: "provider-a/old" },
      after: { model: "provider-a/new" },
      undo: { model: "provider-a/old" },
      writeStatus: "verified",
      readback: { model: "provider-a/new" },
      error: null,
      startedAt: 1000,
      finishedAt: 1001,
    });
  });

  const reopened = createModelChangeJournal(file, { now: () => 2000 });
  assert.equal(reopened.get("op-persist").stage, "migrate-references");
  assert.deepEqual(reopened.get("op-persist").steps[0].undo, { model: "provider-a/old" });
  assert.equal(JSON.stringify(reopened.get("op-persist")).includes("credential-value"), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});

test("相同 operationId 同摘要幂等，不同摘要稳定报 operation_reused", async () => {
  const journal = createModelChangeJournal(tmpFile());
  await journal.withExclusiveLock("digest", async () => {
    const original = entry("op-digest");
    assert.equal(journal.begin(original).operationId, "op-digest");
    assert.equal(journal.begin(entry("op-digest")).operationId, "op-digest");
    assert.throws(
      () => journal.begin(entry("op-digest", 1000, { requestDigest: "another-digest" })),
      (error) => error instanceof ModelChangeJournalError && error.code === "operation_reused",
    );
  });
  assert.throws(
    () => journal.begin(entry("op-digest")),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_not_locked",
  );
  assert.throws(
    () => journal.begin(entry("op-digest", 1000, { requestDigest: "outside-conflict" })),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_not_locked",
  );
});

test("entry 与 step 使用固定字段白名单，恢复必填字段缺失即 fail-closed", async () => {
  const row = createEntry({ operationId: "op-schema", requestDigest: "digest-only" });
  assert.deepEqual(
    Object.keys(row).sort(),
    ["backendId", "commitState", "createdAt", "createdProvider", "error", "fingerprints",
      "kind", "mode", "modelDiff", "operationId", "previewTokenDigest", "providerDiff", "providerKey", "requestDigest",
      "result", "secretStep", "source", "stage", "status", "steps", "target", "updatedAt", "version"].sort(),
  );
  assert.equal(row.mode, "full");
  assert.equal(createEntry({ operationId: "op-co", requestDigest: "d", mode: "config-only" }).mode, "config-only");
  assert.equal(isNonTerminalStatus("cleanup_pending"), true);
  assert.equal(isNonTerminalStatus("applied"), false);

  const journal = createModelChangeJournal(tmpFile());
  await journal.withExclusiveLock("schema", async () => {
    assert.throws(
      () => journal.begin(row),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
    );
    assert.throws(
      () => journal.begin({ ...entry("op-extra"), unexpected: true }),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
    );
    journal.begin(entry("op-step"));
    assert.throws(
      () => journal.recordStep("op-step", {
        scannerId: "scanner", store: "sessions", referenceKey: "session:1", stage: "migrate-references",
        before: null, after: null, undo: null, writeStatus: "pending", readback: null, error: null,
        startedAt: 10, finishedAt: 9,
      }),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
    );
  });
});

test("深度拒绝 secret key 与任何带 userinfo 的 HTTP(S) URL", async () => {
  const journal = createModelChangeJournal(tmpFile());
  await journal.withExclusiveLock("secret", async () => {
    for (const [index, forbidden] of [
      { nested: { apiKey: "credential-value" } },
      { nested: [{ api_key: "credential-value" }] },
      { token: "credential-value" },
      { metadata: { Authorization: "Bearer credential-value" } },
      { endpoint: "https://user:pass@example.com/v1" },
      { nested: { "https://key-user:key-pass@example.com/v1": "value" } },
    ].entries()) {
      assert.throws(
        () => journal.begin(entry(`op-secret-${index}`, 1000, { fingerprints: forbidden })),
        (error) => error instanceof ModelChangeJournalError && error.code === "journal_secret",
      );
    }

    journal.begin(entry("op-safe-url", 1000, {
      fingerprints: { endpoint: "https://example.com/v1", previewTokenDigest: "safe-digest" },
    }));
    const beforeTextSecret = fs.readFileSync(journal.filePath, "utf8");
    const stateBeforeTextSecret = journal.get("op-safe-url");
    for (const rejectSecretText of [
      () => journal.setStage("op-safe-url", "blocked", { error: { message: "Authorization: Bearer credential-value" } }),
      () => journal.finish("op-safe-url", "failed", { message: "Authorization=Basic dXNlcjpwYXNz" }),
      () => journal.recordStep("op-safe-url", {
        ...referenceStep("openclaw.sessions.v1", "sessions", "session:secret", { model: "provider-a/old" }),
        error: "token=credential-value",
      }),
      () => journal.setStage("op-safe-url", "blocked", { error: { message: "apiKey: credential-value" } }),
      () => journal.setStage("op-safe-url", "blocked", { error: { message: "Bearer secret-token" } }),
      () => journal.finish("op-safe-url", "failed", { message: "Basic dXNlcjpwYXNz" }),
      () => journal.setStage("op-safe-url", "blocked", { error: { message: "Bearer supersecret" } }),
      () => journal.finish("op-safe-url", "failed", { message: "Basic YTpi" }),
      () => journal.setStage("op-safe-url", "blocked", { error: { message: "bearer token missing" } }),
      () => journal.recordStep("op-safe-url", {
        ...referenceStep("openclaw.sessions.v1", "sessions", "session:bare-secret", { model: "provider-a/old" }),
        error: { message: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" },
      }),
      () => journal.setStage("op-safe-url", "blocked", {
        error: { "Authorization: Bearer key-secret": "redacted" },
      }),
      () => journal.finish("op-safe-url", "failed", {
        nested: { "Authorization: Token supersecret": "redacted" },
      }),
      () => journal.recordStep("op-safe-url", {
        ...referenceStep("openclaw.sessions.v1", "sessions", "session:authorization-token", { model: "provider-a/old" }),
        error: { message: "Authorization=Token supersecret" },
      }),
      () => journal.setStage("op-safe-url", "blocked", {
        error: { message: "Incorrect API key provided: sk-review-secret" },
      }),
      () => journal.finish("op-safe-url", "failed", { nested: { "X-API-Key": "header-secret" } }),
      () => journal.recordStep("op-safe-url", {
        ...referenceStep("openclaw.sessions.v1", "sessions", "session:access-token", { model: "provider-a/old" }),
        error: { access_token: "access-secret" },
      }),
      () => journal.begin(entry("op-secret-aliases", 1000, {
        fingerprints: {
          refresh_token: "refresh-secret",
          client_secret: "client-secret",
          password: "password-secret",
          credential: "credential-secret",
        },
      })),
      () => journal.finish("op-safe-url", "failed", { message: "provider returned sk-short-secret" }),
      () => journal.finish("op-safe-url", "failed", { message: "provider returned ghp_reviewtoken" }),
      () => journal.finish("op-safe-url", "failed", { message: "provider returned xoxb-review-token" }),
      () => journal.finish("op-safe-url", "failed", { message: "provider returned AKIAREVIEWTOKEN" }),
      () => journal.finish("op-safe-url", "failed", { message: "provider returned AIzaReviewToken" }),
      () => journal.finish("op-safe-url", "failed", { "token=result-key-secret": "redacted" }),
      () => journal.recordStep("op-safe-url", {
        ...referenceStep("openclaw.sessions.v1", "sessions", "session:key-secret", { model: "provider-a/old" }),
        error: { "apiKey=step-key-secret": "redacted" },
      }),
      () => journal.begin(entry("op-fingerprint-key-secret", 1000, {
        fingerprints: { nested: { "Authorization=Basic a2V5OnNlY3JldA==": "redacted" } },
      })),
    ]) {
      assert.throws(
        rejectSecretText,
        (error) => error instanceof ModelChangeJournalError
          && error.code === "journal_secret"
          && !/(?:credential-value|secret-token|supersecret|YTpi|key-secret|review|header-secret|access-secret|a2V5OnNlY3JldA)/i.test(error.message),
      );
      assert.equal(fs.readFileSync(journal.filePath, "utf8"), beforeTextSecret);
      assert.deepEqual(journal.get("op-safe-url"), stateBeforeTextSecret);
      assert.equal(journal.get("op-fingerprint-key-secret"), null);
      assert.equal(journal.get("op-secret-aliases"), null);
    }

    journal.setStage("op-safe-url", "blocked", {
      fingerprints: { tokenDigest: "digest-is-safe", passwordHash: "hash-is-safe" },
    });
    assert.deepEqual(journal.get("op-safe-url").fingerprints, {
      tokenDigest: "digest-is-safe", passwordHash: "hash-is-safe",
    });
  });
  assert.equal(fs.readFileSync(journal.filePath, "utf8").includes("credential-value"), false);
});

test("lock owner 复用统一 secret 策略且有界，拒绝后不创建 lock 文件", async () => {
  for (const owner of [
    "Authorization: Bearer owner-secret",
    "Incorrect API key provided: sk-owner-secret",
    "x".repeat(201),
  ]) {
    const file = tmpFile("secret-owner.json");
    const journal = createModelChangeJournal(file);
    await assert.rejects(
      journal.withExclusiveLock(owner, async () => {}),
      (error) => error instanceof ModelChangeJournalError
        && (error.code === "journal_secret" || error.code === "journal_schema")
        && !/(?:owner-secret|sk-owner-secret)/i.test(error.message),
    );
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
});

test("modelDiff 与 reference step 只接受封闭 registry 声明的公共模型字段", async () => {
  const journal = createModelChangeJournal(tmpFile(), { now: () => 2000 });
  const publicModel = {
    id: "old", name: "Old", provider: "provider-a", backendId: "openclaw", profile: "default",
    contextWindow: 8192, maxTokens: 1024, reasoning: false,
    pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    acpProviderRef: "custom:provider-a",
  };
  const validReferences = [
    ["openclaw.config.v2", "config", { model: "provider-a/old", primary: "provider-a/old", fallbacks: ["provider-a/fallback"] }],
    ["openclaw.sessions.v1", "sessions", { model: "provider-a/old" }],
    ["openclaw.cron.v1", "cron", { provider: "provider-a", model: "old", fallbacks: ["fallback"] }],
    ["hermes.provider.v1", "provider", { profile: "default", provider: "provider-a", modelId: "old", model: publicModel }],
    ["hermes.main.v1", "main", { profile: "default", provider: "provider-a", model: "old" }],
    ["hermes.auxiliary.v1", "auxiliary", { profile: "default", provider: "provider-a", model: "old" }],
    ["hermes.cron.v1", "cron", { profile: "default", provider: "provider-a", model: "old", fallbacks: ["fallback"] }],
    ["hermes.sessions.v1", "sessions", { profile: "default", model: "old" }],
  ];

  await journal.withExclusiveLock("diff-registry", async () => {
    journal.begin(entry("op-valid-diff", 1000, { modelDiff: { before: publicModel, after: { ...publicModel, id: "new" } } }));
    journal.begin(entry("op-valid-profile-diff", 1000, {
      modelDiff: {
        before: publicModel,
        after: { ...publicModel, contextWindow: 16384 },
        profiles: [
          { profile: "bull", before: { ...publicModel, profile: "bull", contextWindow: 4096 }, after: { ...publicModel, profile: "bull", contextWindow: 16384 } },
          { profile: "default", before: { ...publicModel, profile: "default", contextWindow: 8192 }, after: { ...publicModel, profile: "default", contextWindow: 16384 } },
        ],
      },
    }));
    assert.equal(journal.get("op-valid-profile-diff").modelDiff.profiles.length, 2);
    validReferences.forEach(([scannerId, store, diff], index) => {
      journal.recordStep("op-valid-diff", referenceStep(scannerId, store, `reference:${index}`, diff, 1000 + index));
    });

    for (const [operationId, modelDiff] of [
      ["op-model-field", { before: { id: "old", unknown: true }, after: { id: "new" } }],
      ["op-provider-subtree", { before: { id: "old", models: [{ id: "nested" }] }, after: { id: "new" } }],
    ]) {
      assert.throws(
        () => journal.begin(entry(operationId, 1000, { modelDiff })),
        (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
      );
    }

    for (const [scannerId, store, diff] of [
      ["unknown.sessions.v1", "sessions", { model: "old" }],
      ["openclaw.sessions.v1", "cron", { model: "old" }],
      ["openclaw.sessions.v1", "sessions", { payload: "old" }],
      ["hermes.provider.v1", "provider", { profile: "default", providerConfig: { models: [{ id: "old" }] } }],
    ]) {
      assert.throws(
        () => journal.recordStep("op-valid-diff", referenceStep(scannerId, store, "invalid", diff)),
        (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
      );
    }

    const stepsBeforeNullDiff = journal.get("op-valid-diff").steps;
    const fileBeforeNullDiff = fs.readFileSync(journal.filePath, "utf8");
    assert.throws(
      () => journal.recordStep("op-valid-diff", {
        scannerId: "unknown.null-only.v1",
        store: "unknown-store",
        referenceKey: "unknown:null-only",
        stage: "migrate-references",
        before: null,
        after: null,
        undo: null,
        writeStatus: "pending",
        readback: null,
        error: null,
        startedAt: 1500,
        finishedAt: 1501,
      }),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
    );
    assert.deepEqual(journal.get("op-valid-diff").steps, stepsBeforeNullDiff);
    assert.equal(fs.readFileSync(journal.filePath, "utf8"), fileBeforeNullDiff);
  });
});

test("Provider diff 接受逐 Profile 安全摘要并拒绝重复或未知字段", async () => {
  const journal = createModelChangeJournal(tmpFile());
  const digest = (char) => char.repeat(64);
  const valid = {
    beforeDigest: digest("a"),
    afterDigest: digest("b"),
    profiles: [
      { profile: "bull", beforeDigest: digest("c"), afterDigest: digest("d") },
      { profile: "default", beforeDigest: digest("e"), afterDigest: digest("f") },
    ],
  };
  await journal.withExclusiveLock("provider-diff", async () => {
    journal.begin(entry("provider-diff-valid", 1000, { kind: "update-provider", providerDiff: valid }));
    assert.deepEqual(journal.get("provider-diff-valid").providerDiff, valid);
    const invalidDiffs = [
      { ...valid, profiles: [valid.profiles[0], valid.profiles[0]] },
      { ...valid, profiles: [{ ...valid.profiles[0], endpoint: "https://secret.example" }] },
    ];
    for (const [index, providerDiff] of invalidDiffs.entries()) {
      assert.throws(
        () => journal.begin(entry(`provider-diff-bad-${index}`, 1000, { kind: "update-provider", providerDiff })),
        (error) => error instanceof ModelChangeJournalError
          && (error.code === "journal_schema" || error.code === "journal_secret"),
      );
    }
  });
});

test("所有 mutator 只能在 global exclusive lock 内调用", async () => {
  const journal = createModelChangeJournal(tmpFile());
  assert.throws(
    () => journal.begin(entry("outside")),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_not_locked",
  );
  await journal.withProviderLock("openclaw:provider-a", "provider-only", async () => {
    assert.throws(
      () => journal.begin(entry("provider-only")),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_not_locked",
    );
  });
});

test("同实例其他异步上下文不能借用正在持有的 global lock", async () => {
  const journal = createModelChangeJournal(tmpFile());
  let signalStarted;
  let releaseHolder;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const holder = new Promise((resolve) => { releaseHolder = resolve; });
  const locked = journal.withExclusiveLock("async-holder", async () => {
    signalStarted();
    await holder;
  });
  await started;
  assert.throws(
    () => journal.begin(entry("borrowed-lock")),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_not_locked",
  );
  releaseHolder();
  await locked;
});

test("commitState 只允许 precommit 到 committing 再到 committed", async () => {
  const journal = createModelChangeJournal(tmpFile());
  await journal.withExclusiveLock("transition", async () => {
    journal.begin(entry("op-transition"));
    journal.setStage("op-transition", "commit-retire", { commitState: "committing" });
    journal.setStage("op-transition", "verify-ready", { commitState: "committed" });
    assert.throws(
      () => journal.setStage("op-transition", "rollback", { commitState: "precommit" }),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_transition",
    );
  });
});

test("prune 永远保留非终态，只删除 30 天前终态并把近期终态限制为 200 条", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let current = 0;
  const journal = createModelChangeJournal(tmpFile(), { now: () => current });
  await journal.withExclusiveLock("prune", async () => {
    journal.begin(entry("old-terminal", 0));
    journal.finish("old-terminal", "failed", { code: "old" });
    journal.begin(entry("old-pending", 0));
    journal.finish("old-pending", "cleanup_pending", { code: "pending" });

    current = 31 * DAY;
    for (let index = 0; index < 205; index += 1) {
      const operationId = `recent-${String(index).padStart(3, "0")}`;
      journal.begin(entry(operationId, current));
      journal.finish(operationId, "applied", { operationId });
    }
    journal.prune();
  });

  assert.equal(journal.get("old-terminal"), null);
  assert.equal(journal.get("old-pending").status, "cleanup_pending");
  const terminal = Array.from({ length: 205 }, (_, index) => journal.get(`recent-${String(index).padStart(3, "0")}`))
    .filter(Boolean);
  assert.equal(terminal.length, 200);
  assert.deepEqual(journal.listPending().map((row) => row.operationId), ["old-pending"]);
});

test("损坏 JSON、损坏 schema 与父路径不可写都 fail-closed，不降级内存", async () => {
  const corrupt = tmpFile();
  fs.writeFileSync(corrupt, "{not-json", { mode: 0o600 });
  assert.throws(
    () => createModelChangeJournal(corrupt),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_corrupt",
  );

  const invalid = tmpFile();
  fs.writeFileSync(invalid, JSON.stringify({ version: 1, operations: [{ operationId: "incomplete" }] }), { mode: 0o600 });
  assert.throws(
    () => createModelChangeJournal(invalid),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_schema",
  );

  const directory = path.dirname(tmpFile());
  const blocker = path.join(directory, "parent-is-file");
  fs.writeFileSync(blocker, "block", { mode: 0o600 });
  assert.throws(
    () => createModelChangeJournal(path.join(blocker, "journal.json")),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_read",
  );

  const writeFailure = tmpFile();
  const noFallback = createModelChangeJournal(writeFailure);
  await noFallback.withExclusiveLock("initialize", async () => {
    noFallback.begin(entry("persisted-before-failure"));
  });
  await assert.rejects(
    noFallback.withExclusiveLock("write-failure", async () => {
      fs.unlinkSync(writeFailure);
      fs.mkdirSync(writeFailure);
      noFallback.begin(entry("must-not-stay-in-memory"));
    }),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_write",
  );
  assert.throws(
    () => noFallback.get("must-not-stay-in-memory"),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_read",
  );
  fs.rmdirSync(writeFailure);
  assert.equal(noFallback.get("must-not-stay-in-memory"), null);
});

test("原子写 pre-rename 失败不提交，parent fsync 失败则磁盘与内存一致标记已提交", async () => {
  const preFile = tmpFile("pre-rename.json");
  let failBeforeRename = false;
  const preJournal = createModelChangeJournal(preFile, {
    faults: {
      beforeRename() {
        if (failBeforeRename) throw new Error("injected pre-rename failure");
      },
    },
  });
  await preJournal.withExclusiveLock("pre-rename", async () => {
    failBeforeRename = true;
    assert.throws(
      () => preJournal.begin(entry("pre-not-committed")),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_write" && error.committed === false,
    );
    failBeforeRename = false;
    assert.equal(preJournal.get("pre-not-committed"), null);
  });
  assert.equal(createModelChangeJournal(preFile).get("pre-not-committed"), null);

  const postFile = tmpFile("post-rename.json");
  let failParentFsync = false;
  const postJournal = createModelChangeJournal(postFile, {
    faults: {
      beforeParentFsync() {
        if (failParentFsync) throw new Error("injected parent fsync failure");
      },
    },
  });
  await postJournal.withExclusiveLock("post-rename", async () => {
    failParentFsync = true;
    assert.throws(
      () => postJournal.begin(entry("post-committed")),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_write" && error.committed === true,
    );
    failParentFsync = false;
    assert.equal(postJournal.get("post-committed").operationId, "post-committed");
  });
  assert.equal(createModelChangeJournal(postFile).get("post-committed").operationId, "post-committed");
  assert.equal(fs.statSync(postFile).mode & 0o777, 0o600);
});

test("跨实例 get/listPending 每次读取原子文件最新真值，损坏仍 fail-closed", async () => {
  const file = tmpFile("fresh-read.json");
  const first = createModelChangeJournal(file);
  const second = createModelChangeJournal(file);
  await first.withExclusiveLock("fresh-a", async () => {
    first.begin(entry("fresh-op"));
  });
  assert.equal(second.get("fresh-op").status, "in_progress");
  assert.deepEqual(second.listPending().map((row) => row.operationId), ["fresh-op"]);

  await first.withExclusiveLock("fresh-finish", async () => {
    first.finish("fresh-op", "applied", { ok: true });
  });
  assert.equal(second.get("fresh-op").status, "applied");
  assert.deepEqual(second.listPending(), []);

  fs.writeFileSync(file, "{corrupt-after-construction", { mode: 0o600 });
  assert.throws(
    () => second.get("fresh-op"),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_corrupt",
  );
  assert.throws(
    () => second.listPending(),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_corrupt",
  );
});

test("global/provider lock 跨实例互斥，不同 Provider scope 可并行", async () => {
  const first = createModelChangeJournal(tmpFile());
  const second = createModelChangeJournal(first.filePath);
  await first.withExclusiveLock("owner-1", async () => {
    await assert.rejects(
      second.withExclusiveLock("owner-2", async () => {}),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
    );
    first.begin(entry("owned-write"));
  });

  await first.withProviderLock("openclaw:provider-a", "owner-1", async () => {
    await assert.rejects(
      second.withProviderLock("openclaw:provider-a", "owner-2", async () => {}),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
    );
    await second.withProviderLock("openclaw:provider-b", "owner-3", async () => {});
  });
});

test("过期锁可接管，释放时 nonce 不匹配绝不删除后来者锁", async () => {
  const file = tmpFile();
  const lockPath = `${file}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ owner: "dead", pid: DEAD_PID, nonce: "a".repeat(32), expiresAt: 0 }), { mode: 0o600 });
  const journal = createModelChangeJournal(file, { now: () => 1000 });
  await journal.withExclusiveLock("takeover", async () => {});
  const releasedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(releasedLock.owner, "released");
  assert.equal(releasedLock.pid, 0);

  await assert.rejects(
    journal.withExclusiveLock("old-owner", async () => {
      const oldInode = `${lockPath}.old-inode`;
      fs.renameSync(lockPath, oldInode);
      fs.writeFileSync(lockPath, JSON.stringify({
        owner: "new-owner", pid: process.pid, nonce: "b".repeat(32), expiresAt: 9999,
      }), { mode: 0o600 });
    }),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
  );
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, "b".repeat(32));
  const oldInode = JSON.parse(fs.readFileSync(`${lockPath}.old-inode`, "utf8"));
  assert.equal(oldInode.owner, "released");
  assert.equal(oldInode.pid, 0);
  assert.equal(oldInode.expiresAt, 0);

  const inPlaceFile = tmpFile("in-place-owner.json");
  const inPlaceLock = `${inPlaceFile}.lock`;
  const inPlaceJournal = createModelChangeJournal(inPlaceFile, { now: () => 1000 });
  await assert.rejects(
    inPlaceJournal.withExclusiveLock("old-in-place", async () => {
      fs.writeFileSync(inPlaceLock, JSON.stringify({
        owner: "later-in-place", pid: process.pid, nonce: "f".repeat(32), expiresAt: 9999,
      }), { mode: 0o600 });
    }),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
  );
  assert.equal(JSON.parse(fs.readFileSync(inPlaceLock, "utf8")).nonce, "f".repeat(32));
});

test("过期锁 owner PID 仍存活时不可接管，global mutator 会同步续租", async () => {
  let current = 0;
  const first = createModelChangeJournal(tmpFile(), { now: () => current, lockTtlMs: 10 });
  const second = createModelChangeJournal(first.filePath, { now: () => current, lockTtlMs: 10 });
  await first.withExclusiveLock("live-owner", async () => {
    current = 20;
    await assert.rejects(
      second.withExclusiveLock("same-process-contender", async () => {}),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
    );
    first.begin(entry("renewed-live-owner", current));
    const lock = JSON.parse(fs.readFileSync(`${first.filePath}.lock`, "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.expiresAt, 30);
  });
});

test("stale rename 后内容损坏必须恢复或保留未确认 inode，不能 cleanup 删除", async () => {
  const file = tmpFile("stale-corrupt.json");
  const lockPath = `${file}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: "dead", pid: DEAD_PID, nonce: "d".repeat(32), expiresAt: 0,
  }), { mode: 0o600 });
  const originalRename = fs.renameSync;
  const originalExists = fs.existsSync;
  const originalLink = fs.linkSync;
  let injected = false;
  let contenderCreated = false;
  let contenderInode = null;
  const contender = {
    owner: "new-contender", pid: process.pid, nonce: "9".repeat(32), expiresAt: 9999,
  };
  function createContender() {
    if (contenderCreated) return;
    fs.writeFileSync(lockPath, JSON.stringify(contender), { mode: 0o600 });
    contenderInode = fs.statSync(lockPath).ino;
    contenderCreated = true;
  }
  fs.renameSync = function renameAndCorrupt(source, target) {
    originalRename.call(fs, source, target);
    if (!injected && source === lockPath && target.includes(".stale-")) {
      injected = true;
      fs.writeFileSync(target, "{corrupt-stale", { mode: 0o600 });
    }
  };
  fs.existsSync = function existsAndRace(target) {
    if (injected && !contenderCreated && target === lockPath) {
      const existedBefore = originalExists.call(fs, target);
      createContender();
      return existedBefore;
    }
    return originalExists.call(fs, target);
  };
  fs.linkSync = function linkAndRace(source, target) {
    if (injected && !contenderCreated && target === lockPath) createContender();
    return originalLink.call(fs, source, target);
  };
  try {
    const journal = createModelChangeJournal(file, { now: () => 1000 });
    await assert.rejects(
      journal.withExclusiveLock("takeover-corrupt", async () => {}),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_lock_corrupt",
    );
  } finally {
    fs.renameSync = originalRename;
    fs.existsSync = originalExists;
    fs.linkSync = originalLink;
  }
  const staleFiles = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".stale-"));
  assert.equal(contenderCreated, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, contender.nonce);
  assert.equal(fs.statSync(lockPath).ino, contenderInode);
  assert.equal(staleFiles.length > 0, true);
});

test("lock schema 拒绝额外字段与非安全 hex nonce，且不生成路径注入 stale 文件", async () => {
  for (const [name, lock] of [
    ["extra", { owner: "owner", pid: 1, nonce: "c".repeat(32), expiresAt: 0, unexpected: true }],
    ["unsafe-nonce", { owner: "owner", pid: 1, nonce: "../escape", expiresAt: 0 }],
    ["unsafe-owner", {
      owner: "Authorization: Bearer lock-secret", pid: DEAD_PID, nonce: "d".repeat(32), expiresAt: 0,
    }],
  ]) {
    const file = tmpFile(`${name}.json`);
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify(lock), { mode: 0o600 });
    const journal = createModelChangeJournal(file, { now: () => 1000 });
    await assert.rejects(
      journal.withExclusiveLock("new-owner", async () => {}),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_lock_corrupt",
    );
    assert.equal(fs.readdirSync(path.dirname(file)).some((entryName) => entryName.includes(".stale-")), false);
  }
});

test("Provider lock 在单阶段超过 TTL 时仍由心跳持续续租", async () => {
  const clock = fakeClock();
  const first = createModelChangeJournal(tmpFile(), { now: clock.now, lockTtlMs: 90, timers: clock.timers });
  const second = createModelChangeJournal(first.filePath, { now: clock.now, lockTtlMs: 90, timers: clock.timers });
  await first.withProviderLock("openclaw:provider-a", "slow-owner", async () => {
    await clock.advance(300);
    await assert.rejects(
      second.withProviderLock("openclaw:provider-a", "other", async () => {}),
      (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
    );
  });
});

test("Provider guard 暴露 token/signal/checkpoint，所有权丢失后 abort 且不能报告成功", async () => {
  const file = tmpFile("provider-guard.json");
  const journal = createModelChangeJournal(file, { now: () => 1000 });
  let mutationWrites = 0;
  await assert.rejects(
    journal.withProviderLock("openclaw:provider-a", "guard-owner", async (guard) => {
      assert.match(guard.token, /^[0-9a-f]{32}$/);
      assert.equal(guard.signal.aborted, false);
      guard.assertActive();
      const providerLock = fs.readdirSync(path.dirname(file))
        .map((name) => path.join(path.dirname(file), name))
        .find((candidate) => candidate.startsWith(`${file}.provider-`) && candidate.endsWith(".lock"));
      fs.renameSync(providerLock, `${providerLock}.lost-owner`);
      fs.writeFileSync(providerLock, JSON.stringify({
        owner: "replacement", pid: process.pid, nonce: "e".repeat(32), expiresAt: 9999,
      }), { mode: 0o600 });
      assert.throws(
        () => guard.assertActive(),
        (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
      );
      assert.equal(guard.signal.aborted, true);
      if (!guard.signal.aborted) mutationWrites += 1;
    }),
    (error) => error instanceof ModelChangeJournalError && error.code === "journal_locked",
  );
  assert.equal(mutationWrites, 0);
});

/** 串行运行并在 finally 中只删除本测试创建的目录。 */
(async () => {
  try {
    const filter = process.env.MODEL_JOURNAL_TEST_FILTER || "";
    for (const { name, run } of tests.filter((row) => !filter || row.name.includes(filter))) {
      await run();
      process.stdout.write(`ok - ${name}\n`);
    }
    process.stdout.write("model change journal unit: PASS\n");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const directory of ownedDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
})();
