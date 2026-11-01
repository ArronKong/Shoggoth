"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeExecutableIdentity, executableFileStamp, executableInterpreter } = require("../app/agent-service/runtime-executable-identity");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-executable-identity-")));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const write = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value, { mode: 0o700 }); return target; };
  return { root, write };
}

test("same-path replacement and a restored mtime invalidate executable proof", async t => {
  const f = fixture(t), binary = f.write("binary", "first"), reader = new RuntimeExecutableIdentity();
  const first = reader.observe({ binaryPath: binary }), hash = await reader.capture(first);
  const stat = fs.statSync(binary);
  f.write("binary", "other"); fs.utimesSync(binary, stat.atime, stat.mtime);
  const second = reader.observe({ binaryPath: binary });
  assert.notEqual(first.stamp, second.stamp);
  assert.notEqual(hash.digest, (await reader.capture(second)).digest);
  assert.notEqual(executableFileStamp(binary), executableFileStamp(f.write("other", "first")));
});

test("symlink targets, interpreter and explicit bridge each participate in identity", async t => {
  const f = fixture(t), binary = f.write("version-a", "first"), other = f.write("version-b", "other");
  const link = path.join(f.root, "cli"); fs.symlinkSync(binary, link);
  const interpreter = f.write("interpreter", "node-1"), bridge = f.write("bridge.mjs", "export default 1");
  const reader = new RuntimeExecutableIdentity(), input = { binaryPath: link, interpreterPath: interpreter, extraPaths: [bridge] };
  let previous = reader.observe(input);
  for (const mutate of [() => { fs.unlinkSync(link); fs.symlinkSync(other, link); },
    () => f.write("interpreter", "node-2"), () => f.write("bridge.mjs", "export default 2")]) {
    mutate(); const current = reader.observe(input); assert.notEqual(current.stamp, previous.stamp); previous = current;
  }
  fs.unlinkSync(bridge);
  assert.throws(() => reader.observe(input), { code: "RUNTIME_IDENTITY_UNAVAILABLE" });
});

test("package upgrades and direct dependency entry changes are observed without recursive scans", async t => {
  const f = fixture(t), binary = f.write("node_modules/tool/bin/cli.js", "console.log(1)");
  f.write("node_modules/tool/package.json", JSON.stringify({ name: "tool", main: "dist/main.js", bin: "bin/cli.js", dependencies: { dep: "1" } }));
  f.write("node_modules/tool/dist/main.js", "main-1");
  f.write("node_modules/dep/package.json", JSON.stringify({ name: "dep", main: "index.js" }));
  f.write("node_modules/dep/index.js", "dep-1");
  const reader = new RuntimeExecutableIdentity(), input = { binaryPath: binary };
  const first = reader.observe(input);
  assert.equal(first.files.some(file => file.file.endsWith("dep/index.js")), true);
  f.write("node_modules/dep/index.js", "dep-2");
  const second = reader.observe(input); assert.notEqual(first.stamp, second.stamp);
  f.write("node_modules/tool/package.json", JSON.stringify({ name: "tool", main: "dist/new.js" }));
  f.write("node_modules/tool/dist/new.js", "main-2");
  const third = reader.observe(input);
  assert.equal(third.files.some(file => file.file.endsWith("dist/new.js")), true);
  assert.notEqual(second.stamp, third.stamp);
});

test("content hashing is shared and cached; changed files are never published as a stable proof", async t => {
  const f = fixture(t), binary = f.write("binary", "first");
  let reads = 0, mutate = false;
  const reader = new RuntimeExecutableIdentity({ fileSystem: { ...fs, createReadStream(file) {
    reads++; const stream = fs.createReadStream(file);
    if (mutate) stream.once("data", () => f.write("binary", "third"));
    return stream;
  } } });
  let observed = reader.observe({ binaryPath: binary });
  const [first, second] = await Promise.all([reader.capture(observed), reader.capture(observed)]);
  assert.equal(first, second); assert.equal(reads, 1);
  await reader.capture(observed); assert.equal(reads, 1);
  f.write("binary", "other"); observed = reader.observe({ binaryPath: binary }); mutate = true;
  await assert.rejects(reader.capture(observed), { code: "RUNTIME_IDENTITY_UNAVAILABLE" });
});

test("new optional dependencies and extensionless package entries invalidate previous proof", async t => {
  const f = fixture(t), binary = f.write("node_modules/tool/bin/cli.js", "cli");
  f.write("node_modules/tool/package.json", JSON.stringify({ name: "tool", main: "dist/main", optionalDependencies: { dep: "1" } }));
  f.write("node_modules/tool/dist/main.js", "main-1");
  const reader = new RuntimeExecutableIdentity(), input = { binaryPath: binary };
  const first = reader.observe(input); await reader.capture(first);
  assert.ok(first.files.some(file => file.file.endsWith("main.js") && file.real));
  f.write("node_modules/dep/package.json", JSON.stringify({ name: "dep", main: "index.js" }));
  f.write("node_modules/dep/index.js", "dep-1");
  const second = reader.observe(input); await reader.capture(second);
  assert.notEqual(first.stamp, second.stamp);
  assert.ok(second.files.some(file => file.file.endsWith("dep/index.js")));
});

test("shebang identity follows the interpreter actually selected by the spawn PATH", t => {
  const f = fixture(t), binary = f.write("cli", "#!/usr/bin/env node\nconsole.log(1)");
  const first = f.write("first/node", "first"), second = f.write("second/node", "second");
  const search = [path.dirname(first), path.dirname(second)].join(path.delimiter);
  assert.equal(executableInterpreter(binary, search), first);
  fs.unlinkSync(first);
  assert.equal(executableInterpreter(binary, search), second);
  assert.equal(executableInterpreter(f.write("native", "compiled"), search), null);
});

test("Darwin system Codex identity includes the native payload behind its npm launcher", t => {
  if (process.platform !== "darwin") return;
  const f = fixture(t), launcher = f.write("node_modules/@openai/codex/bin/codex.js", "#!/usr/bin/env node\n// official launcher fixture");
  f.write("node_modules/@openai/codex/package.json", JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
  const native = "node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex";
  f.write(native, "native-one");
  const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
  const account = require("../app/agent-service/runtime-account").DEFAULT_RUNTIME_ACCOUNTS
    .find(value => value.runtime === "codex" && value.kind === "native-user");
  const binding = { runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: account.id };
  const resolver = new RuntimeAccountResolver({ homedir: f.root, parentEnv: { PATH: path.dirname(process.execPath) } });
  const first = resolver.observeExecutable(binding, account, { binaryPath: launcher });
  assert.ok(first.files.some(value => value.file.endsWith(native)));
  f.write(native, "native-two");
  assert.notEqual(resolver.observeExecutable(binding, account, { binaryPath: launcher }).stamp, first.stamp);
});
