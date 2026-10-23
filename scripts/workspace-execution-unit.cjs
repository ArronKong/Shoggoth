"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { WorkspaceExecutionService } = require("../app/agent-service/workspace-execution");
const { workspaceAutoExecution, workspaceExecutionInstructions, validWorkspaceExecutionArguments } = require("../app/agent-service/workspace-execution-tools");
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-execution-")));
const workspace = path.join(root, "workspace"), outside = path.join(root, "private");
fs.mkdirSync(workspace); fs.mkdirSync(outside);
const cacheDir = path.join(root, "control");
const service = new WorkspaceExecutionService({ cacheDir, paths: { trustedRoot: root, homeDir: root } });
const run = { id: "run-workspace", profileId: "profile-workspace", workspace, source: "chat" };
const contract = { ...run, runId: run.id, runtime: "antigravity", permissionMode: "auto-review",
  permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" }, workspaceExecutionVersion: 1 };
const scope = { runId: run.id, assertCurrent() {} };
const execute = (command, extra = {}) => service.execute({ contract, run, scope, args: { command, ...extra } });
const node = script => `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
const tests = [];
const test = async (name, action) => { await action(); tests.push(name); console.log(`PASS ${name}`); };

(async () => {
  try {
    await test("contract grants only new frozen auto runs of the four runtimes", async () => {
      for (const runtime of ["antigravity", "pi", "opencode", "deepseek-harness"]) assert.equal(workspaceAutoExecution({ ...contract, runtime }), true);
      for (const update of [{ permissionMode: "request-approval" }, { permissionMode: "full-access" }, { runtime: "codex" }, { source: "proactive" },
        { workspaceExecutionVersion: undefined }, { permissionPolicy: { sandbox: "read-only" } }]) {
        assert.equal(workspaceAutoExecution({ ...contract, ...update }), false);
      }
      assert.match(workspaceExecutionInstructions(contract), /workspace_execute/);
      assert.equal(validWorkspaceExecutionArguments({ command: "true", workspace: "/" }), false);
      assert.equal(validWorkspaceExecutionArguments({ command: "true", env: { TOKEN: "secret" } }), false);
      assert.equal(validWorkspaceExecutionArguments({ command: "true", timeoutMs: 600001 }), true);
      assert.equal(validWorkspaceExecutionArguments({ command: "true", timeoutMs: 1800000 }), true);
      assert.equal(validWorkspaceExecutionArguments({ command: "true", timeoutMs: 1800001 }), false);
    });
    assert.equal(await service.verify(), true, "a real OS sandbox must pass before automatic execution");
    await test("default and explicit thirty-minute commands pass both Service and standalone supervisor", async () => {
      for (const extra of [{}, { timeoutMs: 1800000 }]) {
        const result = await execute("printf timeout-budget-ok", extra);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, "timeout-budget-ok");
      }
    });
    await test("all workspace file operations, dotfiles and scripts execute without approval", async () => {
      const script = "const fs=require('node:fs');fs.mkdirSync('nested');fs.writeFileSync('nested/.env','fixture');fs.renameSync('nested/.env','nested/result');if(fs.readFileSync('nested/result','utf8')!=='fixture')process.exit(9);fs.unlinkSync('nested/result');fs.writeFileSync('proof','done')";
      const result = await execute(node(script));
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(fs.readFileSync(path.join(workspace, "proof"), "utf8"), "done");
      for (const runtime of ["antigravity", "pi", "opencode", "deepseek-harness"]) {
        const result = await service.execute({ contract: { ...contract, runtime }, run, scope,
          args: { command: node(`require('node:fs').writeFileSync(${JSON.stringify(runtime + '.txt')},'done')`) } });
        assert.equal(result.exitCode, 0, result.stderr); assert.equal(fs.readFileSync(path.join(workspace, runtime + ".txt"), "utf8"), "done");
      }
    });
    await test("outside reads and writes, symlinks, child interpreters and inherited secrets are blocked", async () => {
      const secret = path.join(outside, "secret"); fs.writeFileSync(secret, "PRIVATE-CANARY");
      fs.symlinkSync(outside, path.join(workspace, "escape"));
      process.env.SHOGGOTH_WORKSPACE_SECRET_CANARY = "must-not-inherit";
      const script = `const fs=require('node:fs'),cp=require('node:child_process');let blocked=0;for(const p of [${JSON.stringify(secret)},'escape/secret',${JSON.stringify('/System/Volumes/Data' + secret)}]){try{fs.readFileSync(p)}catch(e){if(['EPERM','EACCES','ENOENT'].includes(e.code))blocked++}};try{fs.writeFileSync(${JSON.stringify(secret)},'changed')}catch(e){if(['EPERM','EACCES'].includes(e.code))blocked++};const nested=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`require('node:fs').readFileSync(${JSON.stringify(secret)})`)}],{encoding:'utf8'});if(nested.status!==0)blocked++;console.log(JSON.stringify({blocked,secret:process.env.SHOGGOTH_WORKSPACE_SECRET_CANARY||null}));`;
      const result = await execute(node(script));
      assert.equal(result.exitCode, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { blocked: 5, secret: null });
      assert.equal(fs.readFileSync(secret, "utf8"), "PRIVATE-CANARY"); delete process.env.SHOGGOTH_WORKSPACE_SECRET_CANARY;
    });
    await test("network and Service-like Unix sockets are denied", async () => {
      let connections = 0;
      const tcp = net.createServer(socket => { connections++; socket.destroy(); });
      const unix = net.createServer(socket => { connections++; socket.destroy(); });
      await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
      const socketPath = path.join(root, "service.sock");
      await new Promise(resolve => unix.listen(socketPath, resolve));
      try {
        const script = `const net=require('node:net');Promise.all([{host:'127.0.0.1',port:${tcp.address().port}},{path:${JSON.stringify(socketPath)}}].map(options=>new Promise(resolve=>{const s=net.connect(options);s.once('connect',()=>{s.destroy();resolve(false)});s.once('error',e=>resolve(['EPERM','EACCES'].includes(e.code)))}))).then(r=>console.log(JSON.stringify(r)))`;
        const result = await execute(node(script)); assert.equal(result.exitCode, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [true, true]); assert.equal(connections, 0);
      } finally { await Promise.all([tcp, unix].map(server => new Promise(resolve => server.close(resolve)))); }
    });
    await test("hard links cannot expose or change an outside file", async () => {
      const secret = path.join(outside, "hard-secret"); fs.writeFileSync(secret, "HARD-PRIVATE");
      fs.linkSync(secret, path.join(workspace, "preexisting-hard-link"));
      const script = `const fs=require('node:fs');let blocked=0;for(const action of [()=>fs.readFileSync('preexisting-hard-link'),()=>fs.writeFileSync('preexisting-hard-link','changed'),()=>fs.linkSync(${JSON.stringify(secret)},'created-hard-link')])try{action()}catch(e){if(['EACCES','EPERM'].includes(e.code))blocked++};console.log(blocked)`;
      await assert.rejects(execute(node(script)), { code: "WORKSPACE_EXECUTION_SCOPE_INVALID" });
      assert.equal(fs.readFileSync(secret, "utf8"), "HARD-PRIVATE");
      fs.unlinkSync(path.join(workspace, "preexisting-hard-link"));
      const created = await execute(node(`const fs=require('node:fs');let blocked=false;try{fs.linkSync(${JSON.stringify(secret)},'created-hard-link')}catch(e){blocked=['EACCES','EPERM'].includes(e.code)};if(!blocked)fs.writeFileSync('created-hard-link','changed');console.log(blocked)`));
      assert.equal(created.exitCode, 0, created.stderr);
      assert.equal(created.stdout.trim(), "true", "a command cannot import a new hard link after the preflight scan");
      assert.equal(fs.readFileSync(secret, "utf8"), "HARD-PRIVATE");
    });
    await test("cwd cannot escape through traversal or symlinks", async () => {
      for (const cwd of ["..", "escape", outside]) await assert.rejects(execute("true", { cwd }), { code: "WORKSPACE_EXECUTION_SCOPE_INVALID" });
      const result = await execute("pwd", { cwd: "nested" }); assert.equal(result.stdout.trim(), path.join(workspace, "nested"));
    });
    await test("real nonzero exits are preserved", async () => {
      const result = await execute("printf 'failed' >&2; exit 7"); assert.equal(result.exitCode, 7); assert.equal(result.stderr, "failed");
    });
    await test("a real offline npm build can run scripts and produce its workspace output", async () => {
      fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ private: true,
        scripts: { build: "node build.cjs" } }));
      fs.writeFileSync(path.join(workspace, "build.cjs"), "const fs=require('node:fs');fs.mkdirSync('dist');fs.writeFileSync('dist/result.txt','built')");
      const result = await execute("npm --offline --silent run build");
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(fs.readFileSync(path.join(workspace, "dist/result.txt"), "utf8"), "built");
    });
    await test("large and hostile output stays bounded without turning a successful command into a replay", async () => {
      const result = await execute(node("process.stdout.write('\\u0000'.repeat(100000));process.stderr.write('🙂'.repeat(20000)+'FINAL')"));
      assert.equal(result.exitCode, 0); assert.equal(result.outputTruncated, true);
      assert.equal(result.stdout.isWellFormed(), true); assert.equal(result.stderr.isWellFormed(), true);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32000); assert.match(result.stderr, /FINAL$/u);
    });
    await test("wider file access requires one approval and keeps all other files blocked", async () => {
      const target = path.join(outside, "approved");
      const args = { command: node(`require('node:fs').writeFileSync(${JSON.stringify(target)},'allowed')`),
        access: { writePaths: [target] }, reason: "Create the explicitly requested fixture file" };
      await assert.rejects(service.execute({ contract, run, scope, args }), { code: "WORKSPACE_EXECUTION_APPROVAL_REQUIRED" });
      let approvals = 0;
      service.requestApproval = async input => { approvals++; assert.equal(input.arguments.effectiveAccess.writePaths[0], target); return { approved: false }; };
      await assert.rejects(service.execute({ contract, run, scope, args }), { code: "WORKSPACE_EXECUTION_APPROVAL_DENIED" });
      assert.equal(fs.existsSync(target), false);
      service.requestApproval = async () => { approvals++; return { approved: true }; };
      const result = await service.execute({ contract, run, scope, args });
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(fs.readFileSync(target, "utf8"), "allowed");
      const read = await execute(node(`const fs=require('node:fs');console.log(fs.readFileSync(${JSON.stringify(target)},'utf8'));try{fs.writeFileSync(${JSON.stringify(target)},'bad')}catch(e){console.log(e.code)}`),
        { access: { readPaths: [target] }, reason: "Read this one fixture file" });
      assert.match(read.stdout, /allowed\nEPERM/u); assert.equal(fs.readFileSync(target, "utf8"), "allowed");
      assert.equal(approvals, 3);
    });
    await test("standard DSH and OpenCode credential stores cannot become wider file grants", async () => {
      for (const relative of [".dsh/.credentials.yaml", ".local/share/opencode/auth.json"]) {
        const credential = path.join(root, relative);
        fs.mkdirSync(path.dirname(credential), { recursive: true, mode: 0o700 }); fs.writeFileSync(credential, "SYNTHETIC-CREDENTIAL", { mode: 0o600 });
        await assert.rejects(execute("true", { access: { readPaths: [credential] }, reason: "Forbidden credential fixture" }),
          { code: "WORKSPACE_EXECUTION_SCOPE_INVALID" });
        assert.equal(fs.readFileSync(credential, "utf8"), "SYNTHETIC-CREDENTIAL");
      }
    });
    await test("network approval allows IP networking for one command, with Unix sockets still blocked", async () => {
      let connections = 0, approvals = 0;
      const tcp = net.createServer(socket => { connections++; socket.on("error", () => {}); socket.end("ok"); });
      const unix = net.createServer(socket => { connections++; socket.destroy(); });
      await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
      const socketPath = path.join(root, "approved-network.sock");
      await new Promise(resolve => unix.listen(socketPath, resolve));
      service.requestApproval = async input => { approvals++; assert.equal(input.arguments.effectiveAccess.network, true); return { approved: true }; };
      try {
        const script = `const net=require('node:net');Promise.all([{host:'127.0.0.1',port:${tcp.address().port}},{path:${JSON.stringify(socketPath)}}].map(options=>new Promise(resolve=>{const s=net.connect(options);s.once('connect',()=>{s.destroy();resolve('connected')});s.once('error',e=>resolve(e.code))}))).then(r=>console.log(JSON.stringify(r)))`;
        const result = await execute(node(script), { access: { network: true }, reason: "Connect only for this fixture invocation" });
        assert.equal(result.exitCode, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), ["connected", "EPERM"]);
        assert.equal(connections, 1); assert.equal(approvals, 1); assert.equal(result.network, "approved-for-command");
        const denied = await execute(node(`const s=require('node:net').connect({host:'127.0.0.1',port:${tcp.address().port}});s.on('error',e=>console.log(e.code))`));
        assert.match(denied.stdout, /EPERM/u); assert.equal(connections, 1);
      } finally { await Promise.all([tcp, unix].map(server => new Promise(resolve => server.close(resolve)))); }
    });
    await test("background and detached children cannot write after their command exits", async () => {
      const delayed = "setTimeout(()=>require('node:fs').writeFileSync('late-detached','bad'),1200)";
      const script = `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(delayed)}],{detached:true,stdio:'ignore'});child.unref()`;
      const result = await execute(node(script)); assert.equal(result.exitCode, 0, result.stderr);
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(fs.existsSync(path.join(workspace, "late-detached")), false);
    });
    await test("parent death is cleaned by the supervisor and the next instance only reconciles its markers", async () => {
      const crashRoot = path.join(root, "crash"), crashWorkspace = path.join(crashRoot, "workspace"), crashCache = path.join(crashRoot, "cache");
      fs.mkdirSync(crashRoot, { mode: 0o700 }); fs.mkdirSync(crashWorkspace);
      const crashRun = { id: "crash-run", profileId: "crash-profile", source: "chat", workspace: crashWorkspace };
      const crashCommand = node("const cp=require('node:child_process');cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('late-crash','bad'),1500)\"],{detached:true,stdio:'ignore'}).unref();require('node:fs').writeFileSync('started','ready');setTimeout(()=>{},60000)");
      const source = [
        `const {WorkspaceExecutionService}=require(${JSON.stringify(path.resolve(__dirname, '../app/agent-service/workspace-execution'))})`,
        `const config=${JSON.stringify({ cacheDir: crashCache, paths: { trustedRoot: crashRoot, homeDir: crashRoot } })}`,
        `const run=${JSON.stringify(crashRun)}`,
        `const contract=${JSON.stringify({ ...crashRun, runId: crashRun.id, runtime: "pi", permissionMode: "auto-review",
          workspaceExecutionVersion: 1, permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" } })}`,
        `const args=${JSON.stringify({ command: crashCommand })}`,
        "new WorkspaceExecutionService(config).execute({run,contract,args,scope:{runId:run.id,assertCurrent(){}}}).catch(error=>{console.error(error);process.exit(2)})",
      ].join(";\n");
      new (require("node:vm").Script)(source);
      const parent = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "pipe"] });
      let parentError = ""; parent.stderr.on("data", chunk => { parentError += chunk.toString("utf8"); });
      const unrelated = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
      try {
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(path.join(crashWorkspace, "started"))) {
          assert.ok(Date.now() < deadline && parent.exitCode === null, "isolated parent started its workspace command: " + parentError);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const closed = new Promise(resolve => parent.once("close", resolve)); parent.kill("SIGKILL"); await closed;
        await new Promise(resolve => setTimeout(resolve, 1800));
        assert.equal(fs.existsSync(path.join(crashWorkspace, "late-crash")), false);
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "a process without this sandbox's marker must survive");
        const recovered = new WorkspaceExecutionService({ cacheDir: crashCache, paths: { trustedRoot: crashRoot, homeDir: crashRoot } });
        assert.equal(await recovered.verify(), true); await recovered.close();
        assert.equal(fs.readdirSync(crashCache).some(name => name.startsWith("execution-")), false);
      } finally { try { parent.kill("SIGKILL"); } catch {} try { unrelated.kill("SIGKILL"); } catch {} }
    });
    await test("packaging includes both architectures and refreshes the signed helper manifest before sealing", async () => {
      const repo = path.resolve(__dirname, ".."), binaryRoot = path.join(repo, ".vendor/workspace-execution");
      assert.equal(execFileSync("/usr/bin/lipo", ["-archs", path.join(binaryRoot, "process-owner")], { encoding: "utf8" }).trim().split(/\s+/u).sort().join(","), "arm64,x86_64");
      const app = path.join(root, "Fixture.app"), resources = path.join(app, "Contents/Resources/workspace-execution");
      fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(path.join(app, "Contents/MacOS"));
      for (const name of ["process-owner", "manifest.json"]) fs.copyFileSync(path.join(binaryRoot, name), path.join(resources, name));
      fs.copyFileSync(path.join(binaryRoot, "process-owner"), path.join(app, "Contents/MacOS/Fixture"));
      fs.writeFileSync(path.join(app, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.shoggoth.workspace-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
      const { packagedWorkspaceManifest } = require("./adhoc-sign.cjs");
      packagedWorkspaceManifest(app);
      execFileSync("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", path.join(resources, "process-owner")], { stdio: "ignore" });
      packagedWorkspaceManifest(app, true);
      execFileSync("/usr/bin/codesign", ["--force", "--deep", "--options", "runtime", "--timestamp=none", "--sign", "-", app], { stdio: "ignore" });
      packagedWorkspaceManifest(app);
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", app], { stdio: "ignore" });
    });
    await test("timeout and cancellation stop owned processes", async () => {
      await assert.rejects(execute(node("setTimeout(()=>require('node:fs').writeFileSync('late-timeout','bad'),1500)"), { timeoutMs: 100 }), { code: "WORKSPACE_EXECUTION_TIMEOUT" });
      const controller = new AbortController();
      const promise = service.execute({ contract, run, args: { command: node("setTimeout(()=>require('node:fs').writeFileSync('late-cancel','bad'),1500)") },
        scope: { ...scope, signal: controller.signal } });
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(promise, { code: "HOST_CAPABILITY_REVOKED" });
      await new Promise(resolve => setTimeout(resolve, 1700));
      for (const file of ["late-timeout", "late-cancel"]) assert.equal(fs.existsSync(path.join(workspace, file)), false);
      assert.equal(service.active.size, 0);
    });
    await test("lease revocation and Service close stop work without replay or an unbounded approval wait", async () => {
      const revoked = path.join(workspace, "lease-revoked-ready"), late = path.join(workspace, "lease-revoked-late");
      let valid = true;
      const action = service.execute({ contract, run, args: { command: node(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(revoked)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'bad'),1000)`) },
        scope: { ...scope, assertCurrent() { if (!valid) throw Object.assign(new Error("revoked"), { code: "HOST_CAPABILITY_REVOKED" }); } } });
      const denied = assert.rejects(action, { code: "HOST_CAPABILITY_REVOKED" });
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(revoked)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
      valid = false; await denied;
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal(fs.existsSync(late), false);
      let asked = false;
      const waiting = new WorkspaceExecutionService({ cacheDir: path.join(root, "closing-control"), paths: { trustedRoot: root, homeDir: root },
        requestApproval: input => new Promise(resolve => { asked = true;
          input.signal.addEventListener("abort", () => resolve({ approved: false }), { once: true }); }) });
      const pending = waiting.execute({ contract, run, scope, args: { command: "true", access: { network: true }, reason: "Closing approval fixture" } });
      const stopped = assert.rejects(pending, { code: "HOST_CAPABILITY_REVOKED" });
      while (!asked) await new Promise(resolve => setTimeout(resolve, 10));
      await waiting.close(); await stopped;
      assert.equal(waiting.pending.size, 0); assert.equal(waiting.active.size, 0);
    });
    console.log(JSON.stringify({ passed: tests.length, tests }));
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
