#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), uiRoot = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(uiRoot, "package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-managed-host-ui-"));
const output = path.join(root, ".artifacts/managed-host-panel-ui-fixture"); fs.mkdirSync(output, { recursive: true });
try {
  await requireUi("esbuild").build({ entryPoints: [path.join(root, "scripts/fixtures/managed-plugin-host-panel.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"),
    [path.join(root, "scripts/fixtures/managed-plugin-host-panel-driver.cjs"), root, temp, output],
    { encoding: "utf8", timeout: 40000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "managed Host panel actual HTTP/Electron regression failed");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
