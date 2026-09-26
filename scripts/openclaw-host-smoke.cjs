"use strict";
// S2 openclaw-host 检测 smoke(本机有 openclaw+网关在跑的前提下断言正向;
// 负向用 paths 注入沙箱)。POST start 不在此跑(动 launchd)。
// Run: node scripts/openclaw-host-smoke.cjs
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectOpenclawHost, createOpenclawHostController } = require("../app/openclaw-host");

let failed = false;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok  ${name}`); }
  catch (e) { failed = true; console.error(`FAIL ${name}: ${e?.message || e}`); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oh-smoke-"));

(async () => {
  await check("生产 host controller 如实声明 supervisor drain/paused restart 不支持", async () => {
    assert.strictEqual(typeof createOpenclawHostController, "function");
    const controller = createOpenclawHostController();
    assert.strictEqual(controller.topology, "local");
    assert.deepStrictEqual(controller.capabilities, {
      drain: false,
      recoverDrain: false,
      restartPaused: false,
      waitHealthy: false,
    });
    await assert.rejects(
      controller.acquireDrain({ operationId: "smoke-no-write" }),
      (error) => error?.code === "runtime_drain_unsupported",
    );
    await assert.rejects(
      controller.restartPaused({ token: "never" }),
      (error) => error?.code === "runtime_restart_unavailable",
    );
  });
  await check("本机正向:bin/version/config/identity/token 全在,网关 18792 在跑", async () => {
    const h = await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:18792" });
    assert.strictEqual(typeof h.binPath, "string");
    assert.match(h.version || "", /\d{4}\.\d+\.\d+/);
    assert.strictEqual(h.gatewayRunning, true);
    assert.strictEqual(h.configExists, true);
    assert.strictEqual(h.identityExists, true);
    assert.strictEqual(h.localTokenReadable, true);
    // R125:status 探出的本机网关真实地址(端口随版本/配置变,不能猜默认值)
    assert.strictEqual(h.localGatewayUrl, "ws://127.0.0.1:18792");
    assert.strictEqual(h.localGatewayRunning, true);
  });
  await check("死端口 → gatewayRunning=false(其余不受影响)", async () => {
    const h = await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:1" });
    assert.strictEqual(h.gatewayRunning, false);
  });
  await check("paths 沙箱:config/identity 缺失 → 对应布尔 false;bin 注入不存在 → binPath null", async () => {
    const h = await detectOpenclawHost({
      gatewayUrl: "ws://127.0.0.1:1",
      paths: {
        configPath: path.join(tmp, "none.json"),
        identityPath: path.join(tmp, "no-device.json"),
        binPath: path.join(tmp, "no-openclaw"),
      },
    });
    assert.strictEqual(h.binPath, null);
    assert.strictEqual(h.version, null);
    assert.strictEqual(h.configExists, false);
    assert.strictEqual(h.identityExists, false);
    assert.strictEqual(h.localTokenReadable, false);
    assert.strictEqual(h.localGatewayUrl, null); // 无 bin → 问不了 status
  });
  await check("检测结果缓存:同参数 3s 内第二次调用应命中缓存(<50ms)", async () => {
    await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:18792" });
    const t0 = Date.now();
    await detectOpenclawHost({ gatewayUrl: "ws://127.0.0.1:18792" });
    assert.ok(Date.now() - t0 < 50, `二次耗时 ${Date.now() - t0}ms`);
  });
  process.exit(failed ? 1 : 0);
})();
