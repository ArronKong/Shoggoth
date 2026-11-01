"use strict";

const fs = require("node:fs"), path = require("node:path");
const { scanPackage } = require("./native-skill-store");
const { sha256 } = require("./official-skill-mcp-bridge");
const RELEASE = Object.freeze({ version: "1.0.25", url: "https://pdds.quark.cn/download/stfile/eekkigineefiegmgo/quarkclouddrive-1.0.25.zip",
  sha256: "56c34e9a9313ae29d39475b4ff9da9e92fbfd59699bf5843e3382e54434fffb8",
  cliSha256: "b19755822486bd812c76e15de31e9213bccfa2cc6ed1e639c43201e5cf2e07b5" });
const fail = () => { throw Object.assign(new Error("OFFICIAL_SKILL_INTEGRITY_FAILED"), { code: "OFFICIAL_SKILL_INTEGRITY_FAILED" }); };

// The original CLI starts itself. Expose its pinned parser/SDK to our fixed
// helper instead. No source from tools, accounts, or downloads can select code.
function managedModule(bytes) {
  if (sha256(bytes) !== RELEASE.cliSha256) fail();
  const source = bytes.toString("utf8"), marker = "Sr()&&Fg(de.getInstance());var nP=KE(),Df=Pn.flushTraces,jE=Pn.endCommandFail;";
  const index = source.indexOf(marker);
  if (index < 0 || index !== source.lastIndexOf(marker)) fail();
  return Buffer.from(source.slice(0, index) + `\n// Modified for Shoggoth: managed entry, truthful client identity, private home, no telemetry.\n
module.exports = {
  configure(home, allowReadOnlyRefresh = false) {
    Ie = () => "shoggoth";
    lt = require("node:path").join(home, ".quarkclouddrive");
    const noop = new Proxy({ initialize: async () => {}, waitForReady: async () => false, getSpanDimValues: () => ({}) },
      { get(target, key) { return key === "then" ? undefined : target[key] || (() => {}); } });
    de.getInstance = () => noop;
    E = noop; z = noop; q = (_name, operation) => operation();
    _i.prototype.shouldRetryTransientSocketError = () => false;
    const refresh = _i.prototype.handleTokenRefreshReplay;
    _i.prototype.handleTokenRefreshReplay = async function(options, ...rest) {
      if (allowReadOnlyRefresh && options.method === "GET" && new URL(options.url).pathname === "/open/v1/user/info") return refresh.call(this, options, ...rest);
    };
    _i.prototype.handleAccessTokenNotAuth = async code => {
      if (code === 11000 || !allowReadOnlyRefresh && [11001, 11017, 12003, 12004].includes(code)) throw new j(ie, -107, "Authorization required");
    };
    Jm({ verbose: false });
    A.getPlatformModel = async () => "Shoggoth";
    A.permissionManager.getWorkDir = () => "Shoggoth";
    zc(false);
    return A;
  },
  sdk: O,
  authorizeUrl: XC,
  command: args => KE().parseAsync(args, { from: "user" }),
};\n`);
}

// This stable public download redirects to Quark's CDN. Follow only the
// audited HTTPS hosts, then check the entire archive digest before extraction.
function archiveFetch(fetch) {
  return async (url, options) => {
    let current = String(url);
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await fetch(current, { ...options, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const target = new URL(response.headers.get("location") || "", current);
      if (target.protocol !== "https:" || target.username || target.password || target.port
        || !["pdds.quark.cn", "pdds-c1-cdn.quark.cn", "pdds-c2-cdn.quark.cn"].includes(target.hostname)
        || !target.pathname.endsWith(`/quarkclouddrive-${RELEASE.version}.zip`)) fail();
      await response.body?.cancel?.(); current = target.href;
    }
    fail();
  };
}

async function prepareQuarkSkill({ provider, root, homeDir, serverId, signal, fetch, onStage, downloadPinned, readZip, writePayload, adapterInstructions }) {
  onStage("download");
  const archive = await downloadPinned(RELEASE, { fetch: archiveFetch(fetch), signal });
  onStage("verify");
  const content = readZip(archive), files = [], skillPath = "adapters/official-quark-drive";
  if (!/^---\s*\nname: quarkclouddrive\s*\nversion: 1\.0\.25\s*\n/u.test(content["SKILL.md"]?.toString("utf8") || "")
    || !content["scripts/hash-worker.cjs"]) fail();
  const put = (relative, bytes) => { signal?.throwIfAborted(); files.push(writePayload(root, relative, bytes)); };
  put("runtime/quark-managed.cjs", managedModule(content["scripts/quark-drive.cjs"]));
  put("runtime/hash-worker.cjs", content["scripts/hash-worker.cjs"]);
  put("vendor/quark-drive.cjs", content["scripts/quark-drive.cjs"]);
  put("vendor/LICENSE", fs.readFileSync(path.join(__dirname, "data", "quark-skill-LICENSE.txt")));
  put("vendor/NOTICE", Buffer.from("Quark Drive Skill 1.0.25, https://github.com/quark-clouddrive/quarkclouddrive_offical. Managed adaptation by Shoggoth: expose the pinned SDK/parser, use the Shoggoth client identity and private storage, disable upstream telemetry and automatic installation. Original CLI is preserved beside this notice.\n"));
  for (const [name, bytes] of Object.entries(content)) if (name === "SKILL.md" || /^references\/[a-z-]+\.md$/u.test(name)) put(`vendor-docs/${name}`, bytes);
  put(`${skillPath}/SKILL.md`, Buffer.from(adapterInstructions(provider, serverId)));
  // Only the managed workflow is admitted as an Agent Skill. Pristine vendor
  // instructions remain in the payload, never override the connector boundary.
  put(`${skillPath}/skill.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, id: "official-quark-drive", name: "official-quark-drive", version: provider.version,
    description: provider.description["zh-CN"], entry: "SKILL.md", requiredTools: ["mcp_server_list", "mcp_server_tools", "mcp_server_call"], requiredRuntimeCapabilities: ["mcp"], sourceCompatibility: ["shoggoth"] })));
  onStage("installSkills");
  const scan = scanPackage(path.join(root, skillPath));
  files.push(writePayload(root, "payload-manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 1, providerId: provider.id, version: provider.version, source: RELEASE, files }))));
  return { skills: [{ id: scan.manifest.id, version: scan.manifest.version, contentHash: scan.contentHash, sourcePath: path.join(root, skillPath) }], files,
    transport: { kind: "stdio-command", command: process.execPath, args: [path.join(__dirname, "official-skill-mcp-bridge.js"), "--provider", provider.id, "--root", root, "--home", homeDir], cwd: root } };
}
module.exports = { RELEASE, managedModule, archiveFetch, prepareQuarkSkill };
