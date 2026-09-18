"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { managedConfigFor } = require("../app/agent-service/codex-runtime-config");

const value = memoryFixture();
try {
  const root = path.join(value.paths.stateDir, "codex", "runtime-1", "memories");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "preference.md"), "User prefers deterministic tests.", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "secret.md"), "api_key=abcdefghijklmnopqrstuvwxyz", { mode: 0o600 });
  const first = value.engine.importCodexNative({ profileId: "profile-1", root });
  const second = value.engine.importCodexNative({ profileId: "profile-1", root });
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0, "重复导入命中同一 candidate，不产生第二条记录");
  const candidates = value.store.list("profile-1", { status: "candidate" });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].content, /deterministic tests/u);
  assert.doesNotMatch(JSON.stringify(candidates), /api_key/u);
  const config = managedConfigFor(null);
  assert.match(config, /^generate_memories = false$/mu);
  assert.match(config, /^use_memories = false$/mu);
  console.log("ok - Codex native memory 只读导入 candidate、secret 跳过、原生生成/注入关闭");
  console.log("1 codex memory import regression passed");
} finally { value.cleanup(); }
