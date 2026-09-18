#!/usr/bin/env node

// Regression: BUG-013 — cron trajectory/delivery must only read the local
// transcript that belongs to the requested job. User-supplied sessionKey values
// must not cross jobs, escape an agent sessions directory, or touch local disk
// while the configured gateway is remote.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OpenClawBackend } = require("../app/core/openclaw-backend.js");

const previousHome = process.env.OPENCLAW_HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-trajectory-"));
process.env.OPENCLAW_HOME = tempHome;

try {
  const sessionsDir = path.join(tempHome, "agents", "worker", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "run-a.jsonl"),
    `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "job-a result" }] } })}\n`,
  );

  const local = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:18792" });
  const validKey = "agent:worker:cron:job-a:run:run-a";
  assert.equal(
    local._cronRunTranscriptPath("openclaw:job-a", validKey),
    path.join(sessionsDir, "run-a.jsonl"),
    "matching job/run should resolve inside the agent sessions directory",
  );
  assert.equal(
    local._cronRunTranscriptPath(
      "openclaw:group/job-a",
      "agent:worker:cron:group/job-a:run:run-a",
    ),
    path.join(sessionsDir, "run-a.jsonl"),
    "cron job ids may contain '/' and remain safe because they never become a path segment",
  );
  assert.equal(
    local._cronRunTranscriptPath("openclaw:job-b", validKey),
    null,
    "a sessionKey from another job must be rejected",
  );
  assert.equal(
    local._cronRunTranscriptPath("openclaw:job-a", "agent:../outside:cron:job-a:run:run-a"),
    null,
    "agent traversal must be rejected",
  );
  assert.equal(
    local._cronRunTranscriptPath("openclaw:job-a", "agent:worker:cron:job-a:run:../../outside"),
    null,
    "run traversal must be rejected",
  );

  const valid = await local.getCronRunTrajectory("openclaw:job-a", { sessionKey: validKey });
  assert.equal(valid.supported, true);
  assert.equal(valid.parts[0]?.text, "job-a result");
  const foreign = await local.getCronRunTrajectory("openclaw:job-b", { sessionKey: validKey });
  assert.equal(foreign.supported, false);
  assert.equal(foreign.reason, "invalid-session");

  const remote = new OpenClawBackend({ getUpstreamUrl: () => "wss://gateway.example.test" });
  remote.getCronRuns = async () => ({ runs: [{ sessionKey: validKey, summary: "fallback" }] });
  let localReads = 0;
  remote._readCronTranscriptText = () => {
    localReads += 1;
    return "must-not-read";
  };
  const delivery = await remote.getCronLatestDelivery("openclaw:job-a");
  assert.equal(localReads, 0, "remote gateway delivery must perform zero local transcript reads");
  assert.equal(delivery.source, "summary");

  console.log("PASS openclaw cron trajectory ownership and containment");
} finally {
  if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}
