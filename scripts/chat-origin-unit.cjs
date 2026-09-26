#!/usr/bin/env node
"use strict";

// Unit: cross-site WebSocket hijacking guards.
//
// The chat broker rides the on-disk operator identity, so only OUR page may open
// /__chatws. The federating proxy serves foreign-backend RPCs locally, so only a
// loopback page may open it. WS handshakes ignore the same-origin policy, hence
// these Origin checks are the only thing standing between a random tab and a
// fully authenticated operator channel.

const assert = require("node:assert");
const { isAllowedBrowserOrigin } = require("../app/core/chat-broker");

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};

console.log("chat-broker isAllowedBrowserOrigin (self port 18799)");
const allow = (origin) => isAllowedBrowserOrigin(origin, 18799);

check("no Origin header (native client) allowed", () => assert.strictEqual(allow(undefined), true));
check("our own page allowed", () => assert.strictEqual(allow("http://127.0.0.1:18799"), true));
check("localhost form of our page allowed", () => assert.strictEqual(allow("http://localhost:18799"), true));
check("ipv6 loopback form of our page allowed", () => assert.strictEqual(allow("http://[::1]:18799"), true));

check("cross-site https page refused", () => assert.strictEqual(allow("https://evil.com"), false));
check("cross-site http page refused", () => assert.strictEqual(allow("http://evil.com"), false));
check("sandboxed iframe / file:// (\"null\") refused", () => assert.strictEqual(allow("null"), false));
check("empty Origin refused", () => assert.strictEqual(allow(""), false));
check("garbage Origin refused", () => assert.strictEqual(allow("not a url"), false));
check("other loopback port refused (rogue local dev server)", () =>
  assert.strictEqual(allow("http://127.0.0.1:3000"), false));
check("loopback without port refused (defaults to :80)", () =>
  assert.strictEqual(allow("http://127.0.0.1"), false));
check("evil.com subdomain trick refused", () =>
  assert.strictEqual(allow("http://127.0.0.1.evil.com:18799"), false));

// When the port is unknown, fall back to loopback-host-only.
check("unknown self port → any loopback allowed", () =>
  assert.strictEqual(isAllowedBrowserOrigin("http://127.0.0.1:3000", undefined), true));
check("unknown self port → cross-site still refused", () =>
  assert.strictEqual(isAllowedBrowserOrigin("https://evil.com", undefined), false));

// ---- /__api 管理面的 CSRF 守卫 ----
// Host 检查挡不住 evil.com 直接 POST 本机（它发的正是本机 Host），而 /__api 上挂着
// host/open-path、host/terminal 这类能代跑命令的路由。这里钉住两件事：守卫存在，
// 且**故意不锁端口**——dev 下 UI 跑在 vite 5173 并把 /__api 代理到本服务，锁端口
// 会直接打断 `npm run start:dev`。
console.log("\nstatic-server /__api origin guard");
const staticServerSrc = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "..", "app", "static-server.js"),
  "utf8",
);

check("/__api 分发前有 Origin 守卫", () =>
  assert.match(staticServerSrc, /isAllowedBrowserOrigin\(req\.headers\.origin\)[\s\S]{0,200}?pathname\.startsWith\("\/__api\/"\)|pathname\.startsWith\("\/__api\/"\)[\s\S]{0,300}?isAllowedBrowserOrigin\(req\.headers\.origin\)/));
check("守卫不传 selfPort（vite dev 代理来的 Origin 端口与本服务不同）", () =>
  assert.doesNotMatch(staticServerSrc, /isAllowedBrowserOrigin\(req\.headers\.origin\s*,/));

// 不锁端口下的实际语义：跨源一律拒，任意环回端口放行。
const apiAllow = (origin) => isAllowedBrowserOrigin(origin);
check("dev：vite 5173 转发的 Origin 放行", () =>
  assert.strictEqual(apiAllow("http://127.0.0.1:5173"), true));
check("dev：manage-serve 18801 放行", () =>
  assert.strictEqual(apiAllow("http://localhost:18801"), true));
check("原生客户端 / curl / smoke（无 Origin）放行", () =>
  assert.strictEqual(apiAllow(undefined), true));
check("恶意站点拒绝", () => assert.strictEqual(apiAllow("https://evil.com"), false));
check("null Origin 拒绝", () => assert.strictEqual(apiAllow("null"), false));
check("前缀伪装域名拒绝", () =>
  assert.strictEqual(apiAllow("http://127.0.0.1.evil.com"), false));

console.log(failed === 0 ? "\nchat-origin-unit: all passed" : `\nchat-origin-unit: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
