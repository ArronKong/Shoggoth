#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(uiRoot, "package.json"));
const { build } = requireUi("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-external-approval-"));
const outputDir = path.join(root, ".artifacts/chat-external-approval-ui-fixture");
fs.mkdirSync(outputDir, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-external-approval.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")],
    logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { backgroundThrottling: false } });
  const out = ${JSON.stringify(outputDir)};
  let passed = false;
  try {
    await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});
    w.show(); w.focus();
    const checks = await w.webContents.executeJavaScript("window.runExternalApprovalFixture()", true);
    const geometry = [];
    for (const width of [900, 390]) {
      w.setContentSize(width, 700);
      for (const theme of ["light", "dark"]) {
        const item = await w.webContents.executeJavaScript('window.captureExternalApproval('+JSON.stringify(theme)+')', true);
        geometry.push(item);
        fs.writeFileSync(path.join(out, 'chat-'+width+'-'+theme+'.png'),
          (await w.webContents.capturePage()).toPNG());
      }
    }
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ checks, geometry }, null, 2) + "\\n");
    console.log(JSON.stringify({ checks, geometry })); passed = true;
  } catch (error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript(
      "JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText})"));
    fs.writeFileSync(path.join(out, "failure.png"), (await w.webContents.capturePage()).toPNG());
  } finally { w.destroy(); app.exit(passed ? 0 : 1); }
}).catch(error => { console.error(error); app.exit(1); });`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 45_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "external approval timeline Electron regression failed");
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "report.json"), "utf8"));
  assert.equal(report.checks.crossSessionHidden, true);
  assert.equal(report.checks.ambiguousHidden, true);
  assert.equal(report.checks.duplicateStepHidden, true);
  assert.equal(report.checks.missingIdHidden, true);
  assert.equal(report.checks.ordinaryToolIgnored, true);
  for (const item of report.geometry) {
    assert.deepEqual(item.errors, []);
    assert(item.scrollWidth <= item.width, `horizontal overflow at ${item.width}/${item.theme}`);
    assert(item.badge.left >= 0 && item.badge.right <= item.width,
      `approval badge outside viewport at ${item.width}/${item.theme}`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
