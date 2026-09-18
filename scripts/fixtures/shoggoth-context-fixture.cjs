"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentDefinitionStore } = require("../../app/agent-service/agent-definition-store");
const { ContextCompiler } = require("../../app/agent-service/context-compiler");
const { ContextSnapshotStore } = require("../../app/agent-service/context-snapshot-store");
const { MemoryEngine } = require("../../app/agent-service/memory-engine");
const { MemoryStore } = require("../../app/agent-service/memory-store");
const { DEFAULT_TOOL_REGISTRY } = require("../../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../../app/agent-service/permission-engine");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { TranscriptStore } = require("../../app/agent-service/transcript-store");

function contextFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-context-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  let id = 0;
  const now = options.now || (() => 500);
  const randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const definitions = new AgentDefinitionStore({ paths, now, randomUUID });
  definitions.open();
  definitions.ensureProfile({ profileId: "profile-1" });
  const memoryStore = new MemoryStore({ paths });
  memoryStore.open();
  const memoryEngine = new MemoryEngine({
    store: memoryStore, definitionStore: definitions, now, randomUUID,
  });
  memoryEngine.open(["profile-1"]);
  const transcripts = new TranscriptStore({ paths, now, assertSecretSafe: () => true });
  transcripts.open();
  const snapshots = new ContextSnapshotStore({ paths });
  snapshots.open();
  const permissions = new PermissionEngine({ toolRegistry: DEFAULT_TOOL_REGISTRY });
  const compiler = new ContextCompiler({
    definitionStore: definitions,
    memoryEngine,
    memoryStore,
    transcriptStore: transcripts,
    toolRegistry: DEFAULT_TOOL_REGISTRY,
    permissionEngine: permissions,
    skillStore: options.skillStore,
    runtimeCapabilitiesForProfile: options.runtimeCapabilitiesForProfile,
    snapshotStore: snapshots,
    now,
    budgets: options.budgets,
  });
  const profile = {
    id: "profile-1",
    name: options.profileName || "Test Agent",
    runtime: options.runtime || "codex",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  };
  const transcriptSessionId = options.transcriptSessionId
    || "33333333-3333-4333-8333-333333333333";
  const run = {
    id: "run-1", source: "chat", sourceId: "session-key-1", profileId: "profile-1",
    workspace: "/tmp/context-workspace",
  };
  return {
    root, paths, definitions, memoryStore, memoryEngine, transcripts, snapshots,
    permissions, compiler, profile, run, transcriptSessionId,
    append(event) {
      return transcripts.appendEvent({
        profileId: "profile-1", sessionId: transcriptSessionId, runId: "run-1",
        runtimeRef: null, contextExcluded: false, occurredAt: 500, ...event,
      });
    },
    cleanup() {
      try { snapshots.close(); } catch {}
      try { transcripts.close(); } catch {}
      try { memoryEngine.close(); } catch {}
      try { memoryStore.close(); } catch {}
      try { definitions.close(); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { contextFixture };
