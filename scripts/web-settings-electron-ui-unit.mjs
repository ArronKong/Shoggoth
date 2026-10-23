import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const temp = fs.mkdtempSync("/private/tmp/sg-web-ui-"), output = path.join(root, ".artifacts/web-providers");
fs.mkdirSync(output, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/web-settings-ui.tsx")], bundle: true, format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;min-height:100%;width:100%}</style><div id="root"></div><script>window.addEventListener("error",e=>window.fixtureError=e.error?.stack||e.message);window.addEventListener("unhandledrejection",e=>window.fixtureError=String(e.reason));</script><script type="module" src="fixture.js"></script>');
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [path.join(root, "scripts/fixtures/web-settings-electron.cjs"), path.join(temp, "index.html"), output],
    { encoding: "utf8", timeout: 45000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout || ""); if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  fs.writeFileSync(path.join(output, "ui-result.json"), result.stdout + (result.status === 0 ? "" : result.stderr));
  assert.equal(result.status, 0); assert.match(result.stdout, /"verified":true/u);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
