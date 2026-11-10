import { get, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import type { Plugin } from "vite";

type AgentDirectoryPaths = { agentsDir: string; userDataRoot: string };
type ManagedWorkspace = { path: string; exists: boolean };
type AgentResponse = {
  agent?: { id?: string; name?: string; backendId?: string; profile?: string; managedWorkspace?: ManagedWorkspace };
};

const require = createRequire(import.meta.url);
const { resolveCanonicalServicePaths } = require("../agent-service/paths.js") as {
  resolveCanonicalServicePaths(): AgentDirectoryPaths;
};
const { describeAgentDirectory } = require("../agent-service/agent-name-links.js") as {
  describeAgentDirectory(paths: AgentDirectoryPaths, profile: { id: string; name?: string }): ManagedWorkspace | undefined;
};
const AGENT_DETAIL = /^\/__api\/agents\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\?backend=shoggoth$/u;
const MAX_DETAIL_BYTES = 1024 * 1024;

function isLocalPreviewRequest(req: IncomingMessage): boolean {
  const host = `127.0.0.1:${req.socket.localPort}`;
  return req.socket.remoteAddress === "127.0.0.1" && req.headers.host === host
    && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
    && String(req.headers["sec-fetch-site"] || "").toLowerCase() !== "cross-site";
}

function addManagedWorkspace(body: Buffer, id: string, paths: AgentDirectoryPaths): Buffer {
  try {
    const detail = JSON.parse(body.toString("utf8")) as AgentResponse;
    const agent = detail?.agent;
    if (agent?.id !== id || agent.backendId !== "shoggoth" || Object.hasOwn(agent, "managedWorkspace")
      || typeof agent.profile !== "string") return body;
    const managedWorkspace = describeAgentDirectory(paths, { id: agent.profile, name: agent.name });
    if (!managedWorkspace) return body;
    agent.managedWorkspace = managedWorkspace;
    return Buffer.from(JSON.stringify(detail));
  } catch {
    return body;
  }
}

async function relayAgentDetail(reply: IncomingMessage, res: ServerResponse, id: string, paths: AgentDirectoryPaths) {
  const status = reply.statusCode ?? 502;
  const length = Number(reply.headers["content-length"]);
  if (status !== 200 || !reply.headers["content-type"]?.startsWith("application/json")
    || reply.headers["content-encoding"] || !(length > 0 && length <= MAX_DETAIL_BYTES)) {
    res.writeHead(status, reply.headers);
    await pipeline(reply, res);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of reply) chunks.push(chunk);
  const original = Buffer.concat(chunks);
  const body = addManagedWorkspace(original, id, paths);
  const headers = { ...reply.headers, "content-length": body.length };
  if (body !== original) delete headers.etag;
  res.writeHead(status, headers).end(body);
}

// A source UI can run against a packaged desktop host that predates the
// managedWorkspace projection. Use the same canonical paths as desktop startup.
export function devAgentWorkspace(target: string, paths?: AgentDirectoryPaths): Plugin {
  return {
    name: "shoggoth-dev-agent-workspace",
    apply: "serve",
    configureServer(server) {
      const upstream = new URL(target);
      const directoryPaths = paths ?? resolveCanonicalServicePaths();
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        const id = AGENT_DETAIL.exec(url)?.[1];
        if (req.method !== "GET" || !id || !isLocalPreviewRequest(req)) return next();
        const request = get(new URL(url, upstream), { headers: { ...req.headers, host: upstream.host } }, (reply) => {
          void relayAgentDetail(reply, res, id, directoryPaths).catch(() => res.destroy());
        });
        request.on("error", () => {
          if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
        });
        res.on("close", () => {
          if (!res.writableFinished) request.destroy();
        });
      });
    },
  };
}
