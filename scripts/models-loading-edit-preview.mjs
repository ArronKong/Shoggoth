import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
const fixture = "/@fs/" + path.join(root, "scripts/fixtures/models-loading-edit.tsx");
const server = await createServer({
  configFile: false, root: uiRoot, cacheDir: path.join(root, ".artifacts/models-loading-edit/vite-cache"), plugins: [react(), {
    name: "isolated-models-page", configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        // Unexpected requests from any other script cannot fall through to a real API.
        if (pathname.startsWith("/__api/")) { response.writeHead(404); response.end("fixture API only"); return; }
        if (pathname !== "/") return next();
        const html = await server.transformIndexHtml(request.url, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>模型页隔离验证</title></head><body><div id="root"></div><script type="module" src="${fixture}"></script></body></html>`);
        response.setHeader("Content-Type", "text/html"); response.end(html);
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root, fs.realpathSync(path.join(uiRoot, "node_modules"))] } },
});
await server.listen();
console.log(`Isolated models page: http://127.0.0.1:${server.httpServer.address().port}/#/models`);
process.once("SIGTERM", async () => { await server.close(); process.exit(0); });
process.once("SIGINT", async () => { await server.close(); process.exit(0); });
