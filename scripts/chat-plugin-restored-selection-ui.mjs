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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-restored-plugin-selection-"));
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/chat-plugin-restored-selection.tsx")],
    bundle: true, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl",
      ".png": "dataurl" },
    outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(uiRoot, "node_modules")],
    logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 820,
    webPreferences: { backgroundThrottling: false } });
  try {
    for (const scenario of ["pending", "stale"]) {
      await window.loadURL(${JSON.stringify(pathToFileURL(path.join(temp, "index.html")).href)}
        + "?scenario=" + scenario + "#/chat");
      const result = await window.webContents.executeJavaScript(
        "window.runRestoredSelectionFixture()", true).catch(async error => {
          console.error(JSON.stringify({ scenario, diagnostic: await window.webContents.executeJavaScript(
            "({ text: document.body.innerText.slice(0, 1200), stored: localStorage.getItem('shoggoth.chat.plugin-selection.v1'), url: location.href })", true) }));
          throw error;
        });
      console.log(JSON.stringify(result));
    }
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });`);
  const result = spawnSync(createRequire(path.join(root, "package.json"))("electron"), [main], {
    encoding: "utf8", timeout: 45_000, env: { ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  process.stdout.write(result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || ""));
  assert.equal(result.status, 0, "restored plugin selection ChatPage fixture failed");
  const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.scenario), ["pending", "stale"]);
  assert.deepEqual(rows[0].selection, [{ installationId: "selected-fixture", revision: 1 }]);
  assert.equal(rows[0].clearedAfterAccepted, true);
  assert.equal(rows[1].sent, 1);
  assert.equal(rows[1].retainedDraft, true);
  assert.equal(rows[1].foreignSelectionForwardedToProxy, true);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
