"use strict";

const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");

const RETIRED_TOOL_NAMES = new Set([
  "browser_session_open", "browser_session_close", "browser_navigate", "browser_back",
  "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll",
  "browser_tabs", "browser_tab_open", "browser_tab_activate", "browser_tab_close",
  "browser_screenshot",
]);

function permissionError(code, message) { return serviceError(code, message); }

class PermissionEngine {
  constructor(options = {}) {
    if (!options.toolRegistry || typeof options.toolRegistry.get !== "function") {
      throw new TypeError("PermissionEngine 需要 ToolRegistry");
    }
    this.toolRegistry = options.toolRegistry;
    this.paths = options.paths || null;
    this.profileOverrides = new Map();
    this.revision = 1;
    this.opened = this.paths === null;
  }
  open(profileIds = []) {
    if (this.opened) return;
    const knownProfiles = new Set(profileIds);
    if (lstatIfExists(this.paths.toolPolicyPath)) {
      let state;
      try {
        state = JSON.parse(readPrivateFile(this.paths.toolPolicyPath, {
          maxBytes: 4 * 1024 * 1024,
        }).toString("utf8"));
      } catch {
        throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限状态无效");
      }
      if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision)
        || state.revision < 1 || !state.profiles || typeof state.profiles !== "object"
        || Array.isArray(state.profiles) || Object.getPrototypeOf(state.profiles) !== Object.prototype) {
        throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限状态无效");
      }
      const restored = new Map();
      let migrated = false;
      for (const [profileId, entries] of Object.entries(state.profiles)) {
        if (!knownProfiles.has(profileId) || !entries || typeof entries !== "object"
          || Array.isArray(entries) || Object.getPrototypeOf(entries) !== Object.prototype) {
          throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限 Profile 无效");
        }
        const values = new Map();
        for (const [toolName, effect] of Object.entries(entries)) {
          if (!["allow", "deny"].includes(effect)) {
            throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限条目无效");
          }
          if (!this.toolRegistry.get(toolName)) {
            if (RETIRED_TOOL_NAMES.has(toolName)) { migrated = true; continue; }
            throw permissionError("TOOL_PERMISSION_STORE_INVALID", "工具权限条目无效");
          }
          values.set(toolName, effect);
        }
        restored.set(profileId, values);
      }
      this.profileOverrides = restored;
      this.revision = state.revision + (migrated ? 1 : 0);
      this.opened = true;
      if (migrated) {
        try { this._persist(); } catch (error) { this.opened = false; throw error; }
      }
    }
    this.opened = true;
  }
  close() { if (this.paths) this.opened = false; }
  _assertOpen() {
    if (!this.opened) throw permissionError("TOOL_PERMISSION_STORE_CLOSED", "工具权限状态未打开");
  }
  _persist() {
    if (!this.paths) return;
    const profiles = Object.fromEntries([...this.profileOverrides].map(([profileId, entries]) => (
      [profileId, Object.fromEntries(entries)]
    )));
    atomicWritePrivateFile(this.paths.toolPolicyPath, `${JSON.stringify({
      schemaVersion: 1, revision: this.revision, profiles,
    })}\n`, { trustedRoot: this.paths.trustedRoot });
  }
  setProfileOverride(profileId, toolName, effect, expectedRevision = this.revision) {
    this._assertOpen();
    if (typeof profileId !== "string" || typeof toolName !== "string"
      || !["allow", "deny"].includes(effect) || !this.toolRegistry.get(toolName)) {
      throw permissionError("TOOL_PERMISSION_INVALID", "工具权限修改无效");
    }
    if (expectedRevision !== this.revision) {
      throw permissionError("TOOL_PERMISSION_REVISION_CONFLICT", "工具权限 revision 已变化");
    }
    const current = new Map(this.profileOverrides.get(profileId) || []);
    current.set(toolName, effect);
    this.profileOverrides.set(profileId, current);
    this.revision += 1;
    this._persist();
    return this.revision;
  }
  profileProjection(profileId) {
    this._assertOpen();
    const overrides = this.profileOverrides.get(profileId) || new Map();
    return {
      registryRevision: this.toolRegistry.revision,
      revision: this.revision,
      tools: this.toolRegistry.list().filter((tool) => tool.modelVisible !== false).map((tool) => ({
        name: tool.tool,
        domain: tool.domain,
        description: tool.description,
        risk: tool.risk,
        enabled: tool.enabled,
        effect: overrides.get(tool.tool) || "allow",
      })),
    };
  }
  authorize(input) {
    this._assertOpen();
    const tool = this.toolRegistry.get(input.name);
    if (!tool || !tool.enabled) throw permissionError("MCP_TOOL_FORBIDDEN", "工具已撤销或不存在");
    if (input.profile !== undefined
      && (!input.profile || input.profile.id !== input.profileId || input.profile.enabled !== true)) {
      throw permissionError("MCP_TOOL_FORBIDDEN", "Profile 无权调用工具");
    }
    if (this.profileOverrides.get(input.profileId)?.get(input.name) === "deny") {
      throw permissionError("MCP_TOOL_FORBIDDEN", "工具权限已撤销");
    }
    if (["confirm", "destructive"].includes(tool.risk) && input.confirmed !== true) {
      throw permissionError("MCP_TOOL_CONFIRMATION_REQUIRED", "工具需要本次用户确认");
    }
    if (input.run !== null && input.run !== undefined) {
      if (input.run.profileId !== input.profileId) {
        throw permissionError("MCP_TOOL_FORBIDDEN", "WorkRun 不属于当前 Profile");
      }
      if (input.workspace !== undefined && input.workspace !== input.run.workspace) {
        throw permissionError("MCP_TOOL_FORBIDDEN", "工具 workspace 超出 WorkRun 范围");
      }
    }
    return Object.freeze({
      toolRevision: this.toolRegistry.revision,
      permissionRevision: this.revision,
      risk: tool.risk,
    });
  }
}

module.exports = { PermissionEngine };
