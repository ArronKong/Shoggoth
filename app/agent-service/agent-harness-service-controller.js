"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { DOCUMENT_KINDS, DEFINITION_EXPORT_FORMAT } = require("./agent-definition-store");
const { assertValidDownstreamMcpTools } = require("./mcp-product-tool-controller");
const { hasSecret } = require("./memory-engine");
const { serviceError } = require("./security");
const { querySkillManagementCatalog } = require("./skill-management-query");

const GENERATED = new Set(["TOOLS", "MEMORY"]);
const IMPORT_TTL_MS = 15 * 60 * 1000;
const PAGE_BYTES = 44 * 1024;
const REVIEWED_MEMORY_ID = /^reviewed-mc-[a-f0-9]{64}$/u;

function harnessError(code, message) { return serviceError(code, message); }
function reviewItemVisible(engine, profileId, item) {
  if (!REVIEWED_MEMORY_ID.test(item.id)) return true;
  // A durable candidate batch may precede its accepted receipt and active
  // promotion. Hide that intermediate record from the ordinary memory UI.
  if (item.status === "candidate") return false;
  // A withdrawn or superseded claim remains available through the user's
  // explicit audit UI even after its source is no longer Agent-visible. The
  // accepted review receipt is still required to exclude orphaned writes.
  if (["deleted", "superseded"].includes(item.status)) {
    return engine.isReviewReceipted?.(profileId, item) === true;
  }
  return engine.isReviewCommitted?.(profileId, item) === true;
}
function validProbeTools(tools) {
  if (!Array.isArray(tools) || tools.length > 256) return false;
  // Activation and the model-facing mcp_server_tools path must agree on the
  // downstream contract (including description type and size).
  try { assertValidDownstreamMcpTools(tools); }
  catch { return false; }
  const names = new Set();
  let bytes = 0;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)
      || typeof tool.name !== "string" || !tool.name.isWellFormed()
      || !tool.name || /[\x00-\x1f\x7f]/u.test(tool.name)
      || Buffer.byteLength(tool.name, "utf8") > 128 || names.has(tool.name)
      || !tool.inputSchema || typeof tool.inputSchema !== "object"
      || Array.isArray(tool.inputSchema)
      || Object.getPrototypeOf(tool.inputSchema) !== Object.prototype) return false;
    names.add(tool.name);
    try { bytes += Buffer.byteLength(JSON.stringify(tool), "utf8"); }
    catch { return false; }
    if (bytes > 256 * 1024) return false;
  }
  return true;
}
function page(items, cursor, limit) {
  const output = [];
  let bytes = 0;
  for (let index = cursor; index < items.length && output.length < limit; index += 1) {
    const item = items[index];
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (output.length > 0 && bytes + size > PAGE_BYTES) break;
    if (size > PAGE_BYTES) throw harnessError("HARNESS_RESPONSE_TOO_LARGE", "单条记录超过响应预算");
    output.push(item); bytes += size;
  }
  const nextCursor = cursor + output.length;
  return { items: output, nextCursor, hasMore: nextCursor < items.length };
}
function summary(manifest) {
  return {
    revision: manifest.revision,
    actor: manifest.actor,
    reason: manifest.reason,
    updatedAt: manifest.updatedAt,
    documents: Object.fromEntries(Object.entries(manifest.documents).map(([kind, ref]) => [kind, {
      kind, contentHash: ref.contentHash, byteLength: ref.byteLength, revision: ref.revision,
    }])),
  };
}

class AgentHarnessServiceController {
  constructor(options = {}) {
    for (const [value, methods, label] of [
      [options.productStore, ["getAgentProfile"], "ProductStore"],
      [options.definitionStore, ["get", "history", "readRevision", "update", "restore", "previewImport", "import", "readGeneratedView"], "AgentDefinitionStore"],
      [options.memoryStore, ["get", "getRevision", "list"], "MemoryStore"],
      [options.memoryEngine, ["propose", "update", "delete"], "MemoryEngine"],
      [options.chatSessionStore, ["listSessions"], "ChatSessionStore"],
      [options.transcriptStore, ["listEvents", "getRevision", "setContextExcluded"], "TranscriptStore"],
      [options.toolRegistry, ["list"], "ToolRegistry"],
      [options.permissionEngine, ["profileProjection", "setProfileOverride"], "PermissionEngine"],
    ]) if (!value || methods.some((method) => typeof value[method] !== "function")) {
      throw new TypeError(`${label} dependency is invalid`);
    }
    this.productStore = options.productStore;
    this.definitionStore = options.definitionStore;
    this.memoryStore = options.memoryStore;
    this.memoryEngine = options.memoryEngine;
    this.memoryProvenanceService = options.memoryProvenanceService || null;
    this.memoryCandidateService = options.memoryCandidateService || null;
    if (this.memoryCandidateService && ["list", "accept", "acceptMany", "reject"].some(
      (method) => typeof this.memoryCandidateService[method] !== "function")) {
      throw new TypeError("MemoryCandidateService dependency is invalid");
    }
    this.chatSessionStore = options.chatSessionStore;
    this.transcriptStore = options.transcriptStore;
    this.toolRegistry = options.toolRegistry;
    this.permissionEngine = options.permissionEngine;
    this.skillStore = options.skillStore || null;
    if (this.skillStore && ["list", "setProfileSkill", "setGlobalSkill", "installFromDirectory", "uninstall", "preview", "usage"]
      .some((method) => typeof this.skillStore[method] !== "function")) {
      throw new TypeError("NativeSkillStore dependency is invalid");
    }
    this.nativeMcpStore = options.nativeMcpStore || null;
    this.nativeMcpClientManager = options.nativeMcpClientManager || null;
    if (this.nativeMcpStore && ["list", "get", "prepare", "register"].some(
      (method) => typeof this.nativeMcpStore[method] !== "function")) {
      throw new TypeError("NativeMcpStore dependency is invalid");
    }
    if (this.nativeMcpClientManager && ["probe", "closeServer"].some(
      (method) => typeof this.nativeMcpClientManager[method] !== "function")) {
      throw new TypeError("NativeMcpClientManager dependency is invalid");
    }
    this.mcpActivationTokens = new Map();
    this.computerUseController = options.computerUseController || null;
    if (this.computerUseController && ["status", "list", "closeForProfile"]
      .some((method) => typeof this.computerUseController[method] !== "function")) {
      throw new TypeError("ComputerUseController dependency is invalid");
    }
    this.now = options.now || Date.now;
    this.imports = new Map();
  }
  _profile(profileId) {
    const profile = this.productStore.getAgentProfile(profileId);
    if (!profile) {
      throw harnessError("HARNESS_PROFILE_NOT_FOUND", "Agent Profile 不存在");
    }
    return profile;
  }
  _assertRevision(actual, expected, code) {
    if (actual !== expected) {
      const error = harnessError(code, "revision 已变化"); error.currentRevision = actual; throw error;
    }
  }
  _pruneImports() {
    const cutoff = this.now() - IMPORT_TTL_MS;
    for (const [id, item] of this.imports) if (item.updatedAt < cutoff) this.imports.delete(id);
  }
  _import(params) {
    this._pruneImports();
    const item = this.imports.get(params.operationId);
    if (!item || item.profileId !== params.profileId) {
      throw harnessError("HARNESS_IMPORT_NOT_FOUND", "Definition import staging 不存在");
    }
    if (DOCUMENT_KINDS.some((kind) => typeof item.documents[kind] !== "string")) {
      throw harnessError("HARNESS_IMPORT_INCOMPLETE", "Definition import staging 不完整");
    }
    return item;
  }
  _bundle(item) {
    return {
      format: DEFINITION_EXPORT_FORMAT,
      schemaVersion: 1,
      profileId: item.sourceProfileId,
      revision: item.sourceRevision,
      documents: structuredClone(item.documents),
    };
  }
  handle(method, params) {
    this._profile(params.profileId);
    if (method.startsWith("harness.skills.") && !this.skillStore) {
      throw harnessError("HARNESS_SERVICE_CLOSED", "Skill management is unavailable");
    }
    if (method.startsWith("harness.mcp.")
      && (!this.nativeMcpStore || !this.nativeMcpClientManager)) {
      throw harnessError("HARNESS_SERVICE_CLOSED", "MCP management is unavailable");
    }
    if (method.startsWith("harness.computer.") && !this.computerUseController) {
      throw harnessError("HARNESS_SERVICE_CLOSED", "Computer Use management is unavailable");
    }
    if (method === "harness.mcp.list") {
      const value = this.nativeMcpStore.list();
      const disabled = value.servers.filter((server) => !server.enabled);
      const items = disabled.slice(params.cursor, params.cursor + params.limit).map((server) => ({
        id: server.id, name: server.name,
        commandLabel: (path.basename(server.command) || "(root)").slice(0, 128),
        cwdLabel: (path.basename(server.cwd) || "(root)").slice(0, 128),
        argCount: server.args.length, updatedAt: server.updatedAt,
      }));
      const nextCursor = params.cursor + items.length;
      return { revision: value.revision, totalDisabled: disabled.length, items,
        nextCursor, hasMore: nextCursor < disabled.length };
    }
    if (method === "harness.mcp.rebind") {
      if (this.nativeMcpStore.revision !== params.expectedRevision) {
        throw harnessError("MCP_REGISTRY_REVISION_CONFLICT", "MCP Registry revision 已变化");
      }
      const current = this.nativeMcpStore.get(params.id);
      if (!current) throw harnessError("MCP_SERVER_NOT_FOUND", "MCP Server 不存在");
      if (current.enabled) throw harnessError("MCP_SERVER_ALREADY_ENABLED", "MCP Server 已启用");
      const server = this.nativeMcpStore.prepare({ id: current.id, name: current.name,
        command: params.command, args: params.args, cwd: params.cwd, enabled: false });
      return (async () => {
        await this.nativeMcpClientManager.closeServer(current.id);
        const value = this.nativeMcpStore.register({ expectedRevision: params.expectedRevision, server });
        const activationToken = crypto.randomUUID();
        this.mcpActivationTokens.set(current.id, { revision: value.revision, activationToken });
        return { revision: value.revision, id: current.id, enabled: false, activationToken };
      })();
    }
    if (method === "harness.mcp.activate") {
      if (this.nativeMcpStore.revision !== params.expectedRevision) {
        throw harnessError("MCP_REGISTRY_REVISION_CONFLICT", "MCP Registry revision 已变化");
      }
      const pending = this.mcpActivationTokens.get(params.id);
      if (!pending || pending.revision !== params.expectedRevision
        || pending.activationToken !== params.activationToken) {
        throw harnessError("MCP_REBIND_REQUIRED", "请重新设置 MCP 启动路径后再启用");
      }
      const current = this.nativeMcpStore.get(params.id);
      if (!current) throw harnessError("MCP_SERVER_NOT_FOUND", "MCP Server 不存在");
      if (current.enabled) throw harnessError("MCP_SERVER_ALREADY_ENABLED", "MCP Server 已启用");
      const server = this.nativeMcpStore.prepare({ id: current.id, name: current.name,
        command: current.command, args: current.args, cwd: current.cwd, enabled: true });
      return (async () => {
        let tools;
        try { tools = await this.nativeMcpClientManager.probe(server); }
        catch { throw harnessError("MCP_SERVER_PROBE_FAILED", "MCP Server 探测失败"); }
        if (!validProbeTools(tools)) {
          throw harnessError("MCP_SERVER_PROBE_FAILED", "MCP Server 工具清单无效");
        }
        await this.nativeMcpClientManager.closeServer(current.id);
        const value = this.nativeMcpStore.register({ expectedRevision: params.expectedRevision, server });
        this.mcpActivationTokens.delete(current.id);
        return { revision: value.revision, id: current.id, enabled: true, toolCount: tools.length };
      })();
    }
    if (method === "harness.definition.meta") {
      const current = this.definitionStore.get(params.profileId);
      const history = this.definitionStore.history(params.profileId);
      return {
        current: summary(current.manifest),
        history: history.slice(0, 32).map(summary),
        historyHasMore: history.length > 32,
        files: [
          ...DOCUMENT_KINDS.map((kind) => ({ kind, name: `${kind}.md`, readOnly: kind === "USER" })),
          ...["TOOLS", "MEMORY"].map((kind) => ({ kind, name: `${kind}.md`, readOnly: true })),
        ],
      };
    }
    if (method === "harness.definition.read") {
      if (params.kind === "MEMORY" || (params.kind === "USER" && params.revision === null)) {
        // These are projections of live memory. A failed post-commit rebuild can
        // leave an older file on disk, so refresh against the current recall
        // policy before an ordinary file read and fail closed on any error.
        this.memoryEngine.rebuildViews(params.profileId);
      }
      if (GENERATED.has(params.kind)) {
        const view = this.definitionStore.readGeneratedView(params.profileId, params.kind);
        return { kind: params.kind, revision: view?.revision ?? null, content: view?.content ?? "", readOnly: true };
      }
      const value = params.revision === null
        ? this.definitionStore.get(params.profileId)
        : this.definitionStore.readRevision(params.profileId, params.revision);
      if (!value) throw harnessError("HARNESS_PROFILE_NOT_FOUND", "Definition revision 不存在");
      return { kind: params.kind, revision: value.manifest.revision, content: value.documents[params.kind], readOnly: params.kind === "USER" };
    }
    if (method === "harness.definition.update") {
      if (params.kind === "USER" || GENERATED.has(params.kind)) {
        throw harnessError("DEFINITION_WRITE_FORBIDDEN", "派生文档不可直接编辑");
      }
      if (hasSecret(params.content)) throw harnessError("DEFINITION_SECRET_REJECTED", "Definition 含敏感信息");
      const value = this.definitionStore.update({
        profileId: params.profileId, expectedRevision: params.expectedRevision,
        documents: { [params.kind]: params.content }, actor: "user", reason: params.reason,
      });
      return { current: summary(value.manifest) };
    }
    if (method === "harness.definition.restore") {
      const value = this.definitionStore.restore(params);
      return { current: summary(value.manifest) };
    }
    if (method === "harness.definition.import.stage") {
      if (hasSecret(params.content)) throw harnessError("DEFINITION_SECRET_REJECTED", "Definition 含敏感信息");
      const current = this.imports.get(params.operationId);
      if (current && (current.profileId !== params.profileId
        || current.sourceProfileId !== params.sourceProfileId
        || current.sourceRevision !== params.sourceRevision)) {
        throw harnessError("HARNESS_REVISION_CONFLICT", "operationId 已用于其他导入");
      }
      const item = current || {
        profileId: params.profileId, sourceProfileId: params.sourceProfileId,
        sourceRevision: params.sourceRevision, documents: {}, updatedAt: this.now(),
      };
      if (item.documents[params.kind] !== undefined && item.documents[params.kind] !== params.content) {
        throw harnessError("HARNESS_REVISION_CONFLICT", "导入分片输入冲突");
      }
      item.documents[params.kind] = params.content; item.updatedAt = this.now();
      this.imports.set(params.operationId, item);
      return { staged: Object.keys(item.documents).sort() };
    }
    if (method === "harness.definition.import.preview") {
      const item = this._import(params);
      const preview = this.definitionStore.previewImport({ profileId: params.profileId, bundle: this._bundle(item) });
      return { baseRevision: preview.baseRevision, changes: preview.changes };
    }
    if (method === "harness.definition.import.commit") {
      const item = this._import(params);
      const value = this.definitionStore.import({
        profileId: params.profileId, expectedRevision: params.expectedRevision, bundle: this._bundle(item),
      });
      this.imports.delete(params.operationId);
      return { current: summary(value.manifest) };
    }
    if (method === "harness.memory.list") {
      let recallPolicy;
      try {
        recallPolicy = this.memoryEngine.recallPolicy.getStatus(params.profileId);
      } catch (error) {
        recallPolicy = { ready: false, revision: null, indexPending: true,
          code: error.code || "RECALL_POLICY_UNAVAILABLE" };
      }
      const all = this.memoryStore.list(params.profileId, {
        ...(params.status ? { status: params.status } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
      }).filter((item) => {
        if (!reviewItemVisible(this.memoryEngine, params.profileId, item)) return false;
        if (item.status !== "active") return true;
        // A live sibling may share a forgotten source or fact even though its
        // primary MemoryStore status is still active. Do not show it as current.
        try { return this.memoryEngine.recallPolicy.isMemoryVisible(params.profileId, item); }
        catch { return false; }
      });
      return { revision: this.memoryStore.getRevision(params.profileId), recallPolicy,
        ...page(all, params.cursor, params.limit) };
    }
    if (method === "harness.memory.explain") {
      const current = this.memoryStore.get(params.profileId, params.id);
      if (current && !reviewItemVisible(this.memoryEngine, params.profileId, current)) {
        throw harnessError("MEMORY_NOT_FOUND", "记忆尚未完成审核回执");
      }
      if (this.memoryProvenanceService) {
        return this.memoryProvenanceService.explain({ profileId: params.profileId,
          id: params.id, viewer: "user" });
      }
      const item = this.memoryStore.get(params.profileId, params.id);
      if (!item) throw harnessError("MEMORY_NOT_FOUND", "记忆不存在");
      return { item, evidence: { status: "unavailable", reason: "provenance_store_unavailable" } };
    }
    if (method === "harness.memory.candidates.list") {
      if (!this.memoryCandidateService) throw harnessError("MEMORY_CANDIDATE_UNAVAILABLE", "候选审核不可用");
      return this.memoryCandidateService.list({ profileId: params.profileId,
        status: params.status, cursor: params.cursor, limit: params.limit,
        expectedRevision: params.expectedRevision });
    }
    if (method === "harness.memory.candidates.accept") {
      if (!this.memoryCandidateService) throw harnessError("MEMORY_CANDIDATE_UNAVAILABLE", "候选审核不可用");
      return this.memoryCandidateService.accept(params);
    }
    if (method === "harness.memory.candidates.acceptMany") {
      if (!this.memoryCandidateService) throw harnessError("MEMORY_CANDIDATE_UNAVAILABLE", "候选审核不可用");
      return this.memoryCandidateService.acceptMany(params);
    }
    if (method === "harness.memory.candidates.reject") {
      if (!this.memoryCandidateService) throw harnessError("MEMORY_CANDIDATE_UNAVAILABLE", "候选审核不可用");
      return this.memoryCandidateService.reject(params);
    }
    if (method === "harness.memory.create") {
      this._assertRevision(this.memoryStore.getRevision(params.profileId), params.expectedRevision, "MEMORY_REVISION_CONFLICT");
      const sourceRef = `user-edit:${crypto.randomUUID()}`;
      const item = this.memoryEngine.propose({
        profileId: params.profileId, content: params.content, scope: params.scope,
        type: "semantic", classification: "explicit", sourceRefs: [sourceRef],
      });
      // A same-content create may return an existing memory. Its original
      // source must not be relabeled as a new UI write.
      if (item.sourceRefs.includes(sourceRef)) {
        try { this.memoryProvenanceService?.recordUiWrite({ profileId: params.profileId,
          item, operationId: `ui-create-${item.id}`, origin: "ui_create" }); } catch {}
      }
      return { revision: this.memoryStore.getRevision(params.profileId), item };
    }
    if (method === "harness.memory.update") {
      this._assertRevision(this.memoryStore.getRevision(params.profileId), params.expectedRevision, "MEMORY_REVISION_CONFLICT");
      const previous = this.memoryStore.get(params.profileId, params.id);
      if (!previous || previous.status !== "active") throw harnessError("MEMORY_NOT_FOUND", "记忆不存在");
      const sourceRef = `user-edit:${crypto.randomUUID()}`;
      const sourceRefs = [sourceRef,
        ...previous.sourceRefs.filter((ref) => ref.startsWith("workspace:"))];
      const item = this.memoryEngine.propose({ profileId: params.profileId,
        scope: previous.scope, type: previous.type, content: params.content,
        sourceRefs, classification: "explicit", sensitivity: previous.sensitivity,
        confidence: params.confidence, validUntil: params.validUntil,
        supersedes: previous.id });
      if (item.supersedes === previous.id && item.sourceRefs.includes(sourceRef)) {
        try { this.memoryProvenanceService?.recordUiWrite({ profileId: params.profileId,
          item, operationId: `ui-edit-${item.id}`, origin: "ui_edit" }); } catch {}
      }
      return { revision: this.memoryStore.getRevision(params.profileId), item };
    }
    if (method === "harness.memory.delete") {
      this._assertRevision(this.memoryStore.getRevision(params.profileId), params.expectedRevision, "MEMORY_REVISION_CONFLICT");
      const value = this.memoryEngine.delete({ ...params, reason: "user_deleted" });
      return { revision: this.memoryStore.getRevision(params.profileId), item: value };
    }
    if (method === "harness.transcript.sessions") {
      const sessions = this.chatSessionStore.listSessions()
        .filter((session) => session.profileId === params.profileId)
        .map((session) => {
          const events = this.transcriptStore.listEvents(params.profileId, session.id);
          return { ...session, transcriptRevision: this.transcriptStore.getRevision(params.profileId, session.id), eventCount: events.length };
        });
      return page(sessions, params.cursor, params.limit);
    }
    if (method === "harness.transcript.events") {
      const events = this.transcriptStore.listEvents(params.profileId, params.sessionId);
      return { revision: this.transcriptStore.getRevision(params.profileId, params.sessionId), ...page(events, params.cursor, params.limit) };
    }
    if (method === "harness.transcript.context.set") {
      this._assertRevision(this.transcriptStore.getRevision(params.profileId, params.sessionId), params.expectedRevision, "TRANSCRIPT_REVISION_CONFLICT");
      const event = this.transcriptStore.setContextExcluded(params);
      return { revision: this.transcriptStore.getRevision(params.profileId, params.sessionId), event };
    }
    if (method === "harness.skills.list") {
      const value = this.skillStore.list(params.profileId);
      return {
        registryRevision: value.registryRevision,
        registryVersion: value.registryVersion,
        profileRevision: value.profileRevision,
        ...page(value.items, params.cursor, params.limit),
      };
    }
    if (method === "harness.skills.query") {
      const profile = this._profile(params.profileId);
      const value = this.skillStore.list(params.profileId);
      const usage = new Map();
      const usageAgents = new Map();
      usage.supported = true;
      try {
        for (const agent of this.productStore.listAgentProfiles()) {
          if (!agent.enabled || agent.backendId !== "shoggoth") continue;
          const result = this.skillStore.usage(agent.id);
          if (result.supported !== true) throw harnessError("SKILL_USAGE_CORRUPT", "Skill usage unavailable");
          for (const [name, agents] of Object.entries(result.skills)) {
            const count = agents[agent.id] || 0;
            if (count > 0) {
              usage.set(name, (usage.get(name) || 0) + count);
              if (!usageAgents.has(name)) usageAgents.set(name, {});
              usageAgents.get(name)[agent.agentId] = count;
            }
          }
        }
      } catch {
        // Usage is optional decoration. Never sort by a partial aggregate.
        usage.clear();
        usageAgents.clear();
        usage.supported = false;
      }
      const items = value.items.map(skill => ({
        ...skill,
        backendId: "shoggoth",
        category: skill.source === "builtin" ? "Shoggoth built-in" : "Shoggoth native",
        emoji: "🧩",
        profileId: profile.id,
        agentId: profile.agentId,
        registryRevision: value.registryRevision,
        registryVersion: value.registryVersion,
        profileRevision: value.profileRevision,
        usageCount: usage.get(skill.name) || 0,
        usageAgents: usageAgents.get(skill.name) || {},
      }));
      return querySkillManagementCatalog({ catalog: { ...value, items }, usage,
        query: params.query, status: params.status, pageIndex: params.pageIndex,
        limit: params.limit, expectedRevision: params.expectedRevision });
    }
    if (method === "harness.skills.preview") {
      const skill = this.skillStore.preview(params);
      const { content, ...metadata } = skill;
      const points = [...content];
      if (params.cursor > points.length) throw harnessError("INVALID_PARAMS", "Skill preview cursor 无效");
      let chunk = "";
      let bytes = 0;
      let nextCursor = params.cursor;
      while (nextCursor < points.length) {
        const size = Buffer.byteLength(points[nextCursor], "utf8");
        if (bytes + size > params.maxBytes) break;
        chunk += points[nextCursor];
        bytes += size;
        nextCursor += 1;
      }
      if (!chunk && nextCursor < points.length) throw harnessError("INVALID_PARAMS", "Skill preview budget 无效");
      return { skill: metadata, content: chunk, nextCursor, hasMore: nextCursor < points.length };
    }
    if (method === "harness.skills.install") {
      const value = this.skillStore.installFromDirectory({
        sourcePath: params.sourcePath,
        operationId: params.operationId,
        expectedRevision: params.expectedRevision,
        globalEnabled: true,
      });
      return { registryRevision: value.revision, skill: value.package };
    }
    if (method === "harness.skills.uninstall") {
      const value = this.skillStore.uninstall(params);
      return { registryRevision: value.revision, skill: value.removed };
    }
    if (method === "harness.skills.enable") {
      if (params.source !== "builtin") {
        throw harnessError("INVALID_PARAMS", "用户安装的 Skill 只能全局启停");
      }
      const value = this.skillStore.setProfileSkill(params);
      // Skill packages stay in the content-addressed Skill Store. The Context
      // Compiler and authorized MCP tools inject the selected Profile view at
      // run time; materializing into a Runtime Home would duplicate packages
      // and leak one Profile's selection through a shared account Home.
      return { profileRevision: value.revision, skill: value.skill };
    }
    if (method === "harness.skills.global.set") {
      const value = this.skillStore.setGlobalSkill(params);
      return { registryRevision: value.revision, skill: value.skill };
    }
    if (method === "harness.skills.usage") return this.skillStore.usage(params.profileId);
    if (method === "harness.computer.status") {
      return this.computerUseController.status(params.profileId);
    }
    if (method === "harness.tools.list") return this.permissionEngine.profileProjection(params.profileId);
    if (method === "harness.tools.permission.set") {
      const revision = this.permissionEngine.setProfileOverride(
        params.profileId, params.toolName, params.effect, params.expectedRevision,
      );
      const response = { revision, tools: this.permissionEngine.profileProjection(params.profileId).tools };
      if (params.effect === "deny" && params.toolName.startsWith("computer_")) {
        return Promise.resolve(this.computerUseController?.closeForProfile(params.profileId)).then(() => response);
      }
      return response;
    }
    throw harnessError("HARNESS_SERVICE_CLOSED", "Agent Harness method 未接线");
  }
}

module.exports = { AgentHarnessServiceController, IMPORT_TTL_MS };
