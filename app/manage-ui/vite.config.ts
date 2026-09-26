import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import type { ProxyOptions } from "vite";

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

// The React control plane is the primary UI, served at the loopback root by
// static-server.js.
export default defineConfig({
  base: "/",
  plugins: [react()],
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
