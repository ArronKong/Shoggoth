#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { AgentDefinitionStore } = require(path.join(
  ROOT, "app", "agent-service", "agent-definition-store.js",
));
const { ContextCompiler } = require(path.join(
  ROOT, "app", "agent-service", "context-compiler.js",
));
const { ContextSnapshotStore } = require(path.join(
  ROOT, "app", "agent-service", "context-snapshot-store.js",
));
const { MemoryEngine } = require(path.join(ROOT, "app", "agent-service", "memory-engine.js"));
const { MemoryStore } = require(path.join(ROOT, "app", "agent-service", "memory-store.js"));
const { DEFAULT_TOOL_REGISTRY } = require(path.join(
  ROOT, "app", "agent-service", "mcp-product-tool-controller.js",
));
const { PermissionEngine } = require(path.join(
  ROOT, "app", "agent-service", "permission-engine.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { TranscriptStore } = require(path.join(
  ROOT, "app", "agent-service", "transcript-store.js",
));
const { prepareCodexHome } = require(path.join(
  ROOT, "app", "agent-service", "codex-runtime-paths.js",
));
const { prepareGrokBuildHome } = require(path.join(
  ROOT, "app", "agent-service", "grok-build-runtime-paths.js",
));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function makeProfile(index, workspaceRoot) {
  const ordinal = index + 1;
  const codex = index % 2 === 0;
  return Object.freeze({
    id: `soak-profile-${ordinal}`,
    backendId: codex ? "codex" : "grok-build",
    agentId: `soak-agent-${ordinal}`,
    name: `Soak Agent ${ordinal}`,
    runtime: codex ? "codex" : "grok-build",
    runtimeProfileId: `soak-runtime-${ordinal}`,
    defaultModel: codex ? `model-codex-${ordinal}` : `model-grok-${ordinal}`,
    defaultCwd: path.join(workspaceRoot, `agent-${ordinal}`),
    permissionPolicy: codex
      ? { approvalPolicy: "never", sandbox: "read-only" }
      : { approvalPolicy: "on-request", sandbox: "workspace-write" },
    enabled: true,
  });
}

function marker(index, kind) {
  return `ISOLATION_${kind}_${index + 1}`;
}

function authorizeInput(profile, run) {
  return {
    profileId: profile.id,
    profile,
    name: "app_status",
    run,
    workspace: run.workspace,
  };
}

function assertForbidden(action) {
  assert.throws(action, (error) => error?.code === "MCP_TOOL_FORBIDDEN");
}

async function main() {
  const interactions = Number(option("--interactions", "100"));
  const agentCount = Number(option("--agents", "2"));
  assert.equal(Number.isSafeInteger(interactions) && interactions > 0 && interactions <= 100_000,
    true, "--interactions must be an integer in [1, 100000]");
  assert.equal(Number.isSafeInteger(agentCount) && agentCount >= 2 && agentCount <= 16,
    true, "--agents must be an integer in [2, 16]");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-isolation-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const workspaceRoot = path.join(root, "workspaces");
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const profiles = Array.from({ length: agentCount }, (_, index) => makeProfile(index, workspaceRoot));
  for (const profile of profiles) fs.mkdirSync(profile.defaultCwd, { mode: 0o700 });

  let uuidSequence = 0;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`;
  const now = () => 2_000_000 + uuidSequence;
  const definitions = new AgentDefinitionStore({ paths, now, randomUUID });
  const memoryStore = new MemoryStore({ paths });
  const memoryEngine = new MemoryEngine({ store: memoryStore, definitionStore: definitions, now, randomUUID });
  const transcripts = new TranscriptStore({ paths, now, assertSecretSafe: () => true });
  const snapshots = new ContextSnapshotStore({ paths });
  const permissions = new PermissionEngine({ paths, toolRegistry: DEFAULT_TOOL_REGISTRY });
  const runtimeHomes = new Map();

  definitions.open();
  memoryStore.open();
  transcripts.open();
  snapshots.open();
  for (const profile of profiles) definitions.ensureProfile({ profileId: profile.id });
  memoryEngine.open(profiles.map((profile) => profile.id));
  permissions.open(profiles.map((profile) => profile.id));

  try {
    for (const [index, profile] of profiles.entries()) {
      memoryEngine.propose({
        profileId: profile.id,
        scope: "agent",
        type: "semantic",
        content: `persistent preference ${marker(index, "MEMORY")}`,
        sourceRefs: [`memory-source-${index + 1}`],
        classification: "explicit",
      });
      const current = definitions.get(profile.id);
      definitions.update({
        profileId: profile.id,
        expectedRevision: current.manifest.revision,
        actor: "user",
        reason: "distinct-agent-definition",
        documents: {
          IDENTITY: `# Identity\n\n${marker(index, "IDENTITY")}\n`,
          SOUL: `# Soul\n\n${marker(index, "SOUL")}\n`,
          AGENTS: `# Rules\n\n${marker(index, "RULES")}\n`,
        },
      });
      const sessionId = `soak-session-${index + 1}`;
      transcripts.appendEvent({
        profileId: profile.id,
        sessionId,
        runId: `seed-run-${index + 1}`,
        id: `history-${index + 1}`,
        kind: "user",
        content: { text: `persistent transcript ${marker(index, "TRANSCRIPT")}` },
        runtimeRef: null,
        contextExcluded: false,
        occurredAt: now(),
      });
      transcripts.appendEvent({
        profileId: profile.id,
        sessionId,
        runId: `seed-run-${index + 1}`,
        id: `current-${index + 1}`,
        kind: "user",
        content: { text: "current request excluded from prior transcript context" },
        runtimeRef: null,
        contextExcluded: false,
        occurredAt: now(),
      });
      permissions.setProfileOverride(
        profile.id,
        "app_status",
        index % 2 === 0 ? "allow" : "deny",
        permissions.revision,
      );
      const runtimeHome = profile.runtime === "codex"
        ? prepareCodexHome(paths, profile.runtimeProfileId)
        : prepareGrokBuildHome(paths, profile.runtimeProfileId);
      runtimeHomes.set(profile.id, runtimeHome);
      assert.equal(fs.statSync(runtimeHome).mode & 0o077, 0);
    }
    assert.equal(new Set(runtimeHomes.values()).size, profiles.length,
      "every Agent must receive a distinct runtime home");

    const compiler = new ContextCompiler({
      definitionStore: definitions,
      memoryEngine,
      memoryStore,
      transcriptStore: transcripts,
      toolRegistry: DEFAULT_TOOL_REGISTRY,
      permissionEngine: permissions,
      snapshotStore: snapshots,
      now,
    });
    let frozenBeforeRevocation = null;
    let revoked = false;
    for (let interaction = 0; interaction < interactions; interaction += 1) {
      const index = interaction % profiles.length;
      const profile = profiles[index];
      const run = {
        id: `soak-run-${interaction + 1}`,
        source: "chat",
        sourceId: `soak-session-${index + 1}`,
        profileId: profile.id,
        workspace: profile.defaultCwd,
      };
      const snapshot = compiler.compile({
        profile,
        run,
        transcriptSessionId: `soak-session-${index + 1}`,
        query: "persistent preference",
      });
      const audit = Object.freeze({
        profileId: snapshot.profileId,
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        workspace: run.workspace,
        defaultModel: profile.defaultModel,
        permissionPolicy: profile.permissionPolicy,
        permissionRevision: snapshot.revisions.permission,
        developerInstructions: snapshot.developerInstructions,
        dynamicContext: snapshot.dynamicContext,
      });
      assert.equal(audit.profileId, profile.id);
      assert.equal(audit.runtimeProfileId, `soak-runtime-${index + 1}`);
      assert.equal(audit.workspace, path.join(workspaceRoot, `agent-${index + 1}`));
      assert.equal(audit.defaultModel, profile.defaultModel);
      assert.match(audit.developerInstructions, new RegExp(marker(index, "IDENTITY"), "u"));
      assert.match(audit.developerInstructions, new RegExp(marker(index, "SOUL"), "u"));
      assert.match(audit.developerInstructions, new RegExp(marker(index, "RULES"), "u"));
      assert.match(audit.developerInstructions, new RegExp(profile.defaultCwd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.match(audit.dynamicContext, new RegExp(marker(index, "MEMORY"), "u"));
      assert.match(audit.dynamicContext, new RegExp(marker(index, "TRANSCRIPT"), "u"));
      for (let other = 0; other < profiles.length; other += 1) {
        if (other === index) continue;
        assert.doesNotMatch(audit.developerInstructions, new RegExp(marker(other, "IDENTITY"), "u"));
        assert.doesNotMatch(audit.dynamicContext, new RegExp(marker(other, "MEMORY"), "u"));
        assert.doesNotMatch(audit.dynamicContext, new RegExp(marker(other, "TRANSCRIPT"), "u"));
      }
      if (index % 2 === 1 || (index === 0 && revoked)) {
        assertForbidden(() => permissions.authorize(authorizeInput(profile, run)));
      } else {
        assert.equal(permissions.authorize(authorizeInput(profile, run)).permissionRevision,
          permissions.revision);
      }
      if (!revoked && interaction >= Math.floor(interactions / 2)) {
        const target = profiles[0];
        frozenBeforeRevocation = target.id === profile.id ? snapshot : compiler.compile({
          profile: target,
          transcriptSessionId: "soak-session-1",
          run: {
            id: `soak-revocation-${interaction + 1}`,
            source: "chat",
            sourceId: "soak-session-1",
            profileId: target.id,
            workspace: target.defaultCwd,
          },
          query: "persistent preference",
        });
        const priorRevision = frozenBeforeRevocation.revisions.permission;
        permissions.setProfileOverride(target.id, "app_status", "deny", permissions.revision);
        assert.ok(permissions.revision > priorRevision);
        assertForbidden(() => permissions.authorize(authorizeInput(target, {
          id: "soak-live-revocation",
          profileId: target.id,
          workspace: target.defaultCwd,
        })));
        assert.equal(frozenBeforeRevocation.revisions.permission, priorRevision,
          "audit snapshot remains frozen while realtime authorization uses the new revision");
        revoked = true;
      }
    }
    assert.equal(revoked, true);

    snapshots.close();
    transcripts.close();
    memoryEngine.close();
    memoryStore.close();
    permissions.close();
    definitions.close();

    const restartedDefinitions = new AgentDefinitionStore({ paths, now, randomUUID });
    const restartedPermissions = new PermissionEngine({ paths, toolRegistry: DEFAULT_TOOL_REGISTRY });
    restartedDefinitions.open();
    restartedPermissions.open(profiles.map((profile) => profile.id));
    try {
      for (const [index, profile] of profiles.entries()) {
        assert.match(restartedDefinitions.get(profile.id).documents.IDENTITY,
          new RegExp(marker(index, "IDENTITY"), "u"));
        assert.equal(fs.existsSync(runtimeHomes.get(profile.id)), true);
      }
      assertForbidden(() => restartedPermissions.authorize({
        profileId: profiles[0].id,
        profile: profiles[0],
        name: "app_status",
        run: null,
      }));
    } finally {
      restartedPermissions.close();
      restartedDefinitions.close();
    }
    console.log(`PASS agent isolation soak ${interactions}/${interactions} interactions, ${agentCount} agents`);
  } finally {
    try { snapshots.close(); } catch {}
    try { transcripts.close(); } catch {}
    try { memoryEngine.close(); } catch {}
    try { memoryStore.close(); } catch {}
    try { permissions.close(); } catch {}
    try { definitions.close(); } catch {}
    assert.match(path.basename(root), /^shoggoth-agent-isolation-/u);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
