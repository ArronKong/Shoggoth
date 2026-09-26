"use strict";

const { serviceError } = require("./security");

const MAX_SELECTED_PLUGINS = 4;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function fail(code, message) { throw serviceError(code, message); }

// A chat selection names an installed lineage and the revision the user saw.
// The Service resolves release and availability; renderer-supplied names or
// component descriptions are never execution authority.
function normalizePluginSelection(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTED_PLUGINS) {
    fail("PLUGIN_SELECTION_INVALID", "插件选择数量无效");
  }
  const seen = new Set();
  const rows = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype
      || Object.keys(item).length !== 2 || !Object.hasOwn(item, "installationId")
      || !Object.hasOwn(item, "revision") || typeof item.installationId !== "string"
      || !ID.test(item.installationId) || !Number.isSafeInteger(item.revision)
      || item.revision < 1 || seen.has(item.installationId)) {
      fail("PLUGIN_SELECTION_INVALID", "插件选择身份无效或重复");
    }
    seen.add(item.installationId);
    return { installationId: item.installationId, revision: item.revision };
  });
  rows.sort((a, b) => a.installationId < b.installationId ? -1
    : a.installationId > b.installationId ? 1 : 0);
  return rows;
}

function validPluginSelection(value) {
  try { normalizePluginSelection(value); return true; } catch { return false; }
}

function resolvePluginSelection(store, value, toolCatalogRegistry = null) {
  const selection = normalizePluginSelection(value);
  if (!selection) return [];
  if (!store || typeof store.getInstallation !== "function"
    || typeof store.getRelease !== "function") {
    fail("PLUGIN_SELECTION_UNAVAILABLE", "插件库尚未就绪");
  }
  return selection.map(({ installationId, revision }) => {
    const installation = store.getInstallation(installationId);
    if (!installation || installation.desiredState !== "enabled"
      || installation.revision !== revision
      || store.hasPendingInstallationDisable?.(installationId)) {
      fail("PLUGIN_SELECTION_STALE", `插件 ${installationId} 已停用、更新或卸载，请重新选择`);
    }
    const release = store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    if (!release) fail("PLUGIN_SELECTION_STALE", `插件 ${installationId} 的版本已变化`);
    if (!release.components?.skills?.length && !release.components?.mcpServers?.length) {
      fail("PLUGIN_SELECTION_UNAVAILABLE", `插件 ${release.name} 尚无可用的 Shoggoth 能力`);
    }
    const { createPluginAvailability } = require("./plugin-availability");
    const stateFor = createPluginAvailability(store, toolCatalogRegistry);
    const states = [...(release.components?.skills || []).map(item => ["skill", item.name]),
      ...(release.components?.mcpServers || []).map(item => ["mcp-server", item.name])]
      .map(([kind, name]) => stateFor(installation, kind, name));
    if (!states.includes("ready")) {
      const reason = states.includes("permission_required")
        ? "连接已就绪，但尚无获得授权的可用工具"
        : states.includes("connection_required")
          ? "尚未连接所需账号或本地 MCP"
          : "当前没有可用组件";
      fail("PLUGIN_SELECTION_UNAVAILABLE", `插件 ${release.name}${reason}，请到插件页查看状态`);
    }
    return {
      installationId,
      revision,
      releaseDigest: installation.releaseDigest,
      packageName: release.name,
      declaredVersion: release.declaredVersion,
    };
  });
}

module.exports = { MAX_SELECTED_PLUGINS, normalizePluginSelection, validPluginSelection,
  resolvePluginSelection };
