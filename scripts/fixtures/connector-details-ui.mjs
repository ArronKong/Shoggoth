import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
const compileComponent = name => ts.transpileModule(fs.readFileSync(new URL(`../../app/manage-ui/src/components/${name}.tsx`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const compiledDetails = compileComponent("ConnectorDetails");
const compiledAddButton = compileComponent("ConnectorAddButton");

export const bundledBridgeVersions = { __esModule: true, default: require("../agent-service/data/mcp-bundled-bridge-versions.json") };
export const connectorTelemetryFixture = {
  measureTelemetry: (_feature, _backend, run) => run(),
  startTelemetryOperation: () => undefined,
  useTelemetryOperations: () => require("react").useRef(new Map()).current,
  retainTelemetryOperation: () => undefined,
  useTelemetrySnapshot: () => undefined,
};

function loadComponent(compiled, t) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
    if (name === "react-i18next") return { useTranslation: () => ({ t }) };
    if (name.endsWith(".module.css")) return { __esModule: true, default: {} };
    return require(name);
  } });
  return module.exports;
}
export const loadConnectorDetails = (t = key => key) => loadComponent(compiledDetails, t);
export const loadConnectorAddButton = (t = key => key) => loadComponent(compiledAddButton, t);
