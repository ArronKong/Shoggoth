"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
const { launchAndWait, ORDINARY_OPEN_SCRIPT } = require("./shoggoth-quarantined-first-launch.cjs");

test("the exact ordinary Open script compiles with the macOS System Events dictionary", { skip: process.platform !== "darwin" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-open-script-"));
  try {
    execFileSync("/usr/bin/osacompile", ["-o", path.join(directory, "ordinary-open.scpt"), "-e", ORDINARY_OPEN_SCRIPT], { timeout: 15000 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(options = {}) {
  const child = new EventEmitter();
  const state = { ticks: 0, prompts: 0, confirmed: false, killed: false, spawnCalls: 0 };
  child.kill = signal => { assert.equal(signal, "SIGTERM"); state.killed = true; };
  const dependencies = {
    spawnProcess(executable, args, settings) {
      state.spawnCalls++;
      assert.equal(executable, "/usr/bin/open");
      assert.deepEqual(args, ["-n", "/Applications/Shoggoth.app"]);
      assert.equal(settings.timeout, 15000);
      return child;
    },
    readProcesses(binary) {
      assert.equal(binary, "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth");
      return options.processes ? options.processes(state) : state.confirmed ? [123] : [];
    },
    runCommand(executable, args) {
      state.prompts++;
      assert.equal(executable, "/usr/bin/osascript");
      assert.equal(args[0], "-e");
      assert.match(args[1], /process "CoreServicesUIAgent"/u);
      assert.deepEqual([...args[1].matchAll(/button "([^"]+)"/gu)].map(x => x[1]), ["Open", "Open"]);
      if (options.noOrdinaryPrompt) return "no-ordinary-open-prompt";
      state.confirmed = true;
      child.emit("close", 0, null);
      return "ordinary-open-confirmed";
    },
    async wait(milliseconds) {
      assert.equal(milliseconds, 500);
      state.ticks++;
      options.onTick?.(state, child);
    },
  };
  const evidence = { normalOpenConfirmation: false };
  return { state, evidence, run: () => launchAndWait("/Applications/Shoggoth.app", "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth", evidence, dependencies) };
}

test("confirms the ordinary prompt while open remains pending, including an early prelaunch PID", async () => {
  const f = fixture({ processes: () => [123] });
  assert.equal(await f.run(), 123);
  assert.equal(f.state.prompts, 1);
  assert.equal(f.state.ticks, 21);
  assert.equal(f.evidence.normalOpenConfirmation, true);
  assert.deepEqual(f.evidence.launcherNaturalExit, { code: 0, signal: null });
  assert.equal(f.state.spawnCalls, 1);
  assert.equal(f.state.killed, false);
});

test("an already accepted launch needs no dialog interaction", async () => {
  const f = fixture({ processes: () => [123], onTick: (state, child) => child.emit("close", 0, null) });
  assert.equal(await f.run(), 123);
  assert.equal(f.state.prompts, 0);
  assert.equal(f.evidence.normalOpenConfirmation, false);
});

test("a failed launcher cannot pass because an App PID happens to exist", async () => {
  const f = fixture({ processes: () => [123], onTick: (state, child) => child.emit("close", 1, null) });
  await assert.rejects(f.run(), /LaunchServices open failed or timed out/u);
});

test("a launcher timeout remains a failure", async () => {
  const f = fixture({ processes: () => [123], onTick: (state, child) => child.emit("close", null, "SIGTERM") });
  await assert.rejects(f.run(), /LaunchServices open failed or timed out/u);
});

test("spawn errors remain failures and the launcher is cleaned up", async () => {
  const f = fixture({ onTick: (state, child) => child.emit("error", new Error("fixture launch error")) });
  await assert.rejects(f.run(), /fixture launch error/u);
  assert.equal(f.state.killed, true);
});

test("duplicate main processes still fail and stop the pending launcher", async () => {
  const f = fixture({ processes: () => [123, 456] });
  await assert.rejects(f.run(), /Unexpected duplicate GUI process/u);
  assert.equal(f.state.prompts, 0);
  assert.equal(f.state.killed, true);
});

test("without a normal Open prompt, a pending launch still times out", async () => {
  const f = fixture({ noOrdinaryPrompt: true, onTick: (state, child) => {
    if (state.ticks === 30) child.emit("close", null, "SIGTERM");
  } });
  await assert.rejects(f.run(), /LaunchServices open failed or timed out/u);
  assert.equal(f.state.prompts, 1);
  assert.equal(f.evidence.normalOpenConfirmation, false);
});

test("successful open without a GUI retains the original 60 second PID budget", async () => {
  const f = fixture({ noOrdinaryPrompt: true, processes: () => [], onTick: (state, child) => child.emit("close", 0, null) });
  await assert.rejects(f.run(), /Normal quarantined GUI did not launch/u);
  assert.equal(f.state.ticks, 120);
  assert.equal(f.evidence.normalOpenConfirmation, false);
});
