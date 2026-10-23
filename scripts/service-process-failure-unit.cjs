"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { installServiceProcessFailureHandler } = require("../app/agent-service/process-failure-handler");
const { recordServiceProcessFailure } = require("../app/bootstrap-diagnostics");

const probeIndex = process.argv.indexOf("--service-fatal-probe");
if (probeIndex >= 0) {
  const [root, mode] = process.argv.slice(probeIndex + 1);
  const { app, dialog } = require("electron");
  app.setPath("userData", path.join(root, "electron"));
  dialog.showErrorBox = () => {
    fs.writeFileSync(path.join(root, "modal-opened"), "true");
    app.exit(72);
  };
  if (mode !== "baseline") installServiceProcessFailureHandler({
    paths: { runtimeDir: path.join(root, "run"), trustedRoot: root },
  });
  app.whenReady().then(() => setImmediate(() => {
    const error = Object.assign(new Error("PRIVATE_PROMPT PRIVATE_TOKEN"), { code: "EPIPE" });
    if (mode === "rejection") void Promise.reject(error);
    else throw error;
  }));
} else {
  const { test } = require("node:test");
  const fixture = (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-service-failure-")));
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, paths: { runtimeDir: path.join(root, "run"), trustedRoot: root } };
  };

  test("fatal failure records once and exits even when the diagnostic writer throws", () => {
    const emitter = new EventEmitter();
    const exits = [];
    let writes = 0;
    const detach = installServiceProcessFailureHandler({ emitter, exit: (code) => exits.push(code),
      record: () => { writes++; throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } });
    emitter.emit("uncaughtException", new Error("failure"));
    emitter.emit("unhandledRejection", new Error("duplicate"));
    assert.equal(writes, 1);
    assert.deepEqual(exits, [1]);
    detach();
    assert.equal(emitter.listenerCount("uncaughtException"), 0);
    assert.equal(emitter.listenerCount("unhandledRejection"), 0);
  });

  test("Service installs fatal handlers before ready and removes them on failed startup", async (t) => {
    const f = fixture(t);
    const emitter = new EventEmitter();
    const paths = require("../app/agent-service/paths").resolveServicePaths({
      stateRoot: path.join(f.root, "state"), cacheRoot: path.join(f.root, "cache"),
    });
    await assert.rejects(require("../app/agent-service").startAgentServiceProcess({
      paths, signalEmitter: emitter, electronApp: {
        setPath() {}, setActivationPolicy() {},
        async whenReady() {
          assert.equal(emitter.listenerCount("uncaughtException"), 1);
          assert.equal(emitter.listenerCount("unhandledRejection"), 1);
          throw new Error("fixture startup failure");
        },
      },
    }), /fixture startup failure/u);
    assert.equal(emitter.listenerCount("uncaughtException"), 0);
    assert.equal(emitter.listenerCount("unhandledRejection"), 0);
  });

  test("running Service owns fatal handlers until its actual stop completes", async (t) => {
    const f = fixture(t);
    const emitter = new EventEmitter();
    const paths = require("../app/agent-service/paths").resolveServicePaths({
      stateRoot: path.join(f.root, "state"), cacheRoot: path.join(f.root, "cache"),
    });
    const service = await require("../app/agent-service").startAgentServiceProcess({
      paths, signalEmitter: emitter, builtinCliProfiles: false, version: "failure-handler-fixture",
    });
    try {
      assert.equal(emitter.listenerCount("uncaughtException"), 1);
      assert.equal(emitter.listenerCount("unhandledRejection"), 1);
    } finally {
      await service.stop({ notify: false });
    }
    assert.equal(emitter.listenerCount("uncaughtException"), 0);
    assert.equal(emitter.listenerCount("unhandledRejection"), 0);
  });

  test("runtime failure journal is private, bounded and excludes error text", (t) => {
    const f = fixture(t);
    const error = Object.assign(new Error("PRIVATE_PROMPT PRIVATE_TOKEN"), { code: "EPIPE" });
    error.stack = `Error: PRIVATE_PROMPT\n    at fn (${path.resolve(__dirname, "../app/agent-service.js")}:72:7)`;
    for (let i = 0; i < 20; i++) assert.equal(recordServiceProcessFailure(error, {
      paths: f.paths, origin: "uncaughtException",
    }), true);
    const target = path.join(f.paths.runtimeDir, "service-process-failures.json");
    const body = fs.readFileSync(target, "utf8");
    const records = JSON.parse(body).records;
    assert.equal(records.length, 8);
    assert.equal(records[0].errors[0].code, "EPIPE");
    assert.deepEqual(records[0].errors[0].locations, [{ file: "agent-service.js", line: 72, column: 7 }]);
    assert.doesNotMatch(body, /PRIVATE_|\/Users\//u);
    assert.ok(Buffer.byteLength(body) < 16 * 1024);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(recordServiceProcessFailure("private rejection", { paths: f.paths, origin: "unhandledRejection" }), true);
    const last = JSON.parse(fs.readFileSync(target, "utf8")).records.at(-1);
    assert.equal(last.errors[0].code, "UNKNOWN_RUNTIME_ERROR");
    assert.equal(recordServiceProcessFailure(error, { paths: f.paths, origin: "PRIVATE_TOKEN" }), false);
  });

  test("runtime failure journal refuses a symlink target", (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.paths.runtimeDir, { mode: 0o700 });
    const retained = path.join(f.root, "retained");
    fs.writeFileSync(retained, "retained");
    fs.symlinkSync(retained, path.join(f.paths.runtimeDir, "service-process-failures.json"));
    assert.equal(recordServiceProcessFailure(new Error("private"), {
      paths: f.paths, origin: "uncaughtException",
    }), false);
    assert.equal(fs.readFileSync(retained, "utf8"), "retained");
  });

  test("real Electron suppresses its default modal and exits on both fatal origins", (t) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const mode of ["baseline", "exception", "rejection"]) {
      const f = fixture(t);
      const child = spawnSync(require("electron"), [__filename, "--service-fatal-probe", f.root, mode], {
        env, timeout: 15_000, encoding: "utf8",
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.status, mode === "baseline" ? 72 : 1, child.stderr);
      assert.equal(fs.existsSync(path.join(f.root, "modal-opened")), mode === "baseline");
      if (mode !== "baseline") {
        const body = fs.readFileSync(path.join(f.paths.runtimeDir, "service-process-failures.json"), "utf8");
        const record = JSON.parse(body).records[0];
        assert.equal(record.origin, mode === "rejection" ? "unhandledRejection" : "uncaughtException");
        assert.equal(record.errors[0].code, "EPIPE");
        assert.doesNotMatch(body, /PRIVATE_/u);
      }
    }
  });
}
