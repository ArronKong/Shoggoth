import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json")), { build } = require("esbuild");
const output = path.resolve(process.argv[2] || path.join(root, ".artifacts/apple-device-ui-render"));
fs.mkdirSync(output, { recursive: true });
await build({ entryPoints: [path.join(root, "scripts/fixtures/apple-device-render.tsx")], bundle: true, format: "esm", target: "es2022", jsx: "automatic", outdir: output, nodePaths: [path.join(root, "app/manage-ui/node_modules")], loader: { ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" }, logLevel: "warning" });
let state;
function reset(mode) {
  state = { revision: 4, available: mode !== "unavailable", errorCode: mode === "unavailable" ? "APPLE_DEVICE_HOST_UNAVAILABLE" : null,
    resources: ["calendar", "reminders"].map(id => ({ id, authorization: mode === "denied" && id === "calendar" ? "denied" : mode === "restricted" && id === "reminders" ? "restricted" : mode === "unconnected" ? "notDetermined" : "fullAccess", enabled: !["denied", "unconnected"].includes(mode), readPolicy: "ask", writePolicy: "ask", disabledProfileIds: id === "calendar" ? ["unknown-kept"] : [] })) };
}
reset("connected");
const json = (response, code, value) => { response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
const html = '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apple device connector fixture</title><link rel="stylesheet" href="/apple-device-render.css"><div id="root"></div><script type="module" src="/apple-device-render.js"></script></html>';
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/viewport") {
      const width = Number(url.searchParams.get("width"));
      if (![390, 680, 1100].includes(width)) return json(response, 400, {});
      url.searchParams.delete("width");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(`<!doctype html><html><meta charset="utf-8"><title>Responsive Apple device fixture</title><body style="margin:0;background:#888"><iframe id="fixture-frame" title="Isolated Apple device component at ${width} CSS pixels" src="/?${url.searchParams}" style="display:block;border:0;width:${width}px;height:1200px"></iframe></body></html>`);
    }
    if (url.pathname === "/") { reset(url.searchParams.get("state") || "connected"); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return response.end(html); }
    if (url.pathname === "/apple-device-render.js" || url.pathname === "/apple-device-render.css") { response.writeHead(200, { "content-type": url.pathname.endsWith("css") ? "text/css" : "application/javascript" }); return response.end(fs.readFileSync(path.join(output, url.pathname.slice(1)))); }
    if (url.pathname === "/__api/connectors/mcp/subjects") return json(response, 200, { items: [{ profileId: "a", agentId: "a", backendId: "shoggoth", label: "日程助理 · Planning agent", enabled: true }, { profileId: "b", agentId: "b", backendId: "hermes", label: "Research assistant with a longer name", enabled: true }], unavailableBackends: [] });
    if (url.pathname === "/__api/connectors/apple/status") return json(response, 200, state);
    if (request.method === "POST" && url.pathname.startsWith("/__api/connectors/apple/")) {
      let body = ""; for await (const bytes of request) { body += bytes; if (body.length > 10000) return json(response, 413, {}); }
      const input = JSON.parse(body), resource = state.resources.find(resource => resource.id === input.resource);
      if (!resource) return json(response, 400, { code: "APPLE_DEVICE_INVALID_ARGUMENT" });
      if (url.pathname.endsWith("/settings")) return json(response, 200, { opened: true });
      if (input.expectedRevision !== state.revision) return json(response, 409, { code: "APPLE_DEVICE_REVISION_CONFLICT" });
      if (url.pathname.endsWith("/connect")) { resource.enabled = true; resource.authorization = "fullAccess"; }
      else if (url.pathname.endsWith("/policy")) Object.assign(resource, { enabled: input.enabled, readPolicy: input.readPolicy, writePolicy: input.writePolicy, disabledProfileIds: input.disabledProfileIds });
      else return json(response, 404, {});
      state.revision++; return json(response, 200, state);
    }
    json(response, 404, {});
  } catch { json(response, 400, {}); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ fixtureUrl: `http://127.0.0.1:${server.address().port}`, output, synthetic: true }));
process.once("SIGINT", () => server.close()); process.once("SIGTERM", () => server.close());
