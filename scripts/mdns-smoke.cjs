"use strict";
// mDNS 浏览端 smoke:①解析器吃合成包(含压缩指针) ②dns-sd 假服务端到端。
// Run: node scripts/mdns-smoke.cjs
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { browseOpenclawGateways, _parsePacket } = require("../app/core/mdns-browser");

let failed = false;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok  ${name}`); }
  catch (e) { failed = true; console.error(`FAIL ${name}: ${e?.message || e}`); }
};

// ---- 合成一个含 PTR+SRV+A 的应答包(SRV 的名字用压缩指针指回 PTR rdata) ----
function encName(n) {
  return Buffer.concat([...n.split(".").filter(Boolean).map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
}
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }
function synthPacket() {
  const parts = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); header.writeUInt16BE(0x8400, 2); // 响应+权威
  header.writeUInt16BE(0, 4); header.writeUInt16BE(1, 6);      // qd=0 an=1
  header.writeUInt16BE(0, 8); header.writeUInt16BE(2, 10);     // ns=0 ar=2
  parts.push(header);
  const svcName = encName("_openclaw-gw._tcp.local");           // 位于 offset 12
  // AN: PTR —— rdata = "gw-a." + 指针(0xC00C → offset12 的服务名)
  const instRdata = Buffer.concat([Buffer.from([4]), Buffer.from("gw-a"), Buffer.from([0xc0, 12])]);
  parts.push(svcName, Buffer.from([0, 12, 0, 1, 0, 0, 0, 120]), u16(instRdata.length), instRdata);
  const instPtr = Buffer.from([0xc0, 12 + svcName.length + 10]); // 指向 AN rdata 里的实例名
  // AR1: SRV(实例名用指针) —— prio0 weight0 port 18999 target host-a.local
  const target = encName("host-a.local");
  const srvRdata = Buffer.concat([Buffer.from([0, 0, 0, 0]), u16(18999), target]);
  parts.push(instPtr, Buffer.from([0, 33, 0, 1, 0, 0, 0, 120]), u16(srvRdata.length), srvRdata);
  // AR2: A —— host-a.local = 192.168.9.9(名字不压缩,直接重编码)
  parts.push(encName("host-a.local"), Buffer.from([0, 1, 0, 1, 0, 0, 0, 120]), u16(4), Buffer.from([192, 168, 9, 9]));
  return Buffer.concat(parts);
}

(async () => {
  await check("解析器:合成包(含压缩指针)解出 PTR/SRV/A", () => {
    const p = _parsePacket(synthPacket());
    assert.deepStrictEqual(p.ptr, ["gw-a._openclaw-gw._tcp.local"]);
    assert.deepStrictEqual(p.srv["gw-a._openclaw-gw._tcp.local"], { target: "host-a.local", port: 18999 });
    assert.strictEqual(p.a["host-a.local"], "192.168.9.9");
  });
  await check("E2E:dns-sd 注册假服务 → browse 找到 host+port", async () => {
    const reg = spawn("dns-sd", ["-R", "smoke-oc-gw", "_openclaw-gw._tcp", "local", "18999"]);
    try {
      await new Promise((r) => setTimeout(r, 900)); // 等注册完成
      let list = await browseOpenclawGateways({ timeoutMs: 2500 });
      if (!list.length) list = await browseOpenclawGateways.uncached({ timeoutMs: 2500 }); // 抗单次丢包
      const hit = list.find((g) => g.port === 18999);
      assert.ok(hit, `未发现假服务,got=${JSON.stringify(list)}`);
      assert.match(hit.url, /^ws:\/\/.+:18999$/);
      assert.ok(hit.name.includes("smoke-oc-gw"), `实例名不符: ${hit.name}`);
    } finally { try { reg.kill(); } catch { /* ignore */ } }
  });
  process.exit(failed ? 1 : 0);
})();
