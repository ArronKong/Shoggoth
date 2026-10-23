#!/usr/bin/env node
"use strict";

// Read-only measurement of native Agent fixed context overhead.
//
// For every Shoggoth transcript, take the first turn that called no tools: its
// Runtime-reported input tokens are the fixed request (CLI prompt and tools,
// Shoggoth rules, product tools, memory) plus one short user message. Usage is
// what the CLI reported, not a local estimate. Nothing is written.
//
// Usage: node scripts/native-context-overhead-measure.cjs [--root <shoggoth-core>] [--json]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_ROOT = path.join(os.homedir(), "Library", "Application Support", "Shoggoth", "shoggoth-core");

// events: transcript payloads in order. Returns the first tool-free turn's usage.
function firstToolFreeTurn(events) {
  let sawUser = false, tools = 0;
  for (const event of events) {
    if (event?.kind === "user") { sawUser = true; tools = 0; continue; }
    if (event?.kind === "tool_call") { tools += 1; continue; }
    const content = event?.content;
    if (event?.kind !== "status" || content?.transcriptType !== "terminal") continue;
    if (!sawUser) continue;
    const usage = content.responseMetadata?.usage;
    if (tools !== 0 || !Number.isSafeInteger(usage?.inputTokens)) return null;
    return { runtime: event.runtimeRef?.runtime ?? null, inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? null, occurredAt: event.occurredAt ?? null };
  }
  return null;
}

function summarize(samples) {
  const byRuntime = new Map();
  for (const sample of samples) {
    if (!sample?.runtime) continue;
    if (!byRuntime.has(sample.runtime)) byRuntime.set(sample.runtime, []);
    byRuntime.get(sample.runtime).push(sample);
  }
  return [...byRuntime].sort(([a], [b]) => a.localeCompare(b)).map(([runtime, list]) => {
    const values = list.map(item => item.inputTokens).sort((a, b) => a - b);
    const latest = list.reduce((a, b) => ((b.occurredAt ?? 0) > (a.occurredAt ?? 0) ? b : a));
    return { runtime, samples: values.length, min: values[0], median: values[Math.floor((values.length - 1) / 2)],
      max: values.at(-1), latest: latest.inputTokens, latestAt: latest.occurredAt };
  });
}

function readTranscript(file) {
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line).payload); } catch { /* skip a torn line */ }
  }
  return events;
}

function measure(root = DEFAULT_ROOT) {
  const agents = path.join(root, "agents");
  const samples = [];
  for (const agent of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
    const transcripts = path.join(agents, agent, "transcripts");
    if (!fs.existsSync(transcripts)) continue;
    for (const session of fs.readdirSync(transcripts)) {
      const file = path.join(transcripts, session, "events.jsonl");
      if (!fs.existsSync(file)) continue;
      const sample = firstToolFreeTurn(readTranscript(file));
      if (sample) samples.push(sample);
    }
  }
  return summarize(samples);
}

module.exports = { firstToolFreeTurn, summarize, measure };

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const rows = measure(rootIndex >= 0 ? args[rootIndex + 1] : DEFAULT_ROOT);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    for (const row of rows) {
      console.log(`${row.runtime.padEnd(18)} n=${String(row.samples).padStart(3)}  min=${row.min}  median=${row.median}`
        + `  max=${row.max}  latest=${row.latest}`);
    }
  }
}
