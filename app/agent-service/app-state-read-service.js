"use strict";

const { APP_STATE_SECTIONS, APP_STATE_HOST_SECTIONS, validAppStateArguments } = require("./app-state-contract");
const { AppStatePager, snapshot, sourceUnavailable, fields, text, number, timestamp, stateError, resourceRevision, sectionSummary } = require("./app-state-projection");
const { componentId } = require("./plugin-component-catalog");
const { aliasOf } = require("./plugin-skill-facade");
const TOKEN_FIELDS = ["totalTokens", "totalCost", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
  "reasoningTokens", "missingCostEntries", "estimatedCostEntries"];
const ACTIVE_RUN_STATUSES = new Set(["queued", "starting", "running", "waiting_input", "waiting_approval"]);
function rows(value) {
  if (!Array.isArray(value)) throw stateError("APP_STATE_SOURCE_UNAVAILABLE");
  return value;
}
function publicRun(run, profile) {
  return { id: text(run.id, 512), backendId: text(profile?.backendId, 128),
    agentId: text(profile?.agentId, 128), ...fields(run, ["profileId", "source", "sourceId", "status", "runtimeBindingId"]),
    ...fields(run, ["createdAt", "startedAt", "finishedAt", "updatedAt"], "timestamp"),
    errorCode: /^[A-Z][A-Z0-9_]{0,127}$/u.test(run.errorCode || "") ? run.errorCode : null };
}
function scheduleDisplay(schedule) {
  if (schedule?.kind === "cron") return text(schedule.expr, 512);
  if (schedule?.kind === "every") return `every ${number(schedule.everyMs)}ms`;
  if (schedule?.kind === "at") return String(schedule.at ?? schedule.atMs ?? "");
  return null;
}
function settingsProjection(config) {
  // Explicit leaves only. Never clone ConfigStore: it also contains gateway
  // tokens, remote URLs and authentication material.
  return { locale: text(config.locale, 32), theme: text(config.theme, 32),
    hermesMode: text(config.hermesMode, 32), hermesKeepAlive: config.hermesKeepAlive === true,
    openclawPluginHostMode: text(config.openclawPluginHostMode, 32), hermesPluginHostMode: text(config.hermesPluginHostMode, 32),
    setupCompletedAt: timestamp(config.setupCompletedAt), inspirationShortcut: text(config.inspirationShortcut, 128),
    disabledBackends: rows(config.disabledBackends).map(value => text(value, 128)).filter(Boolean).slice(0, 64),
    notifications: Object.fromEntries(["chat", "cron", "task", "proactive"].map(key => [key, config.notifications?.[key] === true])),
    notificationPolicy: { suppressWhileFocused: config.notificationPolicy?.suppressWhileFocused === true,
      quietHours: { enabled: config.notificationPolicy?.quietHours != null,
        ...fields(config.notificationPolicy?.quietHours, ["start", "end", "timezone"]) } },
    nativeConcurrency: fields(config.nativeConcurrency, ["maxActive", "startupConcurrency", "revision"], "number"),
    runtimeFrameworkFlags: Object.fromEntries(require("./runtime-framework-flags").RUNTIME_FRAMEWORK_FLAG_NAMES
      .filter(key => typeof config.runtimeFrameworkFlags?.[key] === "boolean").map(key => [key, config.runtimeFrameworkFlags[key]])),
    browserUse: { enabled: config.browserUse?.enabled === true, isolated: config.browserUse?.isolated === true,
      headless: config.browserUse?.headless === true, browser: text(config.browserUse?.browser, 32) },
  };
}

class AppStateReadService {
  constructor(options = {}) {
    Object.assign(this, options); this.now = options.now || Date.now;
    this.pager = new AppStatePager({ now: this.now });
  }
  async get(args, authority) {
    if (!validAppStateArguments(args)) throw stateError("APP_STATE_INVALID_ARGUMENTS");
    const principal = `${authority.federationClient ? "external" : "native"}:${authority.profileId}`;
    if (args.cursor !== null) return this.pager.page({ section: args.section }, args, principal);
    const context = { statuses: this.#statuses(), includeNativeRoles: !authority.federationClient };
    if (args.section === "overview") {
      const entries = await Promise.all(APP_STATE_SECTIONS.filter(section => section !== "overview")
        .map(async section => [section, await this.#read(section, context)]));
      const sections = Object.fromEntries(entries.map(([section, value]) => [section, {
        available: value.available, complete: value.complete, total: value.total, knownTotal: value.knownTotal,
        summary: Object.fromEntries(Object.entries(value.summary).filter(([key]) => key !== "byAgent" && key !== "byAgentHasMore")), unavailableSources: value.unavailableSources,
      }]));
      const value = snapshot("overview", [], [], { sections }, this.now());
      value.complete = entries.every(([, entry]) => entry.complete);
      value.available = entries.some(([, entry]) => entry.available);
      value.total = null; value.knownTotal = null;
      return this.pager.page(value, args, principal);
    }
    return this.pager.page(await this.#read(args.section, context), args, principal);
  }
  async #statuses() {
    try { return rows((await this.federationClient.request("backend.status", {})).backends); }
    catch { return null; }
  }
  async #host(section) {
    if (!this.federationClient) return snapshot(section, [], [sourceUnavailable("app_host", "APP_HOST_UNAVAILABLE")], {}, this.now());
    try {
      const items = [], seen = new Set();
      let cursor = null, first;
      do {
        const result = await this.federationClient.request("app.state.read", { section, cursor, limit: 50 });
        first ??= result;
        if (result.section !== section || result.sampledAt !== first.sampledAt || result.knownTotal !== first.knownTotal) throw stateError("APP_STATE_SOURCE_INCOMPLETE");
        items.push(...rows(result.items));
        cursor = result.nextCursor;
        if (cursor !== null && (seen.has(cursor) || seen.size >= 2000)) throw stateError("APP_STATE_SOURCE_INCOMPLETE");
        seen.add(cursor);
      } while (cursor !== null);
      if (items.length !== first.knownTotal) throw stateError("APP_STATE_SOURCE_INCOMPLETE");
      return { ...first, items };
    } catch (error) { return snapshot(section, [], [sourceUnavailable("app_host",
      error?.code === "APP_HOST_UNAVAILABLE" ? "APP_HOST_UNAVAILABLE" : "APP_STATE_SOURCE_UNAVAILABLE")], {}, this.now()); }
  }
  async #read(section, context) {
    const [native, host] = await Promise.all([
      this.#native(section, context).catch(() => snapshot(section, [], [sourceUnavailable(`native:${section}`)], {}, this.now())),
      APP_STATE_HOST_SECTIONS.includes(section) ? this.#host(section) : null,
    ]);
    const items = [...native.items, ...(host?.items || [])];
    items.sort((left, right) => String(left.backendId || "").localeCompare(String(right.backendId || ""))
      || String(left.type || "").localeCompare(String(right.type || ""))
      || String(left.id ?? left.agentId ?? "").localeCompare(String(right.id ?? right.agentId ?? "")));
    const value = snapshot(section, items, [...native.unavailableSources, ...(host?.unavailableSources || [])],
      { ...native.summary, ...(host?.summary || {}) }, this.now());
    // Recompute merged counts, rather than allowing a backend's partial counts
    // to overwrite native totals. Section-specific non-count metadata survives.
    value.summary = { ...value.summary, ...sectionSummary(section, items) };
    value.available = native.available || host?.available === true;
    if (section === "agents") value.summary.connectedTotal = value.summary.connectionUnknown === 0
      && !value.unavailableSources.some(source => !["BACKEND_DISABLED", "BACKEND_DISCONNECTED"].includes(source.code))
      ? value.summary.connected : null;
    if (section === "usage") {
      const complete = value.complete && items.every(item => item.availability === "complete");
      value.summary = { range: "30d", totalTokens: complete ? items.reduce((sum, item) => sum + (item.totalTokens || 0), 0) : null,
        totalCost: complete && items.every(item => item.totalCost !== null && !(item.missingCostEntries > 0)) ? items.reduce((sum, item) => sum + item.totalCost, 0) : null,
        costAvailability: !complete || items.some(item => item.totalCost === null) ? "unknown"
          : items.some(item => item.missingCostEntries > 0) ? "partial"
            : items.some(item => item.estimatedCostEntries > 0) ? "estimated" : "complete" };
    }
    if (section === "cron") {
      const groups = new Map();
      for (const item of items) {
        const key = JSON.stringify([item.backendId, item.agentId]);
        const group = groups.get(key) || { backendId: item.backendId, agentId: item.agentId, total: 0, enabled: 0, failedLastRun: 0 };
        group.total++; if (item.enabled) group.enabled++; if (item.hasError) group.failedLastRun++; groups.set(key, group);
      }
      value.summary.byAgent = [...groups.values()].slice(0, 40); value.summary.byAgentHasMore = groups.size > 40;
    }
    if (section === "runs") value.summary.nativeHistoryTotal = native.items.length;
    return value;
  }
  #role(profileId) {
    try {
      const document = this.agentDefinitionStore?.get(profileId)?.documents?.identity;
      if (typeof document !== "string") return null;
      const role = /^\s*[-*]?\s*(?:Responsibilities|Role|Purpose|Specialization|职责|角色|定位)\s*[:：]\s*(.+)$/imu.exec(document)?.[1];
      return text(role, 512);
    } catch { return null; }
  }
  #profiles() { return rows(this.productStore.listAgentProfiles()); }
  #profileMap() { return new Map(this.#profiles().map(profile => [profile.id, profile])); }
  #runs() { return rows(this.productStore.listWorkRuns()); }
  async #native(section, context) {
    let items = [], summary = {}, unavailable = [];
    if (section === "service") {
      const value = await this.getServiceStatus();
      items = [{ healthy: value.healthy === true, serviceVersion: text(value.serviceVersion, 128), startedAt: timestamp(value.startedAt),
        pendingCommandsLocked: value.pendingCommandsLocked === true, mcpCredentialsLocked: value.mcpCredentialsLocked === true,
        cronAvailable: value.domainAvailability?.cron?.available === true, kanbanAvailable: value.domainAvailability?.kanban?.available === true }];
    } else if (section === "backends") {
      const statuses = await context.statuses;
      if (statuses === null) throw stateError("APP_HOST_UNAVAILABLE");
      items = statuses.map(row => ({ id: text(row.id, 128), name: text(row.name, 256),
        connected: row.connected === true, disabled: row.disabled === true, health: text(row.health, 128),
        version: text(row.version, 128), agentCount: number(row.agentCount) }));
      summary = { connected: items.filter(row => row.connected).length, disabled: items.filter(row => row.disabled).length };
    } else if (section === "agents") {
      const statuses = await context.statuses;
      const byBackend = new Map((statuses || []).map(row => [row.id, row]));
      if (statuses === null) unavailable.push(sourceUnavailable("app_host", "APP_HOST_UNAVAILABLE"));
      items = this.#profiles().map(profile => {
        const status = byBackend.get(profile.backendId);
        const bindings = this.productStore.getAgentRuntimeBindings?.(profile.id)?.bindings || [];
        const binding = bindings.find(row => row.id === profile.defaultBindingId) || bindings[0] || profile;
        return { profileId: text(profile.id, 128), backendId: text(profile.backendId, 128), agentId: text(profile.agentId, 128),
          name: text(profile.name, 256), kind: "native", enabled: profile.enabled === true && binding.enabled !== false, isDefault: profile.isDefault === true,
          connected: profile.enabled !== true || binding.enabled === false || status?.disabled === true ? false : status ? status.connected === true : null,
          model: text(profile.defaultModel, 512), provider: text(profile.providerRef, 256),
          responsibilities: context.includeNativeRoles ? this.#role(profile.id) : null,
          runtime: text(binding.runtime, 128), runtimeAccountId: text(binding.runtimeAccountId, 128), bindingCount: bindings.length };
      });
    } else if (section === "cron") {
      const profiles = this.#profileMap();
      const latest = new Map();
      for (const run of this.#runs().filter(run => run.source === "cron")) if (!latest.has(run.sourceId)
        || run.createdAt > latest.get(run.sourceId).createdAt) latest.set(run.sourceId, run);
      items = rows(this.cronStore.listJobs()).map(job => {
        const run = latest.get(job.id), profile = profiles.get(job.profileId);
        return { id: job.id, profileId: job.profileId, backendId: text(profile?.backendId, 128), agentId: text(profile?.agentId, 128),
          name: text(job.name, 256), revision: resourceRevision("cron", job), enabled: job.enabled, schedule: scheduleDisplay(job.schedule), timezone: text(job.schedule?.tz, 128),
          status: !job.enabled ? "disabled" : ACTIVE_RUN_STATUSES.has(run?.status) ? run.status : job.nextRunAt != null ? "scheduled" : "idle",
          nextRunAt: timestamp(job.nextRunAt), lastRunAt: timestamp(run?.startedAt ?? run?.createdAt),
          lastStatus: text(run?.status, 128), latestRunId: text(run?.id, 128), hasError: run?.status === "failed",
          createdAt: timestamp(job.createdAt), updatedAt: timestamp(job.updatedAt),
          overlapPolicy: text(job.overlapPolicy, 128), threadPolicy: text(job.threadPolicy, 128) };
      });
    } else if (section === "inspiration") {
      items = rows(this.inspirationStore.list()).map(idea => {
        const view = this.inspirationService.view(idea.id, true), execution = view.latestExecution;
        return { id: idea.id, title: text(idea.title, 512), preview: text(view.body, 240), revision: idea.revision,
          favorite: idea.favorite === true, archived: idea.archivedAt != null, assigned: Boolean(execution?.agentId),
          status: text(view.status, 128), backendId: text(execution?.backendId, 128), agentId: text(execution?.agentId, 128),
          profileId: text(execution?.profileId, 128), runId: text(execution?.runId, 128),
          executionStatus: text(execution?.status, 128), acceptedAt: timestamp(idea.acceptedAt),
          createdAt: timestamp(idea.createdAt), updatedAt: timestamp(idea.updatedAt), archivedAt: timestamp(idea.archivedAt) };
      });
      const growth = await this.inspirationService.handle("inspiration.growth.get", {});
      summary = { automaticExecutionEnabled: growth.enabled === true };
    } else if (section === "kanban") {
      const profiles = this.#profileMap(), runs = new Map(this.#runs().map(run => [run.id, run]));
      const owner = profileId => ({ profileId, backendId: text(profiles.get(profileId)?.backendId, 128), agentId: text(profiles.get(profileId)?.agentId, 128) });
      items = [...rows(this.kanbanStore.listBoards()).map(board => ({ type: "board", id: board.id, name: text(board.name, 512), revision: resourceRevision("board", board), ...owner(board.profileId) })),
        ...rows(this.kanbanStore.listCards()).map(card => {
          const links = rows(this.kanbanStore.listCardRunLinks(card.id)).sort((a, b) => b.createdAt - a.createdAt);
          const run = runs.get(links[0]?.runId);
          return { type: "card", id: card.id, boardId: card.boardId, title: text(card.title, 512), revision: resourceRevision("card", card), ...owner(card.profileId),
            status: card.status, archived: card.archivedAt != null, runId: text(run?.id, 128), runStatus: text(run?.status, 128),
            createdAt: timestamp(card.createdAt), updatedAt: timestamp(card.updatedAt) };
        })];
    } else if (section === "runs") {
      const profiles = this.#profileMap(); items = this.#runs().map(run => publicRun(run, profiles.get(run.profileId)));
    } else if (section === "sessions") {
      const profiles = this.#profileMap();
      items = rows(this.chatSessionStore.listSessions()).map(session => ({
        id: session.id, ...fields(session, ["profileId", "sessionKey", "status", "runtimeBindingId"]),
        ...fields(session, ["createdAt", "updatedAt"], "timestamp"), title: text(session.title, 512), model: text(session.modelOverride, 512),
        backendId: text(profiles.get(session.profileId)?.backendId, 128), agentId: text(profiles.get(session.profileId)?.agentId, 128),
      }));
    } else if (section === "runtime_accounts") {
      let cursor = null; const seen = new Set();
      do {
        const value = await this.runtimeAccountController.handle("runtime.account.list", { cursor, limit: 100 });
        items.push(...rows(value.accounts).map(account => ({ type: "account", ...fields(account, ["id", "runtime", "kind", "installationKind", "homeKind"]),
          isDefault: account.isDefault === true, sharedAgentCount: number(account.sharedAgentCount),
          active: number(account.admission?.active), maxActive: number(account.admission?.maxActive),
          mutationActive: typeof account.admission?.mutationActive === "boolean" ? account.admission.mutationActive : number(account.admission?.mutationActive), backoffUntil: timestamp(account.admission?.backoffUntil) })));
        cursor = value.nextCursor;
        if (cursor !== null && (typeof cursor !== "string" || seen.has(cursor) || seen.size >= 1000)) throw stateError("APP_STATE_SOURCE_INCOMPLETE");
        seen.add(cursor);
      } while (cursor !== null);
    } else if (section === "models") {
      items = rows(this.productStore.listModelProviders()).map(provider => ({ type: "provider", id: provider.id,
        provider: text(provider.provider ?? provider.id, 256), name: text(provider.name, 256), kind: text(provider.kind, 128) }));
      summary = { configuredProviders: items.length };
    } else if (section === "skills") {
      const all = new Map();
      for (const { installation, release } of this.#pluginInstallations()) for (const component of release?.components?.skills || []) {
        const id = componentId(installation.installationId, "skill", component.name);
        all.set(id, { id, name: aliasOf(id), localName: text(component.name, 256), packageName: text(release.name, 256),
          installationId: installation.installationId, version: text(release.declaredVersion, 128), source: "plugin",
          globalEnabled: installation.desiredState === "enabled" && !this.pluginStore.hasPendingInstallationDisable?.(installation.installationId),
          enabled: false, enabledProfiles: new Set(), ineligibleProfiles: new Set() });
      }
      for (const profile of this.#profiles()) {
        const installed = this.nativeSkillStore.list(profile.id), selected = this.skillStore.catalog(profile.id);
        for (const item of [...rows(installed.items), ...rows(selected.items), ...rows(selected.ineligible)]) {
          const current = all.get(item.id) || { id: item.id, name: text(item.name, 256), version: text(item.version, 128), source: text(item.source, 128),
            globalEnabled: item.globalEnabled === true, enabled: false, enabledProfiles: new Set(), ineligibleProfiles: new Set() };
          current.globalEnabled ||= item.globalEnabled === true;
          if (item.enabled) { current.enabled = true; current.enabledProfiles.add(profile.id); }
          if (item.eligible === false) current.ineligibleProfiles.add(profile.id);
          all.set(item.id, current);
        }
      }
      items = [...all.values()].map(({ enabledProfiles, ineligibleProfiles, ...item }) => ({ ...item,
        enabledAgentCount: enabledProfiles.size, ineligibleAgentCount: ineligibleProfiles.size }));
    } else if (section === "mcp") {
      const value = this.nativeMcpStore.list();
      items = rows(value.servers).map(server => ({ id: server.id, name: text(server.name, 256), transport: text(server.transport ?? "stdio", 128),
        enabled: server.enabled === true, source: "shared_registry" }));
      const bindings = this.#pluginBindings().filter(binding => ["mcp", "mcp_server", "mcp-server"].includes(binding.componentKind));
      items.push(...bindings.map(binding => ({ id: binding.bindingId, profileId: binding.subjectKind === "profile" ? binding.subjectId : null,
        installationId: binding.installationId, componentId: binding.componentId, enabled: binding.enabled === true, source: "plugin_binding" })));
      for (const { installation, release } of this.#pluginInstallations()) for (const server of release?.components?.mcpServers || []) {
        const id = componentId(installation.installationId, "mcp-server", server.name);
        const connections = rows(this.pluginStore.listConnections()).filter(row => row.componentId === id);
        items.push({ id, installationId: installation.installationId, name: text(server.name, 256), transport: text(server.type, 128),
          enabled: installation.desiredState === "enabled" && !this.pluginStore.hasPendingInstallationDisable?.(installation.installationId),
          bindingCount: bindings.filter(row => row.componentId === id).length, connectionCount: connections.length,
          connectionStates: [...new Set(connections.map(row => text(row.state, 128)))], source: "installed_plugin" });
      }
      summary = { registryRevision: value.revision, sharedServers: value.servers.length, pluginBindings: bindings.length,
        builtInProductTools: this.productToolCount, builtInCatalog: "shared_across_native_runtimes" };
    } else if (section === "plugins") {
      const installations = this.#pluginInstallations();
      items = installations.map(({ installation, release }) => ({ type: "installation", id: installation.installationId,
        name: text(release?.name, 256), version: text(release?.declaredVersion, 128),
        skills: release?.components?.skills?.length ?? null, mcpServers: release?.components?.mcpServers?.length ?? null,
        hooks: release?.components?.hooks?.length ?? 0, desiredState: text(installation.desiredState, 128), revision: installation.revision,
        pendingDisable: this.pluginStore.hasPendingInstallationDisable?.(installation.installationId) === true,
        createdAt: timestamp(installation.createdAt), updatedAt: timestamp(installation.updatedAt) }));
      if (this.bundledPluginCatalog) items.push(...rows(this.bundledPluginCatalog.list().items).map(entry => ({ type: "library", id: text(entry.id, 128),
        installationId: text(entry.installationId, 128), name: text(entry.displayName, 256), version: text(entry.version, 128), category: text(entry.category, 128),
        skills: number(entry.converted?.skills), mcpServers: number(entry.converted?.mcp), apps: number(entry.components?.apps), importStatus: text(entry.importStatus, 128),
        installed: installations.some(({ installation }) => installation.installationId === entry.installationId) })));
      items.push(...this.#pluginBindings().map(binding => ({ type: "binding", id: binding.bindingId,
        ...fields(binding, ["subjectKind", "subjectId", "installationId", "componentId", "componentKind", "connectionId"]), enabled: binding.enabled === true })));
      items.push(...rows(this.pluginStore.listConnections()).map(connection => ({ type: "connection", id: connection.connectionId,
        ...fields(connection, ["installationId", "componentId", "state"]), revision: connection.revision })));
    } else if (section === "usage") {
      const value = this.usageStore.summarize("30d");
      items = [{ backendId: "native", range: "30d", availability: "complete", ...fields(value.series?.totals ?? value.totals, TOKEN_FIELDS, "number") }];
    } else if (section === "settings") {
      items = [settingsProjection(await this.getSettings())];
    } else if (section === "computer" || section === "browser") {
      const controller = section === "computer" ? this.computerUseController : this.browserUseController;
      const value = await controller.status();
      items = rows(value.sessions).map(session => ({ ...fields(session, ["id", "profileId", "workRunId", "status", "browser"]),
        createdAt: timestamp(session.createdAt) }));
      summary = { available: value.available === true, reason: text(value.reason, 128),
        driverVersion: text(value.driverVersion, 128), engineVersion: text(value.engineVersion, 128), browser: text(value.browser, 128),
        permissions: section === "computer" ? {
          accessibility: typeof value.permissions?.accessibility === "boolean" ? value.permissions.accessibility : null,
          screenRecording: typeof value.permissions?.screenRecording === "boolean" ? value.permissions.screenRecording : null } : null };
    } else throw stateError("APP_STATE_INVALID_ARGUMENTS");
    return snapshot(section, items, unavailable, summary, this.now());
  }
  #pluginInstallations() {
    return rows(this.pluginStore.listInstallations()).map(installation => {
      const release = this.pluginStore.getRelease?.(installation.sourceIdentity, installation.releaseDigest);
      if (this.pluginStore.getRelease && !release) throw stateError("APP_STATE_SOURCE_INCOMPLETE");
      return { installation, release };
    });
  }
  #pluginBindings() {
    return [...new Map([...rows(this.pluginStore.listGlobalBindings()), ...this.#profiles().flatMap(profile => rows(this.pluginStore.listBindingsForProfile(profile.id)))]
      .map(binding => [binding.bindingId, binding])).values()];
  }
}

module.exports = { AppStateReadService, settingsProjection };
