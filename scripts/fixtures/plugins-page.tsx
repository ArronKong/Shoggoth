import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
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
const target = (id: string) => ({ profileId: `profile-${id}`, bindingId: `binding-${id}` });
type Saved = { effect: "allow" | "deny"; approvalMode: "always" | "each-call"; revision: number; expired: boolean; matchesCurrentContract: boolean };
type AgentState = { connected: boolean; discovered: boolean; disconnected?: boolean; bindingRevision?: number; grants: Record<string, Saved> };
const agentState: Record<string, AgentState> = {};
let revision = 1, catalogRevision = 1, enabled = true, removed = false;
let consentCancelNext = true, uninstallDeferred = true;
let delayedTools: { agent: string; resolve: (() => void) | null } | null = null;
const operations = new Map<string, any>();
const writes: Array<{ route: string; body: any; canceled?: boolean }> = [];
scope.fixtureWrites = writes;
const reads: string[] = [];
let externalMode = "ready";
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
let rollbackDigest = "8".repeat(64), rollbackLostResponse = false, rollbackHasSnapshot = true;
let rollbackPending: Array<{ operationId: string; action: string; phase: string; state: string | null }> = [];
const rollbackReceipts = new Map<string, any>();
const rollbackSnapshot = { snapshotId: "5".repeat(64), snapshotDigest: "6".repeat(64), releaseDigest: "7".repeat(64), byteLength: 128, createdAt: 1_800_000_000_000 };
function seed(visual = false) {
  revision = 1; catalogRevision++; enabled = true; removed = false;
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
      components: [{ componentId, kind: "mcp-server", transport: "stdio", title: "project-issues-and-collaboration-tools", state: "installed_inactive" },
        { componentId: skillId, kind: "skill", title: "issue-summary", state: "installed_inactive" },
        { componentId: httpComponentId, kind: "mcp-server", transport: "streamable-http",
          title: "remote-account-issues-and-project-review", state: "installed_inactive" }] }] };
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
    check(body.packageId === "fixture-update", "bundled update previews the exact package");
    return response({ canceled: false, preview: bundleUpdatePreview,
      selectionHandle: "fixture-bundled-update" });
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
      version: "1.0.0", iconAvailable: false, components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 0 },
      converted: { skills: 1, mcp: 0 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "not-installed", installedReleaseDigest: null },
    { id: "fixture-connector", installationId: "e".repeat(64), displayName: "Fixture Connector",
      shortDescription: "A connector awaiting its Service adapter", category: "Productivity",
      version: "1.0.0", iconAvailable: false, components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 },
      converted: { skills: 0, mcp: 0 }, unconvertedMcp: [{ name: "fixture-api",
        reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }],
      importStatus: "needs-adapter", installationState: "not-installed", installedReleaseDigest: null },
    { id: "fixture-update", installationId: "d".repeat(64), displayName: "Fixture Update",
      shortDescription: "An installed package whose bundled version differs", category: "Developer Tools",
      version: "2.0.0", iconAvailable: false, components: { skills: 1, allSkillFiles: 1, apps: 0, mcp: 0 },
      converted: { skills: 1, mcp: 0 }, unconvertedMcp: [],
      importStatus: "previewable", installationState: "enabled", installedReleaseDigest: "a".repeat(64) },
  ] });
  if (route === "/__api/plugins") return response({ page: catalog() });
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
    const state = agentState[agent];
    const grants = Object.values(state.grants);
    return response({ installationId, profileId: target(agent).profileId, items: [{ componentId,
      connections: { pending: 0, verified: state.connected ? 1 : 0, disconnected: 0 },
      binding: state.connected || state.disconnected ? { bindingId: target(agent).bindingId, connectionId: `connection-${agent}`, enabled: enabled && state.connected,
        revision: state.bindingRevision || 1, connectionState: state.connected ? "ready" : "disconnected", grants: { allow: grants.filter(item => item.effect === "allow").length,
          deny: grants.filter(item => item.effect === "deny").length } } : null },
      { componentId: httpComponentId, connections: { pending: 0, verified: oauthAgents[agent] ? 1 : 0, disconnected: 0 },
        binding: oauthAgents[agent] ? { bindingId: `oauth-binding-${agent}`, connectionId: `oauth-connection-${agent}`,
          enabled, revision: 1, connectionState: "ready", grants: { allow: 0, deny: 0 } } : null }] });
  }
  if (route === "/__api/plugins/mcp-tools") {
    const agent = url.searchParams.get("agentId")!;
    const result = structuredClone(toolPage(agent));
    if (delayedTools?.agent === agent) await new Promise<void>(resolve => { delayedTools!.resolve = resolve; });
    return response(result);
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
  return <MemoryRouter initialEntries={["/plugins"]}><UiProvider><NavigationGuardProvider>
    <main className="content" style={{ height: "100vh" }}><PluginsPage key={key} /></main>
  </NavigationGuardProvider></UiProvider></MemoryRouter>;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<Fixture />);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
const click = async (text: string) => { await wait(() => button(text) && !button(text)!.disabled, `button ready: ${text}`); button(text)!.click(); await pause(); };
const selector = () => document.querySelector<HTMLSelectElement>("#plugin-inspect-agent")!;
const selectAgent = async (agent: string) => {
  selector().value = agent; selector().dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => selector().value === agent, "Agent selection applied"); await pause(60);
};
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
  check(document.querySelector<HTMLElement>("#plugin-inspect-agent")?.offsetParent === null,
    "bundled installation does not show an Agent selector");
  check(document.body.textContent!.includes("已转换 1 / 1 个技能"),
    "bundled card distinguishes converted Skills from source declarations");
  await click("已安装");
  await wait(() => document.body.textContent!.includes("这些技能随能力包的全局启用状态生效"),
    "installed package Skills show global availability");
  check(!button("为当前助理启用") && !button("为当前助理停用"),
    "installed package Skills do not expose per-agent enable controls");
  await wait(() => button("连接本地 MCP") && !button("连接本地 MCP")!.disabled, "connect ready");
  button("连接本地 MCP")!.focus(); return { focused: document.activeElement === button("连接本地 MCP") };
};
scope.checkPluginKeyboard = async () => {
  await wait(() => writes.some(item => item.canceled) && !selector().disabled, "keyboard consent cancellation settled");
  check(!agentState[a].connected, "keyboard canceled consent causes no connection");
  selector().focus(); return true;
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
  await wait(() => button("查看工具授权") && !selector().disabled, "connected state rendered");
  check(agentState[a].discovered, "connect discovers tools after trusted consent");
  agentState[a].discovered = false;
  await click("查看工具授权");
  await wait(() => toolsVisible(a), "tool discovery fallback visible");
  await click("每次调用确认");
  await wait(() => !selector().disabled && !!button("查看工具授权"), "per-call grant refresh settled");
  check(writes.some(item => item.route.endsWith("mcp-consent") && item.body.approvalMode === "each-call"), "per-call selection reaches consent API");
  await click("查看工具授权"); await wait(() => document.body.textContent!.includes("已保存每次调用审批"), "per-call status visible");
  await click("撤销允许授权");
  await wait(() => !selector().disabled && !!button("查看工具授权"), "revocation settled");
  await click("查看工具授权"); await wait(() => document.body.textContent!.includes("已保存拒绝"), "revoked Grant visible");
  await click("授权工具");
  await wait(() => !selector().disabled && !!button("查看工具授权"), "always Grant settled");
  await click("撤销此助理的全部允许授权");
  await wait(() => !selector().disabled && !button("撤销此助理的全部允许授权"), "bulk revoke settled");

  delayedTools = { agent: a, resolve: null };
  await click("查看工具授权"); await wait(() => !!delayedTools?.resolve, "Agent A tool request pending");
  await selectAgent(b);
  check(!toolsVisible(a), "switch clears old Agent tools immediately");
  await click("查看工具授权"); await wait(() => toolsVisible(b), "Agent B tools rendered");
  const release = delayedTools!.resolve!; delayedTools = null; release(); await pause(80);
  check(toolsVisible(b) && !toolsVisible(a), "late Agent A response cannot overwrite Agent B");
  await selectAgent(a);

  await click("卸载能力包"); await wait(() => !!button("确认卸载并保留数据"), "uninstall preview visible");
  check(button("确认卸载并保留数据")!.disabled, "enabled package cannot uninstall");
  check(document.body.textContent!.includes("请先停用能力包"), "disable requirement explained");
  await click("取消"); await click("停用能力包");
  await wait(() => !!button("启用能力包") && !selector().disabled, "disabled package shown");
  await click("卸载能力包"); await click("确认卸载并保留数据");
  await wait(() => !!button("继续卸载"), "deferred uninstall offers retry");
  check(selector().disabled, "uncertain uninstall locks Agent selection");
  const firstUninstall = writes.filter(item => item.route.endsWith("/uninstall"))[0].body.operationId;
  await click("继续卸载"); await wait(() => document.body.textContent!.includes("尚未安装能力包"), "uninstall completion rendered");
  const attempts = writes.filter(item => item.route.endsWith("/uninstall"));
  check(attempts.length === 2 && attempts.every(item => item.body.operationId === firstUninstall), "retry reuses exact durable operation ID");
  check(!sessionStorage.getItem("shoggoth.plugin.pending-management.v1"), "settled operation clears recovery token");
  check(scope.fixtureErrors.length === 0, `no page errors: ${scope.fixtureErrors}`);
  return { productionPage: true, consentCancellation: true, eachCallGrant: true, discovery: true,
    individualAndBulkRevocation: true, staleAgentResponseRejected: true, uninstallDisabledFirst: true,
    uninstallRetrySameOperation: true, mockedWrites: writes.length };
};
scope.runPluginOAuthFixture = async () => {
  seed(); scope.remountPlugins();
  await wait(() => selector()?.value === a && !!button("连接账号"), "OAuth control mounted");
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

  delayedOAuthStatus = { agent: a, resolve: null };
  await click("重新连接账号");
  await wait(() => !!delayedOAuthStatus?.resolve, "Agent A poll held");
  await selectAgent(b);
  check(!button("取消连接") && !!button("连接账号"), "Agent B does not show Agent A pending flow");
  const releasePoll = delayedOAuthStatus!.resolve!; delayedOAuthStatus = null; releasePoll(); await pause(80);
  check(!button("取消连接") && !sessionStorage.getItem(oauthKey(b)), "late A poll cannot write B flow");
  await selectAgent(a); await wait(() => !!button("取消连接"), "returning to A resumes its own flow");
  await click("取消连接");
  await wait(() => !button("取消连接"), "poll test flow canceled");

  delayedOAuthStart = { agent: a, resolve: null };
  await click("重新连接账号");
  await wait(() => !!delayedOAuthStart?.resolve, "Agent A native start response held");
  const lateFlowId = [...oauthFlows.keys()].at(-1)!;
  await selectAgent(b);
  const releaseStart = delayedOAuthStart!.resolve!; delayedOAuthStart = null; releaseStart(); await pause(100);
  check(!button("取消连接") && !sessionStorage.getItem(oauthKey(b)), "late A connect cannot open B state");
  check(oauthFlows.get(lateFlowId)?.status === "canceled" || sessionStorage.getItem(oauthKey(a)) === lateFlowId,
    "late A connect must remain recoverable or be canceled, never orphaned");
  await selectAgent(a);
  if (button("取消连接")) await click("取消连接");
  check(scope.fixtureErrors.length === 0, `no OAuth page errors: ${scope.fixtureErrors}`);
  return { unconfiguredProviderExplained: true, canceledConsent: true, canceledFlow: true,
    readyPollRefresh: true, serviceRestartReconnect: true, crossAgentLatePoll: true, crossAgentLateConnect: true };
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
  await click("启用能力包"); await wait(() => !!button("停用能力包") && !selector().disabled, "new enabled revision applied");
  await click("停用能力包"); await wait(() => !!button("启用能力包") && !selector().disabled, "new disabled revision applied");
  const release = delayedDependency!.resolve!; delayedDependency = null; release();
  await wait(() => !!button("准备解释器") && !button("准备解释器")!.disabled,
    "late dependency response cannot leave new revision permanently busy");
  dependencySupported = false;
  return { disabledFirst: true, prepareLostResponseReconciled: true, noProbeReplay: true, revocation: true, revisionRace: true };
};
scope.runPluginDisconnectFixture = async () => {
  seed(true); scope.remountPlugins();
  await wait(() => selector()?.value === a && !!button("断开账号"), "disconnect control mounted");
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
  await wait(() => !!delayedDisconnect?.resolve, "disconnect response held"); await selectAgent(b);
  const release = delayedDisconnect!.resolve!; delayedDisconnect = null; release(); await pause(80);
  check(agentState[b].connected && !document.body.textContent!.includes("账号已断开，工具授权已撤销"), "late A disconnect cannot overwrite B status");
  await selectAgent(a);
  await wait(() => document.body.textContent!.includes("账号已断开，工具授权已撤销"), "return to A reconciles retained operation");
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
    crossAgentLateResponse: true, historicalReceiptCannotMislabelNewAccount: true, restoreReplayBlocked: true };
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
  await wait(() => !!button("从固定 Git 提交添加") && !selector().disabled, "Git source entry ready");
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
scope.checkPluginGitTab = () => {
  check(document.activeElement === button("获取并预览"), "Git Tab order reaches preview from subdir");
  if (document.hasFocus()) check(document.activeElement!.matches(":focus-visible"),
    "Git keyboard focus visibly styled");
};
scope.finishPluginGitFixture = async () => {
  await wait(() => !!button("安装并保持停用") && !button("安装并保持停用")!.disabled, "Git preview rendered after keyboard submit");
  check(document.body.textContent!.includes(gitPreview.name), "Git preview shows package contents");
  check(writes.filter(item => item.route.endsWith("git-preview")).length === 1, "Git preview sent once");
  check(!writes.some(item => item.route.endsWith("/install")), "Git preview does not install or enable");
  await click("安装并保持停用");
  await wait(() => writes.some(item => item.route.endsWith("/install")) && !selector().disabled, "Git install receipt settled");
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
  await wait(() => !!button("查看工具授权") && selector()?.value === a, "capture page ready");
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
  await wait(() => document.querySelectorAll("article").length === 3, "bundled cards rendered");
  const installCount = writes.filter(item => item.route === "/__api/plugins/install").length;
  await click("检查版本");
  await wait(() => document.body.textContent!.includes("App 所带版本与当前安装不同"),
    "different bundled version is explicit before updating");
  check(button("安装更新")?.disabled === true, "enabled package must drain before updating");
  check(writes.filter(item => item.route === "/__api/plugins/install").length === installCount,
    "version check never silently installs the bundled update");
  await click("可安装");
  await wait(() => document.querySelectorAll("article").length === 3, "bundled cards restored");
  const content = document.querySelector<HTMLElement>("main.content")!;
  content.scrollTop = 0;
  const overflowing = [...document.querySelectorAll<HTMLElement>("article,button,input,[role=tablist]")]
    .filter(element => { const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1); });
  check(content.scrollWidth <= content.clientWidth + 1 && overflowing.length === 0,
    `bundled library overflows at ${innerWidth}px`);
  check(button("查看并安装")?.disabled === false && button("适配中")?.disabled === true,
    "ready and pending bundle actions remain distinct");
  return { width: innerWidth, theme, view: "bundled", cards: 3,
    updateRequiresDisable: true, horizontalOverflow: false };
};
scope.expandBundledGap = () => {
  const detail = document.querySelector<HTMLDetailsElement>("article details");
  check(detail?.querySelector("summary")?.textContent?.includes("MCP 声明待适配"),
    "unconverted MCP declaration has a visible summary");
  detail!.open = true;
  check(detail!.textContent?.includes("fixture-api")
    && detail!.textContent?.includes("包含尚未适配的配置字段"),
  "unconverted MCP keeps its component name and reason");
  const content = document.querySelector<HTMLElement>("main.content")!;
  check(content.scrollWidth <= content.clientWidth + 1, "expanded MCP gap does not overflow");
  return { expanded: true, horizontalOverflow: false };
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
