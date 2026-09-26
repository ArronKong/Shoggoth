"use strict";
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const [origin, root, output] = process.argv.slice(2);
assert.match(root, /^\/tmp\/sghui-[A-Za-z0-9]+$/u);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
app.setPath("userData", path.join(root, "electron-profile"));
app.setPath("logs", path.join(root, "electron-logs"));
const timeout = setTimeout(() => app.exit(1), 45_000);
let window;
process.once("SIGTERM", () => { window?.destroy(); app.quit(); });
app.whenReady().then(async () => {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const permitted = details.url.startsWith(`${origin}/`) || details.url.startsWith("data:");
    if (!permitted) blocked.push(details.url.split("?")[0]);
    callback({ cancel: !permitted });
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 1000,
    webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let passed = false;
  try {
    await window.loadURL(`${origin}/`);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const deadline=Date.now()+8000;
      const timer=setInterval(()=>{if(typeof window.runHandoffPreviewStep==='function'){
        clearInterval(timer);resolve();
      }else if(Date.now()>deadline){clearInterval(timer);reject(Error('fixture module readiness'));}},10);
    })`);
    const steps = [];
    for (let index = 0; index < 4; index++) {
      const step = await window.webContents.executeJavaScript(`window.runHandoffPreviewStep(${index}).catch(error=>({error:error.stack||String(error)}))`, true);
      assert.ok(!step.error, step.error);
      steps.push(step);
      fs.writeFileSync(path.join(output, `step-${index}-${steps[index].runtime}.png`), (await window.webContents.capturePage()).toPNG(), { flag: "wx" });
    }
    assert.deepEqual(steps.map(step => step.runtime), ["codex", "pi", "deepseek-harness", "codex"]);
    assert.notEqual(steps[0].nativeSessionId, steps[3].nativeSessionId);
    assert.equal(steps[1].confirmationAccepted, true);
    assert.deepEqual(blocked, [], "no request to another authority or network");
    fs.writeFileSync(path.join(output, "renderer.json"), JSON.stringify({ steps, blockedRequestCount: blocked.length,
      viewport: { width: 1100, height: 1000 }, actualReactControl: true, fixtureTranscriptFrame: true }, null, 2) + "\n", { flag: "wx" });
    passed = true;
  } catch (error) {
    console.error(error.stack || error);
    fs.writeFileSync(path.join(output, "failure.png"), (await window.webContents.capturePage()).toPNG());
  } finally { clearTimeout(timeout); window.destroy(); app.exit(passed ? 0 : 1); }
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
