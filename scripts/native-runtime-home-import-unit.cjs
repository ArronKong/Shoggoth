#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { BUILTIN_CLI_AGENT_PROFILES } = require(path.join(
  ROOT, "app", "agent-service", "builtin-cli-profiles.js",
));
const { importNativeRuntimeHomes, readMarker } = require(path.join(
  ROOT, "app", "agent-service", "native-runtime-home-import.js",
));
const { trustedImportedSettingSources } = require(path.join(
  ROOT, "app", "agent-service", "claude-code-native-import.js",
));
const { NativeSkillStore } = require(path.join(
  ROOT, "app", "agent-service", "native-skill-store.js",
));
const { CodexRuntimeConfigWriter } = require(path.join(
  ROOT, "app", "agent-service", "codex-runtime-config.js",
));
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account.js",
));
const { resolveServicePaths } = require(path.join(
  ROOT, "app", "agent-service", "paths.js",
));
const { ensurePrivateDirectoryTree } = require(path.join(
  ROOT, "app", "agent-service", "security.js",
));

function write(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600 });
}

function digest(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function writeSkill(target, name) {
  write(path.join(target, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: Imported ${name}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-import-"));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const paths = resolveServicePaths({
    homeDir: home,
    userDataRoot: path.join(root, "Shoggoth"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);

  write(path.join(home, ".codex", "config.toml"), [
    'model = "gpt-5"',
    'model_reasoning_effort = "high"',
    'approval_policy = "never"',
    'api_key = "sk-proj-abcdefghijklmnop"',
    "",
    "[mcp_servers.unsafe]",
    'command = "/usr/bin/true"',
    "",
  ].join("\n"));
  write(path.join(home, ".codex", "auth.json"), '{"access_token":"secret"}\n');
  write(path.join(home, ".codex", "sessions", "old.jsonl"), '{"message":"private"}\n');
  write(path.join(home, ".codex", "plugins", "example", "index.js"), "module.exports = {};\n");
  write(path.join(home, ".codex", "rules", "default.rules"), "prefix_rule(pattern=[\"git\", \"status\"], decision=\"allow\")\n");
  writeSkill(path.join(home, ".codex", "skills", "hello"), "hello");
  write(path.join(home, ".codex", "skills", "not-a-skill", "README.md"), "# Ignore me\n");
  const sharedSkill = path.join(home, ".codex", "plugins", "shared-skill");
  writeSkill(sharedSkill, "shared-skill");
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(sharedSkill, path.join(home, ".agents", "skills", "shared-skill"));
  const externalEgoSkill = path.join(root, "ego-browser");
  writeSkill(externalEgoSkill, "ego-browser");
  write(path.join(externalEgoSkill, "learnings", "x-com", "manifest.json"), "{}\n");
  fs.symlinkSync(externalEgoSkill, path.join(home, ".agents", "skills", "ego-browser"));
  const unsafeLinkedSkill = path.join(root, "unsafe-linked-skill");
  fs.mkdirSync(unsafeLinkedSkill, { mode: 0o700 });
  const unsafeInstructions = path.join(root, "unsafe-skill-instructions.md");
  write(unsafeInstructions, "# must not import through a nested symlink\n");
  fs.symlinkSync(unsafeInstructions, path.join(unsafeLinkedSkill, "SKILL.md"));
  fs.symlinkSync(unsafeLinkedSkill, path.join(home, ".agents", "skills", "unsafe-linked-skill"));

  write(path.join(home, ".claude", "CLAUDE.md"), "# User Claude instructions\n");
  write(path.join(home, ".claude", "settings.json"), JSON.stringify({
    theme: "dark",
    apiKey: "sk-proj-abcdefghijklmnop",
    env: { LOG_LEVEL: "debug", ANTHROPIC_API_KEY: "secretsecret" },
    hooks: { PreToolUse: [{ command: "/usr/bin/true" }] },
    permissions: { defaultMode: "bypassPermissions" },
  }));
  write(path.join(home, ".claude", "history.jsonl"), '{"prompt":"private"}\n');
  write(path.join(home, ".claude", "plugins", "sample", "plugin.js"), "export default {};\n");
  writeSkill(path.join(home, ".claude", "skills", "claude-skill"), "claude-skill");
  writeSkill(path.join(home, ".claude", "skills", "hello"), "hello");

  write(path.join(home, ".grok", "config.toml"), [
    'model = "grok-code-fast-1"',
    'token = "secretsecret"',
    "",
    "[mcp_servers.unsafe]",
    'command = "/usr/bin/true"',
    "",
  ].join("\n"));
  write(path.join(home, ".grok", "auth.json"), '{"token":"secret"}\n');
  write(path.join(home, ".grok", "installed-plugins", "sample", "index.js"), "export {};\n");
  writeSkill(path.join(home, ".grok", "skills", "grok-skill"), "grok-skill");

  write(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
    theme: "dark",
    oauthToken: "secretsecret",
  }));
  write(path.join(home, ".pi", "agent", "auth.json"), '{"token":"secret"}\n');
  write(path.join(home, ".pi", "agent", "extensions", "sample.js"), "export default {};\n");
  writeSkill(path.join(home, ".pi", "agent", "skills", "pi-skill"), "pi-skill");
  write(path.join(home, ".pi", "agent", "skills", "hello", "SKILL.md"), [
    "---", "name: hello", "description: Pi-specific hello", "---", "", "# Different hello", "",
  ].join("\n"));

  write(path.join(home, ".gemini", "GEMINI.md"), "# Gemini instructions\n");
  write(path.join(home, ".gemini", "settings.json"), JSON.stringify({
    theme: "system",
    accessToken: "secretsecret",
  }));
  write(path.join(home, ".gemini", "oauth_creds.json"), '{"refresh_token":"secret"}\n');
  write(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({
    mcpServers: {
      local: {
        command: "/usr/bin/true",
        env: { LOG_LEVEL: "debug", API_KEY: "secretsecret" },
      },
    },
  }));
  writeSkill(path.join(home, ".gemini", "config", "skills", "antigravity-skill"), "antigravity-skill");

  write(path.join(home, ".dsh", "settings.yaml"), [
    "theme: dark",
    "api_key: secretsecret",
    "",
  ].join("\n"));
  write(path.join(home, ".dsh", ".credentials.yaml"), "token: secretsecret\n");
  write(path.join(home, ".dsh", "profiles", "local", "package.json"), JSON.stringify({
    name: "local",
    dependencies: { "safe-plugin": "1.0.0" },
  }));
  writeSkill(path.join(home, ".dsh", "skills", "deepseek-skill"), "deepseek-skill");

  const sourceDigest = digest(path.join(home, ".codex", "config.toml"));
  const profileIds = new Set(BUILTIN_CLI_AGENT_PROFILES.map((profile) => profile.id));
  const skillStore = new NativeSkillStore({
    paths,
    profileExists: (profileId) => profileIds.has(profileId),
    now: () => 100,
  });
  skillStore.open([...profileIds]);
  return {
    root,
    home,
    paths,
    skillStore,
    sourceDigest,
    cleanup() {
      skillStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const value = fixture();
try {
  const custom = {
    ...BUILTIN_CLI_AGENT_PROFILES[0],
    id: "custom-profile",
    runtimeProfileId: "custom-runtime",
  };
  const first = importNativeRuntimeHomes({
    paths: value.paths,
    profiles: [...BUILTIN_CLI_AGENT_PROFILES, custom],
    homeDir: value.home,
    skillStore: value.skillStore,
    now: () => 1234,
  });
  assert.equal(first.results.length, 6);
  assert.ok(first.results.every((result) => result.status === "imported"), first.results);

  const codexHome = path.join(value.paths.stateDir, "codex", "shoggoth-codex-cli-v1");
  const importedCodexConfig = path.join(codexHome, ".shoggoth-imported", "config.toml");
  const codexConfig = fs.readFileSync(importedCodexConfig, "utf8");
  assert.match(codexConfig, /model = "gpt-5"/u);
  assert.doesNotMatch(codexConfig, /api_key|sk-proj|approval_policy|mcp_servers|command/u);
  const codexReview = fs.readFileSync(path.join(
    codexHome, ".shoggoth-import-pending", "imported-source", "config.toml",
  ), "utf8");
  assert.match(codexReview, /mcp_servers\.unsafe/u);
  assert.doesNotMatch(codexReview, /api_key|sk-proj/u);
  new CodexRuntimeConfigWriter({ paths: value.paths }).write({
    runtimeProfileId: "shoggoth-codex-cli-v1",
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig: null,
  });
  const managedCodexConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(managedCodexConfig, /^model = "gpt-5"$/mu);
  assert.match(managedCodexConfig, /^model_reasoning_effort = "high"$/mu);
  assert.doesNotMatch(managedCodexConfig, /approval_policy|mcp_servers\.unsafe/u);
  assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "sessions")), false);
  assert.equal(fs.existsSync(path.join(
    codexHome, ".shoggoth-import-pending", "plugins", "example", "index.js",
  )), true);
  assert.equal(fs.readFileSync(path.join(
    codexHome, ".shoggoth-import-pending", "rules", "default.rules",
  ), "utf8"), "prefix_rule(pattern=[\"git\", \"status\"], decision=\"allow\")\n");

  const claudeHome = path.join(
    value.paths.stateDir, "claude-code", "shoggoth-claude-code-cli-v1",
  );
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json")));
  assert.deepEqual(claudeSettings, { theme: "dark" });
  assert.deepEqual(trustedImportedSettingSources(claudeHome), ["user"]);
  const claudeReview = JSON.parse(fs.readFileSync(path.join(
    value.paths.stateDir, "claude-code", "shoggoth-claude-code-cli-v1",
    ".shoggoth-import-pending", "imported-source", "settings.json",
  )));
  assert.deepEqual(claudeReview.env, { LOG_LEVEL: "debug" });
  assert.equal(claudeReview.permissions.defaultMode, "bypassPermissions");
  assert.equal(fs.existsSync(path.join(
    value.paths.stateDir, "claude-code", "shoggoth-claude-code-cli-v1",
    ".shoggoth-import-pending", "plugins", "sample", "plugin.js",
  )), true);

  const grokHome = path.join(value.paths.stateDir, "grok-build", "shoggoth-grok-build-v1");
  const grokConfig = fs.readFileSync(path.join(grokHome, "config.toml"), "utf8");
  assert.match(grokConfig, /model = "grok-code-fast-1"/u);
  assert.doesNotMatch(grokConfig, /mcp_servers|command|token/u);
  assert.equal(fs.existsSync(path.join(
    grokHome, ".shoggoth-import-pending", "installed-plugins", "sample", "index.js",
  )), true);
  assert.equal(fs.existsSync(path.join(
    value.paths.stateDir, "pi", "shoggoth-pi-cli-v1",
    ".shoggoth-import-pending", "extensions", "sample.js",
  )), true);

  const antigravityHome = path.join(
    value.paths.stateDir, "antigravity", "shoggoth-antigravity-cli-v1",
  );
  assert.equal(fs.existsSync(path.join(antigravityHome, ".gemini", "GEMINI.md")), true);
  const pendingMcp = JSON.parse(fs.readFileSync(path.join(
    antigravityHome, ".shoggoth-import-pending", "config", "mcp_config.json",
  )));
  assert.deepEqual(pendingMcp.mcpServers.local.env, { LOG_LEVEL: "debug" });
  const antigravityProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => (
    profile.runtime === "antigravity"
  ));
  assert.equal(value.skillStore.list(antigravityProfile.id).items
    .find((item) => item.name === "ego-browser")?.enabled, true);
  assert.equal(value.skillStore.list(antigravityProfile.id).items
    .some((item) => item.name === "unsafe-linked-skill"), false);
  assert.equal(fs.existsSync(path.join(
    value.paths.stateDir, "deepseek-harness", "shoggoth-deepseek-harness-v1",
    ".shoggoth-import-pending", "profiles", "local", "package.json",
  )), true);

  const skill = value.skillStore.list(BUILTIN_CLI_AGENT_PROFILES[0].id)
    .items.find((item) => item.name === "hello");
  assert.equal(skill?.enabled, true);
  assert.equal(skill?.source, "user");
  const codexSkills = value.skillStore.list(BUILTIN_CLI_AGENT_PROFILES[0].id).items;
  assert.equal(codexSkills.find((item) => item.name === "shared-skill")?.enabled, true,
    JSON.stringify(codexSkills.map((item) => item.name)));
  const expectedSkills = new Map([
    ["codex", "hello"],
    ["claude-code", "claude-skill"],
    ["grok-build", "grok-skill"],
    ["pi", "pi-skill"],
    ["antigravity", "antigravity-skill"],
    ["deepseek-harness", "deepseek-skill"],
  ]);
  for (const profile of BUILTIN_CLI_AGENT_PROFILES) {
    const importedSkill = value.skillStore.list(profile.id).items.find((item) => (
      item.name === expectedSkills.get(profile.runtime)
    ));
    assert.equal(importedSkill?.enabled, true, profile.runtime);
  }
  const claudeProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "claude-code");
  assert.equal(value.skillStore.list(claudeProfile.id).items
    .find((item) => item.name === "hello")?.enabled, true);
  const piProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "pi");
  assert.equal(value.skillStore.list(piProfile.id).items
    .find((item) => item.name === "pi-hello")?.enabled, true);
  assert.equal(fs.existsSync(path.join(value.paths.stateDir, "codex", "custom-runtime")), false);
  assert.equal(digest(path.join(value.home, ".codex", "config.toml")), value.sourceDigest);

  const marker = readMarker(value.paths);
  assert.equal(Object.keys(marker.imports).length, 6);
  assert.ok(Object.values(marker.imports).every((entry) => entry.completedAt === 1234));

  const second = importNativeRuntimeHomes({
    paths: value.paths,
    profiles: BUILTIN_CLI_AGENT_PROFILES,
    homeDir: value.home,
    skillStore: value.skillStore,
    now: () => 9999,
  });
  assert.ok(second.results.every((result) => result.status === "already_imported"));
  assert.equal(readMarker(value.paths).updatedAt, 1234);

  console.log("PASS native Runtime home import unit");
} finally {
  value.cleanup();
}

const upgradeValue = fixture();
try {
  const antigravityProfile = BUILTIN_CLI_AGENT_PROFILES.find((profile) => (
    profile.runtime === "antigravity"
  ));
  write(upgradeValue.paths.nativeRuntimeImportPath, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: 1000,
    imports: {
      [`antigravity:${antigravityProfile.runtimeProfileId}`]: {
        status: "imported",
        runtime: "antigravity",
        profileId: antigravityProfile.id,
        runtimeProfileId: antigravityProfile.runtimeProfileId,
        sourceFingerprint: "0".repeat(64),
        completedAt: 1000,
        counts: { files: 0, pending: 0, excluded: 0, skills: 0, conflicts: 0 },
      },
    },
  })}\n`);
  const upgraded = importNativeRuntimeHomes({
    paths: upgradeValue.paths,
    profiles: BUILTIN_CLI_AGENT_PROFILES,
    homeDir: upgradeValue.home,
    skillStore: upgradeValue.skillStore,
    now: () => 2000,
  });
  assert.equal(upgraded.results.find((result) => (
    result.runtime === "antigravity"
  )).status, "upgraded");
  assert.equal(upgradeValue.skillStore.list(antigravityProfile.id).items
    .find((item) => item.name === "ego-browser")?.enabled, true);
  const marker = readMarker(upgradeValue.paths);
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.imports[`antigravity:${antigravityProfile.runtimeProfileId}`]
    .skillImportRevision, 2);
  const repeated = importNativeRuntimeHomes({
    paths: upgradeValue.paths,
    profiles: BUILTIN_CLI_AGENT_PROFILES,
    homeDir: upgradeValue.home,
    skillStore: upgradeValue.skillStore,
    now: () => 3000,
  });
  assert.equal(repeated.results.find((result) => (
    result.runtime === "antigravity"
  )).status, "already_imported");
  console.log("PASS native Runtime Antigravity shared Skill import upgrade");
} finally {
  upgradeValue.cleanup();
}
