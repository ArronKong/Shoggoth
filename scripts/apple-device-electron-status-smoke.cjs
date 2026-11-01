"use strict";

// Exercise the real Electron Node runtime without launching Shoggoth, opening a
// BrowserWindow, requesting system access, or reading Calendar/Reminders data.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync("/private/tmp/apple-electron-status-");
try {
  const main = path.join(scratch, "main.cjs");
  const source = `
    'use strict';
    const { app } = require('electron');
    const path = require('node:path');
    const root = ${JSON.stringify(scratch)};
    app.setPath('userData', path.join(root, 'user-data'));
    app.setPath('sessionData', path.join(root, 'session-data'));
    app.setPath('crashDumps', path.join(root, 'crashes'));
    app.setAppLogsPath(path.join(root, 'logs'));
    app.setActivationPolicy('prohibited');
    app.disableHardwareAcceleration();
    for (const flag of ['disable-background-networking', 'disable-component-update', 'no-first-run', 'disable-default-apps']) app.commandLine.appendSwitch(flag);
    const timer = setTimeout(() => app.exit(2), 15000);
    app.whenReady().then(async () => {
      const native = require(${JSON.stringify(path.join(root, "app/apple-device-native.js"))}).createAppleDeviceNative({addonPath:${JSON.stringify(path.join(root, ".vendor/apple-device/apple-device.node"))}});
      const status = await native.invoke('status');
      process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,arch:process.arch,status}) + '\\n');
      clearTimeout(timer); app.exit(0);
    }).catch(error => { process.stderr.write(String(error.code || 'FAILED') + '\\n'); clearTimeout(timer); app.exit(1); });
  `;
  fs.writeFileSync(main, source);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const output = execFileSync(require("electron"), [main], { cwd: scratch, env: environment, encoding: "utf8", timeout: 20000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(output.trim().split("\n").at(-1));
  const authorizations = new Set(["notDetermined", "fullAccess", "writeOnly", "denied", "restricted", "unavailable"]);
  if (!/^44\./u.test(result.electron) || !authorizations.has(result.status?.calendar) || !authorizations.has(result.status?.reminders)) throw new Error("Electron Apple device status response invalid");
  console.log(JSON.stringify(result));
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
