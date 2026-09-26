"use strict";

// Isolated local transcripts only; no gateway, runtime, or user-history writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { HermesBackend } = require("../app/core/hermes-backend");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-hermes-tool-usage-"));
const previousHome = process.env.HERMES_HOME;
process.env.HERMES_HOME = home;
const repeat = 16_384;
const tool = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
const message = { tool_calls: [
  tool("terminal", { command: "git status && npm test" }),
  tool("skill_view", { name: " review " }),
  tool("web_search", { query: "ignored" }),
  { function: { name: "terminal", arguments: "bad-json" } },
] };

function fixture(profile, copies) {
  const dir = profile === "default" ? path.join(home, "sessions")
    : path.join(home, "profiles", profile, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "active.jsonl"), `${JSON.stringify(message)}\n`.repeat(copies)
    + "\nmalformed\n{}\n");
  fs.writeFileSync(path.join(dir, "session_active_1.json"), JSON.stringify({
    session_id: "active", messages: [message],
  }));
  fs.writeFileSync(path.join(dir, "session_archived_1.json"), JSON.stringify({
    session_id: "archived", messages: [message, message],
  }));
  fs.writeFileSync(path.join(dir, "session_archived_2.json"), JSON.stringify({
    session_id: "archived", messages: [message],
  }));
  fs.writeFileSync(path.join(dir, "session_bad.json"), "malformed");
  fs.writeFileSync(path.join(dir, "request_ignored.json"), JSON.stringify({
    session_id: "ignored", messages: [message],
  }));
  // An unreadable file-shaped entry keeps the existing fail-soft behavior.
  fs.mkdirSync(path.join(dir, "unreadable.jsonl"));
  return { agentId: `hermes-${profile}`, dir };
}

function backend(mode = "local") {
  const instance = new HermesBackend({ getConfig: () => ({ hermesMode: mode }) });
  instance.profileById.set("hermes-default", "default");
  instance.profileById.set("hermes-other", "other");
  return instance;
}

async function measure(instance, method, dirs) {
  let heartbeats = 0;
  let parsedMessages = 0;
  let parsedBeforeYield = null;
  let parseYield;
  const originalParse = JSON.parse;
  JSON.parse = function (text, ...args) {
    const value = originalParse.call(this, text, ...args);
    if (value?.tool_calls?.[0]?.function?.name === "terminal") {
      parsedMessages += 1;
      if (parsedMessages === 1) {
        parseYield = setImmediate(() => { parsedBeforeYield = parsedMessages; });
      }
    }
    return value;
  };
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    heartbeats += 1;
  }, 1);
  const started = performance.now();
  try {
    const data = await instance[method](dirs, "fixture");
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    return { data, heartbeats, parsedBeforeYield, maxGapMs: Math.round(maxGapMs), ms: Math.round(performance.now() - started) };
  } finally {
    clearInterval(timer);
    clearImmediate(parseYield);
    JSON.parse = originalParse;
  }
}

(async () => {
  try {
    const dirs = [fixture("default", repeat), fixture("other", 1),
      { agentId: "hermes-missing", dir: path.join(home, "missing") }];
    const counts = { "hermes-default": repeat + 2, "hermes-other": 3 };
    const cli = await measure(backend(), "_scanCliUsage", dirs);
    const skills = await measure(backend(), "_scanSkillUsage", dirs);
    assert.deepEqual(cli.data, { supported: true, commands: { git: counts, npm: counts } });
    assert.deepEqual(skills.data, { supported: true, skills: { review: counts } });
    for (const [name, result] of [["cli", cli], ["skills", skills]]) {
      const { data: _data, ...timing } = result;
      console.log(`${name}: ${JSON.stringify(timing)}`);
    }
    assert.ok(cli.heartbeats > 1, "CLI transcript scan must let the event loop serve work before completion");
    assert.ok(skills.heartbeats > 1, "Skill transcript scan must let the event loop serve work before completion");
    for (const result of [cli, skills]) {
      assert.ok(result.parsedBeforeYield > 0 && result.parsedBeforeYield <= 256,
        "Parsing one long transcript must yield in bounded batches, beyond merely asynchronous file IO");
    }

    for (const [get, scan, cache, inflight] of [
      ["getCliUsage", "_scanCliUsage", "_cliUsageCache", "_cliUsageScanInFlight"],
      ["getSkillUsage", "_scanSkillUsage", "_skillUsageCache", "_skillUsageScanInFlight"],
    ]) {
      const instance = backend();
      const original = instance[scan].bind(instance);
      let scans = 0;
      instance[scan] = (...args) => { scans += 1; return original(...args); };
      const [first, concurrent] = await Promise.all([instance[get](), instance[get]()]);
      assert.deepEqual(concurrent, first);
      assert.equal(scans, 1, "Cold concurrent reads share one scan");
      assert.strictEqual(await instance[get](), first, "Warm cache preserves identity and TTL");
      instance[cache].at = 0;
      assert.strictEqual(await instance[get](), first, "Expired cache returns its previous snapshot");
      await instance[inflight];
      assert.equal(scans, 2, "Expired cache starts one asynchronous rescan");
      assert.deepEqual(await instance[get](), first, "Rescan preserves all counts");
      const remote = backend("remote");
      remote[scan] = () => { throw new Error("Remote mode must never scan local transcripts"); };
      assert.equal((await remote[get]()).reason, "remote");

      const failing = backend();
      const failure = new Error("fixture scan failure");
      failing[scan] = async () => { throw failure; };
      await assert.rejects(failing[get](), (error) => error === failure,
        "Current-scope scan failures keep their original error");
      assert.equal(failing[inflight], null, "A failed cold scan releases its single-flight slot");
      failing[scan] = HermesBackend.prototype[scan];
      assert.deepEqual(await failing[get](), first, "A failed scan remains retryable");

      const stale = backend();
      const pending = stale[scan](dirs, "old-generation");
      await stale.stop();
      await pending;
      assert.equal(stale[cache], null, "Old lifecycle cannot publish into a new cache");
      assert.equal(stale[inflight], null, "Stop clears old single-flight ownership");

      for (const targetMode of ["remote", "local"]) {
        let mode = "local";
        const changing = new HermesBackend({ getConfig: () => ({ hermesMode: mode }) });
        changing.profileById.set("hermes-default", "default");
        const originalStat = fs.promises.stat;
        let release;
        let entered;
        const held = new Promise((resolve) => { release = resolve; });
        const started = new Promise((resolve) => { entered = resolve; });
        let firstStat = true;
        fs.promises.stat = async (...args) => {
          if (firstStat) {
            firstStat = false;
            entered();
            await held;
          }
          return originalStat(...args);
        };
        try {
          const oldScope = changing[get]();
          await started;
          mode = targetMode;
          await changing.stop();
          changing.profileById = new Map([["hermes-other", "other"]]);
          release();
          const result = await oldScope;
          if (targetMode === "remote") {
            assert.equal(result.supported, false, "In-flight local result cannot cross into remote scope");
            assert.equal(result.reason, "remote");
            assert.equal(changing[cache], null, "Remote scope cannot receive a local cache");
          } else {
            const values = result.commands || result.skills;
            assert.ok(Object.values(values).every((byAgent) =>
              byAgent["hermes-other"] === 3 && !("hermes-default" in byAgent)),
            "A new local lifecycle returns only its current profile snapshot");
          }
        } finally {
          release();
          fs.promises.stat = originalStat;
        }
      }
    }
    console.log("PASS Hermes tool usage: complete counts, dedupe, fail-soft, event-loop progress, single-flight, TTL, lifecycle and remote scope");
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
