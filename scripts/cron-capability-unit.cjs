"use strict";

const assert = require("node:assert/strict");
const { OpenClawBackend, normalizeOpenClawCronJob } = require("../app/core/openclaw-backend");
const { normalizeHermesCronJob } = require("../app/core/hermes-backend");

function testOpenClawNormalizationKeepsAdvancedFields() {
  const job = normalizeOpenClawCronJob({
    id: "oc-1",
    name: "advanced",
    description: "完整控制面",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai", staggerMs: 30000 },
    deleteAfterRun: true,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "hello",
      model: "openai/gpt-5",
      fallbacks: ["xai/grok"],
      thinking: "high",
      timeoutSeconds: 60,
      lightContext: true,
      toolsAllow: ["web"],
    },
    delivery: {
      mode: "webhook",
      completionDestination: { kind: "webhook", url: "https://example.com/hook" },
    },
    failureAlert: { after: 2, mode: "announce", cooldownMs: 60000 },
    state: { lastRunStatus: "ok", nextRunAtMs: 123 },
  });

  assert.equal(job.backendId, "openclaw");
  assert.equal(job.description, "完整控制面");
  assert.equal(job.schedule.kind, "cron");
  assert.equal(job.schedule.tz, "Asia/Shanghai");
  assert.equal(job.deleteAfterRun, true);
  assert.equal(job.sessionTarget, "isolated");
  assert.equal(job.wakeMode, "now");
  assert.equal(job.payload.kind, "agentTurn");
  assert.equal(job.payload.model, "openai/gpt-5");
  assert.equal(job.delivery.mode, "webhook");
  assert.equal(job.failureAlert.after, 2);
  assert.deepEqual(job.backendDetails.capabilityTags, [
    "agentTurn",
    "webhook",
    "failure-alert",
    "isolated",
    "wake-now",
    "delete-after-run",
  ]);
}

// The gateway cron schema accepts only `false` (disable) or an object (configure)
// for failureAlert — never null. The UI sends null when the toggle is off, so the
// backend must translate it. Reproduces "rename a cron with failure-alert off".
function testOpenClawCronPatchMapsFailureAlertForGateway() {
  const backend = new OpenClawBackend();

  const disabled = backend._buildCronPatch({ name: "renamed", failureAlert: null });
  assert.equal(disabled.failureAlert, false);
  assert.equal(disabled.name, "renamed");

  const alert = { after: 3, mode: "announce", cooldownMs: 60000 };
  const configured = backend._buildCronPatch({ failureAlert: alert });
  assert.deepEqual(configured.failureAlert, alert);

  // Absent failureAlert stays absent so the gateway leaves the existing config.
  const untouched = backend._buildCronPatch({ name: "renamed" });
  assert.equal("failureAlert" in untouched, false);
}

function testHermesNormalizationKeepsAutomationFields() {
  const job = normalizeHermesCronJob({
    id: "h-1",
    name: "script job",
    prompt: "noop",
    schedule: { kind: "interval", minutes: 30 },
    enabled: false,
    deliver: "local",
    model: "qwen",
    provider: "openrouter",
    base_url: "https://models.example",
    script: "watchdog.sh",
    no_agent: true,
    repeat: { times: 3, completed: 1 },
    skills: ["watchers"],
    context_from: ["previous"],
    enabled_toolsets: ["terminal"],
    workdir: "/tmp/project",
    profile: "ops",
    state: "paused",
  }, "hermes-default");

  assert.equal(job.backendId, "hermes");
  assert.equal(job.id, "hermes-default:h-1");
  assert.equal(job.schedule.kind, "every");
  assert.equal(job.noAgent, true);
  assert.equal(job.script, "watchdog.sh");
  assert.equal(job.repeat.times, 3);
  assert.deepEqual(job.skills, ["watchers"]);
  assert.deepEqual(job.contextFrom, ["previous"]);
  assert.deepEqual(job.enabledToolsets, ["terminal"]);
  assert.equal(job.workdir, "/tmp/project");
  assert.equal(job.profile, "ops");
  assert.equal(job.baseUrl, "https://models.example");
  assert.deepEqual(job.backendDetails.capabilityTags, [
    "no-agent",
    "script",
    "skills",
    "workdir",
    "profile",
    "chained",
  ]);
}

testOpenClawNormalizationKeepsAdvancedFields();
testOpenClawCronPatchMapsFailureAlertForGateway();
testHermesNormalizationKeepsAutomationFields();
console.log("[cron-capability-unit] PASS");
