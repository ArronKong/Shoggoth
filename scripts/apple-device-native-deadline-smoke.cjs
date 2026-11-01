"use strict";

// One explicit ~31s low-CPU regression for the production 30s monotonic native
// deadline. A FIFO blocks the single libuv worker; the queued operation is invalid
// and cannot request authorization or read/write records even if this test fails.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const scratch = fs.mkdtempSync("/private/tmp/apple-native-deadline-");
try {
  const fifo = path.join(scratch, "worker.fifo");
  execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo], { timeout: 1000 });
  const source = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const addon = require(${JSON.stringify(path.join(__dirname, "../.vendor/apple-device/apple-device.node"))});
    const fifo = ${JSON.stringify(fifo)};
    fs.open(fifo, 'r', (error, fd) => { if (error) throw error; fs.closeSync(fd); });
    const started = performance.now();
    const pending = addon.invoke(JSON.stringify({operation:'fixture.invalid',params:{},requestId:'deadline-fixture'}));
    setTimeout(() => { const fd = fs.openSync(fifo, 'w'); fs.closeSync(fd); }, 31000);
    pending.then(raw => {
      const response = JSON.parse(raw);
      assert.equal(response.ok, false); assert.equal(response.error.code, 'APPLE_DEVICE_TIMEOUT');
      process.stdout.write(JSON.stringify({code:response.error.code,elapsedMs:Math.round(performance.now()-started)})+'\\n');
    }).catch(error => { process.stderr.write(String(error)); process.exitCode=1; });
  `;
  const output = execFileSync(process.execPath, ["-e", source], { env: { ...process.env, UV_THREADPOOL_SIZE: "1" }, encoding: "utf8", timeout: 35000, maxBuffer: 16384 });
  console.log(output.trim());
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
