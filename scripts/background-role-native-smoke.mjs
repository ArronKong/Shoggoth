import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-visibility-")));
const appPath = path.join(scratch, "Shoggoth Visibility Fixture.app");
const children = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  execFileSync("/bin/cp", ["-cR", path.join(root, "node_modules/electron/dist/Electron.app"), appPath]);
  const plist = path.join(appPath, "Contents/Info.plist");
  for (const command of [
    "Set :CFBundleIdentifier ai.shoggoth.visibility-fixture",
    "Set :CFBundleName Shoggoth Visibility Fixture",
    "Add :LSUIElement bool true",
  ]) execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist]);
  const resources = path.join(appPath, "Contents/Resources/app");
  fs.mkdirSync(resources);
  fs.writeFileSync(path.join(resources, "package.json"), JSON.stringify({ name: "visibility-fixture", version: "1.0.0", main: "main.cjs" }));
  fs.copyFileSync(path.join(root, "app/background-role-activation.js"), path.join(resources, "background-role-activation.js"));
  fs.writeFileSync(path.join(resources, "main.cjs"), `
    const {app, BrowserWindow} = require('electron');
    const fs = require('node:fs'); const path = require('node:path');
    const {prepareBackgroundRoleActivation, hideBackgroundDock} = require('./background-role-activation');
    const background = process.argv.includes('--fixture-background');
    app.setPath('userData', path.join(${JSON.stringify(scratch)}, background ? 'background' : 'ui'));
    if (background) prepareBackgroundRoleActivation({argv: ['--shoggoth-internal-role=agent-service']});
    app.whenReady().then(() => {
      if (background) hideBackgroundDock(app);
      else {
        app.setActivationPolicy('regular');
        const win = new BrowserWindow({show: false, width: 320, height: 160});
        win.loadURL('data:text/html,Visibility fixture');
      }
      fs.writeFileSync(path.join(${JSON.stringify(scratch)}, background ? 'background.json' : 'ui.json'), JSON.stringify({pid: process.pid}));
    });
    app.on('activate', () => { if (background) hideBackgroundDock(app); });
    process.on('SIGTERM', () => app.quit());
    setTimeout(() => app.quit(), 30000);
  `);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "pipe" });
  const env = { ...process.env, HOME: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const background of [true, false]) {
    const child = spawn(path.join(appPath, "Contents/MacOS/Electron"), background ? ["--fixture-background"] : [], { env, stdio: "ignore" });
    children.push(child);
  }
  const deadline = Date.now() + 20000;
  while (!["background.json", "ui.json"].every((name) => fs.existsSync(path.join(scratch, name)))) {
    assert.ok(Date.now() < deadline, "fixture startup timeout"); await delay(100);
  }
  await delay(1000);
  const policy = () => JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import('AppKit');
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications; const rows = [];
    for (let i = 0; i < apps.count; i++) {
      const a = apps.objectAtIndex(i);
      if (ObjC.unwrap(a.bundleIdentifier) === 'ai.shoggoth.visibility-fixture') rows.push({pid: Number(a.processIdentifier), policy: Number(a.activationPolicy)});
    }
    JSON.stringify(rows);
  `], { encoding: "utf8" }));
  const bgPid = JSON.parse(fs.readFileSync(path.join(scratch, "background.json"))).pid;
  const uiPid = JSON.parse(fs.readFileSync(path.join(scratch, "ui.json"))).pid;
  const rows = policy();
  assert.equal(rows.find((r) => r.pid === bgPid)?.policy, 2, "background must be prohibited");
  assert.equal(rows.find((r) => r.pid === uiPid)?.policy, 0, "UI must be regular");
  assert.equal(rows.filter((r) => r.policy === 0).length, 1);
  console.log(JSON.stringify({ pass: true, backgroundPid: bgPid, uiPid, policies: rows, foregroundApps: 1 }));
} finally {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fixture did not exit naturally")); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }));
  fs.rmSync(scratch, { recursive: true, force: true });
}
