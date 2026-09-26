"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PluginComponentResolver } = require("./plugin-component-resolver");
const { PluginDependencyRegistry } = require("./plugin-dependency-registry");
const { serviceError } = require("./security");

const BARE_COMMAND = /^[^./\\\s][^/\\\s]*$/u;

function fail(code, message) { throw serviceError(code, message); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

class PluginMcpLaunchPlanner {
  constructor({ store, resolver = new PluginComponentResolver({ store }),
    dependencies = new PluginDependencyRegistry({ store, resolver }) } = {}) {
    if (!store?.paths?.pluginPackagesDir || typeof resolver.inspectMcpServer !== "function") {
      throw new TypeError("PluginMcpLaunchPlanner requires PluginStore and component resolver");
    }
    this.store = store;
    this.resolver = resolver;
    this.dependencies = dependencies;
  }

  planStdio(input) {
    const component = this.resolver.inspectMcpServer(input);
    if (component.transport !== "stdio") {
      fail("MCP_SERVER_TRANSPORT_UNSUPPORTED", "组件不是 stdio MCP Server");
    }
    const spec = component.spec;
    if (BARE_COMMAND.test(spec.command)) {
      if (!["node", "python", "python3"].includes(spec.command)) {
        fail("DEPENDENCY_INTERPRETER_UNSUPPORTED", "此裸命令不支持依赖准备");
      }
      // Keep the existing missing-dependency diagnosis even when an unprepared
      // package also declares unsupported interpreter arguments.
      const dependency = this.dependencies.resolve(input);
      const root = fs.realpathSync(path.join(this.store.paths.pluginPackagesDir, input.releaseDigest));
      return Object.freeze({ ...dependency, args: Object.freeze(dependency.args),
        env: Object.freeze(dependency.env), pluginRoot: root, source: "plugin",
        installationId: input.installationId, componentId: input.componentId,
        releaseDigest: input.releaseDigest, descriptorDigest: input.descriptorDigest });
    }
    let root;
    try { root = fs.realpathSync(path.join(this.store.paths.pluginPackagesDir, input.releaseDigest)); }
    catch { fail("PACKAGE_CHANGED", "插件摘要包路径已变化"); }
    const command = path.resolve(root, spec.command);
    let stat;
    let real;
    try { stat = fs.lstatSync(command); real = fs.realpathSync(command); }
    catch { fail("DEPENDENCY_MISSING", "插件 stdio 启动文件不存在"); }
    if (!inside(root, real) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o111) === 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      fail("DEPENDENCY_MISSING", "插件 stdio 启动文件不可执行或路径不安全");
    }
    try { fs.accessSync(real, fs.constants.X_OK); }
    catch { fail("DEPENDENCY_MISSING", "插件 stdio 启动文件没有执行权限"); }
    return Object.freeze({ command: real, args: Object.freeze([...(spec.args || [])]),
      cwd: spec.cwd || "${PLUGIN_ROOT}", env: Object.freeze({ ...(spec.env || {}) }),
      pluginRoot: root, source: "plugin", installationId: input.installationId,
      componentId: input.componentId, releaseDigest: input.releaseDigest,
      descriptorDigest: input.descriptorDigest });
  }
}

module.exports = { PluginMcpLaunchPlanner };
