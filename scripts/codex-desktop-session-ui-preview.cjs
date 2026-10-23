"use strict";
// Full production ChatPage -> HTTP/WebSocket -> Backend -> private Service,
// with isolated SQLite/history and a simulated native model host.
const { fixture, turn } = require("./codex-desktop-session-service-fixture.cjs");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createAuthResolver } = require("../app/core/device-auth");
async function main() {
  const f = await fixture();
  if (process.env.CODEX_DESKTOP_UI_LARGE === "1") {
    const long = f.add({ title: "分页验收：1200 条桌面消息" });
    long.turns = Array.from({ length: 600 }, (_, i) => turn(`桌面问题 ${i + 1}`, `桌面回答 ${i + 1}：原会话的消息已加载。`));
    await f.backend._refreshCodexDesktopSessions();
  }
  if (process.env.CODEX_DESKTOP_UI_FAIL_EARLIER_ONCE === "1") {
    const history = f.backend.getHistory.bind(f.backend); let failed = false;
    f.backend.getHistory = async (key, options = {}) => {
      if (options.cursor && !failed) {
        failed = true; throw Object.assign(new Error("history cursor expired"), { code: "CODEX_DESKTOP_PARAMS_INVALID" });
      }
      return history(key, options);
    };
  }
  const registry = new BackendRegistry(); registry.register(f.backend); await registry.start();
  const proxy = await startProxyGateway({ port: 0, origin: "http://127.0.0.1", getUpstreamUrl: () => "", registry });
  const authResolver = createAuthResolver({ getConfig: () => ({ gatewayUrl: proxy.url, token: "" }),
    credentialsDir: require("node:path").join(f.root, "browser-credentials"), operatorIdentityDir: require("node:path").join(f.root, "browser-operator") });
  const server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: f.root,
    chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1", authResolver });
  const start = f.host.turnStart.bind(f.host);
  f.host.turnStart = async params => {
    const response = await start(params);
    setTimeout(() => f.host.finish(response.turn.id, "这条回复在同一个 Codex Desktop 原线程里完成。"), 200);
    return response;
  };
  const row = f.backend.getSessionRows().find(r => r.label === (process.env.CODEX_DESKTOP_UI_LARGE === "1"
    ? "分页验收：1200 条桌面消息" : "桌面对话：保留原上下文"));
  console.log(`Isolated production UI: ${server.url}/#/chat?backend=shoggoth&session=${encodeURIComponent(row.key)}`);
  console.log(`Fixture root: ${f.root}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); await proxy.close(); await f.close(); process.exit(0); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
