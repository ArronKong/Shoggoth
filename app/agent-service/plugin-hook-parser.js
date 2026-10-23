"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Ajv = require("ajv/dist/2020");
const schema = require("../../schemas/hooks/1.0.0/plugin-hooks.schema.json");
const { validateDefinition, safeJson, relativePath, digest, HOOK_LIMITS } = require("./hook-contract");
const validate = new Ajv({ strict: true }).compile(schema);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function fail() { throw Object.assign(new Error("插件 Hooks 声明或源文件无效"), { code: "PACKAGE_INVALID" }); }
function readSource(root, relative, expected) {
  relativePath(relative);
  const target = path.join(root, relative);
  if (fs.realpathSync(target) !== target) fail();
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > HOOK_LIMITS.scriptBytes) fail();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(target);
    if (opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== before.ino || after.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size || hash(bytes) !== expected) fail();
    return { source: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sourceFile: target };
  } finally { fs.closeSync(fd); }
}
function discoverPluginHooks(root, mcpServers, files) {
  const file = path.join(root, "hooks.json");
  if (!fs.existsSync(file)) return [];
  try {
    if (fs.realpathSync(file) !== file) fail();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > HOOK_LIMITS.inputBytes) fail();
    const expected = files.find(item => item.path === "hooks.json")?.sha256;
    if (!expected) fail();
    const input = safeJson(JSON.parse(readSource(root, "hooks.json", expected).source));
    if (!validate(input)) fail();
    const names = new Set();
    return input.hooks.map(raw => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(raw.name) || names.has(raw.name)) fail();
      names.add(raw.name);
      const { requiresConnections = [], ...definition } = raw;
      if (requiresConnections.some(name => !mcpServers.some(server => server.name === name))) fail();
      if (definition.handler.type === "script" && files.find(item => item.path === definition.handler.relativePath)?.sha256 !== definition.handler.sha256) fail();
      const handler = definition.handler.type === "script"
        ? { type: "script", language: definition.handler.language,
          source: readSource(root, definition.handler.relativePath, definition.handler.sha256).source,
          ...(definition.handler.compatibility ? { compatibility: definition.handler.compatibility } : {}),
          ...(definition.handler.access ? { access: definition.handler.access } : {}) } : definition.handler;
      const checked = validateDefinition({ ...definition, handler }, "/__shoggoth_plugin_hook_validation__");
      const normalized = { ...checked, scope: definition.scope, handler: definition.handler };
      return { name: definition.name, event: definition.event, kind: definition.kind,
        descriptorDigest: digest({ definition: normalized, requiresConnections }), definition: normalized, requiresConnections };
    });
  } catch { fail(); }
}
module.exports = { discoverPluginHooks, readPluginHookSource: readSource };
