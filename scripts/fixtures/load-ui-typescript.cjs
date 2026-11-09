"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../app/manage-ui");
const ts = createRequire(path.join(root, "package.json"))("typescript");
const chatErrors = path.resolve(root, "../agent-service/chat-error-messages.json");

// Small source-only fixtures can load a locale and its local TypeScript imports
// without a build or a global require hook.
function load(relative) {
  const file = path.resolve(root, "src", relative);
  if (!file.startsWith(path.join(root, "src") + path.sep)) throw new Error("UI fixture import outside source tree");
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!name.startsWith(".")) throw new Error("UI fixture expects a local source import");
    const dependency = path.resolve(path.dirname(file), name);
    if (dependency === chatErrors) return { default: JSON.parse(fs.readFileSync(chatErrors, "utf8")) };
    return load(path.relative(path.join(root, "src"), `${dependency}.ts`));
  } });
  return exports;
}
module.exports = { load };
