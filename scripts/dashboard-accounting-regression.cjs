"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { HermesBackend } = require("../app/core/hermes-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { projectGrokUsage } = require("../app/agent-service/grok-build-usage");
const { reconcileGrokUsage } = require("../app/agent-service/grok-usage-reconcile");
const { estimateUsageCost } = require("../app/core/usage-cost");

(async () => {
  const now = Date.now(), start = new Date(now).setHours(0, 0, 0, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-accounting-"));
  const beforeHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = root;
  try {
    const db = path.join(root, "state.db");
    const today = start / 1000, recent = now / 1000;
    execFileSync("/usr/bin/sqlite3", [db, `
      CREATE TABLE sessions(id TEXT,title TEXT,source TEXT,model TEXT,started_at REAL,ended_at REAL,last_activity_at REAL,
        input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
        estimated_cost_usd REAL,actual_cost_usd REAL,billing_provider TEXT,api_call_count INTEGER,message_count INTEGER,tool_call_count INTEGER);
      CREATE TABLE messages(session_id TEXT,role TEXT,tool_name TEXT,tool_calls TEXT);
      CREATE TABLE session_model_usage(session_id TEXT,model TEXT,task TEXT,first_seen_at REAL,last_seen_at REAL,
        input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
        estimated_cost_usd REAL,actual_cost_usd REAL,billing_provider TEXT,api_call_count INTEGER);
      INSERT INTO sessions VALUES('old','Old','cli','gpt-5.6-luna',${today - 1},${today - 1},${today - 1},999,0,0,0,0,1,NULL,'openai',1,1,0);
      INSERT INTO sessions VALUES('today','Today','cli','gpt-5.6-luna',${today},${recent},${recent},100,50,20,10,30,NULL,NULL,'openai',1,1,0);
      INSERT INTO session_model_usage VALUES('today','auxiliary','compression',${today},${recent},5,5,0,0,0,0.2,NULL,'provider',1);
      INSERT INTO session_model_usage VALUES('today','primary-repeat','',${today},${recent},100,50,20,10,30,99,NULL,'provider',1);
    `]);
    const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local" }) });
    backend.profileById.set("hermes-default", "default");
    // No dashboard process: idle Agents still have history.
    assert.equal(backend._usageCostInfo({ model: "unknown", input_tokens: 100, cost_quality: "estimated", resolved_cost: 0 }).missing, 1);
    assert.equal(backend._usageCostInfo({ model: "unknown", input_tokens: 100, cost_quality: "reported", resolved_cost: 0 }).missing, 0);
    const original = fs.readFileSync(db);
    const series = await backend.getUsageSeries("today");
    assert.equal(series.totals.totalTokens, 190);
    assert.equal(series.totals.cacheWriteTokens, 10);
    assert.equal(series.totals.reasoningTokens, 30);
    assert.equal(series.totals.outputTokens, 25);
    assert.equal(series.totals.estimatedCostEntries, 2);
    assert.equal(series.totals.missingCostEntries, 0);
    assert.equal(series.availability, "complete");
    const expected = estimateUsageCost("gpt-5.6-luna", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 30 });
    assert.equal(series.totals.totalCost, expected + 0.2);
    assert.deepEqual(fs.readFileSync(db), original);
    execFileSync("/usr/bin/sqlite3", [db, `UPDATE sessions SET ended_at=${recent},last_activity_at=${recent} WHERE id='old';`]);
    assert.equal((await backend.getUsageSeries("today")).availability, "partial", "older cumulative sessions cannot be silently assigned to today");

    fs.mkdirSync(path.join(root, "cron"));
    execFileSync("/usr/bin/sqlite3", [path.join(root, "cron", "executions.db"), `
      CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT,error TEXT);
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<150)
      INSERT INTO executions SELECT 'run-'||x,'job','completed','${new Date(start-1000).toISOString()}',NULL,'${new Date(now).toISOString()}',NULL FROM n;
      INSERT INTO executions VALUES('preflight-failure','deleted-job','failed','${new Date(start).toISOString()}',NULL,'${new Date(now).toISOString()}','PREFLIGHT_FAILED');
    `]);
    backend.getCronJobs = async () => [];
    const history = await backend.getRecentCronRuns({ sinceMs: start, limit: 5000 });
    assert.equal(history.runs.filter(run => run.status === "ok").length, 150, "Cron ledger must exceed the HTTP session limit and include overnight completions");
    assert.equal(history.runs.filter(run => run.status === "error").length, 1, "No-session preflight failure is counted");
    assert.equal(history.truncated, undefined);
    backend.getCronJobs = async () => { throw new Error("job names unavailable"); };
    assert.equal((await backend.getRecentCronRuns({ sinceMs: start, limit: 5000 })).runs.length, 151,
      "Job metadata failure must not discard readable execution history");
    backend.getCronJobs = async () => [{ id: "hermes-default:job", agentId: "hermes-default", name: "Cron" }];
    backend._readCronExecutionHistory = async () => ({ items: [
      { id: "linked", jobId: "job", startedAt: start, finishedAt: start + 1000, status: "ok" },
      { id: "no-session", jobId: "job", startedAt: start + 2000, finishedAt: start + 3000, status: "error" },
    ] });
    backend.dashboards.set("default", { baseUrl: "http://fixture.invalid", token: "fixture" });
    backend._httpGetJson = async url => ({ status: 200, json: url.includes("/runs?") ? { runs: [
      { id: "cron-session", started_at: (start + 100) / 1000, ended_at: (start + 900) / 1000, preview: "scheduler input" },
      { id: "older-session", started_at: (start - 1000) / 1000, ended_at: (start - 500) / 1000 },
    ] } : { messages: [{ role: "assistant", content: "Completed output" }] } });
    const linked = await backend.getRecentCronRuns({ sinceMs: start, limit: 5000 });
    assert.equal(linked.runs.length, 2, "Session enrichment cannot add or duplicate execution counts");
    assert.equal(linked.runs.find(run => run.id === "linked").sessionKey, "cron-session");
    assert.equal(linked.runs.find(run => run.id === "linked").summary, "Completed output", "Keep the existing assistant summary and trajectory entry");
    assert.equal(linked.runs.find(run => run.id === "no-session").sessionKey, undefined);

    const profile = { id: "p", runtime: "grok-build", runtimeProfileId: "rp", runtimeAccountId: "ra", agentId: "grok-agent", name: "Grok" };
    const row = { turnNumber: 1, endedAt: new Date(start + 1).toISOString(), primaryModelId: "grok-4.6-build",
      totalTokens: 100, inputTokens: 90, outputTokens: 10, cachedReadTokens: 40, reasoningTokens: 5, costUsdTicks: 1_000_000_000 };
    const projected = projectGrokUsage({ sessionId: "session", session: { totalTokens: 9999 }, turns: [row, row,
      { ...row, turnNumber: 2, endedAt: new Date(start - 1).toISOString() }] }, { sessionId: "session", sinceMs: start, untilMs: now });
    assert.equal(projected.length, 1);
    assert.equal(projected[0].costUsd, 0.1);
    assert.equal(projected[0].usage.totalTokens, 100, "session cumulative history must not be added");
    assert.throws(() => projectGrokUsage({ sessionId: "other", turns: [row] }, { sessionId: "session" }));
    assert.throws(() => projectGrokUsage({ sessionId: "session", turns: [{ ...row, totalTokens: -1 }] }, { sessionId: "session" }));
    const recorded = [], usageStore = { list: () => recorded, record: value => recorded.push(value) };
    const run = { id: "run", profileId: "p", source: "inspiration", sourceId: "idea", status: "completed",
      startedAt: start, finishedAt: now, createdAt: start, workspace: root,
      runtimeSessionRef: { runtime: "grok-build", runtimeProfileId: "rp", runtimeAccountId: "ra", sessionId: "session" }, runtimeTurnRef: { turnId: "turn" } };
    let reads = 0;
    const input = { profiles: [profile], runs: [run], usageStore, sinceMs: start, now,
      readUsage: async () => { reads++; return projected; } };
    assert.equal(await reconcileGrokUsage(input), true);
    assert.equal(await reconcileGrokUsage(input), true);
    assert.equal(reads, 1); assert.equal(recorded.length, 1);
    assert.equal(recorded[0].source, "inspiration"); assert.equal(recorded[0].createdAt, start + 1);
    assert.equal(await reconcileGrokUsage({ ...input, usageStore: { ...usageStore, list: () => [] }, readUsage: async () => [] }), false);
    assert.equal(await reconcileGrokUsage({ ...input, runs: [{ ...run, runtimeSessionRef: { ...run.runtimeSessionRef, runtimeAccountId: "foreign" } }] }), false);

    const registry = new BackendRegistry();
    for (const [id, state] of [["good", "complete"], ["partial", "partial"], ["broken", "unavailable"]]) {
      registry.register({ id, name: id, getAgents: () => [], getStatus: async () => ({ id, name: id, connected: true, info: {} }),
        getRecentCronRuns: async () => ({ runs: [] }), getRecentKanbanActivities: async () => ({ supported: true, items: [] }),
        getRunningWork: async () => ({ supported: true, items: [] }), getPendingApprovals: async () => ({ supported: true, items: [] }),
        getRecentArtifacts: async () => ({ supported: true, items: [] }), getUsageSeries: async range => {
          if (range === "7d" || id === "broken") throw new Error("unavailable");
          return { daily: [], totals: { totalTokens: 100, totalCost: 1 }, availability: state };
        } });
    }
    const summary = await registry.getDashboardSummary();
    assert.equal(summary.usage.find(row => row.backend === "good").today.totalTokens, 100, "failed yesterday query must preserve today");
    assert.equal(summary.usage.find(row => row.backend === "partial").availability, "partial");
    assert.equal(summary.usage.find(row => row.backend === "broken").today, undefined);
    console.log("PASS Dashboard accounting: local day, idle Agent, auxiliary/cache/reasoning, estimates, Grok recovery/deduplication/ownership and failure isolation");
  } finally {
    if (beforeHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = beforeHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
