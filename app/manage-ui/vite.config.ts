import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Plugin, ProxyOptions } from "vite";
import { debugInspectorSource } from "./debug-inspector-source.ts";

const DEV_WS_TARGET = "http://127.0.0.1:18799";

// rewriteWsOrigin is only safe after proving the browser came from this exact
// Vite origin. Vite 5 does not run bypass() for WebSocket upgrades, so the
// upgrade must also be rejected at http-proxy's proxyReqWs boundary.
function isAllowedDevWsUpgrade(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;

  try {
    const url = new URL(origin);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port !== ""
      && url.origin === origin
      && url.host === host;
  } catch {
    return false;
  }
}

function devWsProxy(): ProxyOptions {
  return {
    target: DEV_WS_TARGET,
    ws: true,
    changeOrigin: true,
    rewriteWsOrigin: true,
    bypass: (req) => (isAllowedDevWsUpgrade(req) ? undefined : false),
    configure: (proxy) => {
      proxy.on("proxyReqWs", (proxyReq, req, socket) => {
        if (isAllowedDevWsUpgrade(req)) return;
        proxyReq.destroy();
        socket.destroy();
      });
    },
  };
}

// Shared app modules stay CommonJS for the Service and Electron. The production
// build converts them, but the dev server serves files as written, so there
// their `module.exports = { ... }` names are re-exported as ES exports.
const SHARED_COMMONJS = new Set([fileURLToPath(new URL("../group-journal-recovery.js", import.meta.url))]);
function sharedCommonJsDevExports(): Plugin {
  return {
    name: "shoggoth-shared-commonjs-dev",
    apply: "serve",
    transform(code, id) {
      if (!SHARED_COMMONJS.has(id.split("?")[0])) return null;
      const match = /^module\.exports = \{ ([\w$, ]+) \};$/mu.exec(code);
      if (!match || /\brequire\(/u.test(code)) throw new Error(`${id} is not a plain shared CommonJS module`);
      return { code: code.replace(match[0], `export { ${match[1]} };`), map: null };
    },
  };
}

// The React control plane is the primary UI, served at the loopback root by
// static-server.js.
export default defineConfig({
  base: "/",
  plugins: [react(), debugInspectorSource(), sharedCommonJsDevExports()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/__api": "http://127.0.0.1:18799",
      "/__widget": "http://127.0.0.1:18799",
      "/avatar": "http://127.0.0.1:18799",
      "/__chatws": devWsProxy(),
      "/__kanbanws": devWsProxy(),
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
