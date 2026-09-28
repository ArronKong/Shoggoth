#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireUi = createRequire(path.join(uiRoot, "package.json"));
const { build } = requireUi("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-approval-page-"));
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-external-approval-page.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".woff2": "dataurl", ".svg": "dataurl",
      ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")],
    logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { backgroundThrottling: false } });
  try {
    const base = ${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)};
    for (const backendId of ["openclaw", "hermes"]) {
      await w.loadURL(base + "?backend=" + backendId + "#/chat");
      w.show(); w.focus();
      const result = await w.webContents.executeJavaScript("window.runExternalApprovalPageFixture()", true);
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(error);
    console.error(await w.webContents.executeJavaScript(
      "JSON.stringify({errors:window.fixtureErrors,text:document.body.innerText.slice(0,1600),reads:window.fixtureReads})"));
    process.exitCode = 1;
  } finally { w.destroy(); app.exit(process.exitCode || 0); }
}).catch(error => { console.error(error); app.exit(1); });`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 45_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "actual ChatPage external approval identity fixture failed");
  const reports = result.stdout.trim().split("\n")
    .filter(line => line.startsWith("{\"backendId\":"))
    .map(line => JSON.parse(line));
  assert.equal(reports.length, 2);
  for (const [index, backendId] of ["openclaw", "hermes"].entries()) {
    const report = reports[index];
    assert.equal(report.backendId, backendId);
    assert.equal(report.physicalSessionId, `physical-${backendId}-session`);
    assert.equal(report.toolCallId, `host-${backendId}-tool-call`);
    assert.equal(report.rendered, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.scopedReads.length, 1);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
