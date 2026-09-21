"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_KINDS, DEFINITION_EXPORT_FORMAT } = require("./agent-definition-store");
const { hasSecret } = require("./memory-engine");
const { serviceError } = require("./security");

const GENERATED = new Set(["TOOLS", "MEMORY"]);
const IMPORT_TTL_MS = 15 * 60 * 1000;
const PAGE_BYTES = 44 * 1024;

function harnessError(code, message) { return serviceError(code, message); }
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
      [options.memoryStore, ["getRevision", "list"], "MemoryStore"],
      [options.memoryEngine, ["propose", "confirm", "update", "delete"], "MemoryEngine"],
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
    this.chatSessionStore = options.chatSessionStore;
    this.transcriptStore = options.transcriptStore;
    this.toolRegistry = options.toolRegistry;
    this.permissionEngine = options.permissionEngine;
    this.skillStore = options.skillStore || null;
    if (this.skillStore && ["list", "setProfileSkill", "installFromDirectory", "uninstall", "preview", "usage"]
      .some((method) => typeof this.skillStore[method] !== "function")) {
      throw new TypeError("NativeSkillStore dependency is invalid");
    }
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
    if (method.startsWith("harness.computer.") && !this.computerUseController) {
      throw harnessError("HARNESS_SERVICE_CLOSED", "Computer Use management is unavailable");
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
      const all = this.memoryStore.list(params.profileId, {
        ...(params.status ? { status: params.status } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
      });
      return { revision: this.memoryStore.getRevision(params.profileId), ...page(all, params.cursor, params.limit) };
    }
    if (method === "harness.memory.create") {
      this._assertRevision(this.memoryStore.getRevision(params.profileId), params.expectedRevision, "MEMORY_REVISION_CONFLICT");
      const item = this.memoryEngine.propose({
        profileId: params.profileId, content: params.content, scope: params.scope,
        type: "semantic", classification: "explicit", sourceRefs: [`user-edit:${crypto.randomUUID()}`],
      });
      return { revision: this.memoryStore.getRevision(params.profileId), item };
    }
    if (["harness.memory.confirm", "harness.memory.update", "harness.memory.delete"].includes(method)) {
      this._assertRevision(this.memoryStore.getRevision(params.profileId), params.expectedRevision, "MEMORY_REVISION_CONFLICT");
      const value = method.endsWith("confirm") ? this.memoryEngine.confirm(params)
        : method.endsWith("delete") ? this.memoryEngine.delete(params)
          : this.memoryEngine.update({ ...params, sourceRef: "user-edit:agent-settings" });
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
      });
      return { registryRevision: value.revision, skill: value.package };
    }
    if (method === "harness.skills.uninstall") {
      const value = this.skillStore.uninstall(params);
      return { registryRevision: value.revision, skill: value.removed };
    }
    if (method === "harness.skills.enable") {
      const value = this.skillStore.setProfileSkill(params);
      // Skill packages stay in the content-addressed Skill Store. The Context
      // Compiler and authorized MCP tools inject the selected Profile view at
      // run time; materializing into a Runtime Home would duplicate packages
      // and leak one Profile's selection through a shared account Home.
      return { profileRevision: value.revision, skill: value.skill };
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
