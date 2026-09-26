#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const {
  createAgentLifecycleServiceController,
} = require(path.join(ROOT, "app", "agent-service", "agent-lifecycle-service-controller.js"));
const {
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const CRASH_EXIT_CODE = 86;
const CLOCK = 1_000_000;
const CREATE_POINTS = new Set([
  "ledger-pending", "disabled-profile", "resource-init", "enabled-publish", "completed-outcome",
]);
const ARCHIVE_POINTS = new Set(["archive-disabled", "runtime-cleanup"]);
const ALL_POINTS = [...CREATE_POINTS, ...ARCHIVE_POINTS];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function pathsFor(root) {
  return resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
}

function storeFacade(store, overrides = {}) {
  return new Proxy(store, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resourceMarker(root, profileId) {
  return path.join(root, "resources", profileId, "initialized");
}

function cleanupMarker(root, profileId) {
  return path.join(root, "runtime-cleanup", profileId);
}

function writeMarker(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, "ok\n", { mode: 0o600 });
}

function crash() {
  process.exit(CRASH_EXIT_CODE);
}

function controllerFor({ root, store, point = null, crashEnabled = false }) {
  const overrides = {};
  if (crashEnabled && point === "ledger-pending") {
    overrides.beginMcpToolCall = (input) => {
      const result = store.beginMcpToolCall(input);
      if (input.name === "agent.create") crash();
      return result;
    };
  }
  if (crashEnabled && point === "completed-outcome") {
    overrides.completeMcpToolCall = (input) => {
      const result = store.completeMcpToolCall(input);
      crash();
      return result;
    };
  }
  if (crashEnabled && point === "enabled-publish") {
    overrides.putAgentProfile = (input) => {
      const result = store.putAgentProfile(input);
      if (input.enabled === true) crash();
      return result;
    };
  }
  return createAgentLifecycleServiceController({
    productStore: storeFacade(store, overrides),
    runtimeManager: {
      async stop(binding) {
        if (crashEnabled && point === "archive-disabled") crash();
        writeMarker(cleanupMarker(root, binding.runtimeProfileId));
        if (crashEnabled && point === "runtime-cleanup") crash();
      },
    },
    async initializeProfile(profile) {
      if (crashEnabled && point === "disabled-profile") crash();
      writeMarker(resourceMarker(root, profile.id));
      if (crashEnabled && point === "resource-init") crash();
    },
    async activateProfile() {},
    now: () => CLOCK,
  });
}

function createParams(round, point) {
  const backendId = round % 3 === 0 ? "shoggoth" : round % 3 === 1 ? "codex" : "grok-build";
  return {
    operationId: `create-${round}-${point}`,
    backendId,
    name: `Recovery ${round} ${point}`,
    defaultCwd: null,
    createdAt: CLOCK,
  };
}

async function worker(root, point, round) {
  fs.chmodSync(root, 0o700);
  const store = new JsonlProductStore({ paths: pathsFor(root), now: () => CLOCK });
  store.open();
  const controller = controllerFor({ root, store, point, crashEnabled: true });
  controller.open();
  const params = createParams(round, point);
  if (CREATE_POINTS.has(point)) {
    await controller.handle("agent.create", params);
  } else {
    const created = await controller.handle("agent.create", params);
    await controller.handle("agent.archive", {
      operationId: `archive-${round}-${point}`,
      profileId: created.profile.id,
      expectedUpdatedAt: created.profile.updatedAt,
      createdAt: CLOCK,
    });
  }
  throw new Error(`crash point was not reached: ${point}`);
}

function paramsFromCall(call) {
  const binding = call.binding;
  if (call.name === "agent.create") {
    return {
      operationId: binding.operationId,
      backendId: binding.backendId,
      name: binding.name,
      defaultCwd: binding.defaultCwd,
      createdAt: binding.createdAt,
    };
  }
  return {
    operationId: binding.operationId,
    profileId: binding.targetProfileId,
    expectedUpdatedAt: binding.expectedUpdatedAt,
    createdAt: binding.createdAt,
  };
}

async function recover(root, point, round) {
  const store = new JsonlProductStore({ paths: pathsFor(root), now: () => CLOCK });
  store.open();
  const expectedOperationId = CREATE_POINTS.has(point)
    ? `create-${round}-${point}` : `archive-${round}-${point}`;
  const call = store.listMcpToolCalls().find((candidate) => (
    candidate.binding?.operationId === expectedOperationId
  ));
  assert.ok(call, `${point}: durable lifecycle call must survive process exit`);
  const controller = controllerFor({ root, store });
  controller.open();
  try {
    const params = paramsFromCall(call);
    const result = await controller.handle(call.name, params);
    const replay = await controller.handle(call.name, params);
    assert.deepEqual(replay, result, `${point}: exact replay must be stable`);
    const userProfiles = store.listAgentProfiles().filter((profile) => !profile.isDefault);
    assert.equal(userProfiles.length, 1, `${point}: recovery must publish exactly one Agent`);
    assert.equal(new Set(userProfiles.map((profile) => profile.id)).size, 1);
    assert.equal(new Set(userProfiles.map((profile) => profile.agentId)).size, 1);
    assert.equal(new Set(userProfiles.map((profile) => (
      `${profile.runtime}\0${profile.runtimeProfileId}`
    ))).size, 1);
    const profile = userProfiles[0];
    assert.equal(fs.existsSync(resourceMarker(root, profile.id)), true,
      `${point}: profile resources must exist after recovery`);
    assert.equal(profile.enabled, CREATE_POINTS.has(point));
    if (ARCHIVE_POINTS.has(point)) {
      assert.equal(fs.existsSync(cleanupMarker(root, profile.runtimeProfileId)), true,
        `${point}: runtime cleanup must finish after recovery`);
    }
    const saved = store.listMcpToolCalls().find((candidate) => candidate.callId === call.callId);
    assert.equal(saved.status, "completed", `${point}: lifecycle ledger must complete`);
  } finally {
    await controller.close();
    store.close();
  }
}

async function main() {
  const rounds = Number(option("--rounds", "1"));
  assert.equal(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 1_000, true,
    "--rounds must be an integer in [1, 1000]");
  const requested = option("--crash-points", "all");
  const points = requested === "all" ? ALL_POINTS : requested.split(",").filter(Boolean);
  assert.equal(points.length > 0 && points.every((point) => ALL_POINTS.includes(point)), true,
    `--crash-points must be all or a comma list of: ${ALL_POINTS.join(", ")}`);
  let cases = 0;
  for (let round = 1; round <= rounds; round += 1) {
    for (const point of points) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-lifecycle-crash-"));
      try {
        const child = spawnSync(process.execPath, [
          SCRIPT, "--worker", "--root", root, "--point", point, "--round", String(round),
        ], { encoding: "utf8", timeout: 20_000 });
        assert.equal(child.status, CRASH_EXIT_CODE,
          `${point}: worker did not exit at crash point\n${child.stderr || child.stdout}`);
        await recover(root, point, round);
        cases += 1;
      } finally {
        assert.match(path.basename(root), /^shoggoth-lifecycle-crash-/u);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log(`PASS lifecycle crash recovery ${cases}/${cases} cases (${rounds} rounds)`);
}

if (process.argv.includes("--worker")) {
  worker(option("--root"), option("--point"), Number(option("--round")))
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
} else {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
