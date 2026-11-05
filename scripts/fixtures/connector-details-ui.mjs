import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync(new URL("../../app/manage-ui/src/components/ConnectorDetails.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

export const bundledBridgeVersions = { __esModule: true, default: require("../agent-service/data/mcp-bundled-bridge-versions.json") };
export function loadConnectorDetails(t = key => key) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
    if (name === "react-i18next") return { useTranslation: () => ({ t }) };
    if (name.endsWith(".module.css")) return { __esModule: true, default: {} };
    return require(name);
  } });
  return module.exports;
}
