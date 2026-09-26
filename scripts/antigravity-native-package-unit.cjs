"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createPackageWithOptions } = require("@electron/asar");
const { verifyPackagedNativeTerminal } = require("./prepare-native-terminal.cjs");
const repo = path.resolve(__dirname, "..");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-package-"));
  try {
    const stage = path.join(root, "stage");
    const app = path.join(root, "Fixture.app");
    const resources = path.join(app, "Contents", "Resources");
    fs.mkdirSync(resources, { recursive: true });
    const config = fs.readFileSync(path.join(repo, "electron-builder.yml"), "utf8");
    const prefixes = config.split("\n").filter((line) => /^  - node_modules\/(?:node-pty|@xterm\/headless)\//u.test(line))
      .map((line) => line.trim().slice(2));
    assert.ok(prefixes.includes("node_modules/@xterm/headless/lib-headless/**/*"));
    assert.ok(config.includes("  - node_modules/node-pty/**/*"), "PTY dependencies must be unpacked");
    for (const prefix of prefixes) {
      const relative = prefix.replace(/\/\*\*\/\*$/u, "");
      const paths = relative.includes("darwin-*") ? [relative.replace("darwin-*", "darwin-arm64"), relative.replace("darwin-*", "darwin-x64")] : [relative];
      for (const selected of paths) {
        fs.mkdirSync(path.dirname(path.join(stage, selected)), { recursive: true });
        fs.cpSync(path.join(repo, selected), path.join(stage, selected), { recursive: true });
      }
    }
    await createPackageWithOptions(stage, path.join(resources, "app.asar"), { unpackDir: "node_modules/node-pty" });
    verifyPackagedNativeTerminal(app);
    const probe = path.join(root, "probe.cjs");
    fs.writeFileSync(probe, `const assert=require('node:assert/strict');
const pty=require(${JSON.stringify(path.join(resources, "app.asar/node_modules/node-pty"))});
const {Terminal}=require(${JSON.stringify(path.join(resources, "app.asar/node_modules/@xterm/headless"))});
const terminal=new Terminal({cols:80,rows:24,allowProposedApi:true});
terminal.write('native terminal',()=>{assert.equal(terminal.buffer.active.getLine(0).translateToString(true),'native terminal');terminal.dispose();});
const child=pty.spawn('/bin/sh',['-c','test -t 0 && test -t 1 && printf ASAR_PTY_OK'],{cwd:process.cwd(),env:process.env});
let output='';const timer=setTimeout(()=>{child.kill('SIGKILL');process.exitCode=1},5000);
child.onData(data=>{output+=data});child.onExit(({exitCode})=>{clearTimeout(timer);assert.equal(exitCode,0);assert.equal(output,'ASAR_PTY_OK');console.log('PASS packaged PTY and xterm under Electron '+process.versions.electron);});
`);
    process.stdout.write(execFileSync(require("electron"), [probe], { cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10_000, encoding: "utf8" }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
