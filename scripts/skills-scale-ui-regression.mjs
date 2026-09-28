#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const { build } = createRequire(path.join(uiRoot, "package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-skills-scale-ui-"));
const outputDir = path.resolve(process.argv.find((value) => value.startsWith("--output-dir="))?.slice(13)
  || path.join(os.tmpdir(), `shoggoth-skills-scale-ui-${new Date().toISOString().replace(/[:.]/gu, "-")}`));
fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(path.join(outputDir, "report.json"), { force: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/skills-scale-page.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")], logLevel: "silent" });
  const page = path.join(temp, "index.html");
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file:|data:)/.test(details.url) }));
  const outputDir = ${JSON.stringify(outputDir)}, page = ${JSON.stringify(page)};
  const records = [];
  const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } });
  try {
    for (const width of [1280, 390]) {
      w.setContentSize(width, 900);
      try {
        await w.loadFile(page);
        const result = await Promise.race([
          w.webContents.executeJavaScript("window.runSkillsScalePage(" + width + ")", true),
          new Promise((_, reject) => setTimeout(() => reject(Error("Skills scale renderer timeout")), 30000)),
        ]);
        assert.equal(result.pagesChecked, 84);
        assert.deepEqual(result.tailSearch, ["scale-4999"]);
        fs.writeFileSync(path.join(outputDir, "skills-" + width + "-tail.png"), (await w.webContents.capturePage()).toPNG());
        const detail = await w.webContents.executeJavaScript("window.showSkillsScaleDetail()", true);
        assert.equal(detail.cardCount, 60);
        records.push({ ...result, detailCapture: detail });
        fs.writeFileSync(path.join(outputDir, "skills-" + width + "-detail.png"), (await w.webContents.capturePage()).toPNG());
        const repair = await w.webContents.executeJavaScript("window.runStandaloneMcpRepair(" + width + ")", true);
        assert.equal(repair.disabledVisible, true);
        assert.equal(repair.callsBeforeActivation, 1);
        records.at(-1).standaloneMcpRepair = repair;
        fs.writeFileSync(path.join(outputDir, "skills-" + width + "-mcp-repair.png"), (await w.webContents.capturePage()).toPNG());
        const confirmation = await w.webContents.executeJavaScript("window.showStandaloneMcpConfirmation()", true);
        assert.equal(confirmation.dialogVisible, true);
        records.at(-1).standaloneMcpConfirmation = confirmation;
        fs.writeFileSync(path.join(outputDir, "skills-" + width + "-mcp-confirm.png"), (await w.webContents.capturePage()).toPNG());
        const activated = await w.webContents.executeJavaScript("window.finishStandaloneMcpRepair()", true);
        assert.equal(activated.activationCalls, 2);
        records.at(-1).standaloneMcpActivation = activated;
      } catch (error) {
        console.error(error);
        try { fs.writeFileSync(path.join(outputDir, "skills-" + width + "-failure.png"), (await Promise.race([w.webContents.capturePage(), new Promise((_, reject) => setTimeout(() => reject(Error("capture timeout")), 2000))])).toPNG()); } catch {}
        try { console.error(JSON.stringify(await Promise.race([w.webContents.executeJavaScript("({ errors: window.skillsScaleErrors, requests: window.skillsScaleRequests?.slice(-5), text: document.body.innerText.slice(0, 1000) })"), new Promise((_, reject) => setTimeout(() => reject(Error("diagnostics timeout")), 2000))]))); } catch {}
        throw error;
      }
    }
    fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify({ verified: true, records }, null, 2) + "\\n");
    console.log("PASS Skills 5,000-item rendered Electron paging, scroll, focus, tail search at 1280/390 px");
    w.destroy(); app.exit(0);
  } catch (error) { console.error(error); w.destroy(); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });`);
  const electron = createRequire(path.join(root, "package.json"))("electron");
  const run = spawnSync(electron, [main], { encoding: "utf8", timeout: 90_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  assert.equal(run.status, 0, `Electron Skills scale fixture failed: ${run.error || run.signal || run.status}`);
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "report.json"), "utf8"));
  assert.equal(report.verified, true);
  assert.equal(report.records.length, 2);
  console.log(outputDir);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
