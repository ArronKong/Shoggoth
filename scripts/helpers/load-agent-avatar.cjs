const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "../..");
const requireUi = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = requireUi("typescript");
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: {
    esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    if (name.endsWith(".css")) return { avatar: "shared-avatar" };
    if (name.endsWith(".webp")) return name;
    if (name.startsWith(".")) return load(path.resolve(path.dirname(file), `${name}.ts`));
    return requireUi(name);
  } }, { filename: file });
  return module.exports;
}

module.exports = load(path.join(root, "app/manage-ui/src/components/AgentAvatar.tsx"));
