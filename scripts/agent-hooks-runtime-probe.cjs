"use strict";
// Read-only binary/distribution inventory. --version is not an account,
// tool-interception or real-model acceptance test.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { resolveCodexSystemBinary, resolveCodexRuntimeLayout } = require("../app/agent-service/codex-runtime-paths");
const { resolvePiBinary } = require("../app/agent-service/pi-runtime-paths");
const { resolveClaudeCodeBinary } = require("../app/agent-service/claude-code-runtime-paths");
const { resolveOpenCodeBinary } = require("../app/agent-service/opencode-runtime-paths");
const { resolveDeepSeekHarnessBinary } = require("../app/agent-service/deepseek-harness-runtime-paths");
const { resolveGrokBuildBinary } = require("../app/agent-service/grok-build-runtime-paths");
const { resolveAntigravityAcpServer } = require("../app/agent-service/antigravity-acp-distribution");
const repoRoot = path.resolve(__dirname, "..");
function option(name) {
  const at = process.argv.indexOf(name); if (at < 0) return null;
  if (!process.argv[at + 1] || !path.isAbsolute(process.argv[at + 1])) throw new Error(name + " requires an absolute path");
  return process.argv[at + 1];
}
const harnessRoot = option("--harness-root") || repoRoot;
const output = option("--output");
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-hook-version-"));
try {
  const resolverOptions = { parentEnv: { PATH: process.env.PATH }, homedir: os.homedir() };
  const env = { HOME: root, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: root,
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
    CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root,
    DEEPSEEK_HOME: root, NO_UPDATE_NOTIFIER: "1", DO_NOT_TRACK: "1" };
  const inventory = [
    ["codex-harness", () => resolveCodexRuntimeLayout({ repoRoot: harnessRoot }).runtimePath],
    ["codex", () => resolveCodexSystemBinary(resolverOptions)],
    ["claude-code", () => resolveClaudeCodeBinary(resolverOptions)],
    ["pi", () => resolvePiBinary(resolverOptions)],
    ["opencode", () => resolveOpenCodeBinary(resolverOptions)],
    ["deepseek-harness", () => resolveDeepSeekHarnessBinary(resolverOptions)],
    ["grok-build", () => resolveGrokBuildBinary(resolverOptions)],
  ];
  const runtimes = inventory.map(([runtime, resolve]) => {
    let executable;
    try { executable = resolve(); }
    catch (error) { return { runtime, executable: null, cli: "unavailable", code: error.code || "RUNTIME_BINARY_UNAVAILABLE", realModel: "pending" }; }
    try {
      const versionText = execFileSync(executable, ["--version"], { cwd: root, env, encoding: "utf8",
        timeout: 10000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
      const version = versionText.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0] || null;
      return { runtime, executable, cli: version ? "available" : "version_unverified", version, evidence: "isolated --version", realModel: "pending" };
    } catch (error) {
      return { runtime, executable, cli: "version_unverified", code: error.code || "RUNTIME_VERSION_UNAVAILABLE", realModel: "pending" };
    }
  });
  try {
    const distribution = resolveAntigravityAcpServer({ paths: resolveServicePaths() });
    runtimes.push({ runtime: "antigravity", executable: distribution.serverPath,
      cli: "distribution_available", version: distribution.version ?? null,
      evidence: "verified installed ACP distribution; process not launched", realModel: "pending" });
  } catch (error) {
    runtimes.push({ runtime: "antigravity", executable: null, cli: "unavailable", code: error.code || "ANTIGRAVITY_BINARY_UNAVAILABLE", realModel: "pending" });
  }
  const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), platform: process.platform,
    arch: process.arch, harnessRoot, authentication: "not checked", modelCalls: 0,
    nativeHomeImported: false, runtimes };
  const serialized = JSON.stringify(result, null, 2) + "\n";
  if (output) fs.writeFileSync(output, serialized, { mode: 0o600 });
  process.stdout.write(serialized);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
