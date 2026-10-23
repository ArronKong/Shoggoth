"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { firstToolFreeTurn, summarize, measure } = require("./native-context-overhead-measure.cjs");

const terminal = (runtime, inputTokens, occurredAt = 1) => ({ kind: "status", occurredAt, runtimeRef: { runtime },
  content: { transcriptType: "terminal", responseMetadata: { usage: { inputTokens, cachedInputTokens: 0 } } } });

test("only a first turn without tool calls measures the fixed request", () => {
  assert.equal(firstToolFreeTurn([{ kind: "user" }, terminal("pi", 55000)]).inputTokens, 55000);
  assert.equal(firstToolFreeTurn([{ kind: "user" }, { kind: "tool_call" }, terminal("pi", 90000)]), null,
    "a first turn that used tools includes tool results and repeated calls");
  assert.equal(firstToolFreeTurn([terminal("pi", 1), { kind: "user" }, terminal("pi", 40000)]).inputTokens, 40000,
    "a terminal event before any user message is not a turn");
  assert.equal(firstToolFreeTurn([{ kind: "user" }, { kind: "status", content: { transcriptType: "terminal" } }]), null);
});

test("summaries group by runtime with min, median, max and the latest sample", () => {
  const rows = summarize([{ runtime: "codex", inputTokens: 30000, occurredAt: 1 },
    { runtime: "codex", inputTokens: 36000, occurredAt: 3 }, { runtime: "codex", inputTokens: 29000, occurredAt: 2 },
    { runtime: "grok-build", inputTokens: 44000, occurredAt: 1 }]);
  assert.deepEqual(rows.map(row => [row.runtime, row.samples, row.min, row.median, row.max, row.latest]),
    [["codex", 3, 29000, 30000, 36000, 36000], ["grok-build", 1, 44000, 44000, 44000, 44000]]);
});

test("measure reads transcripts read-only from a Shoggoth core directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-overhead-"));
  try {
    const dir = path.join(root, "agents", "a", "transcripts", "s");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), [{ kind: "user" }, terminal("opencode", 67000)]
      .map(payload => JSON.stringify({ payload })).join("\n") + "\n{torn");
    assert.deepEqual(measure(root).map(row => [row.runtime, row.latest]), [["opencode", 67000]]);
    assert.deepEqual(measure(path.join(root, "missing")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
