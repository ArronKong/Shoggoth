import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import PluginsPage from "../../app/manage-ui/src/pages/PluginsPage";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Production page and API client. Only external I/O is replaced.
const scope = window as any;
scope.fixtureErrors = [];
scope.fixtureKeys = [];
for (const event of ["keydown", "keypress", "keyup"]) window.addEventListener(event,
  value => scope.fixtureKeys.push({ type: value.type, key: (value as KeyboardEvent).key,
    target: (value.target as HTMLElement)?.textContent?.slice(0, 40) }));
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 6_000;
  while (!predicate()) { if (performance.now() >= deadline) throw Error(message); await pause(); }
};
const a = "fixture-agent-a", b = "fixture-agent-b", installationId = "fixture-project-assistant";
const componentId = "a".repeat(64), skillId = "b".repeat(64), httpComponentId = "d".repeat(64);
const githubInstallationId = "fixture-github", githubComponentId = "9".repeat(64);
const target = (id: string) => ({ profileId: `profile-${id}`, bindingId: `binding-${id}` });
type Saved = { effect: "allow" | "deny"; approvalMode: "always" | "each-call"; revision: number; expired: boolean; matchesCurrentContract: boolean };
type AgentState = { connected: boolean; discovered: boolean; disconnected?: boolean; bindingRevision?: number; grants: Record<string, Saved> };
const agentState: Record<string, AgentState> = {};
let revision = 1, catalogRevision = 1, enabled = true, removed = false;
let showGitHub = false, githubConnected = false, bearerMode: "cancel" | "ready" = "cancel";
let githubAccounts = 0, githubSelected = "github-connection", githubBindingRevision = 1;
let githubCompatibleTools = true;
let deepLinkPagination = false;
let consentCancelNext = true, uninstallDeferred = true;
let delayedTools: { agent: string; resolve: (() => void) | null } | null = null;
const operations = new Map<string, any>();
const writes: Array<{ route: string; body: any; canceled?: boolean }> = [];
scope.fixtureWrites = writes;
const reads: string[] = [];
let externalMode = "ready";
let externalApprovalPending = false;
let externalApprovalTestRow = false, externalApprovalDecisionFails = false;
const externalApprovalCommand = JSON.stringify({ destination: "fixture-project", value: "approved",
  note: `left\u202eright\u0085\u2066\u2028${"x".repeat(180)}` });
let delayedExternal: { backend: string; cursor: string; resolve: (() => void) | null } | null = null;
function externalCatalog(backend: string, cursor: string | null) {
  const items = backend === "hermes" ? Array.from({ length: 60 }, (_, index) => ({
    pluginId: `hermes:fixture-${index}`, name: index < 2 ? "xai" : `Hermes plugin ${index + 1}`,
    version: "1.0.0", sourceKind: index === 59 ? "user" : "bundled", desiredState: "unknown", observedState: "unknown",
  })) : ["OpenClaw browser", "OpenClaw document-extract"].map((name, index) => ({
    pluginId: `openclaw:fixture-${index}`, name, version: "2026.9.5", sourceKind: "bundled", desiredState: "enabled", observedState: "active",
  }));
  const limit = backend === "hermes" ? 50 : 1, offset = Number(cursor || 0);
  return { supported: true, reasonCode: null, hostVersion: backend === "hermes" ? "0.21.4" : "2026.9.5",
    catalogRevision: `external-${backend}`, nextCursor: offset + limit < items.length ? String(offset + limit) : null,
    items: items.slice(offset, offset + limit) };
}
const oauthAgents: Record<string, boolean> = {};
const oauthFlows = new Map<string, { agent: string; status: string }>();
let oauthSequence = 0, oauthMode = "pending";
let delayedOAuthStart: { agent: string; resolve: (() => void) | null } | null = null;
let delayedOAuthStatus: { agent: string; resolve: (() => void) | null } | null = null;
let dependencySupported = false, dependencyLostResponse = false;
let delayedDependency: { resolve: (() => void) | null } | null = null;
let disconnectMode = "cancel", delayedDisconnect: { resolve: (() => void) | null } | null = null;
const disconnectOperations = new Map<string, any>();
let dependencyState = { installationId, componentId, status: "missing", revision: 0,
  operationId: null as string | null, interpreter: "node", version: null as string | null };
const oauthKey = (agent: string) => `shoggoth.plugin.oauth.${agent}.${installationId}.${httpComponentId}`;
const gitInput = { repositoryUrl: "https://example.invalid/team/project-assistant.git", commit: "e".repeat(40), subdir: "plugins/project-assistant" };
const gitPreview = { sourceKind: "remote-git", previewDigest: "f".repeat(64), expectedRevision: 0,
  specVersion: "2026-09-25", name: "Fixed Git fixture · 固定提交能力包", declaredVersion: "1.0.0", installable: true,
  components: { skills: [{ name: "git-project-summary", description: "Fixture skill", descriptorDigest: "e".repeat(64) }], mcpServers: [] }, diagnostics: [] };
const bundleUpdatePreview = { sourceKind: "bundled", previewDigest: "b".repeat(64), expectedRevision: 3,
  specVersion: "2026-09-25", name: "Fixture Update", declaredVersion: "2.0.0", installable: true,
  components: { skills: [{ name: "updated-review", description: "Updated fixture skill",
    descriptorDigest: "c".repeat(64) }], mcpServers: [] }, diagnostics: [] };
const googleBundledPreview = { sourceKind: "bundled", previewDigest: "d".repeat(64), expectedRevision: 0,
  specVersion: "2026-09-25", name: "Gmail", declaredVersion: "1.0.0", installable: true,
  components: { skills: [], mcpServers: [{ name: "gmail", type: "streamable-http",
    descriptorDigest: "f".repeat(64) }] },
  diagnostics: [{ scope: "mcp-server", name: "gmail",
    reasonCode: "CODEX_GOOGLE_DESKTOP_OAUTH_REQUIRED" }] };
let rollbackDigest = "8".repeat(64), rollbackLostResponse = false, rollbackHasSnapshot = true;
let googlePreviewInstallCount = 0;
let rollbackPending: Array<{ operationId: string; action: string; phase: string; state: string | null }> = [];
const rollbackReceipts = new Map<string, any>();
const rollbackSnapshot = { snapshotId: "5".repeat(64), snapshotDigest: "6".repeat(64), releaseDigest: "7".repeat(64), byteLength: 128, createdAt: 1_800_000_000_000 };
function seed(visual = false) {
  revision = 1; catalogRevision++; enabled = true; removed = false;
  showGitHub = false; githubConnected = false; bearerMode = "cancel";
  githubCompatibleTools = true;
  externalApprovalPending = false;
  externalApprovalTestRow = false; externalApprovalDecisionFails = false;
  githubAccounts = 0; githubSelected = "github-connection"; githubBindingRevision = 1;
  agentState[a] = { connected: visual, discovered: visual, grants: {} };
  agentState[b] = { connected: true, discovered: true, grants: {} };
  oauthAgents[a] = false; oauthAgents[b] = false; oauthFlows.clear(); oauthMode = "pending";
  disconnectMode = "cancel"; disconnectOperations.clear();
  if (visual) {
    agentState[a].grants[toolIdentity(a, 0)] = { effect: "allow", approvalMode: "each-call", revision: 1, expired: false, matchesCurrentContract: true };
    agentState[a].grants[toolIdentity(a, 1)] = { effect: "allow", approvalMode: "always", revision: 1, expired: false, matchesCurrentContract: true };
  }
  sessionStorage.clear();
  rollbackDigest = "8".repeat(64); rollbackPending = []; rollbackReceipts.clear(); rollbackLostResponse = false; rollbackHasSnapshot = true;
}
const toolIdentity = (agent: string, index: number) => `plugin:${installationId}:${componentId}:connection-${agent}:${String(index + 1).repeat(64)}`;
const toolName = (agent: string, index: number) => `${agent === a ? "A-only" : "B-only"}/${["read-project-issues-and-metadata", "create-project-issue", "list-team-review-assignments"][index]}`;
function catalog() {
  return { supported: true, catalogRevision: String(catalogRevision), nextCursor: null,
    items: removed ? [] : [{ installationId, revision, packageName: "Project Assistant · 项目协作与问题管理能力包",
      declaredVersion: "1.0.0", sourceKind: "directory", desiredState: enabled ? "enabled" : "disabled", diagnosticCount: 0,
      components: [{ componentId, kind: "mcp-server", transport: "stdio", title: "project-issues-and-collaboration-tools", state: enabled ? "connection_required" : "installed_inactive" },
        { componentId: skillId, kind: "skill", title: "issue-summary", state: enabled ? "ready" : "installed_inactive" },
        { componentId: httpComponentId, kind: "mcp-server", transport: "streamable-http",
          title: "remote-account-issues-and-project-review", state: enabled ? "connection_required" : "installed_inactive" }] },
    ...(showGitHub ? [{ installationId: githubInstallationId, revision: 1, packageName: "github",
      declaredVersion: "0.1.11", sourceKind: "bundled", desiredState: "enabled", diagnosticCount: 1,
      components: [{ componentId: githubComponentId, kind: "mcp-server", transport: "streamable-http",
        title: "github", state: githubConnected ? "permission_required" : "connection_required" }] }] : [])] };
}
function toolPage(agent: string) {
  const state = agentState[agent];
  return { ...target(agent), available: state.discovered, catalogRevision: state.discovered ? `tools-${agent}-1` : null,
    items: state.discovered ? [0, 1, 2].map(index => ({ toolIdentity: toolIdentity(agent, index), name: toolName(agent, index),
      contractDigest: String(index + 4).repeat(64), savedGrant: state.grants[toolIdentity(agent, index)] || null })) : [] };
}
function receipt(id: string, kind: string, result: any, phase = "completed") {
  const operation = { operationId: id, kind, phase, result }; operations.set(id, operation); return operation;
}
seed();
scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://fixture.invalid");
  const route = url.pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const mutation = init?.method && init.method !== "GET";
  if (mutation) writes.push({ route, body }); else reads.push(`${route}?${url.searchParams}`);
  const response = (value: unknown, status = 200) => Response.json(value, { status });
  if (route === "/__api/backends") return response({ backends: FALLBACK_BACKEND_DESCRIPTORS });
  if (route === "/__api/config") return response({ config: { disabledBackends: [] } });

  if (route === "/__api/plugins/disconnect-operation") {
    return response(disconnectOperations.get(body.operationId) || { operationId: body.operationId, found: false, phase: null, receipt: null, reasonCode: null });
  }
  if (route === "/__api/plugins/disconnect") {
    check(Object.keys(body).length === 4 && body.bindingId === target(body.agentId).bindingId, "disconnect pins the exact Agent and binding");
    if (disconnectMode === "cancel") return response({ canceled: true, receipt: null });
    const previous = disconnectOperations.get(body.operationId), state = agentState[body.agentId];
    if (!previous) {
      check(body.expectedRevision === (state.bindingRevision || 1), "disconnect binding CAS");
      state.connected = false; state.discovered = false; state.disconnected = true; state.bindingRevision = (state.bindingRevision || 1) + 1;
      for (const grant of Object.values(state.grants)) { grant.effect = "deny"; grant.revision++; }
    }
    const value = { kind: "mcp-disconnect", ...target(body.agentId), revision: state.bindingRevision,
      connectionId: `connection-${body.agentId}`, affectedBindings: 1, credentialDisposition: "none",
      cleanupStatus: disconnectMode === "pending" ? "pending" : "complete",
      reasonCode: disconnectMode === "pending" ? "PLUGIN_CONNECTION_CLEANUP_PENDING" : null };
    disconnectOperations.set(body.operationId, { operationId: body.operationId, found: true, phase: "completed", receipt: value, reasonCode: null });
    catalogRevision++;
    if (delayedDisconnect) await new Promise<void>(resolve => { delayedDisconnect!.resolve = resolve; });
    return disconnectMode === "lost" ? response({ error: "simulated response loss" }, 500) : response({ canceled: false, receipt: value });
  }
  if (route === "/__api/plugins/rollback-list") return response({ installationId, revision,
    desiredState: enabled ? "enabled" : "disabled", codeDigest: rollbackDigest,
    releases: [{ digest: "8".repeat(64), name: "Project Assistant", version: "2.0" },
      { digest: "7".repeat(64), name: "Project Assistant", version: "1.0" }],
    snapshots: rollbackHasSnapshot ? [rollbackSnapshot] : [], unavailableSnapshots: 0, pending: rollbackPending });
  if (route === "/__api/plugins/rollback-operation") {
    const receipt = rollbackReceipts.get(body.operationId) || null;
    const pending = rollbackPending.find(item => item.operationId === body.operationId);
    return response({ operationId: body.operationId, found: Boolean(receipt || pending),
      phase: pending?.phase || (receipt ? "completed" : null), receipt });
  }
  if (route === "/__api/plugins/rollback-change") {
    check(!enabled && body.expectedRevision === revision, "rollback requires disabled current revision");
    if (body.action === "code") {
      check(body.targetDigest === rollbackSnapshot.releaseDigest, "rollback pins selected old digest");
      rollbackDigest = body.targetDigest; revision++; catalogRevision++;
      rollbackPending = [{ operationId: body.operationId, action: "code", phase: "committed", state: "rollback_requires_data_restore" }];
    }
    if (body.action === "restore") {
      check(body.snapshotId === rollbackSnapshot.snapshotId && body.snapshotDigest === rollbackSnapshot.snapshotDigest,
        "data restore pins exact selected snapshot");
      revision++; catalogRevision++; rollbackPending = [];
    }
    const receipt = { operationId: body.operationId, installationId, installationRevision: revision, action: body.action,
      state: body.action === "snapshot" ? "snapshot_preserved" : body.action === "code" ? "rollback_requires_data_restore" : "restored_from_snapshot",
      releaseDigest: rollbackDigest, snapshotId: body.action === "code" ? null : rollbackSnapshot.snapshotId,
      snapshotDigest: body.action === "code" ? null : rollbackSnapshot.snapshotDigest,
      dataDigest: "4".repeat(64), retainedDataId: body.action === "restore" ? "3".repeat(64) : null };
    rollbackReceipts.set(body.operationId, receipt);
    if (rollbackLostResponse) { rollbackLostResponse = false; return response({ error: "response lost" }, 500); }
    return response({ canceled: false, receipt });
  }
  if (route === "/__api/plugins/git-preview") {
    check(JSON.stringify(body) === JSON.stringify(gitInput), "remote Git preview sends exact URL, full SHA and subdir");
    return response({ canceled: false, preview: gitPreview, selectionHandle: "fixture-git-selection" });
  }
  if (route === "/__api/plugins/bundled-preview") {
    check(["fixture-update", "gmail"].includes(body.packageId), "bundled preview pins the exact package");
    return response({ canceled: false,
      preview: body.packageId === "gmail" ? googleBundledPreview : bundleUpdatePreview,
      selectionHandle: body.packageId === "gmail" ? "fixture-google-preview" : "fixture-bundled-update" });
  }
  if (route.startsWith("/__api/plugins/bundled/") && !mutation) {
    const id = decodeURIComponent(route.slice("/__api/plugins/bundled/".length));
    const base = { id, version: "1.0.0", category: "Developer Tools", iconAvailable: false,
      developerName: "Fixture Studio", websiteURL: "https://example.invalid/plugins",
      license: "MIT", prompts: ["Summarize a design and prepare an implementation plan"],
      mcpServers: [] as Array<{ name: string; type: string }>, apps: [] as string[],
      unconvertedMcp: [] as Array<{ name: string; reasonCode: string }>,
      connectionWarnings: [] as Array<{ name: string; reasonCode: string }>, sourceWarnings: [] };
    if (id === "fixture-skill") return response({ detail: { ...base,
      displayName: "Fixture Skill", shortDescription: "A bundled skill that requires a click before installation",
      longDescription: "A detailed bundled plugin description, available before installation.",
      components: { skills: 12, allSkillFiles: 12, apps: 0, mcp: 0 }, converted: { skills: 12, mcp: 0 },
      importStatus: "previewable", skills: Array.from({ length: 12 }, (_, index) => ({
        name: index === 0 ? "fixture-design" : `fixture-design-${index + 1}`,
        description: `Creates a design implementation plan from selected screen ${index + 1}, using the project's component library and handoff notes.`,
      })), sourceWarnings: [{ code: "MISSING_OPTIONAL_LOCAL_REFERENCES",
        source: "skills/setup/SKILL.md", targets: [
          "skills/mixpanelyst/references/analytical-frameworks.md",
          "skills/mixpanelyst/references/python-api.md",
        ] }] } });
    if (id === "fixture-connector") return response({ detail: { ...base,
      displayName: "Fixture Connector", shortDescription: "A connector awaiting its Service adapter",
      longDescription: "A source connector awaiting a Shoggoth adapter.", category: "Productivity",
      components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 }, converted: { skills: 0, mcp: 0 },
      importStatus: "needs-adapter", skills: [], apps: ["fixture-app"],
      unconvertedMcp: [{ name: "fixture-api", reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }] } });
    if (id === "fixture-update") return response({ detail: { ...base,
      displayName: "Fixture Update", shortDescription: "An installed package whose bundled version differs",
      longDescription: "An installed bundled package with a newer version in this App.", version: "2.0.0",
      components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 0 }, converted: { skills: 1, mcp: 0 },
      importStatus: "previewable", skills: [{ name: "updated-review", description: "Reviews the current version." }] } });
    if (id === "gmail") return response({ detail: { ...base,
      displayName: "Gmail", shortDescription: "A fixed Google MCP endpoint needing separate login",
      longDescription: "The frozen Gmail endpoint can be installed as a distinct Shoggoth Desktop OAuth candidate.",
      components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 }, converted: { skills: 0, mcp: 1 },
      importStatus: "previewable", skills: [], apps: ["gmail"], prompts: [],
      mcpServers: [{ name: "gmail", type: "streamable-http" }],
      connectionWarnings: [{ name: "gmail", reasonCode: "CODEX_GOOGLE_DESKTOP_OAUTH_REQUIRED" }] } });
    return response({ error: "not found" }, 404);
  }
  if (route === "/__api/plugins/install") {
    check(body.selectionHandle === "fixture-git-selection" && body.previewDigest === gitPreview.previewDigest
      && body.expectedRevision === 0 && typeof body.operationId === "string", "Git install consumes the opaque selection and CAS");
    check(Object.keys(body).length === 4, "Git install does not resubmit source fields");
    const installation = { installationId: "fixed-git-fixture", revision: 1, desiredState: "disabled" };
    return response({ installation, operation: receipt(body.operationId, "install", installation) });
  }
  if (route === "/__api/plugins/dependency-status") return dependencySupported ? response(dependencyState)
    : response({ error: "unsupported fixture", code: "DEPENDENCY_INTERPRETER_UNSUPPORTED" }, 409);
  if (route === "/__api/plugins/dependency-change") {
    check(!enabled, "dependency changes require disabled installation");
    check(body.expectedRevision === revision, "dependency changes use installation CAS");
    dependencyState = { ...dependencyState, status: body.action === "prepare" ? "ready" : "revoked",
      revision: dependencyState.revision + 1, operationId: body.operationId,
      version: body.action === "prepare" ? "22.22.3" : null };
    if (delayedDependency) await new Promise<void>(resolve => { delayedDependency!.resolve = resolve; });
    if (dependencyLostResponse) { dependencyLostResponse = false; return response({ error: "response lost" }, 500); }
    return response({ canceled: false, receipt: dependencyState });
  }
  if (route === "/__api/plugins/oauth-connect") {
    check(body.componentId === httpComponentId, "OAuth uses exact HTTP component");
    if (oauthMode === "unconfigured") return response({ error: "No trusted provider", code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" }, 409);
    if (oauthMode === "cancel-consent") { oauthMode = "pending"; return response({ canceled: true, flow: null }); }
    const flowId = `flow-${body.agentId}-${++oauthSequence}`;
    oauthFlows.set(flowId, { agent: body.agentId, status: "pending" });
    if (delayedOAuthStart?.agent === body.agentId) await new Promise<void>(resolve => { delayedOAuthStart!.resolve = resolve; });
    return response({ canceled: false, flow: { flowId, status: "pending", expiresAt: Date.now() + 60_000 } });
  }
  if (route === "/__api/plugins/oauth-status" || route === "/__api/plugins/oauth-cancel") {
    const flow = oauthFlows.get(body.flowId);
    if (!flow || flow.agent !== body.agentId) return response({ error: "flow unavailable", code: "PLUGIN_OAUTH_FLOW_NOT_FOUND" }, 404);
    if (route.endsWith("oauth-cancel")) flow.status = "canceled";
    if (flow.status === "ready" && !oauthAgents[flow.agent]) { oauthAgents[flow.agent] = true; catalogRevision++; }
    const result = { flowId: body.flowId, status: flow.status, expiresAt: Date.now() + 60_000, reasonCode: null,
      bindingId: flow.status === "ready" ? `oauth-binding-${flow.agent}` : null,
      receipt: flow.status === "ready" ? { kind: "mcp-connect", profileId: target(flow.agent).profileId,
        bindingId: `oauth-binding-${flow.agent}`, toolIdentity: null, revision: 1 } : null };
    if (route.endsWith("oauth-status") && delayedOAuthStatus?.agent === body.agentId) {
      await new Promise<void>(resolve => { delayedOAuthStatus!.resolve = resolve; });
    }
    return response(result);
  }
  if (route === "/__api/plugins/bundled") return response({ batchDigest: "9".repeat(64), items: [
    { id: "fixture-skill", installationId: "c".repeat(64), displayName: "Fixture Skill",
      shortDescription: "A bundled skill that requires a click before installation", category: "Developer Tools",
      version: "1.0.0", iconAvailable: false, components: { skills: 12, allSkillFiles: 12, apps: 0, mcp: 0 },
      converted: { skills: 12, mcp: 0 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "not-installed", installedReleaseDigest: null },
    { id: "fixture-connector", installationId: "e".repeat(64), displayName: "Fixture Connector",
      shortDescription: "A connector awaiting its Service adapter", category: "Productivity",
      version: "1.0.0", iconAvailable: false, components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 },
      converted: { skills: 0, mcp: 0 }, unconvertedMcp: [{ name: "fixture-api",
        reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }],
      importStatus: "needs-adapter", installationState: "not-installed", installedReleaseDigest: null },
    { id: "fixture-update", installationId, displayName: "Fixture Update",
      shortDescription: "An installed package whose bundled version differs", category: "Developer Tools",
      version: "2.0.0", iconAvailable: false, components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 0 },
      converted: { skills: 1, mcp: 0 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "enabled", installedReleaseDigest: "a".repeat(64) },
    { id: "gmail", installationId: "d".repeat(64), displayName: "Gmail",
      shortDescription: "A fixed Google MCP endpoint needing separate login", category: "Communication",
      version: "1.0.0", iconAvailable: false, components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 },
      converted: { skills: 0, mcp: 1 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "not-installed", installedReleaseDigest: null },
    { id: "fixture-creative", installationId: "f".repeat(64), displayName: "Fixture Creative",
      shortDescription: "A design workflow", category: "Creativity",
      version: "1.0.0", iconAvailable: false, components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 0 },
      converted: { skills: 1, mcp: 0 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "not-installed", installedReleaseDigest: null },
    { id: "fixture-research", installationId: "1".repeat(64), displayName: "Fixture Research",
      shortDescription: "A research workflow", category: "Education & Research",
      version: "1.0.0", iconAvailable: false, components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 0 },
      converted: { skills: 1, mcp: 0 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "not-installed", installedReleaseDigest: null },
  ] });
  if (route === "/__api/plugins") {
    if (deepLinkPagination) {
      const cursor = Number(url.searchParams.get("cursor"));
      if (cursor === 0) return response({ page: { ...catalog(), nextCursor: 1 } });
      check(cursor === 1 && url.searchParams.get("catalogRevision") === String(catalogRevision),
        "deep link pagination pins the catalog revision");
      return response({ page: { supported: true, catalogRevision: String(catalogRevision), nextCursor: null,
        items: [{ installationId: "fixture-deep-link", revision: 1, packageName: "Deep Link Package",
          declaredVersion: "1.0.0", sourceKind: "bundled", desiredState: "enabled", diagnosticCount: 0,
          components: [{ componentId: "f".repeat(64), kind: "skill", title: "deep-skill", state: "ready" }] }] } });
    }
    return response({ page: catalog() });
  }
  if (route === "/__api/plugins/external-calls") {
    const host = url.searchParams.get("backendId");
    check(["all", "openclaw", "hermes"].includes(host || "")
      && url.searchParams.get("limit") === "10", "external call history uses a bounded read");
    const records = [
      { callId: "fixture-external-call-1", backendId: "openclaw", status: "confirmed",
        toolName: "search_issues", agentId: "fixture-openclaw-agent", approvalOutcome: "approved" },
      { callId: "fixture-external-call-2", backendId: "hermes", status: "outcome_unknown",
        toolName: "create_issue", agentId: "fixture-hermes-agent", approvalOutcome: "approved" },
      { callId: "fixture-external-call-3", backendId: "hermes", status: "rejected_before_send",
        toolName: "deny_issue", agentId: "fixture-hermes-agent", approvalOutcome: "denied" },
      { callId: "fixture-external-call-4", backendId: "openclaw", status: "rejected_before_send",
        toolName: "expired_issue", agentId: "fixture-openclaw-agent", approvalOutcome: "expired" },
      { callId: "fixture-external-call-5", backendId: "hermes", status: "canceled_before_send",
        toolName: "withdrawn_issue", agentId: "fixture-hermes-agent", approvalOutcome: "withdrawn" },
      ...(externalApprovalTestRow ? [{ callId: "fixture-external-call", backendId: "openclaw",
        status: externalApprovalPending ? "pending" : "confirmed", toolName: "write_issue",
        agentId: "fixture-openclaw-agent", approvalOutcome: externalApprovalPending ? null : "approved" }] : []),
    ].filter(item => host === "all" || item.backendId === host)
      .map(item => ({ ...item, instanceId: `fixture-${item.backendId}-instance`,
        sessionId: `fixture-session-${item.callId}`,
        runId: item.backendId === "openclaw" ? `fixture-run-${item.callId}` : null,
        taskId: item.backendId === "hermes" ? `fixture-task-${item.callId}` : null,
        turnId: item.backendId === "hermes" ? `fixture-turn-${item.callId}` : null,
        toolCallId: `fixture-tool-${item.callId}`,
        bindingId: "fixture-binding", installationId, componentId,
        connectionId: "fixture-connection", toolIdentity: toolIdentity(a, 0),
        cancelRequested: false, resultDigest: null, resultBytes: null, errorCode: null,
        approvalRequestId: item.approvalOutcome === null ? null
          : item.callId === "fixture-external-call" ? "fixture-approval" : `fixture-approval-${item.callId}`,
        approvalUpdatedAt: item.approvalOutcome === null ? null : 1_800_000_000_001,
        createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001 }));
    return response({ items: records, nextCursor: null });
  }
  if (route === "/__api/plugins/external-approvals") {
    if (mutation) {
      check(body?.requestId === "fixture-approval"
        && body?.decision === (externalApprovalDecisionFails ? "deny" : "once"),
        "external approval responds only to the exact pending request");
      if (externalApprovalDecisionFails) return response({ error: "simulated approval failure" }, 500);
      externalApprovalPending = false;
      return response({ approved: true, requestId: "fixture-approval" });
    }
    check(url.searchParams.get("limit") === "2", "external approvals use bounded pages");
    return response({ items: externalApprovalPending ? [{
      requestId: "fixture-approval", backendId: "openclaw", instanceId: "fixture-instance",
      agentId: "fixture-openclaw-agent", sessionId: "fixture-session", runId: "fixture-run",
      taskId: null, turnId: null, toolCallId: "fixture-call", callId: "fixture-external-call",
      bindingId: "fixture-binding", connectionId: "fixture-connection",
      connectionAuthRevision: 1, packageName: "Project assistant", toolName: "write_issue",
      command: externalApprovalCommand,
      argumentDigest: "a".repeat(64), expiresAt: Date.now() + 60_000,
    }] : [], nextCursor: null });
  }
  if (route === "/__api/plugins/external") {
    const backend = url.searchParams.get("backend"), cursor = url.searchParams.get("cursor");
    check(backend === "openclaw" || backend === "hermes", "external reads target only the selected host");
    if (cursor) check(url.searchParams.get("catalogRevision") === `external-${backend}`, "external pagination pins the host revision");
    if (backend === "hermes" && externalMode === "invalid") return response({ supported: false,
      reasonCode: "PLUGIN_EXTERNAL_RESPONSE_INVALID", items: [], nextCursor: null });
    if (backend === "hermes" && externalMode === "empty") return response({ supported: true,
      reasonCode: null, hostVersion: "0.21.4", items: [], nextCursor: null });
    const page = externalCatalog(backend!, cursor);
    if (delayedExternal?.backend === backend && delayedExternal.cursor === cursor) {
      await new Promise<void>(resolve => { delayedExternal!.resolve = resolve; });
    }
    return response(page);
  }
  if (route === "/__api/agents") return response({ agents: [{ id: a, name: "项目助理 A", backendId: "shoggoth" },
    { id: b, name: "项目助理 B · 独立账号与授权", backendId: "shoggoth" }] });
  if (route === "/__api/plugins/skill-bindings") return response({ profileId: target(url.searchParams.get("agentId") || a).profileId, items: [] });
  if (route === "/__api/plugins/mcp-status") {
    const agent = url.searchParams.get("agentId")!;
    if (url.searchParams.get("installationId") === githubInstallationId) {
      return response({ installationId: githubInstallationId, profileId: target(agent).profileId,
        items: [{ componentId: githubComponentId,
          connections: { pending: 0, verified: githubAccounts, disconnected: 0 },
          accounts: Array.from({ length: githubAccounts }, (_, index) => ({
            connectionId: index === 0 ? "github-connection" : `github-connection-${index + 1}`,
            label: `GitHub #${index + 42}` })),
          binding: githubConnected ? { bindingId: "github-global-binding", connectionId: githubSelected,
            enabled: true, revision: githubBindingRevision, connectionState: "ready", grants: { allow: 0, deny: 0 } } : null }] });
    }
    const state = agentState[agent];
    const grants = Object.values(state.grants);
    return response({ installationId, profileId: target(agent).profileId, items: [{ componentId,
      connections: { pending: 0, verified: state.connected ? 1 : 0, disconnected: 0 },
      accounts: state.connected ? [{ connectionId: `connection-${agent}`, label: `连接 ${agent}` }] : [],
      binding: state.connected || state.disconnected ? { bindingId: target(agent).bindingId, connectionId: `connection-${agent}`, enabled: enabled && state.connected,
        revision: state.bindingRevision || 1, connectionState: state.connected ? "ready" : "disconnected", grants: { allow: grants.filter(item => item.effect === "allow").length,
          deny: grants.filter(item => item.effect === "deny").length } } : null },
      { componentId: httpComponentId, connections: { pending: 0, verified: oauthAgents[agent] ? 1 : 0, disconnected: 0 },
        accounts: oauthAgents[agent] ? [{ connectionId: `oauth-connection-${agent}`, label: `连接 ${agent}` }] : [],
        binding: oauthAgents[agent] ? { bindingId: `oauth-binding-${agent}`, connectionId: `oauth-connection-${agent}`,
          enabled, revision: 1, connectionState: "ready", grants: { allow: 0, deny: 0 } } : null }] });
  }
  if (route === "/__api/plugins/mcp-tools") {
    const agent = url.searchParams.get("agentId")!;
    if (url.searchParams.get("bindingId") === "github-global-binding") {
      const githubTools = ["get_file_contents", "create_or_update_file"].map((name, index) => ({
        toolIdentity: `plugin:${githubInstallationId}:${githubComponentId}:${githubSelected}:${String(index + 1).repeat(64)}`,
        name, contractDigest: String(index + 3).repeat(64), savedGrant: null,
      }));
      return response({ profileId: target(agent).profileId, bindingId: "github-global-binding",
        available: true, catalogRevision: "github-tools-1", items: githubTools,
        ...(githubCompatibleTools ? { portableCapabilities: [
          { id: "repository-file-read", toolName: "get_file_contents" },
          { id: "repository-file-write", toolName: "create_or_update_file" },
        ], referenceCoverage: {
          packageId: "github", referenceName: "github",
          managedAppId: "connector_76869538009648d5b282a4bb21c3d157",
          relationship: "functional-overlap", equivalence: "unverified",
          operations: [
            { id: "repository-file-read", toolName: "get_file_contents" },
            { id: "repository-file-write", toolName: "create_or_update_file" },
          ],
        } } : {}) });
    }
    const result = structuredClone(toolPage(agent));
    if (delayedTools?.agent === agent) await new Promise<void>(resolve => { delayedTools!.resolve = resolve; });
    return response(result);
  }
  if (route === "/__api/plugins/bearer-connect") {
    check(body.agentId === a && body.installationId === githubInstallationId
      && body.componentId === githubComponentId && body.expectedRevision === 1
      && body.accessToken === "github_pat_fixture_ui", "GitHub UI submits only the selected package and typed token");
    if (bearerMode === "cancel") return response({ canceled: true, receipt: null });
    githubConnected = true; githubAccounts++;
    githubSelected = githubAccounts === 1 ? "github-connection" : `github-connection-${githubAccounts}`;
    githubBindingRevision = githubAccounts;
    catalogRevision++;
    return response({ canceled: false, receipt: { kind: "mcp-connect", profileId: target(a).profileId,
      bindingId: "github-global-binding", toolIdentity: null, revision: githubBindingRevision } });
  }
  if (route === "/__api/plugins/account-select") {
    check(body.agentId === a && body.bindingId === "github-global-binding"
      && body.expectedRevision === githubBindingRevision && body.connectionId === "github-connection"
      && githubAccounts === 2, "account selection pins exact binding revision and saved connection");
    githubSelected = body.connectionId; githubBindingRevision += 2; catalogRevision++;
    const result = { kind: "mcp-connect", profileId: target(a).profileId,
      bindingId: "github-global-binding", toolIdentity: null, revision: githubBindingRevision };
    receipt(body.operationId, "mcp-connect", result);
    return response({ canceled: false, receipt: result });
  }
  if (route === "/__api/plugins/mcp-discover") {
    check(body.bindingId === target(body.agentId).bindingId, "discovery must use selected Agent binding");
    agentState[body.agentId].discovered = true;
    return response({ ...target(body.agentId), catalogRevision: `tools-${body.agentId}-1` });
  }
  if (route === "/__api/plugins/mcp-consent") {
    if (consentCancelNext) { consentCancelNext = false; writes.at(-1)!.canceled = true; return response({ canceled: true, receipt: null }); }
    const state = agentState[body.agentId];
    const kind = body.action === "connect" ? "mcp-connect" : "grant-allow";
    if (body.action === "connect") state.connected = true;
    else {
      check(body.bindingId === target(body.agentId).bindingId, "consent uses current binding");
      check(body.toolIdentity.includes(`connection-${body.agentId}:`), "tool identity belongs to selected Agent");
      state.grants[body.toolIdentity] = { effect: "allow", approvalMode: body.approvalMode,
        revision: body.expectedRevision + 1, expired: false, matchesCurrentContract: true };
    }
    catalogRevision++;
    const value = { kind, ...target(body.agentId), toolIdentity: body.toolIdentity || null, revision: 1 };
    receipt(body.operationId, kind, value);
    return response({ canceled: false, receipt: value });
  }
  if (route === "/__api/plugins/operations") {
    const operation = operations.get(url.searchParams.get("operationId")!) || null;
    return response({ found: operation !== null, operation });
  }
  if (route === "/__api/plugins/mcp-grants/revoke") {
    const state = agentState[body.agentId], grant = state.grants[body.toolIdentity];
    check(grant?.revision === body.expectedRevision, "Grant revoke preserves revision");
    state.grants[body.toolIdentity] = { ...grant, effect: "deny", revision: grant.revision + 1 };
    catalogRevision++;
    return response({ grant: { bindingId: body.bindingId, toolIdentity: body.toolIdentity, effect: "deny", revision: grant.revision + 1, epoch: 2 },
      operation: receipt(body.operationId, "grant-revoke", null) });
  }
  if (route === "/__api/plugins/mcp-grants/revoke-all") {
    for (const grant of Object.values(agentState[body.agentId].grants)) { grant.effect = "deny"; grant.revision++; }
    catalogRevision++;
    return response({ revocation: { bindingId: body.bindingId, revokedCount: 1, bindingRevision: 1, epoch: 3 },
      operation: receipt(body.operationId, "grants-revoke-all", null) });
  }
  if (route === "/__api/plugins/uninstall-preview") return response({ installationId,
    expectedRevision: revision, releaseDigest: "c".repeat(64), requiresDisable: enabled,
    bindingCount: 2, affectedAgentCount: 2, connectionCount: 2, activeCallCount: 0,
    dataRetained: true, credentialsRetained: true });
  if (route === "/__api/plugins/state") {
    check(body.expectedRevision === revision, "state CAS"); enabled = body.desiredState === "enabled"; revision++; catalogRevision++;
    return response({ installation: { installationId, desiredState: body.desiredState, revision },
      operation: receipt(body.operationId, "installation-state", null) });
  }
  if (route === "/__api/plugins/uninstall") {
    check(!enabled, "uninstall must follow explicit disable");
    if (uninstallDeferred) { uninstallDeferred = false; receipt(body.operationId, "uninstall", null, "created");
      return response({ error: "fixture drain still active", code: "ACTIVATION_DEFERRED" }, 409); }
    check(operations.get(body.operationId)?.phase === "created", "uninstall retry preserves operation ID");
    removed = true; catalogRevision++;
    return response({ uninstall: { installationId, dataRetained: true, credentialsRetained: true },
      operation: receipt(body.operationId, "uninstall", null) });
  }
  if (route === "/__api/plugins/preview") return response({ canceled: true });
  throw Error(`Unexpected fixture network request ${init?.method || "GET"} ${route}`);
};
function Fixture() {
  const [key, setKey] = useState(0); scope.remountPlugins = () => setKey(value => value + 1);
  return <MemoryRouter initialEntries={["/plugins"]}><RouteFixtureControl /><UiProvider><NavigationGuardProvider>
    <main className="content" style={{ height: "100vh" }}><PluginsPage key={key} /></main>
  </NavigationGuardProvider></UiProvider></MemoryRouter>;
}
function RouteFixtureControl() {
  const navigate = useNavigate();
  scope.navigatePlugins = (installationId: string) => navigate(`/plugins?installationId=${encodeURIComponent(installationId)}`);
  return null;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<Fixture />);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
const click = async (text: string) => { await wait(() => button(text) && !button(text)!.disabled, `button ready: ${text}`); button(text)!.click(); await pause(); };
const detailButton = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="查看 ${name} 详情"]`);
const openDetail = async (name: string) => { await wait(() => !!detailButton(name), `detail card: ${name}`); detailButton(name)!.click(); await pause(); };
const toolsVisible = (agent: string) => document.body.textContent!.includes(toolName(agent, 0));
const hostTab = (name: string) => document.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${name}"]`);
const selectHost = async (name: string) => {
  await wait(() => !!hostTab(name), `host tab available: ${name}`);
  hostTab(name)!.click();
  await wait(() => hostTab(name)!.getAttribute("aria-selected") === "true", `host selected: ${name}`);
  await pause();
};
scope.preparePluginKeyboard = async () => {
  await selectHost("Shoggoth");
  await wait(() => !!button("已安装"), "installed library tab available");
  check(document.body.textContent!.includes("Fixture Skill"), "bundled source is browsable before installation");
  check(button("适配中")?.disabled === true, "connector declaration cannot be installed as a working tool");
  check(document.querySelector("#plugin-inspect-agent") === null,
    "bundled installation does not show an Agent selector");
  check(document.body.textContent!.includes("已转换 12 / 12 个技能"),
    "bundled card distinguishes converted Skills from source declarations");
  const groups = [...document.querySelectorAll<HTMLElement>("[data-plugin-group]")];
  check(groups.map(group => group.dataset.pluginGroup).join(",")
    === "creative,development,collaboration,research", "bundled cards follow the four requested groups");
  check(groups.map(group => group.querySelectorAll("article").length).join(",") === "1,2,2,1",
    "group headings show the correct cards without losing any plugins");
  const category = document.querySelector<HTMLSelectElement>("#plugin-library-category")!;
  check(category.options.length === 5, "the four bundled groups are selectable");
  category.value = "collaboration"; category.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => document.querySelectorAll("article").length === 2,
    "category combines productivity and communication plugins");
  check(document.querySelectorAll("[data-plugin-group]").length === 1,
    "category filter hides unrelated group headings");
  category.value = ""; category.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => document.querySelectorAll("article").length === 6, "all categories restores bundled cards");
  const search = document.querySelector<HTMLInputElement>("#plugin-library-search")!;
  const setSearch = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setSearch.call(search, "科研"); search.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => document.querySelectorAll("article").length === 1,
    "translated group name is searchable");
  check(document.querySelector<HTMLElement>("[data-plugin-group]")?.dataset.pluginGroup === "research",
    "search retains the matching group heading");
  setSearch.call(search, ""); search.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => document.querySelectorAll("article").length === 6, "clearing search restores bundled cards");
  await click("已安装");
  await wait(() => document.body.textContent!.includes("这些技能随能力包的全局启用状态生效"),
    "installed package Skills show global availability");
  check(!button("为当前助理启用") && !button("为当前助理停用"),
    "installed package Skills do not expose per-agent enable controls");
  await wait(() => button("连接本地 MCP") && !button("连接本地 MCP")!.disabled, "connect ready");
  button("连接本地 MCP")!.focus(); return { focused: document.activeElement === button("连接本地 MCP") };
};
scope.checkPluginKeyboard = async () => {
  await wait(() => writes.some(item => item.canceled) && !button("连接本地 MCP")?.disabled, "keyboard consent cancellation settled");
  check(!agentState[a].connected, "keyboard canceled consent causes no connection");
  button("连接本地 MCP")!.focus(); return true;
};
scope.checkPluginTab = () => {
  check(document.activeElement instanceof HTMLButtonElement, "Tab reaches next native control");
  if (document.hasFocus()) check(document.activeElement.matches(":focus-visible"), "keyboard focus visibly styled");
  return { focusedText: document.activeElement.textContent,
    visibleFocus: document.hasFocus() ? true : null };
};
scope.runPluginsPageFixture = async () => {
  if (!writes.some(item => item.canceled)) await click("连接本地 MCP");
  check(!agentState[a].connected, "cancelled native consent leaves binding absent");
  await click("连接本地 MCP");
  await wait(() => button("查看工具授权") && !button("查看工具授权")!.disabled, "connected state rendered");
  check(agentState[a].discovered, "connect discovers tools after trusted consent");
  agentState[a].discovered = false;
  await click("查看工具授权");
  await wait(() => toolsVisible(a), "tool discovery fallback visible");
  await click("每次调用确认");
  await wait(() => !!button("查看工具授权"), "per-call grant refresh settled");
  check(writes.some(item => item.route.endsWith("mcp-consent") && item.body.approvalMode === "each-call"), "per-call selection reaches consent API");
  await click("查看工具授权"); await wait(() => document.body.textContent!.includes("已保存每次调用审批"), "per-call status visible");
  await click("撤销允许授权");
  await wait(() => !!button("查看工具授权"), "revocation settled");
  await click("查看工具授权"); await wait(() => document.body.textContent!.includes("已保存拒绝"), "revoked Grant visible");
  await click("授权工具");
  await wait(() => !!button("查看工具授权"), "always Grant settled");
  await click("撤销全部公共允许授权");
  await wait(() => !button("撤销全部公共允许授权"), "bulk revoke settled");
  check(!document.querySelector("#plugin-inspect-agent"), "shared controls have no Agent selector");

  await click("卸载能力包"); await wait(() => !!button("确认卸载并保留数据"), "uninstall preview visible");
  check(button("确认卸载并保留数据")!.disabled, "enabled package cannot uninstall");
  check(document.body.textContent!.includes("请先停用能力包"), "disable requirement explained");
  await click("取消"); await click("停用能力包");
  await wait(() => !!button("启用能力包"), "disabled package shown");
  await click("卸载能力包"); await click("确认卸载并保留数据");
  await wait(() => !!button("继续卸载"), "deferred uninstall offers retry");
  const firstUninstall = writes.filter(item => item.route.endsWith("/uninstall"))[0].body.operationId;
  await click("继续卸载"); await wait(() => document.body.textContent!.includes("尚未安装能力包"), "uninstall completion rendered");
  const attempts = writes.filter(item => item.route.endsWith("/uninstall"));
  check(attempts.length === 2 && attempts.every(item => item.body.operationId === firstUninstall), "retry reuses exact durable operation ID");
  check(!sessionStorage.getItem("shoggoth.plugin.pending-management.v1"), "settled operation clears recovery token");
  check(scope.fixtureErrors.length === 0, `no page errors: ${scope.fixtureErrors}`);
  return { productionPage: true, consentCancellation: true, eachCallGrant: true, discovery: true,
    individualAndBulkRevocation: true, noAgentSelector: true, uninstallDisabledFirst: true,
    uninstallRetrySameOperation: true, mockedWrites: writes.length };
};
scope.runPluginOAuthFixture = async () => {
  seed(); scope.remountPlugins();
  await wait(() => !!button("连接账号"), "OAuth control mounted");
  oauthMode = "unconfigured";
  await click("连接账号");
  await wait(() => document.body.textContent!.includes("此服务尚未配置受信 OAuth 信息"), "unconfigured provider explained");
  check(!button("连接账号")!.disabled, "unconfigured provider leaves retry enabled");
  oauthMode = "cancel-consent";
  await click("连接账号");
  check(!button("取消连接") && !sessionStorage.getItem(oauthKey(a)), "canceled native consent has no pending flow");
  await click("连接账号");
  await wait(() => !!button("取消连接") && !!sessionStorage.getItem(oauthKey(a)), "pending OAuth remembered per Agent");
  await click("取消连接");
  await wait(() => !button("取消连接") && !button("连接账号")!.disabled, "canceled flow can reconnect");
  check(!sessionStorage.getItem(oauthKey(a)), "cancel clears only matching recovery hint");
  const catalogReads = reads.filter(item => item.startsWith("/__api/plugins?")).length;
  await click("连接账号");
  await wait(() => !!sessionStorage.getItem(oauthKey(a)), "ready flow ID recorded");
  oauthFlows.get(sessionStorage.getItem(oauthKey(a))!)!.status = "ready";
  await wait(() => !!button("重新连接账号") && !button("重新连接账号")!.disabled, "ready poll refreshes current MCP status");
  check(reads.filter(item => item.startsWith("/__api/plugins?")).length > catalogReads, "ready poll refreshes catalog");
  check(!sessionStorage.getItem(oauthKey(a)), "ready removes recovery hint");

  await click("重新连接账号");
  await wait(() => !!sessionStorage.getItem(oauthKey(a)), "restart flow pending");
  oauthFlows.clear(); scope.remountPlugins();
  await wait(() => !!button("重新连接账号") && !button("重新连接账号")!.disabled
    && !sessionStorage.getItem(oauthKey(a)), "Service restart clears missing flow and permits reconnect");
  check(document.body.textContent!.includes("暂时无法读取或完成连接"), "missing restarted flow is explained");

  check(scope.fixtureErrors.length === 0, `no OAuth page errors: ${scope.fixtureErrors}`);
  return { unconfiguredProviderExplained: true, canceledConsent: true, canceledFlow: true,
    readyPollRefresh: true, serviceRestartReconnect: true };
};
scope.runPluginBearerFixture = async () => {
  seed(); showGitHub = true; catalogRevision++;
  scope.remountPlugins(); await selectHost("Shoggoth");
  await wait(() => !!button("连接 GitHub 账号"), "bundled GitHub account control appears");
  await click("连接 GitHub 账号");
  const field = document.querySelector<HTMLInputElement>(`#plugin-bearer-${githubComponentId}`)!;
  check(field?.type === "password" && field.autocomplete === "off", "GitHub token is a private input");
  document.querySelector<HTMLInputElement>(`#plugin-bearer-${githubComponentId}`)!.value = "github_pat_fixture_ui";
  await click("验证并连接");
  await wait(() => !button("验证并连接")?.disabled, "canceled native confirmation settles");
  check(field.value === "" && !githubConnected, "canceled confirmation clears input without connecting");
  bearerMode = "ready"; field.value = "github_pat_fixture_ui";
  await click("验证并连接");
  await wait(() => !!button("重新连接 GitHub 账号"), "verified account refreshes installed status");
  check(document.body.innerText.includes("GitHub") && !document.body.innerText.includes("github_pat_fixture_ui"),
    "credential never appears in rendered management text");
  await click("重新连接 GitHub 账号");
  const form = document.querySelector<HTMLInputElement>(`#plugin-bearer-${githubComponentId}`)!.closest("form")!;
  form.scrollIntoView({ block: "center" });
  await pause(100);
  const rect = form.getBoundingClientRect();
  const content = document.querySelector<HTMLElement>("main.content")!;
  check(rect.left >= 0 && rect.right <= innerWidth && content.scrollWidth <= content.clientWidth + 1,
    "GitHub account form fits narrow viewport without horizontal overflow");
  document.querySelector<HTMLInputElement>(`#plugin-bearer-${githubComponentId}`)!.value = "github_pat_fixture_ui";
  await click("验证并连接");
  await wait(() => !!button("切换至 GitHub #42"), "previous verified account remains selectable");
  await click("切换至 GitHub #42");
  await wait(() => document.body.innerText.includes("当前公共账号：GitHub #42"),
    "account switch refreshes the shared selected identity");
  check(githubSelected === "github-connection" && !document.body.innerText.includes("github_pat_fixture_ui"),
    "account switch uses only the saved connection and never renders the token");
  const githubPackage = [...document.querySelectorAll<HTMLLIElement>("li")].find(item =>
    item.querySelector(":scope > div > strong")?.textContent === "github");
  const githubToolButton = (label: string) => [...(githubPackage?.querySelectorAll<HTMLButtonElement>("button") || [])]
    .find(item => item.textContent === label);
  check(!!githubPackage && !!githubToolButton("查看工具授权"), "GitHub management card exposes live tool authorization");
  githubToolButton("查看工具授权")!.click();
  await wait(() => githubPackage.textContent?.includes("实时目录操作与冻结的 GitHub 托管引用有功能交集")
    && githubPackage.textContent?.includes("读取仓库文件、写入仓库文件"),
  "verified GitHub MCP file operations appear");
  check(githubPackage.textContent?.includes("尚未证明等价"),
    "independent MCP operations do not claim managed connector equivalence");
  githubToolButton("收起工具授权")!.click(); await pause();
  githubCompatibleTools = false;
  githubToolButton("查看工具授权")!.click();
  await wait(() => githubPackage.textContent?.includes("暂未发现兼容的仓库文件或 Issue 操作"),
    "changed or missing capability profile cannot claim compatible operations");
  check(!githubPackage.textContent?.includes("读取、写入"),
    "tool names alone do not imply a verified read-write capability");
  check(!githubPackage.textContent?.includes("实时目录操作与冻结的 GitHub 托管引用有功能交集"),
    "an empty capability profile must not claim managed-reference overlap");
  check(scope.fixtureErrors.length === 0, `no GitHub page errors: ${scope.fixtureErrors}`);
  return { passwordInput: true, canceledClearsInput: true, connectedRefresh: true,
    tokenNotRendered: true, accountSwitch: true, verifiedMcpOperations: true,
    changedContractNotClaimed: true, width: innerWidth, horizontalOverflow: false };
};
scope.runPluginExternalActivityFixture = async () => {
  seed(); externalApprovalPending = true; externalApprovalTestRow = true;
  scope.remountPlugins(); await selectHost("Shoggoth");
  await click("已安装");
  await wait(() => document.body.innerText.includes("search_issues")
    && document.body.innerText.includes("create_issue"), "actual external calls are rendered");
  const panel = document.querySelector<HTMLElement>('[aria-labelledby="plugins-external-calls-heading"]')!;
  check(panel.innerText.includes("已完成") && panel.innerText.includes("结果待核对")
    && panel.innerText.includes("已允许一次") && panel.innerText.includes("已拒绝")
    && panel.innerText.includes("审批超时") && panel.innerText.includes("请求已撤回")
    && !panel.innerText.includes("fixture-tool-fixture-external-call"),
  "approval decision and tool outcome are separate, while call identity starts collapsed");
  const uncertainApproved = [...panel.querySelectorAll<HTMLLIElement>("li")]
    .find(item => item.textContent?.includes("create_issue"))!;
  check(uncertainApproved.innerText.includes("已允许一次")
    && uncertainApproved.innerText.includes("结果待核对"),
  "an allowed call can still have an unknown tool outcome");
  const identityDetails = uncertainApproved.querySelector("details")!;
  identityDetails.open = true;
  check(identityDetails.innerText.includes("fixture-session-fixture-external-call-2")
    && identityDetails.innerText.includes("fixture-task-fixture-external-call-2")
    && identityDetails.innerText.includes("fixture-turn-fixture-external-call-2")
    && identityDetails.innerText.includes("fixture-tool-fixture-external-call-2")
    && identityDetails.innerText.includes("fixture-external-call-2"),
  "read-only audit shows exact host session, turn, tool and Service call identities");
  check(!writes.some(item => item.route === "/__api/plugins/external-calls"),
    "external call activity is a read-only panel");
  const pendingCall = [...panel.querySelectorAll<HTMLLIElement>("li")]
    .find(item => item.textContent?.includes("write_issue"))!;
  check(pendingCall.innerText.includes("执行中") && !pendingCall.innerText.includes("已允许一次"),
    "pending external call has no approval outcome before a decision");
  await wait(() => document.body.innerText.includes("write_issue")
    && document.body.innerText.includes("fixture-project"), "external approval shows full arguments");
  const command = document.querySelector<HTMLElement>('#plugins-external-approvals pre')!;
  check(command.textContent!.includes("left\\u202eright\\u0085\\u2066\\u2028")
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command.textContent!)
    && command.textContent!.includes('"value":"approved"')
    && command.getAttribute("dir") === "ltr"
    && !!command.getAttribute("aria-label"),
  "external approval arguments visibly escape bidi and control characters");
  const callReadsBeforeApproval = reads.filter(item => item.startsWith("/__api/plugins/external-calls?")).length;
  const approvalReadsBeforeApproval = reads.filter(item => item.startsWith("/__api/plugins/external-approvals?")).length;
  await click("允许一次");
  await wait(() => !externalApprovalPending, "external approval action reaches exact request");
  await wait(() => reads.filter(item => item.startsWith("/__api/plugins/external-calls?")).length
    > callReadsBeforeApproval && reads.filter(item => item.startsWith("/__api/plugins/external-approvals?")).length
    > approvalReadsBeforeApproval && [...panel.querySelectorAll<HTMLLIElement>("li")]
      .some(item => item.textContent?.includes("write_issue") && item.innerText.includes("已完成")
        && item.innerText.includes("已允许一次")),
  "approval success reloads pending requests and associated call outcome");
  const approvalWrite = writes.filter(item => item.route === "/__api/plugins/external-approvals");
  check(approvalWrite.length === 1 && approvalWrite[0].body.decision === "once"
    && approvalWrite[0].body.requestId === "fixture-approval"
    && !Object.hasOwn(approvalWrite[0].body, "command"),
  "renderer only sends request identity and decision, never replacement arguments");
  externalApprovalPending = true; externalApprovalDecisionFails = true;
  scope.remountPlugins(); await selectHost("Shoggoth"); await click("已安装");
  await wait(() => document.body.innerText.includes("write_issue")
    && !!document.querySelector<HTMLElement>("#plugins-external-approvals pre"),
  "failed decision fixture restores pending approval");
  const callReadsBeforeFailure = reads.filter(item => item.startsWith("/__api/plugins/external-calls?")).length;
  const approvalReadsBeforeFailure = reads.filter(item => item.startsWith("/__api/plugins/external-approvals?")).length;
  await click("拒绝");
  await wait(() => writes.some(item => item.route === "/__api/plugins/external-approvals"
    && item.body.decision === "deny"), "failed decision reaches the exact request");
  await wait(() => reads.filter(item => item.startsWith("/__api/plugins/external-calls?")).length
    > callReadsBeforeFailure && reads.filter(item => item.startsWith("/__api/plugins/external-approvals?")).length
    > approvalReadsBeforeFailure,
  "approval failure reloads pending requests and associated call history");
  check(externalApprovalPending && document.body.innerText.includes("write_issue"),
    "failed decision keeps the approval pending");
  return { confirmedCall: true, unknownOutcome: true, readOnly: true,
    fullApprovalArguments: true, escapedInvisibleArguments: true, exactApprovalRequest: true,
    refreshedAfterDecision: true, refreshedAfterFailure: true };
};
scope.preparePluginExternalApprovalCapture = async () => {
  seed(); externalApprovalPending = true; scope.remountPlugins(); await selectHost("Shoggoth");
  await click("已安装");
  await wait(() => !!document.querySelector<HTMLElement>('[aria-labelledby="plugins-external-approvals-heading"] pre'),
    "pending external approval card renders");
  document.querySelector<HTMLElement>('[aria-labelledby="plugins-external-approvals-heading"]')!
    .scrollIntoView({ block: "start" });
  await pause(100);
  const content = document.querySelector<HTMLElement>("main.content")!;
  const command = document.querySelector<HTMLElement>("#plugins-external-approvals pre")!;
  check(content.scrollWidth <= content.clientWidth + 1
    && command.scrollWidth <= command.clientWidth + 1
    && getComputedStyle(command).direction === "ltr"
    && command.textContent!.includes("\\u202e"),
  "external approval card escapes bidi and fits narrow viewport");
  return { width: innerWidth, detail: "external-approval", fullArguments: true,
    horizontalOverflow: false };
};
scope.runPluginDependencyFixture = async () => {
  seed(); dependencySupported = true;
  dependencyState = { ...dependencyState, status: "missing", revision: 0, version: null, operationId: null };
  scope.remountPlugins();
  await wait(() => !!button("准备解释器"), "dependency control shown");
  check(button("准备解释器")!.disabled, "enabled package cannot prepare interpreter");
  await click("停用能力包"); await wait(() => !button("准备解释器")!.disabled, "disabled package can prepare interpreter");
  dependencyLostResponse = true;
  const before = writes.filter(item => item.route.endsWith("dependency-change")).length;
  await click("准备解释器");
  await wait(() => document.body.textContent!.includes("node 22.22.3") && !!button("撤销解释器登记"), "lost prepare response reconciled by status read");
  check(writes.filter(item => item.route.endsWith("dependency-change")).length === before + 1,
    "lost dependency response cannot replay preparation");
  await click("撤销解释器登记");
  await wait(() => !button("撤销解释器登记") && !button("准备解释器")!.disabled, "revocation leaves preparation available");
  delayedDependency = { resolve: null };
  await click("准备解释器"); await wait(() => !!delayedDependency?.resolve, "dependency response held");
  await click("启用能力包"); await wait(() => !!button("停用能力包"), "new enabled revision applied");
  await click("停用能力包"); await wait(() => !!button("启用能力包"), "new disabled revision applied");
  const release = delayedDependency!.resolve!; delayedDependency = null; release();
  await wait(() => !!button("准备解释器") && !button("准备解释器")!.disabled,
    "late dependency response cannot leave new revision permanently busy");
  dependencySupported = false;
  return { disabledFirst: true, prepareLostResponseReconciled: true, noProbeReplay: true, revocation: true, revisionRace: true };
};
scope.runPluginDisconnectFixture = async () => {
  seed(true); scope.remountPlugins();
  await wait(() => !!button("断开账号"), "disconnect control mounted");
  await click("断开账号"); check(agentState[a].connected, "native cancel preserves connection");
  disconnectMode = "lost";
  await click("断开账号");
  await wait(() => document.body.textContent!.includes("账号已断开，工具授权已撤销"), "lost disconnect response recovered by operation ID");
  check(!agentState[a].connected && agentState[b].connected, "disconnect affects selected connection only");
  check(Object.values(agentState[a].grants).every(grant => grant.effect === "deny"), "disconnect grants revoked");
  seed(true); scope.remountPlugins(); disconnectMode = "pending";
  await wait(() => !!button("断开账号"), "pending cleanup fixture ready"); await click("断开账号");
  await wait(() => !!button("重试旧连接清理"), "pending cleanup visible");
  const pendingOperation = writes.filter(item => item.route.endsWith("/disconnect")).at(-1)!.body.operationId;
  disconnectMode = "complete"; await click("重试旧连接清理");
  await wait(() => document.body.textContent!.includes("账号已断开，工具授权已撤销"), "cleanup retry settled");
  check(writes.filter(item => item.route.endsWith("/disconnect")).at(-1)!.body.operationId === pendingOperation, "cleanup retry preserves operation ID");
  seed(true); scope.remountPlugins(); disconnectMode = "complete"; delayedDisconnect = { resolve: null };
  await wait(() => !!button("断开账号"), "late response fixture ready"); await click("断开账号");
  await wait(() => !!delayedDisconnect?.resolve, "disconnect response held");
  const release = delayedDisconnect!.resolve!; delayedDisconnect = null; release();
  await wait(() => document.body.textContent!.includes("账号已断开，工具授权已撤销"), "late disconnect reconciles retained operation");
  const oldRequest = writes.filter(item => item.route.endsWith("/disconnect")).at(-1)!.body;
  sessionStorage.setItem(`shoggoth.plugin.disconnect.${a}.${target(a).bindingId}`, JSON.stringify(oldRequest));
  agentState[a].connected = true; agentState[a].bindingRevision = 3; scope.remountPlugins();
  await wait(() => !!button("断开账号") && !button("断开账号")!.disabled
    && !sessionStorage.getItem(`shoggoth.plugin.disconnect.${a}.${target(a).bindingId}`), "old receipt removed after a new account binding");
  check(!document.body.textContent!.includes("账号已断开，工具授权已撤销"), "historical receipt cannot mislabel newly connected account");
  const request = { agentId: a, bindingId: target(a).bindingId, expectedRevision: 1, operationId: "restore-disconnect-unknown" };
  sessionStorage.setItem(`shoggoth.plugin.disconnect.${a}.${target(a).bindingId}`, JSON.stringify(request));
  disconnectOperations.set(request.operationId, { operationId: request.operationId, found: true, phase: "outcome_unknown", receipt: null, reasonCode: "PLUGIN_RESTORE_RECONCILIATION_REQUIRED" });
  const before = writes.filter(item => item.route.endsWith("/disconnect")).length;
  scope.remountPlugins();
  await wait(() => document.body.textContent!.includes("恢复前的断开结果待核对"), "restored unknown operation explained");
  check(button("断开账号")!.disabled && writes.filter(item => item.route.endsWith("/disconnect")).length === before, "unknown disconnect is not replayed");
  return { cancelPreservesConnection: true, responseLossRecovered: true, revokeGrants: true, cleanupSameOperation: true,
    delayedResponseReconciled: true, historicalReceiptCannotMislabelNewAccount: true, restoreReplayBlocked: true };
};
scope.runPluginDefaultFixture = async () => {
  seed(); scope.remountPlugins();
  await wait(() => !!button("选择本地能力包"), "default plugin management ready");
  check(!button("启用并重新启动") && !button("切回原有环境"), "plugins need no environment switch");
  check(!writes.some(item => item.route.endsWith("/environment")), "no selector requests");
  return { defaultEnabled: true, noEnvironmentSwitch: true };
};
scope.preparePluginHostKeyboard = async () => {
  await selectHost("Shoggoth"); hostTab("Shoggoth")!.focus();
  return { focused: document.activeElement === hostTab("Shoggoth") };
};
scope.checkPluginHostKeyboard = async () => {
  await wait(() => hostTab("Hermes")?.getAttribute("aria-selected") === "true", "Enter activates the focused host");
  check(document.activeElement === hostTab("Hermes"), "host keyboard focus follows the selected tab");
  if (document.hasFocus()) check(hostTab("Hermes")!.matches(":focus-visible"), "host keyboard focus remains visible");
  return { arrowMovesFocus: true, enterSelectsHost: true,
    visibleFocus: document.hasFocus() ? true : null };
};
scope.checkPluginHostFocus = () => {
  check(document.activeElement === hostTab("Hermes"), "arrow key focuses the next host");
  check(hostTab("Shoggoth")!.getAttribute("aria-selected") === "true", "arrow navigation retains manual activation like Skills");
  return true;
};
scope.runPluginHostTabsFixture = async () => {
  const before = writes.length;
  await selectHost("Shoggoth");
  check(!document.querySelector("#external-plugins-heading"), "native tab shows no external inventory");
  await click("从固定 Git 提交添加"); fillGitFields(); await pause();
  const gitUrl = (document.getElementById("plugin-git-url") as HTMLInputElement).value;
  const native = document.querySelector<HTMLElement>('[data-plugin-host="shoggoth"]')!;
  await selectHost("Hermes");
  await wait(() => document.body.innerText.includes("已读取 50 个插件"), "Hermes first page rendered");
  check(native.hidden && !document.body.innerText.includes("选择本地能力包"), "native controls are hidden on an external host");
  check(!document.body.innerText.includes("OpenClaw browser"), "host inventories remain separate");
  check(document.body.innerText.includes("启用状态未确认"), "unknown enablement is not mislabeled disabled");
  await click("加载更多");
  await wait(() => document.body.innerText.includes("已读取 60 个插件"), "Hermes second page appended");
  const panel = document.querySelector<HTMLElement>('[data-plugin-host="hermes"]')!;
  check(panel.querySelectorAll("li").length === 60, "all Hermes items rendered");
  check([...panel.querySelectorAll("li strong")].filter(item => item.textContent === "xai · 1.0.0").length === 2, "same-name plugins retain separate rows");
  check(panel.innerText.split("内置").length - 1 === 59, "bundled plugins labeled");
  await selectHost("Shoggoth");
  check(!native.hidden && (document.getElementById("plugin-git-url") as HTMLInputElement).value === gitUrl,
    "switching back preserves the native install form");
  await selectHost("Hermes"); scope.remountPlugins(); await pause(80);
  check(hostTab("Hermes")!.getAttribute("aria-selected") === "true", "host selection persists across page remounts");
  await selectHost("OpenClaw");
  await wait(() => document.body.innerText.includes("OpenClaw browser"), "OpenClaw inventory rendered");
  delayedExternal = { backend: "openclaw", cursor: "1", resolve: null };
  await click("加载更多"); await wait(() => !!delayedExternal?.resolve, "OpenClaw page request pending");
  await selectHost("Hermes");
  await wait(() => document.body.innerText.includes("已读取 50 个插件"), "Hermes visible during another host's pending page");
  const release = delayedExternal.resolve!; delayedExternal = null; release(); await pause(80);
  check(!document.body.innerText.includes("OpenClaw document-extract"), "late pagination cannot contaminate another host");
  externalMode = "invalid"; await selectHost("Shoggoth"); await selectHost("Hermes");
  await wait(() => document.body.innerText.includes("插件目录格式暂不兼容"), "catalog failure is explained");
  check(!document.body.innerText.includes("此宿主未发现插件"), "invalid inventory is not an empty inventory");
  externalMode = "ready"; await click("重新读取");
  await wait(() => document.body.innerText.includes("已读取 50 个插件"), "catalog retry recovers");
  externalMode = "empty"; await selectHost("Shoggoth"); await selectHost("Hermes");
  await wait(() => document.body.innerText.includes("此宿主未发现插件"), "empty host catalog is explicit");
  externalMode = "ready"; await selectHost("Shoggoth");
  const readOnlyPosts = new Set(["/__api/plugins/dependency-status", "/__api/plugins/oauth-status",
    "/__api/plugins/rollback-list", "/__api/plugins/rollback-operation", "/__api/plugins/disconnect-operation"]);
  check(writes.slice(before).every(item => readOnlyPosts.has(item.route)), "tab switching and catalog reads cause no plugin mutations");
  return { separateHosts: true, nativeDraftPreserved: true, stickySelection: true, pagination: 60,
    namesakesPreserved: true, bundledLabels: 59, unknownEnablement: true, lateResponseFenced: true,
    failureNotEmpty: true, retry: true, emptyState: true, readOnly: true };
};
function fillGitFields() {
  for (const [id, value] of [["plugin-git-url", gitInput.repositoryUrl], ["plugin-git-commit", gitInput.commit], ["plugin-git-subdir", gitInput.subdir]]) {
    const input = document.getElementById(id) as HTMLInputElement;
    check(input && input.labels?.length === 1, "Git source fields have accessible labels");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
scope.preparePluginGitKeyboard = async () => {
  seed(); dependencySupported = false; scope.remountPlugins();
  await pause(80);
  await wait(() => !!button("从固定 Git 提交添加"), "Git source entry ready");
  check(!document.getElementById("plugin-git-url"), "Git form starts collapsed");
  button("从固定 Git 提交添加")!.focus();
  return { focused: document.activeElement === button("从固定 Git 提交添加") };
};
scope.preparePluginGitSubmit = async () => {
  await wait(() => !!document.getElementById("plugin-git-url"), "keyboard opens Git form");
  check(button("从固定 Git 提交添加")!.getAttribute("aria-expanded") === "true", "Git expanded state accessible");
  fillGitFields(); await pause();
  const sha = document.getElementById("plugin-git-commit") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(sha, "main"); sha.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  check(!sha.checkValidity(), "Git ref name cannot replace full commit SHA");
  setValue.call(sha, gitInput.commit); sha.dispatchEvent(new Event("input", { bubbles: true })); await pause();
  check(sha.checkValidity(), "full Git commit is valid");
  document.getElementById("plugin-git-subdir")!.focus();
};
scope.checkPluginGitTab = async () => {
  await wait(() => document.activeElement === button("获取并预览"),
    "Git Tab order reaches preview from subdir");
  if (document.hasFocus()) check(document.activeElement!.matches(":focus-visible"),
    "Git keyboard focus visibly styled");
};
scope.finishPluginGitFixture = async () => {
  await wait(() => !!button("安装并保持停用") && !button("安装并保持停用")!.disabled, "Git preview rendered after keyboard submit");
  check(document.body.textContent!.includes(gitPreview.name), "Git preview shows package contents");
  check(writes.filter(item => item.route.endsWith("git-preview")).length === 1, "Git preview sent once");
  check(!writes.some(item => item.route.endsWith("/install")), "Git preview does not install or enable");
  await click("安装并保持停用");
  await wait(() => writes.some(item => item.route.endsWith("/install")), "Git install receipt settled");
  check([...operations.values()].some(item => item.kind === "install" && item.result.desiredState === "disabled"), "Git package installs disabled");
  check(scope.fixtureErrors.length === 0, `no Git page errors: ${scope.fixtureErrors}`);
  return { collapsedByDefault: true, keyboardOpenAndSubmit: true, accessibleLabels: true,
    fullCommitRequired: true, previewWithoutInstallation: true, opaqueSelectionInstall: true, installedDisabled: true };
};
scope.runPluginRollbackFixture = async () => {
  seed(); scope.remountPlugins(); await pause(80);
  await click("数据快照与版本回退");
  await wait(() => !!button("保存数据快照"), "rollback panel ready");
  check(button("保存数据快照")!.disabled, "enabled package cannot snapshot through UI");
  await click("停用能力包"); await wait(() => !button("保存数据快照")!.disabled, "disabled rollback controls ready");
  await click("保存数据快照"); await wait(() => document.body.textContent!.includes("数据快照已保存。"), "snapshot receipt rendered");
  await click("回退代码并保持停用");
  await wait(() => document.body.textContent!.includes("恢复匹配快照之前禁止重新启用") && !button("恢复选中的数据快照")!.disabled,
    "code fence and matching data snapshot rendered");
  check(button("保存数据快照")!.disabled && button("回退代码并保持停用")!.disabled, "code fence blocks unrelated maintenance");
  const before = writes.filter(item => item.route.endsWith("rollback-change")).length;
  rollbackLostResponse = true;
  await click("恢复选中的数据快照");
  await wait(() => document.body.textContent!.includes("数据已恢复，原数据已保留。") && !button("保存数据快照")!.disabled,
    "lost data restore response reconciled through receipt");
  check(writes.filter(item => item.route.endsWith("rollback-change")).length === before + 1, "data restore never automatically replays");
  rollbackPending = [{ operationId: "restored-unknown", action: "restore", phase: "outcome_unknown", state: null }];
  scope.remountPlugins(); await pause(80); await click("数据快照与版本回退");
  await wait(() => document.body.textContent!.includes("恢复前的操作结果未知"), "unknown operation remains visible after remount");
  check(!button("继续同一维护操作"), "outcome unknown cannot be replayed from UI");
  seed(); enabled = false; rollbackHasSnapshot = false; scope.remountPlugins(); await pause(80);
  await click("数据快照与版本回退");
  await wait(() => document.body.textContent!.includes("这个旧版本没有可用的数据快照"), "missing target snapshot is explained");
  check(button("回退代码并保持停用")!.disabled, "code rollback cannot strand an installation without a matching data snapshot");
  return { disabledFirst: true, snapshotReceipt: true, persistentCodeFence: true, exactDataSnapshot: true,
    lostResponseReceipt: true, noRestoreReplay: true, unknownRemainsBlocked: true, missingTargetSnapshotBlocked: true };
};
scope.preparePluginCapture = async (theme: string) => {
  await selectHost("Shoggoth");
  await click("已安装");
  dependencySupported = true;
  dependencyState = { ...dependencyState, status: "ready", revision: 2, version: "22.22.3", operationId: "capture-prepare" };
  seed(true); document.documentElement.dataset.theme = theme; scope.remountPlugins();
  await wait(() => !!button("查看工具授权"), "capture page ready");
  await click("查看工具授权"); await wait(() => toolsVisible(a), "capture tools ready"); await pause(80);
  await click("连接账号"); await wait(() => !!button("取消连接"), "capture OAuth pending controls ready");
  await wait(() => document.body.textContent!.includes("node 22.22.3"), "capture pinned interpreter ready");
  check(!document.getElementById("plugin-environment-heading"), "no environment switch in default installation");
  await click("从固定 Git 提交添加"); fillGitFields(); await pause();
  await click("数据快照与版本回退"); await wait(() => !!button("保存数据快照"), "capture rollback controls ready");
  const content = document.querySelector<HTMLElement>("main.content")!; content.scrollTop = 0;
  const overflowing = [...document.querySelectorAll<HTMLElement>("main,section,li,select,button,input,form")].filter(element => {
    const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  });
  check(document.documentElement.scrollWidth <= innerWidth + 1 && content.scrollWidth <= content.clientWidth + 1,
    `horizontal overflow at ${innerWidth}px`);
  check(overflowing.length === 0, `controls overflow at ${innerWidth}px: ${overflowing.map(item => item.textContent?.slice(0,60))}`);
  check(getComputedStyle(button("每次调用确认")!).visibility !== "hidden", "grant buttons rendered");
  const scrollable = content.scrollHeight > content.clientHeight;
  content.scrollTop = content.scrollHeight;
  check(!scrollable || content.scrollTop > 0, "page can scroll to trailing tool controls");
  content.scrollTop = 0;
  return { width: innerWidth, theme, horizontalOverflow: false, controlsInBounds: true,
    oauthPending: true, dependencyPinned: true, disconnectControl: true, defaultPluginManagement: true,
    gitForm: true, rollbackPanel: true, scrollable, background: getComputedStyle(document.body).backgroundColor };
};
scope.prepareBundledCapture = async (theme: string) => {
  await selectHost("Shoggoth");
  document.documentElement.dataset.theme = theme;
  await click("可安装");
  await wait(() => document.querySelectorAll("article").length === 6, "bundled cards rendered");
  const installCount = writes.filter(item => item.route === "/__api/plugins/install").length;
  await openDetail("Fixture Update");
  await wait(() => document.querySelector<HTMLDialogElement>("dialog[open]")?.textContent?.includes("newer version"),
    "installed bundle details loaded");
  const previewButton = [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")]
    .find(item => item.textContent === "检查版本");
  check(previewButton && !previewButton.disabled, "detail action opens the existing version preview");
  previewButton!.click();
  await wait(() => document.body.textContent!.includes("App 所带版本与当前安装不同"),
    "different bundled version is explicit before updating");
  await wait(() => document.activeElement?.className.includes("previewPanel"),
    "installation preview receives focus after leaving the modal");
  check(button("安装更新")?.disabled === true, "enabled package must drain before updating");
  check(writes.filter(item => item.route === "/__api/plugins/install").length === installCount,
    "version check never silently installs the bundled update");
  await click("可安装");
  await wait(() => document.querySelectorAll("article").length === 6, "bundled cards restored");
  const content = document.querySelector<HTMLElement>("main.content")!;
  content.scrollTop = 0;
  const overflowing = [...document.querySelectorAll<HTMLElement>("article,button,input,[role=tablist]")]
    .filter(element => { const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1); });
  check(content.scrollWidth <= content.clientWidth + 1 && overflowing.length === 0,
    `bundled library overflows at ${innerWidth}px`);
  check(button("查看并安装")?.disabled === false && button("适配中")?.disabled === true,
    "ready and pending bundle actions remain distinct");
  return { width: innerWidth, theme, view: "bundled", cards: 6,
    updateRequiresDisable: true, horizontalOverflow: false };
};
scope.prepareBundledDetailCapture = async () => {
  const before = writes.length;
  await openDetail("Fixture Skill");
  await wait(() => document.querySelector<HTMLDialogElement>("dialog[open]")?.textContent?.includes("A detailed bundled plugin description"),
    "bundled details load on demand");
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  check(dialog.textContent!.includes("fixture-design") && dialog.textContent!.includes("Fixture Studio")
    && dialog.textContent!.includes("Summarize a design"), "details show source Skills, developer and example uses");
  check(dialog.textContent!.includes("来源包参考文档缺失")
    && dialog.textContent!.includes("skills/mixpanelyst/references/analytical-frameworks.md")
    && dialog.textContent!.includes("skills/mixpanelyst/references/python-api.md"),
  "missing source references are disclosed in the plugin detail before installation");
  check(reads.some(item => item.startsWith("/__api/plugins/bundled/fixture-skill?")), "detail fetched on card click");
  check(writes.length === before, "opening details does not install or authorize anything");
  check(document.activeElement === dialog.querySelector('[aria-label="关闭插件详情"]'), "modal focus moves to close control");
  const rect = dialog.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    "detail dialog fits viewport");
  const scroll = dialog.querySelector<HTMLElement>('[class*="scroll"]');
  check(!scroll || scroll.scrollWidth <= scroll.clientWidth + 1, "detail content has no horizontal overflow");
  return { width: innerWidth, detail: "skill", readOnly: true, horizontalOverflow: false };
};
scope.prepareGoogleBundledDetailCapture = async () => {
  googlePreviewInstallCount = writes.filter(item => item.route === "/__api/plugins/install").length;
  await selectHost("Shoggoth");
  await click("可安装");
  await openDetail("Gmail");
  await wait(() => document.querySelector<HTMLDialogElement>("dialog[open]")?.textContent
    ?.includes("Google MCP 需单独授权"), "Google Desktop OAuth warning loaded before installation");
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  check(dialog.textContent!.includes("不沿用来源包的占位客户端、密钥、12798 回调或整组权限"),
    "detail explicitly discloses non-equivalent frozen authentication");
  check(dialog.textContent!.includes("安装本身不会连接账号"),
    "detail distinguishes installation from account connection");
  const rect = dialog.getBoundingClientRect();
  const scroll = dialog.querySelector<HTMLElement>('[class*="scroll"]')!;
  check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    "Google detail fits viewport");
  check(scroll.scrollWidth <= scroll.clientWidth + 1, "Google detail has no horizontal overflow");
  return { width: innerWidth, detail: "google", warning: true,
    left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth };
};
scope.prepareGoogleBundledPreviewCapture = async () => {
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  const preview = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent === "查看安装预览");
  check(preview && !preview.disabled, "Google install preview remains available");
  preview!.click();
  await wait(() => !document.querySelector("dialog[open]")
    && document.querySelector('[class*="previewPanel"]')?.textContent
      ?.includes("此组件仅转换固定的 Google MCP 端点"),
    "Google non-equivalent authentication warning appears in installation preview");
  const panel = document.querySelector<HTMLElement>('[class*="previewPanel"]')!;
  panel.scrollIntoView({ block: "center" });
  const content = document.querySelector<HTMLElement>("main.content")!;
  check(content.scrollWidth <= content.clientWidth + 1,
    "Google install preview has no horizontal overflow");
  check(writes.filter(item => item.route === "/__api/plugins/install").length === googlePreviewInstallCount,
    "Google detail and preview never install or authorize by themselves");
  const rect = panel.getBoundingClientRect();
  return { width: innerWidth, preview: "google", warning: true,
    left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    scrollWidth: content.scrollWidth, clientWidth: content.clientWidth };
};
scope.closeGoogleBundledPreview = async () => {
  const panel = document.querySelector<HTMLElement>('[class*="previewPanel"]')!;
  const cancel = [...panel.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent === "取消");
  check(cancel, "Google preview has a cancel action");
  cancel!.click();
  await wait(() => !document.querySelector('[class*="previewPanel"]'),
    "Google preview closes without installation");
};
scope.checkBundledDetailClosed = async () => {
  await wait(() => !document.querySelector("dialog[open]"), "Escape closes bundled details");
  check(document.activeElement === detailButton("Fixture Skill"), "detail close restores card focus");
  return true;
};
scope.expandBundledSkills = async () => {
  await click("查看全部 12 个技能");
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  check(dialog.querySelectorAll('[class*="componentList"] li').length === 12,
    "all Skills expand in the detail dialog");
  const scroll = dialog.querySelector<HTMLElement>('[class*="scroll"]')!;
  scroll.scrollTop = scroll.scrollHeight;
  check(scroll.scrollTop > 0, "long Skill details scroll inside the dialog");
  const rect = dialog.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    "expanded Skills keep dialog in the viewport");
  return { detail: "expanded-skills", count: 12, internalScroll: true, horizontalOverflow: false };
};
scope.expandBundledGap = async () => {
  await openDetail("Fixture Connector");
  await wait(() => document.querySelector<HTMLDialogElement>("dialog[open]")?.textContent?.includes("fixture-api"),
    "unconverted MCP is visible in details");
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  check(dialog.textContent!.includes("包含尚未适配的配置字段")
    && dialog.textContent!.includes("fixture-app")
    && dialog.textContent!.includes("目前没有对应的账号连接设置")
    && (button("适配中")?.disabled ?? false), "pending MCP and app are never presented as usable");
  const rect = dialog.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    "pending details fit narrow viewport");
  return { detail: "pending", horizontalOverflow: false };
};
scope.runBundledManageFixture = async () => {
  seed(); scope.remountPlugins(); await selectHost("Shoggoth");
  await click("可安装");
  await openDetail("Fixture Update");
  await wait(() => !!button("管理已安装插件"), "installed package management entry appears in detail");
  const before = writes.length;
  const statusRoutes = new Set(["/__api/plugins/oauth-status", "/__api/plugins/dependency-status",
    "/__api/plugins/rollback-list", "/__api/plugins/disconnect-operation"]);
  await click("管理已安装插件");
  await wait(() => button("已安装")?.getAttribute("aria-selected") === "true"
    && !!document.querySelector<HTMLElement>('[data-targeted="true"]'), "detail opens selected installed package");
  const target = document.querySelector<HTMLElement>('[data-targeted="true"]')!;
  check(target.textContent!.includes("Project Assistant") && document.activeElement === target,
    "matching installed package is visible and focused");
  check(writes.slice(before).every(item => statusRoutes.has(item.route)),
    "opening management does not mutate the installation");
  deepLinkPagination = true;
  await selectHost("Hermes");
  scope.navigatePlugins("fixture-deep-link");
  await wait(() => hostTab("Shoggoth")?.getAttribute("aria-selected") === "true"
    && document.querySelector<HTMLElement>('[data-targeted="true"]')?.textContent?.includes("Deep Link Package"),
  "chat deep link opens and locates an installed package on a later page");
  check(reads.some(item => item.includes("cursor=1") && item.includes("catalogRevision=")),
    "deep link loads additional catalog pages with revision pinning");
  // The page resumes pending OAuth/status receipts after remount; those POST
  // endpoints are read-only. A deep link must not start a new management action.
  check(writes.slice(before).every(item => statusRoutes.has(item.route)),
    "deep link never mutates the installation");
  return { detailManagement: true, exactInstallationTarget: true,
    paginatedDeepLink: true, hostSwitch: true, noImplicitWrite: true };
};
scope.closeBundledDetail = async () => {
  document.querySelector<HTMLButtonElement>('[aria-label="关闭插件详情"]')!.click();
  await wait(() => !document.querySelector("dialog[open]"), "detail closes");
};
scope.preparePluginExternalCapture = async (theme: string, name: string) => {
  document.documentElement.dataset.theme = theme;
  externalMode = "ready"; await selectHost(name);
  await wait(() => document.querySelector('[data-plugin-host]:not([hidden]) li'), "external capture inventory ready");
  const content = document.querySelector<HTMLElement>("main.content")!; content.scrollTop = 0;
  await pause(380);
  const overflowing = [...document.querySelectorAll<HTMLElement>("section,li,button,[role=tablist]")].filter(element => {
    const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
  });
  check(content.scrollWidth <= content.clientWidth + 1 && overflowing.length === 0, `external ${name} geometry at ${innerWidth}px`);
  const tab = hostTab(name)!.getBoundingClientRect();
  check(tab.top >= 0 && tab.bottom < innerHeight, "host tabs are visible at the page top");
  const scrollable = content.scrollHeight > content.clientHeight;
  content.scrollTop = content.scrollHeight;
  check(!scrollable || content.scrollTop > 0, "external catalog scrolls to the final item");
  content.scrollTop = 0;
  return { width: innerWidth, theme, host: name, horizontalOverflow: false, tabsVisible: true, scrollable };
};
