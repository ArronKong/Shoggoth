"use strict";
// Execute unchanged adapter transport source against a private Unix-socket fixture.
// Only OS home resolution is replaced, so production credentials and Service stay untouched.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net"), vm = require("node:vm");
const { spawn } = require("node:child_process");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const repo = path.resolve(__dirname, "..");
const child = (command, args, options) => new Promise((resolve, reject) => {
  const p = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
  p.stdout.on("data", b => out += b); p.stderr.on("data", b => err += b); p.once("error", reject);
  p.once("exit", code => code === 0 ? resolve(out) : reject(Error(`${command}: ${code}: ${err}`)));
});
for (const backend of ["hermes", "openclaw"]) test(`${backend} sends the current Service wire version and preserves mismatch errors`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adapter-wire-")));
  const run = path.join(root, "Library/Application Support/Shoggoth/run"); fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const socketPath = path.join(run, "service.sock"), requests = [];
  const server = net.createServer(socket => { let text = ""; socket.on("data", b => {
    text += b; if (!text.endsWith("\n")) return; const req = JSON.parse(text); requests.push(req);
    socket.end(JSON.stringify(req.version !== SERVICE_PROTOCOL_VERSION || req.method === "fixture.mismatch"
      ? { id: req.id, ok: false, error: { code: "PROTOCOL_VERSION_MISMATCH" } }
      : { id: req.id, ok: true, result: { registered: true } }) + "\n");
  }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); fs.chmodSync(socketPath, 0o600);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  if (backend === "hermes") {
    const py = `import importlib.util,json,pwd,types,sys\nsys.dont_write_bytecode=True\npwd.getpwuid=lambda uid:types.SimpleNamespace(pw_dir=${JSON.stringify(root)})\nspec=importlib.util.spec_from_file_location('wire_transport',${JSON.stringify(path.join(repo, 'resources/external-plugin-adapters/hermes/transport.py'))})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nassert m.request_service('group.adapter.register',{'fixture':True})=={'registered':True}\ntry:\n m.request_service('fixture.mismatch',{})\n raise AssertionError('mismatch accepted')\nexcept m.ServiceError as e:\n assert e.code=='PROTOCOL_VERSION_MISMATCH'\nprint('ok')`;
    assert.equal((await child("python3", ["-c", py], { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } })).trim(), "ok");
  } else {
    const source = fs.readFileSync(path.join(repo, "resources/external-plugin-adapters/openclaw/transport.mjs"), "utf8");
    const context = vm.createContext({ process: { getuid: process.getuid, env: {}, argv: [] }, Buffer, setTimeout, clearTimeout, Error });
    const mod = new vm.SourceTextModule(source, { context });
    await mod.link(async name => { const value = name === "node:os" ? { userInfo: () => ({ homedir: root }) } : require(name);
      const dependency = new vm.SyntheticModule(["default"], function() { this.setExport("default", value); }, { context }); return dependency; });
    await mod.evaluate(); assert.equal(JSON.stringify(await mod.namespace.request("group.adapter.register", { fixture: true })), '{"registered":true}');
    await assert.rejects(mod.namespace.request("fixture.mismatch", {}), { code: "PROTOCOL_VERSION_MISMATCH" });
  }
  assert.equal(requests.length, 2); assert.ok(requests.every(req => req.version === SERVICE_PROTOCOL_VERSION));
});

test("registration and release checks reject protocol drift in either packaged adapter", () => {
  const { assertAdapterProtocol, checkAdapterProtocols } = require("../app/external-plugin-adapter-protocol");
  const resources = path.join(repo, "resources/external-plugin-adapters");
  assert.deepEqual(checkAdapterProtocols(resources), []);
  for (const backend of ["hermes", "openclaw"]) {
    const source = fs.readFileSync(path.join(resources, backend, backend === "hermes" ? "transport.py" : "transport.mjs"), "utf8");
    assert.throws(() => assertAdapterProtocol(backend, source.replace(/VERSION = \d+/, `VERSION = ${SERVICE_PROTOCOL_VERSION - 1}`)), /Service protocol differs/);
  }
});
