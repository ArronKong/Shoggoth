"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const net = require("node:net");
const { WebSocket } = require("ws");
const { resolveDesktopProxyPort, DEFAULT_PROXY_PORT, DEVELOPMENT_PORT_VARIABLE } = require("../app/desktop-dev-proxy-port");
const { startProxyGateway } = require("../app/core/proxy-gateway");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function main() {
  const passed = [];
  const hostile = Object.defineProperty({}, DEVELOPMENT_PORT_VARIABLE, { get() { throw new Error("packaged env must never be read"); } });
  assert.equal(resolveDesktopProxyPort({ isPackaged: true, env: hostile }), DEFAULT_PROXY_PORT);
  passed.push("packaged bootstrap ignores development overrides before reading their values");
  for (const env of [{}, { [DEVELOPMENT_PORT_VARIABLE]: "" }]) assert.equal(resolveDesktopProxyPort({ isPackaged: false, env }), DEFAULT_PROXY_PORT);
  for (const value of ["0", "00001", " 19000", "19000 ", "-1", "1e4", "65536", "123456", "19000/path", "19000\n", 19000, null]) {
    assert.throws(() => resolveDesktopProxyPort({ isPackaged: false, env: { [DEVELOPMENT_PORT_VARIABLE]: value } }), { code: "DESKTOP_DEVELOPMENT_PROXY_PORT_INVALID" });
  }
  assert.equal(resolveDesktopProxyPort({ isPackaged: false, env: { [DEVELOPMENT_PORT_VARIABLE]: "1" } }), 1);
  assert.equal(resolveDesktopProxyPort({ isPackaged: false, env: { [DEVELOPMENT_PORT_VARIABLE]: "65535" } }), 65535);
  passed.push("source overrides accept exact nonzero decimal ports and reject malformed or out-of-range input");

  const source = fs.readFileSync(path.join(__dirname, "../app/ui-entry.js"), "utf8");
  const declaration = source.match(/^const GATEWAY_PROXY_PORT = .*;$/m);
  assert(declaration); assert(source.includes('chatUpstreamUrl: `ws://127.0.0.1:${GATEWAY_PROXY_PORT}`'));
  assert(source.includes("port: GATEWAY_PROXY_PORT,"));
  const selectedPort = await unusedPort();
  const context = { resolveDesktopProxyPort: options => resolveDesktopProxyPort({ ...options, env: { [DEVELOPMENT_PORT_VARIABLE]: String(selectedPort) } }), app: { isPackaged: false } };
  assert.equal(vm.runInNewContext(declaration[0] + " GATEWAY_PROXY_PORT;", context), selectedPort);
  assert.equal(vm.runInNewContext(declaration[0] + " GATEWAY_PROXY_PORT;", { ...context, app: { isPackaged: true } }), DEFAULT_PROXY_PORT);
  passed.push("actual desktop declaration and static chat upstream consume the same resolved proxy port");

  let first, second, socket;
  try {
    first = await startProxyGateway({ port: selectedPort, getUpstreamUrl: () => "", origin: "http://127.0.0.1:9" });
    const secondPort = await unusedPort(); assert.notEqual(secondPort, selectedPort);
    second = await startProxyGateway({ port: resolveDesktopProxyPort({ isPackaged: false, env: { [DEVELOPMENT_PORT_VARIABLE]: String(secondPort) } }), getUpstreamUrl: () => "", origin: "http://127.0.0.1:10" });
    assert.equal(first.url, `ws://127.0.0.1:${selectedPort}`); assert.equal(second.url, `ws://127.0.0.1:${secondPort}`);
    socket = new WebSocket(second.url);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    passed.push("two actual credentialless loopback proxies coexist and the selected WebSocket listener is reachable");
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) await new Promise(resolve => { socket.once("close", resolve); socket.close(); });
    if (second) await second.close();
    if (first) await first.close();
  }
  console.log(JSON.stringify({ verified: true, passed: passed.length, tests: passed, boundary: "real credentialless loopback proxy and actual desktop port declaration; not full Electron bootstrap, Host, account, Skills or package proof" }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
