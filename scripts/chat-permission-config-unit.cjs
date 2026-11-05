"use strict";

// Settings → Agent permissions: one saved choice that every Agent chat follows.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeConfig, createConfigStore } = require("../app/core/config-store");
const { runtimePermissionModeOptions } = require("../app/agent-service/runtime-permission-modes");

const MODES = ["request-approval", "auto-review", "full-access"];

test("config: chatPermissionMode defaults to automatic review and rejects unknown values", () => {
  assert.equal(normalizeConfig({}).chatPermissionMode, "auto-review");
  for (const mode of MODES) assert.equal(normalizeConfig({ chatPermissionMode: mode }).chatPermissionMode, mode);
  for (const bad of ["", "full", "yolo", "workspace-auto", null, 1, ["full-access"], { mode: "full-access" }]) {
    assert.equal(normalizeConfig({ chatPermissionMode: bad }).chatPermissionMode, "auto-review");
  }
});

test("config: chatPermissionMode persists through a partial Settings write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-permission-"));
  try {
    const file = path.join(dir, "config.json");
    const store = createConfigStore(file);
    store.write({ locale: "zh-CN" });
    assert.equal(store.read().chatPermissionMode, "auto-review");
    assert.equal(store.write({ chatPermissionMode: "request-approval" }).chatPermissionMode, "request-approval");
    store.write({ theme: "dark" });
    assert.equal(createConfigStore(file).read().chatPermissionMode, "request-approval");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).chatPermissionMode, "request-approval");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Settings choices match the unified mode IDs every Shoggoth runtime accepts", () => {
  for (const runtime of ["codex", "claude-code", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]) {
    assert.deepEqual(runtimePermissionModeOptions(runtime).map((option) => option.id), MODES, runtime);
  }
});
