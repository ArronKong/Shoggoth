"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { cronOutputDecision, publicCronTranscript, cronUnattendedCompletionError } = require("../app/agent-service/cron-output-policy");

const start = { id: "start", runId: "run", kind: "user", content: { cronOutputVersion: 1, text: "check" } };
const run = { id: "run", source: "cron", status: "completed", resultSummary: "NO_REPLY" };

test("a denied unattended run must report a result, preserving full reports and actual artifacts", () => {
  const denied = { runId: "run", kind: "status", content: { transcriptType: "cron.authorization", decision: "deny" } };
  const message = { runId: "run", kind: "assistant", content: { phase: "final_answer", text: "NO_REPLY" } };
  assert.equal(cronUnattendedCompletionError(run, [denied, message], null), "CRON_AUTHORIZATION_DENIED");
  assert.equal(cronUnattendedCompletionError(run, [denied], null), "CRON_AUTHORIZATION_DENIED");
  assert.equal(cronUnattendedCompletionError(run, [denied, message], null,
    event => ({ ...event, content: { ...event.content, text: "NO_REPLY" + " ".repeat(20000) + "Alternative result" } })), null);
  assert.equal(cronUnattendedCompletionError(run, [denied, { runId: "run", kind: "artifact" }], null), null);
  assert.equal(cronUnattendedCompletionError({ ...run, source: "chat" }, [denied, message], null), null);
  assert.equal(cronUnattendedCompletionError(run, [message], null), null);
});

test("only successful managed cron runs with an exact silent final are suppressed", () => {
  for (const token of ["NO_REPLY", "[SILENT]", "NO_RESET", " \nNO_REPLY\t"]) {
    assert.equal(cronOutputDecision({ ...run, resultSummary: token }, [start]).disposition, "silent");
  }
  for (const text of ["found a reset\nNO_REPLY", "The token is NO_REPLY", "`NO_REPLY`", "no_reply"]) {
    assert.equal(cronOutputDecision({ ...run, resultSummary: text }, [start]).disposition, "deliver");
  }
  for (const status of ["failed", "canceled", "interrupted", "skipped"]) {
    assert.equal(cronOutputDecision({ ...run, status }, [start]).disposition, "deliver");
  }
  assert.equal(cronOutputDecision({ ...run, status: "running" }, [start]).disposition, "pending");
  assert.equal(cronOutputDecision(run, []), null, "historical runs keep their projection");
  assert.equal(cronOutputDecision({ ...run, source: "chat" }, [start]), null);
  assert.equal(cronOutputDecision(run, [start, { runId: "run", kind: "assistant",
    content: { text: "NO_REPLY" + " ".repeat(20000) + "Actual report", phase: "final_answer" } }]).disposition, "deliver");
  assert.equal(cronOutputDecision({ ...run, resultSummary: null }, [start, { runId: "run", kind: "assistant",
    content: { text: "NO_REPLY", phase: "final_answer" } }]).disposition, "silent", "status-only terminal uses durable final text");
});

test("successful empty output is silent only when no real assistant or artifact was published", () => {
  const empty = { ...run, resultSummary: null };
  assert.equal(cronOutputDecision(empty, [start]).reason, "empty");
  assert.equal(cronOutputDecision(empty, [start, { runId: "run", kind: "assistant", content: { text: "done" } }]).disposition, "deliver");
  assert.equal(cronOutputDecision(empty, [start, { runId: "run", kind: "artifact", content: {} }]).disposition, "deliver");
});

test("public history suppresses pending and silent runs before pagination while retaining interactive failures and other runs", () => {
  const events = [start, { runId: "run", kind: "assistant", content: { text: "checking" } },
    { runId: "run", kind: "tool_call", content: {} }, { runId: "run", kind: "input", content: {} },
    { runId: "run", kind: "error", content: {} }, { runId: "chat", kind: "assistant", content: { text: "hello" } }];
  const decisions = new Map([["run", { disposition: "pending" }]]);
  assert.deepEqual(publicCronTranscript(events, id => decisions.get(id)), events.slice(3));
  decisions.set("run", { disposition: "silent" });
  assert.deepEqual(publicCronTranscript(events, id => decisions.get(id)), events.slice(3));
  decisions.set("run", { disposition: "deliver" });
  assert.deepEqual(publicCronTranscript(events, id => decisions.get(id)), events);
});
