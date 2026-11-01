"use strict";
// Only synthetic local executables and private Unix sockets. No Google process,
// model endpoint, account, or persisted session is used by these regressions.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { test } = require("node:test");
const ROOT = path.resolve(__dirname, "..");
const BUILDER = path.join(ROOT, "scripts/build-antigravity-mcp-timeout.cjs");
const TARGET = path.join(ROOT, ".vendor/antigravity-mcp-timeout/harness-bootstrap");
const TOKEN = "a".repeat(64);
const ORIGINAL = Buffer.from([8, 129, 3, 18, 3, 97, 98, 99]);
const PATCHED = Buffer.from([8, 130, 3, 18, 3, 100, 101, 102]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function frame(bytes) { const head = Buffer.alloc(4); head.writeUInt32LE(bytes.length); return Buffer.concat([head, bytes]); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function until(check, timeout = 4000) { const end = Date.now() + timeout; while (!check() && Date.now() < end) await delay(10); assert.ok(check(), "bounded process/transport condition did not settle"); }
function reader(socket) {
  let bytes = Buffer.alloc(0), closed = false;
  socket.on("data", chunk => { bytes = Buffer.concat([bytes, chunk]); });
  socket.on("close", () => { closed = true; });
  return async () => {
    await until(() => bytes.length >= 4 || closed);
    assert.ok(bytes.length >= 4, "missing control frame"); const n = bytes.readUInt32LE();
    assert.ok(n > 0 && n <= 16384); await until(() => bytes.length >= n + 4 || closed);
    assert.ok(bytes.length >= n + 4, "incomplete control frame");
    const result = bytes.subarray(4, n + 4); bytes = bytes.subarray(n + 4); return result;
  };
}
const FIXTURE = String.raw`
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int all(int fd,const void *p,size_t n){const char *b=p;while(n){ssize_t k=write(fd,b,n);if(k<0&&errno==EINTR)continue;if(k<=0)return 0;b+=k;n-=(size_t)k;}return 1;}
int main(void){
 const char *mode=getenv("FIXTURE_MODE"); if(!mode)mode="normal";
 unsigned char head[4];size_t pos=0;while(pos<4){ssize_t n=read(0,head+pos,4-pos);if(n<=0)return 21;pos+=(size_t)n;}
 if(memcmp(head,"INPT",4)!=0)return 22;
 if(!strcmp(mode,"no-output")){for(;;)pause();}
 if(!strcmp(mode,"oversize")){unsigned char bad[4]={1,64,0,0};all(1,bad,4);for(;;)pause();}
 if(!strcmp(mode,"partial")){all(1,"\x08\x00",2);return 0;}
 unsigned char original[]={8,0,0,0,8,129,3,18,3,97,98,99};
 if(!all(1,original,sizeof(original)))return 23;
 char info[512];int size=snprintf(info,sizeof(info),"\n{\"pid\":%d,\"ppid\":%d,\"cleanEnv\":%s}\n",getpid(),getppid(),
  !getenv("SHOGGOTH_AGY_HARNESS_PATH")&&!getenv("SHOGGOTH_AGY_TIMEOUT_SOCKET")&&!getenv("SHOGGOTH_AGY_TIMEOUT_TOKEN")&&!getenv("ANTIGRAVITY_HARNESS_PATH")?"true":"false");
 if(!all(1,info,(size_t)size))return 24;
 all(2,"fixture stderr\n",15);
 if(!strcmp(mode,"closed-output"))close(1);
 if(!strcmp(mode,"bulk")){char bulk[65536];memset(bulk,'q',sizeof(bulk));for(int i=0;i<32;i++)if(!all(1,bulk,sizeof(bulk)))return 25;}
 char b[64];while(read(0,b,sizeof(b))>0){}return 0;
}
`;

test("native bootstrap builds from the checked sources", () => {
  assert.ok(fs.existsSync(BUILDER), "native bootstrap builder must exist");
  execFileSync(process.execPath, [BUILDER], { cwd: ROOT, stdio: "pipe", timeout: 60000 });
  execFileSync(process.execPath, [BUILDER, "--check"], { cwd: ROOT, stdio: "pipe", timeout: 60000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(TARGET), "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.sourceSha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "resources/antigravity-mcp-timeout/harness-bootstrap.c"))).digest("hex"));
  assert.equal(manifest.sha256, crypto.createHash("sha256").update(fs.readFileSync(TARGET)).digest("hex"));
  assert.deepEqual(manifest.architectures, ["arm64", "x86_64"]);
});

async function fixture(options, check) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-bootstrap-"))); fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "control.sock"), binary = path.join(directory, "fixture");
  const source = path.join(directory, "fixture.c"); fs.writeFileSync(source, FIXTURE, { mode: 0o600 });
  execFileSync("/usr/bin/xcrun", ["clang", "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", source, "-o", binary], { timeout: 30000, stdio: "pipe" });
  const server = net.createServer(), sockets = new Set(); let connection;
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); connection = socket; });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); fs.chmodSync(socketPath, 0o600);
  let executable = binary;
  if (options.symlink) { executable = path.join(directory, "linked"); fs.symlinkSync(binary, executable); }
  const env = { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, FIXTURE_MODE: options.mode || "normal",
    ANTIGRAVITY_HARNESS_PATH: TARGET, SHOGGOTH_AGY_HARNESS_PATH: executable,
    SHOGGOTH_AGY_TIMEOUT_SOCKET: socketPath, SHOGGOTH_AGY_TIMEOUT_TOKEN: options.token ?? TOKEN };
  if (options.invalidPath) env.SHOGGOTH_AGY_HARNESS_PATH = options.invalidPath;
  if (options.publicSocket) fs.chmodSync(socketPath, 0o666);
  let bootstrap = TARGET;
  if (options.shortDeadline) {
    bootstrap = path.join(directory, "deadline-bootstrap");
    execFileSync("/usr/bin/xcrun", ["clang", "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-DIO_TIMEOUT_MS=5000",
      path.join(ROOT, "resources/antigravity-mcp-timeout/harness-bootstrap.c"), "-o", bootstrap], { timeout: 30000, stdio: "pipe" });
  }
  const child = spawn(bootstrap, options.args || [], { cwd: directory, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0), stderr = ""; child.stdout.on("data", chunk => { stdout = Buffer.concat([stdout, chunk]); });
  child.stderr.on("data", chunk => { stderr += chunk; }); child.stdin.on("error", () => {});
  const ended = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const result = { child, ended, directory, get stdout() { return stdout; }, get stderr() { return stderr; },
    async connect() { await until(() => connection || child.exitCode !== null); assert.ok(connection, stderr); return { socket: connection, read: reader(connection) }; } };
  try { child.stdin.write("INPT"); await check(result); }
  finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    for (const socket of sockets) socket.destroy(); await Promise.race([ended, delay(3000)]);
    await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const [title, options] of [["invalid token", { token: "secret-not-a-token" }], ["relative executable", { invalidPath: "fixture" }],
  ["symlink executable", { symlink: true }], ["public control socket", { publicSocket: true }], ["unexpected arguments", { args: ["--inject"] }]]) {
  test(`bootstrap rejects ${title} before running the fixture`, async () => fixture(options, async f => {
    const result = await f.ended; assert.notEqual(result.code, 0); assert.equal(f.stdout.length, 0);
    assert.ok(!f.stderr.includes("secret-not-a-token") && !f.stderr.includes(f.directory));
  }));
}

test("handshake replaces only the first output frame and preserves PID, parent, stdin, stderr and environment", async () => fixture({}, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read());
  assert.deepEqual(Object.keys(hello).sort(), ["harnessPid", "relayPid", "token", "version"]);
  assert.equal(hello.version, 1); assert.equal(hello.token, TOKEN); assert.equal(hello.harnessPid, f.child.pid); assert.notEqual(hello.relayPid, f.child.pid);
  assert.deepEqual(await peer.read(), ORIGINAL); peer.socket.write(frame(PATCHED));
  await until(() => f.stdout.includes(Buffer.from("cleanEnv")));
  assert.deepEqual(f.stdout.subarray(0, 4 + PATCHED.length), frame(PATCHED));
  const info = JSON.parse(f.stdout.subarray(4 + PATCHED.length).toString().trim());
  assert.deepEqual(info, { pid: f.child.pid, ppid: process.pid, cleanEnv: true });
  f.child.stdin.end(); assert.deepEqual(await f.ended, { code: 0, signal: null });
  assert.equal(f.stderr, "fixture stderr\n"); await until(() => !alive(hello.relayPid));
}));

test("large stdout backpressure preserves every byte", async () => fixture({ mode: "bulk" }, async f => {
  const peer = await f.connect(); await peer.read(); await peer.read(); f.child.stdout.pause(); peer.socket.write(frame(PATCHED));
  await delay(100); f.child.stdout.resume(); await until(() => f.stdout.length >= 2 * 1024 * 1024 + 12);
  f.child.stdin.end(); assert.equal((await f.ended).code, 0);
  const tail = f.stdout.subarray(f.stdout.indexOf(Buffer.from("}\n")) + 2); assert.equal(tail.length, 2 * 1024 * 1024); assert.ok(tail.every(byte => byte === 113));
}));

for (const [title, reply] of [["oversize response", Buffer.from([1, 64, 0, 0])], ["zero response", Buffer.alloc(4)], ["unsolicited control data", Buffer.concat([frame(PATCHED), Buffer.from("x")])]]) {
  test(`bootstrap stops the harness on ${title}`, async () => fixture({}, async f => {
    const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read(); peer.socket.write(reply);
    await f.ended; await until(() => !alive(hello.relayPid)); assert.ok(!f.stderr.includes(TOKEN));
  }));
}

test("control disconnect kills the original harness and retires relay", async () => fixture({}, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read(); peer.socket.write(frame(PATCHED));
  await until(() => f.stdout.length > 12); peer.socket.destroy(); await f.ended; await until(() => !alive(hello.relayPid));
}));

test("harness death retires relay even if Host control stays connected", async () => fixture({}, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read(); peer.socket.write(frame(PATCHED));
  f.child.kill("SIGKILL"); await f.ended; await until(() => !alive(hello.relayPid));
}));

test("closing startup stdout does not kill a still-controlled harness", async () => fixture({ mode: "closed-output" }, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read(); peer.socket.write(frame(PATCHED));
  await until(() => f.stdout.includes(Buffer.from("cleanEnv"))); await delay(450);
  assert.ok(alive(f.child.pid), "a harness may close startup stdout and keep its WebSocket session running");
  assert.ok(alive(hello.relayPid), "Host must still control the relay after stdout EOF");
  peer.socket.destroy(); await f.ended; await until(() => !alive(hello.relayPid));
}));

for (const mode of ["oversize", "partial"]) test(`invalid ${mode} harness output is never published to SDK`, async () => fixture({ mode }, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await f.ended;
  assert.equal(f.stdout.length, 0); await until(() => !alive(hello.relayPid));
}));

test("control close during pending OutputConfig stops a stalled harness", async () => fixture({ mode: "no-output" }, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); peer.socket.destroy(); await f.ended; await until(() => !alive(hello.relayPid));
}));

test("bounded startup deadline stops a harness whose Host never replies", async () => fixture({ shortDeadline: true }, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read();
  await f.ended; assert.equal(f.stdout.length, 0); await until(() => !alive(hello.relayPid));
}));

test("bounded stdout write deadline stops a permanently stalled consumer", async () => fixture({ shortDeadline: true, mode: "bulk" }, async f => {
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read(); f.child.stdout.pause(); peer.socket.write(frame(PATCHED));
  await until(() => !alive(f.child.pid), 10000); f.child.stdout.resume(); await f.ended; await until(() => !alive(hello.relayPid));
}));

test("unchanged RuntimeMcpGateIssuer accepts the real exec identity chain and rejects the bootstrap relay", async () => fixture({}, async f => {
  const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
  const peer = await f.connect(); const hello = JSON.parse(await peer.read()); await peer.read();
  const paths = { trustedRoot: f.directory, stateDir: path.join(f.directory, "state"), runtimeDir: path.join(f.directory, "run"),
    mcpAuthPath: path.join(f.directory, "state/mcp-auth.json"), socketPath: path.join(f.directory, "run/service.sock") };
  // Deliberately use the production /bin/ps observers, without injected links
  // or identity functions. Only the test harness and test Node are ancestors.
  const issuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: fs.realpathSync(process.execPath), argsPrefix: [] },
    bootstrapPath: fs.realpathSync(__filename) }).open();
  try {
    const parentExecutable = fs.realpathSync(path.join(f.directory, "fixture"));
    const parent = issuer.getProcessLink(hello.harnessPid), relay = issuer.getProcessLink(hello.relayPid);
    assert.equal(parent.executable, parentExecutable); assert.equal(parent.ppid, process.pid);
    assert.equal(relay.executable, fs.realpathSync(TARGET)); assert.equal(relay.ppid, hello.harnessPid);
    const runtimeProfileId = "runtime-antigravity-bootstrap", runtimeAccountId = "runtime-account-fixture";
    const descriptor = issuer.createMcpServer({ runtimeProfileId, runtimeAccountId, parentExecutable,
      ancestorExecutable: fs.realpathSync(process.execPath), ancestorPid: process.pid,
      executionRunId: "isolated-bootstrap-gate-proof", assertExecutionCurrent: () => true });
    const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
    const input = { runtimeProfileId, runtimeAccountId, gatePath: env.SHOGGOTH_RUNTIME_MCP_GATE_FILE,
      nonce: env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE, parentPid: hello.harnessPid };
    assert.throws(() => issuer.consume({ ...input, parentPid: hello.relayPid }), { code: "RUNTIME_MCP_GATE_INVALID" },
      "the still-running bootstrap child must never substitute for the pinned harness");
    const receipt = issuer.consume(input);
    assert.equal(receipt.consumed, true); assert.equal(receipt.executionRunId, "isolated-bootstrap-gate-proof");
    assert.equal(receipt.assertExecutionCurrent(), true);
    assert.equal(fs.existsSync(input.gatePath), false, "gate consumption remains one-use");
    assert.throws(() => issuer.consume(input), { code: "RUNTIME_MCP_GATE_INVALID" });
    peer.socket.write(frame(PATCHED)); f.child.stdin.end(); assert.equal((await f.ended).code, 0);
    await until(() => !alive(hello.relayPid));
  } finally { issuer.close(); }
}));
