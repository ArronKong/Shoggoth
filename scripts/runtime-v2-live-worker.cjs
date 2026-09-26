"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID, NATIVE_PI_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { runWorkflow } = require("./runtime-v2-live-workflow.cjs");

function configureService(service, { model, workspaceRoot, profileId }) {
  let profile;
  if (profileId) {
    profile = service.productStore.putAgentProfile({ ...service.productStore.getAgentProfile(profileId),
      concurrency: { maxActive: 20, maxWorkspaceWrites: 20 } });
  } else {
    const base = { ...service.productStore.listAgentProfiles()[0] };
    for (const field of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[field];
    const id = crypto.randomUUID();
    profile = service.productStore.putAgentProfile({ ...base, id, backendId: "codex", agentId: `s6-${id}`,
      name: "Isolated S6 acceptance", runtime: "codex", runtimeProfileId: `s6-${id}`,
      runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID, providerRef: null, defaultModel: null,
      defaultCwd: workspaceRoot, permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
      concurrency: { maxActive: 20, maxWorkspaceWrites: 20 }, enabled: true, isDefault: false });
    service.productStore.addAgentRuntimeBinding(profile.id, { runtime: "pi", runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID },
      { operationId: "s6-add-pi" });
  }
  const nativeConfig = service.nativeRuntimeConfig.read();
  service.nativeRuntimeConfig.apply({ ...nativeConfig, revision: nativeConfig.revision + 1,
    maxActive: 20, startupConcurrency: 16, flags: { ...nativeConfig.flags,
      runtimeAdmissionV1: true, runtimeContextLifecycleV1: true, runtimeConversationHandoff: true } });
  service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
  service.memoryStore.ensureProfile(profile.id);
  service.memoryEngine.rebuildViews(profile.id);
  service.nativeSkillStore.ensureProfile(profile.id);
  return profile;
}

async function main() {
  const configPath = process.argv[2];
  const config = JSON.parse(fs.readFileSync(configPath));
  const root = fs.realpathSync(config.root);
  if (!root.startsWith("/private/tmp/sglive-") && !root.startsWith("/tmp/sglive-")) throw new Error("S6_ROOT_INVALID");
  if (fs.realpathSync(process.env.HOME) !== root || process.env.CODEX_HOME !== path.join(root, ".codex")
    || process.env.PI_CODING_AGENT_DIR !== path.join(root, ".pi", "agent")) throw new Error("S6_ENV_INVALID");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } };
  const emptyMcpFixture = path.join(__dirname, "fixtures/runtime-v2-empty-mcp.cjs");
  const mcpHelperLaunch = { command: process.execPath, argsPrefix: [emptyMcpFixture] };
  const runtimeMcpGateIssuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch, bootstrapPath: emptyMcpFixture });
  const service = createAgentService({ paths, parentEnv: { ...process.env }, runtimeStorageHomedir: root,
    piBinaryPath: config.piCli, version: "v2-isolated-live-acceptance", safeStorage,
    mcpHelperLaunch, runtimeMcpGateIssuer });
  const result = { version: 1, evidence: "isolated-source-service-real-native-provider", status: "failed", stage: "start",
    mcpEvidence: "empty-tools-transport-fixture", businessMcpVerified: false };
  const interrupted = () => { result.status = "failed"; result.errorCode = "S6_INTERRUPTED";
    service.stop({ notify: false }).catch(() => {}); };
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  let profile;
  try {
    await service.start();
    result.stage = "configure";
    profile = configureService(service, { model: config.model, workspaceRoot: path.join(root, "workspaces") });
    result.results = await (config.phase === "compaction" ? require("./runtime-compaction-live-workflow.cjs").runCompactionWorkflow : runWorkflow)({ service, paths, profileId: profile.id,
      workspaceRoot: path.join(root, "workspaces"), phase: config.phase,
      onProgress(stage) { result.stage = stage; process.stdout.write(`S6_STAGE ${stage}\n`); } });
    result.configuredNativeModels = { codex: config.model, pi: { provider: "openai-codex", model: config.model } };
    result.profileDefaultModel = null;
    result.observedModels = [...new Set(service.tokenUsageStore.list({ profileId: profile.id })
      .filter(row => typeof row.model === "string" && row.model.length <= 256).map(row => row.model))];
    result.status = "passed";
  } catch (error) {
    result.errorCode = /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code || "") ? error.code : "S6_EXECUTION_FAILED";
    if (error.fixtureCheckpointSummary) result.fixtureCheckpointSummary = require("../app/agent-service/conversation-checkpoint-store")
      .validateSummary(error.fixtureCheckpointSummary);
    process.exitCode = 1;
  } finally {
    if (profile) try {
      result.runOutcomes = service.workRunCoordinator.listRuns({ profileId: profile.id }).map(run => ({
        status: run.status, runtime: run.runtimeSessionRef?.runtime ?? null,
        errorCode: /^[A-Z][A-Z0-9_]{0,100}$/u.test(run.errorCode || "") ? run.errorCode : null,
      }));
    } catch { result.runOutcomesUnavailable = true; }
    if (result.status === "failed") {
      // Keep provider diagnostics categorical. Native error text can contain
      // secret-bearing URLs; never copy it into an acceptance artifact.
      const categories = new Set();
      for (const entry of service.piRuntimePool.entries.values()) try {
        for (const session of entry.host.ledger?.snapshot().sessions || []) {
          const file = session.sessionFile;
          if (!file || !fs.realpathSync(file).startsWith(root + path.sep) || fs.statSync(file).size > 2 * 1024 * 1024) continue;
          for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
            const text = JSON.parse(line).message?.errorMessage; if (typeof text !== "string") continue;
            categories.add(/model.*(?:not|unavailable|unsupported)|(?:not|unsupported).*model/iu.test(text) ? "MODEL_UNAVAILABLE"
              : /401|403|invalid.grant|unauthori|authentication/iu.test(text) ? "AUTH_REJECTED"
                : /429|quota|rate.limit/iu.test(text) ? "RATE_LIMITED"
                  : /network|fetch|socket|ECONN|timeout/iu.test(text) ? "NETWORK" : "PROVIDER_ERROR");
          }
        }
      } catch { categories.add("DIAGNOSTIC_UNAVAILABLE"); }
      result.nativeFailureCategories = [...categories];
      result.protocolViolations = service.workRunCoordinator.getRuntimeObservability().events
        .filter(event => event.name === "runtime.handle.violation");
    }
    try { await service.stop({ notify: false }); result.serviceStopped = true; }
    catch { result.serviceStopped = false; result.status = "failed"; result.errorCode = "S6_SERVICE_STOP_FAILED"; process.exitCode = 1; }
    key.fill(0);
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
    fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  }
}
if (require.main === module) main().catch(() => { console.error("S6_WORKER_FAILED"); process.exitCode = 1; });
module.exports = { configureService };
