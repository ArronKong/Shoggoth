#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { BUILTIN_CLI_AGENT_PROFILES } = require(path.join(
  ROOT, "app", "agent-service", "builtin-cli-profiles.js",
));
const { importNativeRuntimeHomes, sanitizeFile } = require(path.join(
  ROOT, "app", "agent-service", "native-runtime-home-import.js",
));
const { trustedImportedSettingSources } = require(path.join(
  ROOT, "app", "agent-service", "claude-code-native-import.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { ensurePrivateDirectoryTree } = require(path.join(
  ROOT, "app", "agent-service", "security.js",
));

const codexProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "codex");
const claudeProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "claude-code");

function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sri-sec-${label}-`));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  return { root, home, paths };
}

function write(target, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode });
}

{
  const value = fixture("symlink");
  try {
    const victim = path.join(value.root, "victim.md");
    write(victim, "victim\n");
    fs.mkdirSync(path.join(value.home, ".codex"), { mode: 0o700 });
    fs.symlinkSync(victim, path.join(value.home, ".codex", "AGENTS.md"));
    const result = importNativeRuntimeHomes({
      paths: value.paths,
      profiles: [codexProfile],
      homeDir: value.home,
      now: () => 1,
    });
    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].code, "NATIVE_IMPORT_SOURCE_UNSAFE");
    assert.equal(fs.readFileSync(victim, "utf8"), "victim\n");
    assert.equal(fs.existsSync(path.join(
      value.paths.stateDir, "codex", codexProfile.runtimeProfileId, "AGENTS.md",
    )), false);
    assert.equal(fs.readdirSync(value.paths.nativeRuntimeImportStagingDir).length, 0);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

{
  const value = fixture("pending");
  try {
    const executed = path.join(value.root, "executed");
    write(path.join(value.home, ".codex", "AGENTS.md"), "# Safe\n");
    write(path.join(value.home, ".codex", "plugins", "evil", "install.sh"), [
      "#!/bin/sh",
      `touch ${JSON.stringify(executed)}`,
      "",
    ].join("\n"), 0o700);
    write(path.join(value.home, ".codex", "plugins", "oauth-token.txt"),
      `ya29.${"a".repeat(30)}\n`);
    write(path.join(value.home, ".codex", "plugins", "google-key.js"),
      `const GOOGLE_KEY = "AIza${"a".repeat(35)}";\n`);
    const pluginVictim = path.join(value.root, "plugin-victim.js");
    write(pluginVictim, "export const untouched = true;\n");
    fs.symlinkSync(pluginVictim, path.join(value.home, ".codex", "plugins", "linked.js"));
    write(path.join(value.paths.nativeRuntimeImportStagingDir, "abandoned", "file"), "old\n");
    const result = importNativeRuntimeHomes({
      paths: value.paths,
      profiles: [codexProfile],
      homeDir: value.home,
      now: () => 2,
    });
    assert.equal(result.results[0].status, "imported");
    assert.equal(fs.existsSync(executed), false);
    const pending = path.join(
      value.paths.stateDir, "codex", codexProfile.runtimeProfileId,
      ".shoggoth-import-pending", "plugins", "evil", "install.sh",
    );
    assert.equal(fs.existsSync(pending), true);
    assert.equal(fs.statSync(pending).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(
      value.paths.stateDir, "codex", codexProfile.runtimeProfileId,
      ".shoggoth-import-pending", "plugins", "linked.js",
    )), false);
    assert.equal(fs.existsSync(path.join(
      value.paths.stateDir, "codex", codexProfile.runtimeProfileId,
      ".shoggoth-import-pending", "plugins", "oauth-token.txt",
    )), false);
    assert.equal(fs.existsSync(path.join(
      value.paths.stateDir, "codex", codexProfile.runtimeProfileId,
      ".shoggoth-import-pending", "plugins", "google-key.js",
    )), false);
    assert.equal(fs.readFileSync(pluginVictim, "utf8"), "export const untouched = true;\n");
    assert.equal(fs.readdirSync(value.paths.nativeRuntimeImportStagingDir).length, 0);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

{
  const value = fixture("claude-conflict");
  try {
    write(path.join(value.home, ".claude", "settings.json"), '{"theme":"dark"}\n');
    const targetHome = path.join(
      value.paths.stateDir, "claude-code", claudeProfile.runtimeProfileId,
    );
    write(path.join(targetHome, "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ command: "/usr/bin/true" }] },
      permissions: { defaultMode: "bypassPermissions" },
    }));
    const result = importNativeRuntimeHomes({
      paths: value.paths,
      profiles: [claudeProfile],
      homeDir: value.home,
      now: () => 3,
    });
    assert.equal(result.results[0].status, "imported");
    assert.deepEqual(trustedImportedSettingSources(targetHome), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetHome, "settings.json"))).permissions
      .defaultMode, "bypassPermissions");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

{
  const value = fixture("skill-retry");
  try {
    write(path.join(value.home, ".codex", "AGENTS.md"), "# Safe\n");
    write(path.join(value.home, ".codex", "skills", "retry", "SKILL.md"), [
      "---", "name: retry", "description: Retry import", "---", "", "# Retry", "",
    ].join("\n"));
    let attempts = 0;
    const skillStore = {
      importLegacySkill() {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return { enabled: true };
      },
    };
    const first = importNativeRuntimeHomes({
      paths: value.paths,
      profiles: [codexProfile],
      homeDir: value.home,
      skillStore,
      now: () => 4,
    });
    assert.equal(first.results[0].status, "failed");
    const second = importNativeRuntimeHomes({
      paths: value.paths,
      profiles: [codexProfile],
      homeDir: value.home,
      skillStore,
      now: () => 5,
    });
    assert.equal(second.results[0].status, "imported");
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

{
  const value = fixture("marker");
  try {
    write(value.paths.nativeRuntimeImportPath, '{"schemaVersion":1,"updatedAt":0,"imports":[]}\n');
    assert.throws(
      () => importNativeRuntimeHomes({
        paths: value.paths,
        profiles: [codexProfile],
        homeDir: value.home,
      }),
      (error) => error.code === "NATIVE_IMPORT_MARKER_INVALID",
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

assert.equal(sanitizeFile("settings.json", "active", Buffer.from("{broken\n")), null);
assert.equal(sanitizeFile("settings.json", "pending", Buffer.from("{broken\n")).toString(), "{broken\n");
const yaml = sanitizeFile("settings.yaml", "active", Buffer.from([
  "api_key: |", `  AIza${"a".repeat(35)}`, "theme: dark", "",
].join("\n"))).toString("utf8");
assert.doesNotMatch(yaml, /api_key|AIza/u);
assert.match(yaml, /theme: dark/u);
const toml = sanitizeFile("settings.toml", "active", Buffer.from([
  'api_key = """', `AIza${"a".repeat(35)}`, '"""', 'model = "safe"', "",
].join("\n"))).toString("utf8");
assert.doesNotMatch(toml, /api_key|AIza/u);
assert.match(toml, /model = "safe"/u);
assert.equal(sanitizeFile("settings.toml", "active", Buffer.from([
  "api_keys = [", '  "totally-private-value-123456",', "]", 'model = "safe"', "",
].join("\n"))), null);
assert.equal(sanitizeFile("settings.yaml", "active", Buffer.from([
  "api_keys: [", "  totally-private-value-123456,", "]", "theme: dark", "",
].join("\n"))), null);
assert.equal(sanitizeFile(
  "rules/default.rules", "pending", Buffer.from("prefix_rule(pattern=[\"git\"])\n"),
).toString("utf8"), "prefix_rule(pattern=[\"git\"])\n");

console.log("PASS native Runtime import security unit");
