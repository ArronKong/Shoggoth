#!/usr/bin/env node
"use strict";

// V2.3: isolated regression baseline; rollout flags preserve legacy behavior.
// This allowlist was inspected for fake hosts/processes and temporary stores.
// In particular, codex-session-context-regression.cjs is intentionally excluded:
// it starts a real Codex binary even though its model endpoint is a local fixture.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const EVIDENCE = "fixture";
const LIMITATION = "Local deterministic fixtures only; no live CLI/model, installed App, or package acceptance evidence.";
const SUITES = Object.freeze([
  ["fresh-install", "fresh-install-baseline-unit.cjs", "Current-only startup, explicit reset requirement and stable native ownership"],
  ["inspiration-native", "inspiration-native-identity-unit.cjs", "Every enabled native Runtime executes Inspiration through the current facade and real service"],
  ["foundation", "runtime-framework-v2-foundation-unit.cjs", "Four default-off rollout flags, strict configuration and private diagnostic metadata"],
  ["rollback", "runtime-framework-rollback-unit.cjs", "Disabling rollout flags preserves persisted bindings and historical ownership"],
  ["authority", "shoggoth-authority-boundary-unit.cjs", "Product15/Chat8/Usage2 schema versions and field-level authority contracts"],
  ["native-config", "native-runtime-config-unit.cjs", "Core CAS, Service projection contracts, application and compensating rollback"],
  ["native-service-config", "native-runtime-service-config-unit.cjs", "Durable Service projection, startup reservations and recovered account capacity"],
  ["host-capacity", "runtime-host-capacity-unit.cjs", "100 workspace hosts, control headroom, safe retirement and concurrent acquisition"],
  ["crypto-capacity", "runtime-crypto-capacity-unit.cjs", "Bounded crypto FIFO backpressure, cancellation and MCP capacity"],
  ["product-store", "product-store-unit.cjs", "Strict Product15 authority, append/replay/checkpoint and corruption fences"],
  ["account-product", "runtime-account-product-store-unit.cjs", "Current account authority and immutable Binding projections"],
  ["bindings-store", "agent-runtime-bindings-unit.cjs", "Product15 Binding CAS, idempotency and frozen route preservation"],
  ["bindings-protocol", "agent-runtime-binding-protocol-unit.cjs", "Strict Agent Binding request/response contracts"],
  ["bindings-rest", "agent-runtime-bindings-rest.cjs", "Isolated Binding REST passthrough and CAS errors"],
  ["runtime-models-rest", "session-runtime-models-rest.cjs", "Production first-install config enables cross-CLI catalogs and atomic Runtime/model selection"],
  ["provider-contract", "provider-execution-contract-unit.cjs", "Provider/account/credential revision fences and persisted frozen routes"],
  ["runtime-support", "runtime-support-unit.cjs", "Frozen Binding runtime support, model support and deterministic deny reasons"],
  ["execution-context", "runtime-execution-context-unit.cjs", "Exact frozen runtime context dispatch and pre-spawn validation"],
  ["context-namespace", "runtime-context-namespace-unit.cjs", "Frozen Binding namespace controls context history across runtime/account collisions"],
  ["mcp-isolation", "runtime-mcp-bridge-isolation-unit.cjs", "Real local socket routes concurrent same-Profile MCP and revokes terminal authorization"],
  ["shared-ledger", "runtime-shared-ledger-unit.cjs", "Concurrent turn ledger writes, recovery and sibling terminal update isolation"],
  ["host-isolation", "runtime-host-isolation-unit.cjs", "Fake Codex process isolation and RPC/crypto lease limits"],
  ["context-usage", "runtime-context-usage-unit.cjs", "Context occupancy projection, runtime capability and warning thresholds"],
  ["context-budget", "conversation-context-budget-unit.cjs", "Model windows, explicit 1M fallback and adaptive history projection"],
  ["context-budget-service", "runtime-context-budget-service-unit.cjs", "Model changes and native renewal preserve capacity without inheriting occupancy"],
  ["context-request-budget", "context-request-budget-unit.cjs", "Whole requests, complete tool bodies, durable summary fragments and window growth"],
  ["context-window-handoff", "context-window-handoff-unit.cjs", "Destination capacity preflight, summary failures, source preservation and acceptance receipts"],
  ["manual-compaction", "runtime-manual-compaction-unit.cjs", "Runtime capability-gated explicit compaction lifecycle"],
  ["manual-compaction-service", "runtime-manual-compaction-service-unit.cjs", "Isolated Service compaction success, stale state and unsupported runtime"],
  ["chat-runtime-store", "chat-runtime-binding-unit.cjs", "Chat8 CAS switch, bounded retired sessions, audit outbox and restart recovery"],
  ["conversation-handoff", "runtime-conversation-handoff-unit.cjs", "Service handoff preflight, CAS races, audit repair and no old-session resume"],
  ["usage-store", "shoggoth-token-usage-store-unit.cjs", "Persistent usage accounting, idempotency and bounded summaries"],
  ["usage-v2", "token-usage-v2-unit.cjs", "Runtime/account attribution, namespace deduplication and old-format rejection"],
  ["adapter-contract", "shoggoth-runtime-adapter-contract.cjs", "Runtime-neutral contract/capabilities, Codex instruction refresh on resume and fake-host mapping"],
  ["adapter-registry", "shoggoth-runtime-adapter-registry-unit.cjs", "Exact RuntimeBinding routing, unsupported runtimes and isolated adapter shutdown"],
  ["codex-rpc", "codex-rpc-client-unit.cjs", "Codex JSONL ordering, server requests, transport failure and shutdown"],
  ["runtime-stages", "shoggoth-runtime-stage-unit.cjs", "Codex adapter startup stages, safe pre-turn retry and ambiguous acceptance rejection"],
  ["coordinator", "shoggoth-work-run-coordinator-unit.cjs", "Codex fake JSONL conversation/resume/interrupt/approval; frozen contracts, restart and unknown-dispatch no replay"],
  ["execution-store", "shoggoth-run-execution-store-unit.cjs", "Encrypted execution contract persistence, binding integrity, restart and terminal removal"],
  ["pi", "pi-runtime-adapter-unit.cjs", "Pi fake-child conversation, durable session continuation, interruption and approval"],
  ["deepseek-harness", "deepseek-harness-runtime-unit.cjs", "DSH fake bridge conversation/resume, interruption, approval and ledger isolation"],
  ["service-chat", "shoggoth-service-chat-unit.cjs", "Isolated Service chat lifecycle/recovery, native /compact command routing and encrypted Inbox locking"],
  ["codex-history", "codex-chat-history-unit.cjs", "Long/paginated Codex history, contextCompaction projection and bounded reconstruction"],
  ["idle-reaper", "runtime-idle-reaper-unit.cjs", "Idle cleanup fences, approvals, acquisition races and all enabled runtime adapters"],
  ["idle-resume", "runtime-idle-integration.cjs", "Isolated Service retires a fake host and resumes its durable conversation"],
  ["runtime-switch", "shoggoth-runtime-switch-regression.cjs", "Switch canary, journal crash recovery, rollback and frozen context/transcript"],
  ["account-resolver", "runtime-account-resolver-unit.cjs", "Temporary native/managed RuntimeAccount Homes, integration boundaries and overlap rejection"],
  ["account-cli-auth", "runtime-cli-auth-unit.cjs", "Desktop startup auth catalog uses only current account Homes without creating or importing data"],
  ["account-pools", "runtime-account-pool-routing-unit.cjs", "Fake-host pool routing by account/Profile/workspace and Home sharing"],
  ["session-ownership", "runtime-session-ownership-unit.cjs", "Persisted account/Profile/session ownership and cross-Profile rejection"],
  ["account-admission", "runtime-account-admission-unit.cjs", "Account quotas, mutation generation fences, backoff and independent accounts"],
  ["work-dispatcher", "work-dispatcher-unit.cjs", "Profile/session/workspace admission and durable WorkRun transitions"],
  ["native-concurrency", "native-concurrency-unit.cjs", "Current flag rollback, global 100 with mixed runtimes/100 interactions, startup gating, host backpressure and unknown acceptance"],
  ["context-compiler", "shoggoth-context-compiler-unit.cjs", "Frozen context revisions, resumed Transcript and trusted/untrusted separation"],
  ["context-budget", "shoggoth-context-budget-regression.cjs", "Deterministic context budgets, UTF-8 truncation and mandatory safety rules"],
  ["cron-scheduler", "shoggoth-cron-scheduler-unit.cjs", "Temporary Cron/WorkRun stores, deterministic schedule/recovery and no side-effect replay"],
  ["cron-chat", "native-cron-chat-unit.cjs", "Isolated Service/Backend Cron conversation, transcript, trajectory and continuation"],
  ["cron-binding-rollback", "runtime-cron-binding-rollback-unit.cjs", "Cron fixed Binding selection survives default changes and rollback flags"],
  ["inspiration", "shoggoth-inspiration-unit.cjs", "Temporary Inspiration execution, conversation, quota failure and restart no replay"],
].map(([id, filename, coverage]) => Object.freeze({
  id, script: `scripts/${filename}`, coverage, evidence: EVIDENCE, timeoutMs: 120_000,
})));

function parseArgs(args) {
  if (args.length === 0) return { list: false, suites: SUITES };
  if (args.length === 1 && args[0] === "--list") return { list: true, suites: SUITES };
  if (args.length === 2 && args[0] === "--suite") {
    const suite = SUITES.find((candidate) => candidate.id === args[1]);
    if (suite) return { list: false, suites: [suite] };
  }
  if (args.length === 2 && args[0] === "--from") {
    const index = SUITES.findIndex((candidate) => candidate.id === args[1]);
    if (index >= 0) return { list: false, suites: SUITES.slice(index) };
  }
  throw new Error("Usage: node scripts/runtime-framework-v2-baseline-unit.cjs [--list | --suite <exact-id> | --from <exact-id>]");
}

function childEnvironment(directory) {
  const home = path.join(directory, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  // Do not inherit credentials, native CLI Homes, NODE_OPTIONS or runtime flags.
  return {
    HOME: home, TMPDIR: directory, TMP: directory, TEMP: directory,
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    ELECTRON_RUN_AS_NODE: "1", LANG: "en_US.UTF-8", TZ: "UTC",
  };
}

function runSuite(suite, directory) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let interrupted = null;
    let executionError = null;
    let killTimer;
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, [path.join(ROOT, suite.script)], {
      cwd: ROOT, env: childEnvironment(directory), shell: false,
      stdio: ["ignore", "inherit", "inherit"], detached: grouped,
    });
    const kill = (signal) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") executionError ||= error.code || "KILL_FAILED";
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ||= setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const onInterrupt = (signal) => { interrupted ||= signal; stop(); };
    const onSigint = () => onInterrupt("SIGINT");
    const onSigterm = () => onInterrupt("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const timeout = setTimeout(() => { timedOut = true; stop(); }, suite.timeoutMs);
    child.once("error", (error) => { executionError = error.code || "SPAWN_FAILED"; });
    // Wait for natural process completion, including child stdio closure. A printed
    // PASS line is never used to infer success or to manufacture a test-case count.
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      resolve({
        id: suite.id, evidence: EVIDENCE, exitCode, signal, timedOut, interrupted,
        executionError, durationMs: Date.now() - startedAt,
        passed: exitCode === 0 && !signal && !timedOut && !interrupted && !executionError,
      });
    });
  });
}

async function main(args = process.argv.slice(2)) {
  const selection = parseArgs(args);
  if (selection.list) {
    console.log(JSON.stringify({ evidence: EVIDENCE, limitation: LIMITATION, suites: SUITES }, null, 2));
    return 0;
  }
  console.log(`[runtime-framework-v2-baseline] ${LIMITATION}`);
  console.log(`[runtime-framework-v2-baseline] selected=${selection.suites.length}; sequential; fail-fast`);
  // A short private root also leaves room for existing fixtures' Unix socket paths.
  const tempParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const root = fs.mkdtempSync(path.join(tempParent, "sgv2-"));
  fs.chmodSync(root, 0o700);
  let passed = 0;
  try {
    for (const [index, suite] of selection.suites.entries()) {
      const directory = path.join(root, String(index));
      fs.mkdirSync(directory, { mode: 0o700 });
      console.log(`\n[fixture START] ${suite.id}: ${suite.script}`);
      const result = await runSuite(suite, directory);
      console.log(`[fixture RESULT] ${JSON.stringify(result)}`);
      fs.rmSync(directory, { recursive: true, force: true });
      if (!result.passed) {
        console.error(`[fixture STOP] passed=${passed}; failed=1; notRun=${selection.suites.length - index - 1}`);
        if (result.interrupted) return result.interrupted === "SIGINT" ? 130 : 143;
        if (result.timedOut) return 124;
        return Number.isInteger(result.exitCode) && result.exitCode > 0 ? result.exitCode : 1;
      }
      passed += 1;
    }
    console.log(`[fixture PASS] ${passed}/${selection.suites.length} suites; ${LIMITATION}`);
    return 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { SUITES, parseArgs, main };
