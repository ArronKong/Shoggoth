"use strict";

const crypto = require("node:crypto");
const { componentId } = require("./plugin-component-catalog");
const { reservedEndpointKind } = require("./plugin-reserved-official-endpoints");
const { interpreterCandidates } = require("./plugin-interpreter-detect");
const { serviceError } = require("./security");
const { SECRET_NAME } = require("../core/plugin-secret-placeholders");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const BARE = /^[^./\\\s][^/\\\s]*$/u;
const CONSENT_TTL_MS = 120_000;
const MAX_PENDING = 32;
const MAX_TARGET = 256;
const MAX_REASON = 512;
const CANDIDATE_ERRORS = new Set(["DEPENDENCY_EXECUTABLE_INVALID", "DEPENDENCY_CHANGED",
  "DEPENDENCY_PROBE_FAILED", "DEPENDENCY_OPERATION_FAILED"]);
const sha = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = text => text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET - 1)}…` : text;
function fail(code = "PLUGIN_REQUEST_INVALID", message = "插件启用请求无效或已变化") {
  throw serviceError(code, message);
}
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function errorCode(error) {
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || "") ? error.code : "PLUGIN_SERVICE_FAILED";
}

// One confirmed decision takes an installed plugin to a usable state: enable
// it, pin a local Node/Python interpreter, connect each generic MCP server,
// discover its tools and grant them to all Agents. Components that need a
// provider-specific account flow stay with their existing Plugins UI controls.
// Grants still bind to the exact discovered tool contracts, so a later tool or
// contract change needs a new decision, and a current Run never gains tools.
class PluginQuickSetup {
  #pending = new Map();

  constructor({ store, productStore, manager, consent, toolCatalog, dependencies, secrets,
    declarations, setInstallationState, candidates = interpreterCandidates, now = Date.now } = {}) {
    if (typeof store?.performManagementOperation !== "function"
      || typeof productStore?.getAgentProfile !== "function"
      || typeof manager?.component !== "function" || typeof manager?.selfContainedHttp !== "function"
      || typeof consent?.discover !== "function" || typeof toolCatalog?.listForBinding !== "function"
      || typeof dependencies?.peek !== "function" || typeof dependencies?.prepare !== "function"
      || typeof dependencies?.queryState !== "function" || typeof dependencies?.preview !== "function"
      || typeof secrets?.configured !== "function" || typeof declarations?.component !== "function"
      || typeof setInstallationState !== "function" || typeof candidates !== "function") {
      throw new TypeError("PluginQuickSetup requires Service-owned plugin authorities");
    }
    Object.assign(this, { store, productStore, manager, consent, toolCatalog, dependencies,
      secrets, declarations, setInstallationState, candidates, now });
  }

  #context(profileId, installationId) {
    if (typeof profileId !== "string" || !ID.test(profileId)
      || typeof installationId !== "string" || !ID.test(installationId)) fail();
    const profile = this.productStore.getAgentProfile(profileId);
    if (!profile?.enabled) fail("PLUGIN_BINDING_INVALID", "Agent 不可用于插件设置");
    const installation = this.store.getInstallation(installationId);
    if (!installation || installation.desiredState === "uninstalled") {
      fail("PLUGIN_INSTALLATION_INVALID", "插件安装不存在");
    }
    if (this.store.hasPendingInstallationDisable(installationId)) {
      fail("ACTIVATION_DEFERRED", "插件正在停用，请稍后再试");
    }
    const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    if (!release) fail("PLUGIN_SERVICE_FAILED", "插件版本不存在");
    return { profile, installation, release };
  }

  #binding(installationId, selectedId) {
    return this.store.listGlobalBindings().find(item => item.installationId === installationId
      && item.componentId === selectedId) || null;
  }

  // Read-only classification of one MCP server; no process starts.
  #view(installation, server) {
    const selectedId = componentId(installation.installationId, "mcp-server", server.name);
    const declaration = this.declarations.component(installation.releaseDigest, server.name);
    const spec = declaration?.spec || {};
    const secrets = [...new Set((declaration?.secrets || []).map(item => item.name))].sort()
      .map(name => ({ name, configured: this.secrets.configured(installation.installationId, name) }));
    let mode = null; let interpreter = null; let target = ""; let unsupported = null;
    if (installation.sourceIdentity === "bundled:codex-security") unsupported = "CONNECTION_AUTH_REQUIRED";
    else if (server.type === "stdio") {
      const command = typeof spec.command === "string" ? spec.command : "";
      target = clip([command, ...(Array.isArray(spec.args) ? spec.args : [])].join(" "));
      if (!BARE.test(command)) mode = "stdio";
      else if (["node", "python", "python3"].includes(command)) {
        mode = "stdio"; interpreter = command === "node" ? "node" : "python";
      } else unsupported = "DEPENDENCY_INTERPRETER_UNSUPPORTED";
    } else if (server.type === "streamable-http") {
      target = clip(typeof spec.url === "string" ? spec.url : "");
      if (installation.sourceIdentity.startsWith("bundled:") || declaration?.oauthResource
        || reservedEndpointKind(spec.url) !== null) unsupported = "CONNECTION_AUTH_REQUIRED";
      else mode = "http";
    } else unsupported = "CONNECTION_AUTH_REQUIRED";
    const pin = { installationId: installation.installationId, componentId: selectedId,
      releaseDigest: installation.releaseDigest, descriptorDigest: server.descriptorDigest };
    let interpreterStatus = null;
    if (interpreter) {
      try { interpreterStatus = this.dependencies.peek(pin); } catch { interpreterStatus = "missing"; }
    }
    const binding = this.#binding(installation.installationId, selectedId);
    const connection = binding?.connectionId ? this.store.getConnection(binding.connectionId) : null;
    const connected = Boolean(binding?.enabled && connection?.state === "ready");
    let tools = null; let granted = 0;
    if (connected) {
      try {
        const records = this.store.getCapabilityRecords(binding.bindingId, "__projection__");
        tools = this.toolCatalog.listForBinding(records)?.entries.length ?? null;
        granted = this.store.getCurrentAllowedGrantCount(binding.bindingId, this.now());
      } catch { tools = null; granted = 0; }
    }
    const missingSecrets = secrets.filter(item => !item.configured).map(item => item.name);
    const state = unsupported ? "unsupported" : missingSecrets.length ? "secret_required"
      : connected && tools !== null && granted > 0 ? "ready" : "activation_required";
    return { componentId: selectedId, descriptorDigest: server.descriptorDigest, name: server.name,
      transport: server.type, target, mode, interpreter, interpreterStatus, secrets, missingSecrets,
      unsupported, bindingId: connected ? binding.bindingId : null, tools, granted, state };
  }

  #publicView(view) {
    return { componentId: view.componentId, name: view.name, transport: view.transport,
      target: view.target, interpreter: view.interpreter,
      interpreterReady: view.interpreter ? view.interpreterStatus === "ready" : null,
      secrets: view.secrets, state: view.state, reason: view.unsupported,
      tools: view.tools, granted: view.granted };
  }

  #nextSteps(views, enabled) {
    const steps = [...new Set(views.flatMap(view => view.missingSecrets.map(name => `provide_secret:${name}`)))];
    // plugin_activate also enables a disabled package, including Skill-only ones.
    if (!enabled || views.some(view => view.state === "activation_required")) steps.push("activate");
    if (views.some(view => view.state === "unsupported")) steps.push("configure_in_plugins");
    if (!steps.length) steps.push("ready_next_turn");
    return steps;
  }

  inspect(input) {
    if (!exact(input, ["profileId", "installationId"])) fail();
    return this.#state(input.profileId, input.installationId);
  }

  #state(profileId, installationId) {
    const { installation, release } = this.#context(profileId, installationId);
    const views = release.components.mcpServers.map(server => this.#view(installation, server));
    return { installationId, packageName: release.name, declaredVersion: release.declaredVersion,
      releaseDigest: installation.releaseDigest, desiredState: installation.desiredState,
      revision: installation.revision, skills: release.components.skills.length,
      components: views.map(view => this.#publicView(view)),
      nextSteps: this.#nextSteps(views, installation.desiredState === "enabled") };
  }

  #summary(state) {
    return { action: "plugin-quick-enable", package: state.packageName,
      version: state.declaredVersion || "", skills: state.skills,
      components: state.components.filter(item => item.state !== "unsupported").map(item => ({
        name: item.name, target: item.target, interpreter: item.interpreter,
        missingSecrets: item.secrets.filter(secret => !secret.configured).map(secret => secret.name) })),
      unsupported: state.components.filter(item => item.state === "unsupported").map(item => item.name) };
  }

  #prune() {
    for (const [key, value] of this.#pending) if (value.expiresAt <= this.now()) this.#pending.delete(key);
    if (this.#pending.size >= MAX_PENDING) fail("PLUGIN_CONSENT_BUSY", "待确认的插件操作过多，请稍后重试");
  }

  prepare(input) {
    if (!exact(input, ["profileId", "installationId", "expectedRevision"])
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    const state = this.#state(input.profileId, input.installationId);
    if (state.revision !== input.expectedRevision) fail("REVISION_CONFLICT", "插件安装已变化，请刷新");
    this.#prune();
    const summary = this.#summary(state);
    const challenge = crypto.randomUUID();
    const expiresAt = this.now() + CONSENT_TTL_MS;
    this.#pending.set(challenge, { kind: "activate", profileId: input.profileId,
      installationId: input.installationId, releaseDigest: state.releaseDigest,
      fence: sha(summary), operationId: `qs-${crypto.randomUUID()}`, expiresAt });
    return { challenge, expiresAt, summary };
  }

  async commit(input) {
    if (!exact(input, ["challenge", "approved"]) || typeof input.challenge !== "string"
      || typeof input.approved !== "boolean") fail();
    const pending = this.#take(input.challenge, "activate");
    if (!input.approved) return { canceled: true, result: null };
    if (sha(this.#summary(this.#state(pending.profileId, pending.installationId))) !== pending.fence) {
      fail("REVISION_CONFLICT", "插件内容已变化，请重新确认");
    }
    return { canceled: false, result: await this.#activate(pending) };
  }

  // Product-confirmed Agent path. A replay of the same call is idempotent.
  activate({ profileId, installationId, releaseDigest, callId }) {
    if (typeof releaseDigest !== "string" || !HASH.test(releaseDigest)
      || typeof callId !== "string" || !ID.test(callId)) fail();
    return this.#activate({ profileId, installationId, releaseDigest,
      operationId: `qs-${sha([profileId, installationId, releaseDigest, callId]).slice(0, 48)}` });
  }

  #take(challenge, kind) {
    const pending = this.#pending.get(challenge);
    this.#pending.delete(challenge);
    if (!pending || pending.kind !== kind || pending.expiresAt <= this.now()) {
      fail("PLUGIN_CONSENT_EXPIRED", "确认已过期，请重试");
    }
    return pending;
  }

  async #setState(installationId, desiredState, operationId) {
    const current = this.store.getInstallation(installationId);
    if (current.desiredState === desiredState) return current;
    await this.setInstallationState({ installationId, desiredState,
      expectedRevision: current.revision, operationId });
    const next = this.store.getInstallation(installationId);
    if (next?.desiredState !== desiredState) fail("ACTIVATION_DEFERRED", "插件启用状态尚未生效");
    return next;
  }

  async #activate({ profileId, installationId, releaseDigest, operationId }) {
    let { installation, release } = this.#context(profileId, installationId);
    if (installation.releaseDigest !== releaseDigest) fail("REVISION_CONFLICT", "插件版本已变化，请刷新");
    let views = release.components.mcpServers.map(server => this.#view(installation, server));
    const results = new Map();
    const pinnable = [];
    for (const view of views) {
      if (!view.interpreter || view.unsupported || view.missingSecrets.length) continue;
      // The full check also notices an upgraded or removed interpreter binary.
      let status;
      try {
        status = this.dependencies.queryState({ installationId, componentId: view.componentId,
          releaseDigest: installation.releaseDigest, descriptorDigest: view.descriptorDigest }).status;
      } catch (error) {
        results.set(view.componentId, { state: "interpreter_unavailable", reason: errorCode(error) });
        continue;
      }
      if (status !== "ready") pinnable.push({ view, replace: status !== "missing" });
    }
    // A replaced pin must not swap the interpreter under a running process.
    if (pinnable.some(item => item.replace)) {
      installation = await this.#setState(installationId, "disabled", `${operationId}-disable`);
    }
    for (const { view } of pinnable) {
      const outcome = await this.#pin(installation, view, operationId);
      if (!outcome.ok) results.set(view.componentId, { state: "interpreter_unavailable", reason: outcome.reason });
    }
    installation = await this.#setState(installationId, "enabled", `${operationId}-enable`);
    views = release.components.mcpServers.map(server => this.#view(installation, server));
    for (const view of views) {
      if (results.has(view.componentId) || ["unsupported", "secret_required", "ready"].includes(view.state)) continue;
      try {
        const bindingId = view.bindingId || this.#connect(profileId, installation, view, operationId);
        await this.consent.discover({ profileId, bindingId });
        results.set(view.componentId, { state: "ready", ...this.#grantAll(profileId, bindingId, operationId) });
      } catch (error) {
        results.set(view.componentId, { state: "connection_failed", reason: errorCode(error) });
      }
    }
    const final = release.components.mcpServers.map(server => this.#view(installation, server));
    return { installationId, packageName: release.name, desiredState: installation.desiredState,
      components: final.map(view => ({ ...this.#publicView(view),
        ...(results.get(view.componentId)?.state && results.get(view.componentId).state !== "ready"
          ? { state: results.get(view.componentId).state, reason: results.get(view.componentId).reason } : {}),
        eachCallTools: results.get(view.componentId)?.eachCall || [] })),
      nextSteps: this.#nextSteps(final, installation.desiredState === "enabled") };
  }

  async #pin(installation, view, operationId) {
    const pin = { installationId: installation.installationId, componentId: view.componentId,
      releaseDigest: installation.releaseDigest, descriptorDigest: view.descriptorDigest };
    const candidates = this.candidates(view.interpreter).slice(0, 12);
    for (const [index, executablePath] of candidates.entries()) {
      let preview;
      try { preview = this.dependencies.preview({ ...pin, executablePath }); }
      catch (error) {
        if (CANDIDATE_ERRORS.has(error?.code)) continue;
        return { ok: false, reason: errorCode(error) };
      }
      try {
        this.dependencies.prepare({ ...pin, executablePath, previewDigest: preview.previewDigest,
          expectedRevision: preview.expectedRevision, confirmed: true,
          operationId: `qs-dep-${sha([operationId, view.componentId, index]).slice(0, 40)}` });
        return { ok: true };
      } catch (error) {
        if (!CANDIDATE_ERRORS.has(error?.code)) return { ok: false, reason: errorCode(error) };
      }
    }
    return { ok: false, reason: "DEPENDENCY_INTERPRETER_NOT_FOUND" };
  }

  #connect(profileId, installation, view, operationId) {
    const current = this.manager.component(installation.installationId, view.componentId);
    const http = current.component.transport === "streamable-http";
    if (http ? !this.manager.selfContainedHttp(current) : current.component.transport !== "stdio") {
      fail("CONNECTION_AUTH_REQUIRED", "此组件需要在插件页完成账号连接");
    }
    if (!http) this.manager.planner.planStdio(current.input);
    const endpointIdentity = http ? new URL(current.component.spec.url).href
      : `stdio:${current.component.descriptorDigest}`;
    const { installationId } = installation;
    const selectedId = view.componentId;
    return this.store.performManagementOperation({
      operationId: `qs-conn-${sha([operationId, selectedId]).slice(0, 40)}`, kind: "mcp-connect",
      fingerprint: sha(["quick-connect", profileId, installationId, selectedId, endpointIdentity]),
      apply: () => {
        let binding = this.#binding(installationId, selectedId);
        const existing = binding?.connectionId ? this.store.getConnection(binding.connectionId) : null;
        // A disconnected Connection ID is never reused; it stays fenced in the pool.
        const reusable = existing && existing.state !== "disconnected"
          && existing.endpointIdentity === endpointIdentity
          && (!http || this.store.getConnectionAuth(existing.connectionId)?.credentialRef === null);
        const connectionId = reusable ? existing.connectionId
          : sha([http ? "local-http-connection" : "local-connection", "all-agents", installationId,
            selectedId, current.component.descriptorDigest, ...(existing ? [operationId] : [])]);
        let connection = this.store.getConnection(connectionId)
          || this.store.createConnection({ connectionId, installationId, componentId: selectedId, endpointIdentity });
        if (connection.state !== "ready") connection = this.store.setConnectionIdentity({ connectionId,
          principalIdentity: `local:${process.getuid?.() ?? "user"}`, state: "ready",
          expectedRevision: connection.revision });
        binding ||= this.store.createGlobalBinding({ bindingId: sha(["mcp-binding", "all-agents",
          installationId, selectedId]), installationId, componentId: selectedId, connectionId });
        if (binding.connectionId !== connectionId) binding = this.store.setMcpBindingConnection({
          bindingId: binding.bindingId, connectionId, expectedRevision: binding.revision });
        if (!binding.enabled) binding = this.store.setBindingEnabled({ bindingId: binding.bindingId,
          enabled: true, expectedRevision: binding.revision });
        return { kind: "mcp-connect", profileId, bindingId: binding.bindingId, toolIdentity: null,
          revision: binding.revision };
      },
    }).result.bindingId;
  }

  #grantAll(profileId, bindingId, operationId) {
    const records = this.store.getCapabilityRecords(bindingId, "__projection__");
    const catalog = records && this.toolCatalog.listForBinding(records);
    if (!catalog) fail("TOOL_CONTRACT_CHANGED", "工具目录尚未就绪");
    const destructive = this.toolCatalog.destructiveToolNames?.(records) || new Set();
    const principal = records.connection.principalIdentity;
    const eachCall = [];
    let granted = 0;
    for (const entry of catalog.entries) {
      if (entry.appUnsupported) continue;
      const existing = this.store.getGrant(bindingId, entry.toolIdentity);
      if (existing?.effect === "allow" && existing.contractDigest === entry.contractDigest
        && existing.principalIdentity === principal
        && (existing.expiresAt === null || existing.expiresAt > this.now())) {
        granted += 1;
        if (existing.approvalMode === "each-call") eachCall.push(entry.downstreamName);
        continue;
      }
      const approvalMode = destructive.has(entry.downstreamName) ? "each-call" : "always";
      this.store.performManagementOperation({
        operationId: `qs-grant-${sha([operationId, entry.toolIdentity]).slice(0, 40)}`, kind: "grant-allow",
        fingerprint: sha(["quick-grant", profileId, bindingId, entry.toolIdentity, entry.contractDigest, approvalMode]),
        apply: () => {
          const grant = this.store.setGrant({ grantId: existing?.grantId || sha(["grant", bindingId, entry.toolIdentity]),
            bindingId, toolIdentity: entry.toolIdentity, contractDigest: entry.contractDigest,
            effect: "allow", approvalMode, expectedRevision: existing?.revision || 0 });
          return { kind: "grant-allow", profileId, bindingId, toolIdentity: entry.toolIdentity,
            revision: grant.revision };
        },
      });
      granted += 1;
      if (approvalMode === "each-call") eachCall.push(entry.downstreamName);
    }
    return { tools: catalog.entries.length, granted, eachCall };
  }

  #destinations(installation, release, name) {
    const result = [];
    for (const server of release.components.mcpServers) {
      const declaration = this.declarations.component(installation.releaseDigest, server.name);
      for (const item of declaration?.secrets || []) {
        if (item.name !== name) continue;
        result.push(item.target === "env"
          ? { component: server.name, kind: "env", key: item.key }
          : { component: server.name, kind: "header", key: item.key,
            origin: (() => { try { return new URL(declaration.spec.url).origin; } catch { return ""; } })() });
      }
    }
    return result;
  }

  listSecrets(input) {
    if (!exact(input, ["profileId", "installationId"])) fail();
    const { profileId, installationId } = input;
    const { installation, release } = this.#context(profileId, installationId);
    const names = new Map();
    for (const server of release.components.mcpServers) {
      for (const item of this.declarations.component(installation.releaseDigest, server.name)?.secrets || []) {
        if (!names.has(item.name)) names.set(item.name, this.#destinations(installation, release, item.name));
      }
    }
    return { installationId, packageName: release.name,
      items: [...names].sort(([left], [right]) => left.localeCompare(right)).map(([name, destinations]) => ({
        name, configured: this.secrets.configured(installationId, name), destinations })) };
  }

  prepareSecret(input) {
    if (!exact(input, ["profileId", "installationId", "name", "clear"]) || typeof input.clear !== "boolean"
      || typeof input.name !== "string" || !SECRET_NAME.test(input.name)) fail();
    const { installation, release } = this.#context(input.profileId, input.installationId);
    const destinations = this.#destinations(installation, release, input.name);
    if (!destinations.length) fail("PLUGIN_SECRET_NOT_DECLARED", "插件没有声明这个凭据");
    this.#prune();
    const challenge = crypto.randomUUID();
    const expiresAt = this.now() + CONSENT_TTL_MS;
    const summary = { action: input.clear ? "plugin-secret-clear" : "plugin-secret-set",
      package: release.name, name: input.name, destinations };
    this.#pending.set(challenge, { kind: "secret", profileId: input.profileId,
      installationId: input.installationId, name: input.name, clear: input.clear,
      fence: sha(summary), expiresAt });
    return { challenge, expiresAt, summary };
  }

  async commitSecret(input) {
    if (!exact(input, ["challenge", "approved", "value"]) || typeof input.challenge !== "string"
      || typeof input.approved !== "boolean") fail();
    const pending = this.#take(input.challenge, "secret");
    if (!input.approved) return { canceled: true, result: null };
    if (pending.clear ? input.value !== null : typeof input.value !== "string") fail();
    const { installation, release } = this.#context(pending.profileId, pending.installationId);
    const summary = { action: pending.clear ? "plugin-secret-clear" : "plugin-secret-set",
      package: release.name, name: pending.name,
      destinations: this.#destinations(installation, release, pending.name) };
    if (sha(summary) !== pending.fence) fail("REVISION_CONFLICT", "插件内容已变化，请重新确认");
    if (pending.clear) await this.secrets.delete({ installationId: pending.installationId, name: pending.name });
    else await this.secrets.put({ installationId: pending.installationId, name: pending.name, value: input.value });
    return { canceled: false, result: await this.#afterSecret(pending.profileId, pending.installationId, pending.name) };
  }

  // Agent path: the Service raises a password card in the current conversation.
  // `ask` resolves the typed value (or null on cancel); nothing returns to the model.
  async requestSecret({ profileId, installationId, name, reason, ask }) {
    if (typeof name !== "string" || !SECRET_NAME.test(name) || typeof ask !== "function"
      || (reason !== null && (typeof reason !== "string" || !reason.isWellFormed()
        || Buffer.byteLength(reason, "utf8") > MAX_REASON))) fail();
    const { installation, release } = this.#context(profileId, installationId);
    const destinations = this.#destinations(installation, release, name);
    if (!destinations.length) fail("PLUGIN_SECRET_NOT_DECLARED", "插件没有声明这个凭据");
    const configured = this.secrets.configured(installationId, name);
    const where = destinations.map(item => item.kind === "env"
      ? `${item.component} 的环境变量 ${item.key}` : `发往 ${item.origin || item.component} 的请求头 ${item.key}`);
    const message = [
      `插件「${release.name}」需要 ${name}${configured ? "（将替换已保存的值）" : ""}。`,
      `仅用于：${where.join("；")}。`,
      "值只保存在本机加密存储，不会发送给模型，也不会写入会话记录。",
      ...(reason ? [`它说：${reason.replace(/[\u0000-\u001f\u007f]/gu, " ")}`] : []),
    ].join("\n");
    const value = await ask({ message, field: { id: name, title: name,
      description: "粘贴凭据后提交；取消则不保存。" } });
    if (value === null) {
      return { status: "canceled", installationId, name, configured, nextSteps: this.#state(profileId, installationId).nextSteps };
    }
    await this.secrets.put({ installationId, name, value });
    return { status: "stored", ...(await this.#afterSecret(profileId, installationId, name)) };
  }

  // A changed value applies to new connections: reconnect the ready components
  // that declare it so the next turn uses the new value.
  async #afterSecret(profileId, installationId, name) {
    const { installation, release } = this.#context(profileId, installationId);
    const components = [];
    for (const server of release.components.mcpServers) {
      const declared = this.declarations.component(installation.releaseDigest, server.name)?.secrets || [];
      if (!declared.some(item => item.name === name)) continue;
      const view = this.#view(installation, server);
      if (view.missingSecrets.length) {
        // A cleared value must not stay in a running process or client. A busy
        // one is already fenced and closes when its in-flight call returns.
        const connectionId = this.#binding(installation.installationId, view.componentId)?.connectionId;
        let reason;
        if (connectionId) {
          try { await this.manager.releaseSecretHolder({ installationId, componentId: view.componentId, connectionId }); }
          catch (error) { if (error?.code !== "ACTIVATION_DEFERRED") reason = errorCode(error); }
        }
        components.push({ name: server.name, state: view.state, ...(reason ? { reason } : {}) });
        continue;
      }
      if (!view.bindingId) { components.push({ name: server.name, state: view.state }); continue; }
      try {
        await this.consent.discover({ profileId, bindingId: view.bindingId });
        components.push({ name: server.name, state: this.#view(installation, server).state });
      } catch (error) {
        components.push({ name: server.name, state: "connection_failed", reason: errorCode(error) });
      }
    }
    return { installationId, name, configured: this.secrets.configured(installationId, name), components,
      nextSteps: this.#state(profileId, installationId).nextSteps };
  }

  clear() { this.#pending.clear(); }
}

module.exports = { PluginQuickSetup };
