#!/usr/bin/env node
"use strict";
// Generated helpers execute only in VM contexts with fake fs/Source.
// Stream-specific regressions use real node:stream; no production module executes.
// No Source Service, SDK, MCP process, auth reader, Provider or network starts.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto"), streams = require("node:stream");
const workerSource = fs.readFileSync(path.join(__dirname, "group-collaboration-live-worker.cjs"), "utf8");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const SOURCE = "/synthetic/source", SHORT = "/private/tmp/sgpm-mock-owned", LEGACY = "/private/tmp/sggroup-live-mock-owned";
const CANARY = "unknown-message-and-stack-must-never-escape";
const groupNames = ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"];
const toolDefinitions = [...groupNames, "unrelated_tool"].map(name => ({ name, description: "synthetic", inputSchema: { type: "object" } }));
const tests = [], test = (name, run) => tests.push({ name, run });
function fixture(root = SHORT) {
  const markerPath = path.join(root, ".owned-root.json"), marker = Buffer.from('{"kind":"synthetic-helper-root","source":"/synthetic/source"}\n');
  const files = new Map(), descriptors = new Map(), reads = [], writes = [], returnedKeys = [];
  let nextFd = 10, nextIno = 100;
  const add = (file, kind, bytes = Buffer.alloc(0), mode = kind === "directory" ? 0o40700 : 0o100600) => {
    const item = { kind, bytes: Buffer.from(bytes), dev: 1, ino: nextIno++, uid: 501, mode, nlink: 1, mtimeMs: 100, ctimeMs: 100 };
    files.set(file, item); return item;
  };
  add(root, "directory"); add(SOURCE, "directory", Buffer.alloc(0), 0o40755); add(markerPath, "file", marker); add(path.join(root, "mcp-key.bin"), "file", Buffer.alloc(32, 7));
  const stat = item => ({ ...item, size: item.bytes.length, isDirectory: () => item.kind === "directory", isFile: () => item.kind === "file", isSymbolicLink: () => item.kind === "symlink" });
  const get = file => { const item = files.get(file); if (!item) throw Object.assign(new Error(CANARY), { code: "ENOENT" }); return item; };
  const state = { files, reads, writes, returnedKeys, markerPath, root, sourceRequires: [], stderr: [], stdout: [], inputFrames: [], starts: [], bootstrapCalls: [], hook: null };
  const fakeFs = {
    constants: fs.constants,
    lstatSync(file) { state.hook?.("lstat", file); return stat(get(file)); },
    realpathSync(file) { state.hook?.("realpath", file); return get(file).realpath || file; },
    openSync(file, flags) {
      state.hook?.("open", file); const item = get(file);
      assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
      if (item.kind === "symlink") throw Object.assign(new Error(CANARY), { code: "ELOOP" });
      const fd = nextFd++; descriptors.set(fd, { file, item }); return fd;
    },
    fstatSync(fd) { const entry = descriptors.get(fd); assert(entry); state.hook?.("fstat", entry.file); return stat(entry.item); },
    readFileSync(fd) {
      const entry = descriptors.get(fd); assert(entry, "all marker/key reads must use a verified descriptor");
      state.hook?.("read", entry.file); reads.push(entry.file); const bytes = Buffer.from(entry.item.bytes);
      if (entry.file === path.join(root, "mcp-key.bin")) returnedKeys.push(bytes);
      return bytes;
    },
    closeSync(fd) { const entry = descriptors.get(fd); assert(entry); descriptors.delete(fd); state.hook?.("close", entry.file); },
    writeFileSync(file, text, options) { assert.equal(options.flag, "wx"); assert(!files.has(file)); add(file, "file", text); writes.push(file); },
    appendFileSync(file, text) { state.hook?.("append", file); const item = files.get(file) || add(file, "file"); item.bytes = Buffer.concat([item.bytes, Buffer.from(text)]); writes.push(file); },
  };
  const fakeOs = { homedir: () => "/synthetic/user", userInfo: () => ({ uid: 501, homedir: "/synthetic/user" }) };
  const workerModule = { exports: {} }, workerRequire = name => {
    if (name === "node:fs") return fakeFs;
    if (name === "node:path") return path;
    if (name === "node:os") return fakeOs;
    if (name === "node:crypto") return crypto;
    if (name === "node:child_process") return { execFileSync() { throw Error("unexpected child process"); } };
    if (name === "./group-collaboration-live-codes.cjs") return { diagnosticCode: () => ({ errorCode: "GROUP_LIVE_HELPER_FAILED" }) };
    throw Error("unexpected worker import " + name);
  };
  const workerContext = vm.createContext({ require: workerRequire, module: workerModule, __dirname: "/synthetic/scripts", Buffer,
    process: { getuid: () => 501, env: {} } });
  new vm.Script(workerSource, { filename: "worker-under-test.cjs" }).runInContext(workerContext);
  const ownership = { root, sourceRepo: SOURCE, markerPath, markerSha256: sha(marker) };
  state.generate = (value = ownership) => {
    workerContext.suppliedOwnership = value;
    return vm.runInContext(`module.exports.writeHelper(${JSON.stringify(root)},${JSON.stringify(SOURCE)},suppliedOwnership)`, workerContext);
  };
  state.ownership = ownership;
  state.generatedText = () => files.get(path.join(root, "group-mcp-bootstrap.cjs")).bytes.toString();
  state.run = async ({ gate = true, onStart = () => {}, onBootstrap = () => {}, sourceError = null, builtinError = null, tools = toolDefinitions, realStreams = false } = {}) => {
    class FakeTransform {
      constructor(options) { this.options = options; this.destination = null; this.listeners = new Map(); }
      on(event, listener) { this.listeners.set(event, listener); return this; }
      pipe(destination) { this.destination = destination; return destination; }
      destroy() { this.destroyed = true; return this; }
      write(chunk) { this.options.transform.call(this, Buffer.from(chunk), "utf8", (error, output) => { if (error) { this.listeners.get("error")?.(error); return; } if (output?.length) this.destination?.write(output); }); return true; }
    }
    const start = async (options, route) => {
      state.starts.push(route); state.streams = options;
      options.input.pipe(realStreams ? new streams.Writable({ write(bytes, encoding, done) { state.inputFrames.push(Buffer.from(bytes)); done(); } }) : { write: bytes => state.inputFrames.push(String(bytes)) });
      await onStart(options); return undefined;
    };
    const processStub = { getuid: () => 501, argv: ["/synthetic/node", path.join(root, "group-mcp-bootstrap.cjs"), "--shoggoth-internal-role=mcp", "--shoggoth-runtime-profile=synthetic", "--shoggoth-runtime-account=synthetic"],
      env: gate ? { SHOGGOTH_RUNTIME_MCP_GATE_FILE: "/synthetic/gate" } : {}, exitCode: 0,
      stdin: { pipe: input => input }, stdout: { write: bytes => { state.stdout.push(String(bytes)); return true; } }, stderr: { write: bytes => { state.stderr.push(String(bytes)); return true; } } };
    if (realStreams) {
      processStub.stdin = new streams.PassThrough();
      processStub.stdout = new streams.Writable({ write(bytes, encoding, done) { state.stdout.push(Buffer.from(bytes)); done(); } });
    }
    state.process = processStub;
    const runtimeRequire = name => {
      if (builtinError && name === "node:fs") throw builtinError;
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return path;
      if (name === "node:crypto") return crypto;
      if (name === "node:stream") return realStreams ? streams : { Transform: FakeTransform };
      if (name === "node:os") return fakeOs;
      state.sourceRequires.push(name);
      if (sourceError) throw sourceError;
      if (name === SOURCE + "/app/agent-service/paths") return { resolveServicePaths: ({ homeDir }) => ({ homeDir }) };
      if (name === SOURCE + "/app/shoggoth-mcp-helper") return { startShoggothMcpHelper: options => start(options, "standalone") };
      if (name === SOURCE + "/app/agent-service/mcp-product-tool-controller") return { DEFAULT_TOOL_REGISTRY: { mcpDefinitions: () => tools } };
      if (name === SOURCE + "/app/bootstrap-role") return { main: async (argv, env, runtime, loaders) => {
        state.bootstrapCalls.push({ argv, env, runtime }); await onBootstrap(); return loaders.runtimeMcpRelay({ syntheticBridge: true, socket: { destroy() { state.bridgeDestroyed = true; } } });
      } };
      if (name === SOURCE + "/app/runtime-mcp-relay") return { startRuntimeMcpRelay: options => start(options, "relay") };
      throw Error("unexpected Source import " + name);
    };
    const runtimeContext = vm.createContext({ require: runtimeRequire, Buffer, process: processStub });
    state.runCompletion = new vm.Script(state.generatedText(), { filename: "generated-helper-under-test.cjs" }).runInContext(runtimeContext);
    await state.runCompletion;
    return state;
  };
  state.failure = () => { assert.equal(state.stderr.length, 1); assert.equal(state.stderr[0].endsWith("\n"), true); return JSON.parse(state.stderr[0]); };
  state.noKeyOrSource = () => { assert.equal(returnedKeys.length, 0); assert.equal(state.sourceRequires.length, 0); };
  state.keyCleared = () => { assert(returnedKeys.length > 0); assert(returnedKeys.every(bytes => bytes.every(value => value === 0))); };
  return state;
}
test("nonlegacy root requires explicit exact root, source and marker before generation", () => {
  for (const value of [null, {}, { root: SHORT, sourceRepo: SOURCE, markerPath: SHORT + "/.owned-root.json", markerSha256: "0".repeat(64) },
    { root: SHORT, sourceRepo: "/synthetic/other", markerPath: SHORT + "/.owned-root.json", markerSha256: "0".repeat(64) }]) {
    const state = fixture(); assert.throws(() => state.generate(value)); assert.equal(state.writes.length, 0); state.noKeyOrSource();
  }
});
test("explicit marker cannot authorize a personal Home or a nested temporary root", () => {
  for (const root of ["/synthetic/personal-home", "/private/tmp/nested/owned"]) {
    const state = fixture(root); assert.throws(() => state.generate(), error => error.code === "GROUP_LIVE_HELPER_ROOT_INVALID");
    assert.equal(state.writes.length, 0); state.noKeyOrSource();
  }
});
test("valid exact short root retains production bootstrap and relay route with no parent overrides", async () => {
  const state = fixture(); state.generate(); await state.run(); assert.deepEqual(state.starts, ["relay"]); assert.equal(state.stderr.length, 0);
  assert.equal(state.bootstrapCalls.length, 1); const call = state.bootstrapCalls[0];
  assert.deepEqual(Object.keys(call.runtime), ["userInfo"]); assert.equal(call.runtime.userInfo().homedir, SHORT);
  assert(call.argv.includes("--shoggoth-internal-role=mcp")); assert.equal(call.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, "/synthetic/gate");
  state.keyCleared();
});
test("legacy private root needs no new marker argument and retains standalone route", async () => {
  const state = fixture(LEGACY); state.files.delete(state.markerPath); state.generate(null); await state.run({ gate: false });
  assert.deepEqual(state.starts, ["standalone"]); assert.equal(state.stderr.length, 0); state.keyCleared();
});
for (const [name, mutate] of [
  ["root inode replaced", s => { s.files.get(s.root).ino++; }],
  ["root device changed", s => { s.files.get(s.root).dev++; }],
  ["root symlink", s => { s.files.get(s.root).kind = "symlink"; }],
  ["root canonical path changed", s => { s.files.get(s.root).realpath = "/synthetic/elsewhere"; }],
  ["root permissions widened", s => { s.files.get(s.root).mode = 0o40755; }],
  ["root owner changed", s => { s.files.get(s.root).uid = 502; }],
  ["marker missing", s => { s.files.delete(s.markerPath); }],
  ["marker bytes changed", s => { s.files.get(s.markerPath).bytes = Buffer.from("wrong"); }],
  ["marker symlink", s => { s.files.get(s.markerPath).kind = "symlink"; }],
  ["marker hardlink", s => { s.files.get(s.markerPath).nlink = 2; }],
  ["marker permissions widened", s => { s.files.get(s.markerPath).mode = 0o100644; }],
  ["marker owner changed", s => { s.files.get(s.markerPath).uid = 502; }],
]) test(name + " rejects before key read and Source import", async () => {
  const state = fixture(); state.generate(); mutate(state); await state.run(); state.noKeyOrSource();
  assert.equal(state.process.exitCode, 1); assert.equal(state.failure().phase, "root");
  assert(!state.stderr.join("").includes(CANARY)); assert.equal(state.starts.length, 0);
});
test("root replaced during stable marker read rejects before key and Source", async () => {
  const state = fixture(); state.generate(); let changed = false;
  state.hook = (operation, file) => { if (!changed && operation === "read" && file === state.markerPath) { state.files.get(state.root).ino++; changed = true; } };
  await state.run(); state.noKeyOrSource(); assert.equal(state.failure().errorCode, "GROUP_LIVE_HELPER_ROOT_CHANGED");
});
test("marker replaced between open and read rejects before key and Source", async () => {
  const state = fixture(); state.generate(); let changed = false;
  state.hook = (operation, file) => { if (!changed && operation === "read" && file === state.markerPath) { state.files.set(file, { ...state.files.get(file), ino: 999 }); changed = true; } };
  await state.run(); state.noKeyOrSource(); assert.equal(state.failure().errorCode, "GROUP_LIVE_HELPER_MARKER_INVALID");
});
test("key validation and close failure are caught and every returned key buffer is cleared", async () => {
  const invalid = fixture(); invalid.generate(); invalid.files.get(path.join(SHORT, "mcp-key.bin")).kind = "symlink";
  await invalid.run(); invalid.noKeyOrSource(); assert.deepEqual(invalid.failure(), { phase: "key", errorCode: "GROUP_LIVE_HELPER_KEY_INVALID" });
  const closing = fixture(); closing.generate(); closing.hook = (operation, file) => { if (operation === "close" && file.endsWith("mcp-key.bin")) throw new Error(CANARY); };
  await closing.run(); closing.keyCleared(); assert.equal(closing.sourceRequires.length, 0); assert.deepEqual(closing.failure(), { phase: "key", errorCode: "GROUP_LIVE_HELPER_FAILED" });
});
test("initial require and Source require failures use only fixed phase/code and never message/stack", async () => {
  for (const at of ["builtinError", "sourceError"]) {
    const state = fixture(); state.generate(); let getterTouched = false; const error = new Error(CANARY);
    Object.defineProperty(error, "code", { get() { getterTouched = true; throw new Error(CANARY); } });
    await state.run({ [at]: error }); assert.equal(getterTouched, false);
    assert.deepEqual(state.failure(), { phase: at === "builtinError" ? "builtins" : "source", errorCode: "GROUP_LIVE_HELPER_FAILED" });
    const recorded = state.files.get(path.join(SHORT, "helper-observations.jsonl"))?.bytes.toString() || "";
    assert(!state.stderr.join("").includes(CANARY)); assert(!recorded.includes(CANARY));
    if (at === "sourceError") state.keyCleared(); else state.noKeyOrSource();
  }
});
test("known startup failure is bounded to one fixed code/phase and key clears", async () => {
  const state = fixture(); state.generate(); await state.run({ onStart() { throw Object.assign(new Error(CANARY), { code: "BOOTSTRAP_ROLE_REJECTED" }); } });
  assert.deepEqual(state.failure(), { phase: "start", errorCode: "BOOTSTRAP_ROLE_REJECTED" }); state.keyCleared();
  const rows = state.files.get(path.join(SHORT, "helper-observations.jsonl")).bytes.toString().trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter(row => row.method === "helper.failure").length, 1); assert(!JSON.stringify(rows).includes(CANARY));
});
for (const code of ["MCP_HELPER_SERVICE_UNAVAILABLE", "MCP_HELPER_SERVICE_RECOVERY_REQUIRED"]) test("existing public " + code + " survives the safe catch", async () => {
  const state = fixture(); state.generate(); await state.run({ sourceError: Object.assign(new Error(CANARY), { code }) });
  assert.deepEqual(state.failure(), { phase: "source", errorCode: code }); state.keyCleared();
});
test("ownership loss during streaming blocks both directions, latches once and clears the key", async () => {
  const state = fixture(); state.generate();
  await state.run({ onStart(options) {
    state.files.get(state.root).ino++;
    options.input.write('{"id":1,"method":"tools/list"}\n');
    options.input.write('{"id":2,"method":"tools/list"}\n');
    options.output.write('{"id":1,"result":{}}\n');
  } });
  assert.equal(state.inputFrames.length, 0); assert.equal(state.stdout.length, 0);
  assert.deepEqual(state.failure(), { phase: "root", errorCode: "GROUP_LIVE_HELPER_ROOT_CHANGED" }); state.keyCleared();
});
test("ownership loss inside recording cannot hide in JSON parse tolerance and forward a frame", async () => {
  const state = fixture(); state.generate(); let rootChecks = 0;
  await state.run({ onStart(options) {
    state.hook = (operation, file) => { if (operation === "lstat" && file === state.root && ++rootChecks === 3) state.files.get(state.root).ino++; };
    options.input.write('{"id":1,"method":"tools/list"}\n');
  } });
  assert.equal(state.inputFrames.length, 0); assert.equal(state.stdout.length, 0);
  assert.equal(state.failure().errorCode, "GROUP_LIVE_HELPER_ROOT_CHANGED"); state.keyCleared();
});
test("LF framing, split chunks and noninventory JSONL remain transparent; inventory only filters tool names", async () => {
  const state = fixture(); state.generate(); const request = '{ "id": 1, "method": "tools/list", "params": {} }\n';
  const noninventory = '{ "id": 2, "result": { "text": "synthetic unchanged" } }\n';
  await state.run({ onStart(options) {
    options.input.write(request.slice(0, 13)); assert.equal(state.inputFrames.length, 0); options.input.write(request.slice(13));
    options.output.write(JSON.stringify({ id: 1, result: { tools: toolDefinitions } }) + "\n"); options.output.write(noninventory);
  } });
  assert.equal(state.inputFrames.join(""), request); assert.equal(state.stdout[1], noninventory);
  const inventory = JSON.parse(state.stdout[0]); assert.deepEqual(inventory.result.tools, toolDefinitions.filter(tool => groupNames.includes(tool.name)));
  const observations = state.files.get(path.join(SHORT, "helper-observations.jsonl")).bytes.toString();
  assert(observations.endsWith("\n")); const rows = observations.trim().split("\n").map(JSON.parse);
  assert(rows.some(row => row.catalogFilter === "transparent-response-inventory-group-tools-only;definitions-preserved"));
  assert.equal(state.stderr.length, 0); state.keyCleared();
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("pure VM helper did not settle after failure")), 1000); })]); }
  finally { clearTimeout(timer); }
}
test("real streams catch ownership loss while bootstrap is pending before Source listeners exist", async () => {
  const state = fixture(); state.generate(); let releaseBootstrap;
  const bootstrapGate = new Promise(resolve => { releaseBootstrap = resolve; });
  const running = state.run({ realStreams: true, onBootstrap: () => bootstrapGate });
  await nextTurn(); assert.equal(state.starts.length, 0);
  state.files.get(state.root).ino++;
  state.process.stdin.write(Buffer.from('{"id":1,"method":"tools/list"}\n'));
  await bounded(running); await nextTurn();
  assert.deepEqual(state.failure(), { phase: "root", errorCode: "GROUP_LIVE_HELPER_ROOT_CHANGED" });
  assert.equal(state.inputFrames.length, 0); assert.equal(state.stdout.length, 0); state.keyCleared();
  releaseBootstrap(); await nextTurn();
  assert.equal(state.bridgeDestroyed, true); assert.equal(state.starts.length, 0); assert.equal(state.stderr.length, 1);
});
test("real streams settle a pending Source on later root loss and consume its later rejection", async () => {
  const state = fixture(); state.generate(); let rejectSource;
  const sourceGate = new Promise((resolve, reject) => { rejectSource = reject; });
  const running = state.run({ realStreams: true, onStart: () => sourceGate });
  await nextTurn(); assert.deepEqual(state.starts, ["relay"]);
  const first = Buffer.from('{ "id": 1, "method": "tools/list" }\n');
  state.process.stdin.write(first); await nextTurn(); assert.deepEqual(Buffer.concat(state.inputFrames), first);
  state.files.get(state.root).ino++;
  state.process.stdin.write(Buffer.from('{"id":2,"method":"tools/list"}\n'));
  state.streams.output.write(Buffer.from('{"id":2,"result":{}}\n'));
  await bounded(running); await nextTurn();
  assert.deepEqual(Buffer.concat(state.inputFrames), first); assert.equal(state.stdout.length, 0);
  assert.deepEqual(state.failure(), { phase: "root", errorCode: "GROUP_LIVE_HELPER_ROOT_CHANGED" });
  assert.equal(state.streams.input.destroyed, true); assert.equal(state.streams.output.destroyed, true); state.keyCleared();
  rejectSource(new Error(CANARY)); await nextTurn(); assert.equal(state.stderr.length, 1); assert(!state.stderr.join("").includes(CANARY));
});
test("real streams retain the failure listener after Source completes", async () => {
  const state = fixture(); state.generate(); await state.run({ realStreams: true });
  state.files.get(state.root).ino++;
  state.streams.output.write(Buffer.from('{"id":1,"result":{}}\n'));
  await nextTurn();
  assert.deepEqual(state.failure(), { phase: "root", errorCode: "GROUP_LIVE_HELPER_ROOT_CHANGED" });
  assert.equal(state.stdout.length, 0); assert.equal(state.streams.input.destroyed, true); assert.equal(state.streams.output.destroyed, true); state.keyCleared();
});
test("real streams preserve Chinese and emoji JSONL bytes at every split in both directions", async () => {
  const state = fixture(); state.generate();
  const request = Buffer.from(' { "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "group_collaborate", "arguments": { "summary": "合成中文测试🧪🙂" } } }\n');
  const response = Buffer.from('{ "id": 9, "result": { "summary": "合成中文测试🧪🙂" } }\n\n');
  const expectedInput = [], expectedOutput = [];
  await state.run({ realStreams: true, async onStart(options) {
    for (const [target, payload, expected] of [[options.input, request, expectedInput], [options.output, response, expectedOutput]]) {
      for (let index = 1; index < payload.length; index++) {
        target.write(payload.subarray(0, index)); target.write(payload.subarray(index)); expected.push(payload);
      }
      for (let index = 0; index < payload.length; index++) target.write(payload.subarray(index, index + 1));
      expected.push(payload);
      target.write(Buffer.concat([payload, payload])); expected.push(payload, payload);
    }
    await nextTurn();
  } });
  assert.deepEqual(Buffer.concat(state.inputFrames), Buffer.concat(expectedInput));
  assert.deepEqual(Buffer.concat(state.stdout), Buffer.concat(expectedOutput));
  assert.equal(state.stderr.length, 0); state.keyCleared();
});
test("real stream inventory filtering preserves Unicode definitions and only removes other tools", async () => {
  const state = fixture(); state.generate();
  const inventoryTools = toolDefinitions.map(tool => ({ ...tool, description: "中文工具🧪" }));
  await state.run({ realStreams: true, async onStart(options) {
    options.input.write(Buffer.from('{"id":1,"method":"tools/list"}\n'));
    const bytes = Buffer.from(JSON.stringify({ id: 1, result: { tools: inventoryTools } }) + "\n");
    for (let index = 0; index < bytes.length; index++) options.output.write(bytes.subarray(index, index + 1));
    await nextTurn();
  } });
  assert.deepEqual(JSON.parse(Buffer.concat(state.stdout).toString()).result.tools, inventoryTools.filter(tool => groupNames.includes(tool.name)));
  assert.equal(state.stderr.length, 0); state.keyCleared();
});

async function main() {
  for (const { name, run } of tests) { await run(); process.stdout.write("PASS " + name + "\n"); }
  process.stdout.write(JSON.stringify({ passed: tests.length, failed: 0, realSourceSdkMcpAuthProviderExecutions: 0, originalPersonalReads: 0 }) + "\n");
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
