"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceExecutionService } = require("../app/agent-service/workspace-execution");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

(async () => {
  assert.ok(process.versions.electron, "Run this fixture with Electron's embedded Node");
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-electron-")));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace); fs.writeFileSync(outside, "OUTSIDE-CANARY");
  const run = { id: "electron-run", profileId: "electron-profile", source: "chat", workspace };
  const contract = { ...run, runId: run.id, runtime: "antigravity", permissionMode: "auto-review",
    permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" }, workspaceExecutionVersion: 1 };
  const service = new WorkspaceExecutionService({ cacheDir: path.join(root, "control"), paths: { trustedRoot: root, homeDir: root } });
  const scope = { runId: run.id, assertCurrent() {} };
  const execute = command => service.execute({ run, contract, scope, args: { command } });
  try {
    assert.equal(await service.verify(), true, "Electron's embedded Node must pass the actual OS and cleanup probe");
    const source = `const fs=require('node:fs');fs.writeFileSync('.env','workspace');fs.renameSync('.env','result');`;
    const written = await execute(`${quote(process.execPath)} -e ${quote(source)}`);
    assert.equal(written.exitCode, 0, written.stderr); assert.equal(fs.readFileSync(path.join(workspace, "result"), "utf8"), "workspace");
    const blocked = await execute(`/bin/cat ${quote(outside)}`);
    assert.notEqual(blocked.exitCode, 0); assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE-CANARY");
    assert.equal((await execute("exit 7")).exitCode, 7);
    assert.equal(service.active.size, 0);
    console.log(JSON.stringify({ verified: true, electron: process.versions.electron, node: process.versions.node,
      sandbox: true, workspaceWrite: true, outsideBlocked: true, exitStatus: true, cleanup: true, realProvider: false }));
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
