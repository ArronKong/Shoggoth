#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const port = path.join(root, "build/shoggoth-memory");
const source = path.join(port, "source");
const dependencies = path.join(port, "dependencies");
const revision = "c10679395819ede78bb073f979f95c157e165bfa";
const args = process.argv.slice(2);
const refresh = args.includes("--import");
const upstream = refresh ? path.resolve(args[args.indexOf("--import") + 1]) : source;
const deps = refresh ? path.resolve(args[args.indexOf("--dependencies") + 1]) : dependencies;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const manifestPath = path.join(port, "manifest.json");

function checkSources(manifest) {
  for (const file of manifest.files) {
    const base = file.kind === "upstream" ? source : dependencies;
    if (hash(fs.readFileSync(path.join(base, file.path))) !== file.sha256) {
      throw new Error(`Pinned source differs: ${file.kind}/${file.path}`);
    }
  }
}

async function main() {
  if (refresh) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim();
    if (head !== revision) throw new Error(`Expected upstream ${revision}; found ${head}`);
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: upstream, encoding: "utf8" });
    if (dirty.trim()) throw new Error("Upstream must be clean before importing");
  } else checkSources(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const esbuild = require(require.resolve("esbuild", { paths: [path.join(root, "app/manage-ui"), root] }));
  const pinnedEsbuild = JSON.parse(fs.readFileSync(path.join(root, "app/manage-ui/package-lock.json"), "utf8")).packages["node_modules/esbuild"].version;
  if (esbuild.version !== pinnedEsbuild) throw new Error(`Expected locked esbuild ${pinnedEsbuild}; found ${esbuild.version}`);
  const workspacePackages = new Map();
  for (const name of fs.readdirSync(path.join(upstream, "packages"))) {
    const pkgPath = path.join(upstream, "packages", name, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      workspacePackages.set(pkg.name, { dir: path.dirname(pkgPath), pkgPath, pkg });
    }
  }
  const localAliases = new Map([
    ["packages/memory-host-sdk/src/host/openclaw-runtime-auth.ts", "embedding-auth.ts"],
    ["packages/memory-host-sdk/src/host/openclaw-runtime-config.ts", "embedding-config.ts"],
    ["packages/memory-host-sdk/src/host/openclaw-runtime-network.ts", "embedding-network.ts"],
    ["src/infra/net/undici-global-dispatcher.ts", "embedding-network-runtime.ts"],
    ["src/logger.ts", "embedding-network-runtime.ts"],
    ["src/logging/subsystem.ts", "embedding-network-runtime.ts"],
    ["src/proxy-capture/runtime.ts", "embedding-network-runtime.ts"],
    ["extensions/memory-core/src/memory/lifecycle.ts", "embedding-lifecycle.ts"],
    ["src/logging/config.ts", "logging-config.ts"],
    ["src/agents/agent-scope.ts", "agent-scope.ts"],
    // Memory uses the original pure ranked-profile selector with capabilities
    // observed by its Product Runtime. It cannot discover global CLI plugins.
    ["src/plugins/provider-thinking.ts", "model-policy-runtime.ts"],
    ["src/plugins/memory-embedding-provider-runtime.ts", "search-config-runtime.ts"],
    ["src/secrets/runtime-degraded-state.ts", "search-config-runtime.ts"],
    ["src/state/openclaw-agent-db.paths.ts", "search-config-runtime.ts"],
    ["packages/memory-host-sdk/src/host/openclaw-runtime-sqlite.ts", "sqlite.ts"],
    ["extensions/memory-core/src/memory/manager-cpu-entrypoints.ts", "origin-worker.ts"],
    ["extensions/memory-core/src/memory/manager-cpu-worker-runtime.ts", "origin-worker.ts"],
  ]);
  const resolveSource = candidate => {
    if (!fs.existsSync(candidate) && candidate.endsWith(".js")) candidate = candidate.slice(0, -3) + ".ts";
    const alias = localAliases.get(path.relative(upstream, candidate));
    return alias ? path.join(port, alias) : candidate;
  };
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: [path.join(port, "entry.ts")], bundle: true,
    platform: "node", target: "node22", format: "cjs", write: false,
    // Keep shared node_modules links relative to this checkout in bundle labels.
    // Otherwise identical inputs produce different bytes in a managed worktree.
    metafile: true, legalComments: "inline", nodePaths: [deps], preserveSymlinks: true,
    define: { SEALED_RUNTIME_BUILD: "true", "import.meta.url": "__filename" },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: false } },
    outfile: "app/agent-service/shoggoth-memory/core.cjs",
    plugins: [{ name: "shoggoth-memory-host", setup(build) {
      build.onResolve({ filter: /^openclaw\/plugin-sdk\/ssrf-runtime$/ }, () => ({
        path: path.join(port, "embedding-ssrf-runtime.ts"),
      }));
      build.onResolve({ filter: /^openclaw\/plugin-sdk\// }, args => {
        const importer = path.relative(upstream, args.importer);
        if (importer.startsWith("extensions/llama-cpp/src/")) return { path: path.join(port, "gguf-sdk.ts") };
        if (importer === "extensions/anthropic/cli-shared.ts") return { path: path.join(port, "claude-cli-sdk.ts") };
      });
      build.onResolve({ filter: /^\.\/provider-request-config\.js$/ }, args => {
        if (path.relative(upstream, args.importer) === "src/agents/provider-secret-egress.ts") {
          return { path: path.join(port, "provider-transport-resources.ts") };
        }
      });
      build.onResolve({ filter: /^\.\.\/agents\/(?:agent-scope-config|model-auth-provider)\.js$/ }, args => {
        if (path.relative(upstream, args.importer) === "src/plugins/openai-compatible-embedding-provider.ts") {
          return { path: path.join(port, "embedding-local-auth.ts") };
        }
      });
      build.onResolve({ filter: /^\.\.\/plugin-sdk\/memory-core-host-engine-embeddings\.js$/ }, args => {
        if (path.relative(upstream, args.importer) === "src/plugins/openai-compatible-embedding-provider.ts") {
          return { path: path.join(port, "embedding-destination-runtime.ts") };
        }
      });
      build.onResolve({ filter: /^\.\/manager-database-context\.js$/ }, args => {
        if (["extensions/memory-core/src/memory/manager-sync-ops.ts", "extensions/memory-core/src/memory/manager-sync-base.ts"].includes(path.relative(upstream, args.importer))) {
          return { path: path.join(port, "rebuild-database-resources.ts") };
        }
      });
      build.onResolve({ filter: /^openclaw\/plugin-sdk\/memory-core-host-engine-foundation$/ }, args => {
        if (["manager-embedding-ops.ts", "manager-sync-ops.ts", "manager-sync-base.ts", "manager-database-context.ts", "manager-provider-lifecycle.ts", "manager-search-orchestration.ts", "manager-keyword-retrieval.ts", "manager-registry.ts", "manager-source-sync-ops.ts", "manager-session-sync-ops.ts", "manager-watch-ops.ts", "file-watcher.ts"].some(file => path.relative(upstream, args.importer) === `extensions/memory-core/src/memory/${file}`)) {
          return { path: path.join(port, "embedding-index-logging.ts") };
        }
      });
      build.onResolve({ filter: /^\.\.\/infra\/backoff\.js$/ }, args => {
        if (path.relative(upstream, args.importer) === "src/media-understanding/shared.ts") {
          return { path: path.join(port, "embedding-execution.ts") };
        }
      });
      build.onResolve({ filter: /^node:fs\/promises$/ }, args => {
        if (path.relative(upstream, args.importer) === "extensions/active-memory/recall-run.ts") {
          return { path: path.join(port, "active-transcript-fs.ts") };
        }
      });
      build.onResolve({ filter: /^openclaw\/plugin-sdk\/provider-http$/ }, args => {
        if (path.relative(upstream, args.importer) === "extensions/ollama/src/embedding-provider.runtime.ts") {
          return { path: path.join(port, "embedding-ollama-http.ts") };
        }
      });
      build.onResolve({ filter: /^\.\.?\// }, args => {
        if (path.relative(upstream, args.importer) === "src/agents/model-auth-markers.ts" &&
          ["../plugins/manifest-metadata-scan.js", "./model-auth-env-vars.js"].includes(args.path)) {
          return { path: path.join(port, "embedding-auth-markers.ts") };
        }
      });
      build.onResolve({ filter: /^@openclaw\/ai\/diagnostics$/ }, args => {
        if (path.relative(upstream, args.importer) === "src/infra/retryable-network-errors.ts") {
          return { path: path.join(upstream, "packages/ai/src/utils/retryable-network-errors.ts") };
        }
      });
      build.onResolve({ filter: /^@openclaw\/ai\/internal\/(?:runtime|shared)$/ }, args => {
        if (path.relative(upstream, args.importer).startsWith("src/agents/failover/")) {
          return { path: path.join(port, "embedding-failover-runtime.ts") };
        }
      });
      build.onResolve({ filter: /^\.\.?\// }, args => {
        const importer = path.relative(upstream, args.importer);
        if ((importer === "src/agents/live-auth-keys.ts" && args.path === "../secrets/provider-env-vars.js") ||
          (importer === "src/agents/failover/provider-patterns.ts" && args.path === "../../plugins/provider-failover.js")) {
          return { path: path.join(port, "embedding-provider-policy.ts") };
        }
      });
      build.onResolve({ filter: /^\.\.?\// }, args => {
        const importer = path.relative(upstream, args.importer);
        if (importer !== "src/agents/model-selection-shared.ts") return;
        if (["../config/model-policy-allowlist-migration.js", "../config/utility-model-separation-migration.js",
          "../plugins/current-plugin-metadata-snapshot.js", "../plugins/manifest-contract-eligibility.js",
          "../plugins/runtime-state.js", "./agent-scope-config.js", "./openai-model-routes.js",
          "./utility-model-setting.js", "../../packages/terminal-core/src/ansi.js",
          "./model-catalog-metadata.js", "./model-catalog-lookup.js"].includes(args.path)) return { path: path.join(port, "model-alias-runtime.ts") };
      });
      build.onResolve({ filter: /^\.\/recall\.js$/ }, args => {
        if (path.relative(upstream, args.importer) === "extensions/active-memory/index.ts") {
          return { path: path.join(port, "active-recall-resolve.ts") };
        }
      });
      build.onResolve({ filter: /^\.\/recall-run\.js$/ }, args => {
        if (path.relative(upstream, args.importer) === "extensions/active-memory/recall.ts") {
          return { path: path.join(port, "active-recall-run.ts") };
        }
      });
      build.onResolve({ filter: /^undici\/index\.js$/ }, args => {
        if (args.importer === path.join(port, "embedding-module-loader.ts")) {
          return { path: path.join(deps, "undici/index.js") };
        }
      });
      build.onResolve({ filter: /^node:module$/ }, args => {
        // This one upstream dynamic loader must resolve a bundled, pinned
        // dependency instead of relying on an optional desktop dev dependency.
        if (path.relative(upstream, args.importer) === "src/infra/net/undici-dispatcher-options.ts") {
          return { path: path.join(port, "embedding-module-loader.ts") };
        }
      });
      build.onResolve({ filter: /^(?:@openclaw\/ai\/|\.\.\/\.\.\/(?:agents\/|config\/sessions\.js$|config\/model-provider-config\.js$))/ }, args => {
        if (path.relative(upstream, args.importer) !== "src/auto-reply/reply/memory-flush.ts") return;
        return { path: path.join(port, "flush-timing-runtime.ts") };
      });
      build.onLoad({ filter: /\/extensions\/memory-core\/src\/dreaming\.ts$/ }, args => ({
        // Export the existing runner without importing Gateway lifecycle hooks.
        // The pinned file and all algorithm bodies remain unchanged.
        contents: fs.readFileSync(args.path, "utf8") + "\nexport { runShortTermDreamingPromotion };\n", loader: "ts",
      }));
      build.onLoad({ filter: /\/extensions\/llama-cpp\/src\/embedding-provider\.ts$/ }, args => ({
        // Product coordinates the complete model/resource operation. Export
        // the existing preparation helpers without changing their bodies.
        contents: fs.readFileSync(args.path, "utf8") + "\nexport { prepareEmbeddingServer, readIdentityLocalOptions };\n", loader: "ts",
      }));
      build.onResolve({ filter: /^shoggoth-memory-host$/ }, () => ({ path: "./host-bridge.cjs", external: true }));
      build.onResolve({ filter: /^upstream:/ }, args => ({ path: resolveSource(path.join(upstream, args.path.slice(9))) }));
      build.onResolve({ filter: /^openclaw\/plugin-sdk\// }, () => ({ path: path.join(port, "sdk.ts") }));
      build.onResolve({ filter: /^@openclaw\/normalization-core\// }, args => ({ path: path.join(upstream, "packages/normalization-core/src", args.path.split("/").slice(2).join("/") + ".ts") }));
      build.onResolve({ filter: /^@openclaw\/media-core\// }, args => ({ path: path.join(upstream, "packages/media-core/src", args.path.split("/").slice(2).join("/") + ".ts") }));
      build.onResolve({ filter: /^@openclaw\// }, args => {
        const parts = args.path.split("/");
        const found = workspacePackages.get(parts.slice(0, 2).join("/"));
        if (!found) return;
        const key = parts.length > 2 ? "./" + parts.slice(2).join("/") : ".";
        let target = found.pkg.exports?.[key];
        if (target && typeof target === "object") target = target.import || target.default || target.node;
        if (typeof target !== "string") throw new Error(`Missing upstream package export ${args.path}`);
        return { path: path.resolve(found.dir, target.replace(/^\.\/dist\//, "./src/").replace(/\.(mjs|cjs|js)$/, ".ts")) };
      });
      build.onResolve({ filter: /^\./ }, args => {
        if (!args.resolveDir.startsWith(upstream + path.sep)) return;
        const candidate = path.resolve(args.resolveDir, args.path);
        const resolved = resolveSource(candidate);
        if (resolved !== candidate) return { path: resolved };
      });
    } }],
  });
  if (!refresh) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const pinned = new Set(manifest.files.map(file => `${file.kind}/${file.path}`));
    for (const input of Object.keys(result.metafile.inputs)) {
      const abs = path.resolve(root, input);
      const kind = abs.startsWith(upstream + path.sep) ? "upstream"
        : abs.startsWith(deps + path.sep) ? "dependency" : undefined;
      if (kind && !pinned.has(`${kind}/${path.relative(kind === "upstream" ? upstream : deps, abs)}`)) {
        throw new Error(`Memory bundle input is not pinned: ${input}`);
      }
    }
  }
  const files = [];
  const copy = (abs, base, destination, kind) => {
    const rel = path.relative(base, abs);
    const content = fs.readFileSync(abs);
    const dest = path.join(destination, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    files.push({ kind, path: rel, sha256: hash(content) });
  };
  if (refresh) {
    const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { files: [] };
    for (const input of Object.keys(result.metafile.inputs)) {
      const abs = path.resolve(root, input);
      if (abs.startsWith(upstream + path.sep)) copy(abs, upstream, source, "upstream");
      else if (abs.startsWith(deps + path.sep)) copy(abs, deps, dependencies, "dependency");
    }
    // Keep package export maps and license notices alongside bundled leaf files.
    const packagesUsed = new Set(files.filter(file => file.kind === "upstream" && file.path.startsWith("packages/")).map(file => file.path.split("/")[1]));
    for (const name of packagesUsed) copy(path.join(upstream, "packages", name, "package.json"), upstream, source, "upstream");
    const dependencyPackages = new Set(files.filter(file => file.kind === "dependency").map(file => file.path.startsWith("@") ? file.path.split("/").slice(0, 2).join("/") : file.path.split("/")[0]));
    for (const name of dependencyPackages) {
      const dir = path.join(deps, name);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).filter(name => /^(package\.json|licen[sc]e(?:\..*)?|notice(?:\..*)?)$/i.test(name))) {
        const abs = path.join(dir, name);
        if (!files.some(item => item.kind === "dependency" && item.path === path.relative(deps, abs))) copy(abs, deps, dependencies, "dependency");
      }
    }
    copy(path.join(upstream, "LICENSE"), upstream, source, "upstream");
    const manifest = { repository: "https://github.com/openclaw/openclaw", revision, files: files.sort((a, b) => `${a.kind}/${a.path}`.localeCompare(`${b.kind}/${b.path}`)) };
    const retained = new Set(files.map(file => `${file.kind}/${file.path}`));
    for (const file of previous.files) {
      if (retained.has(`${file.kind}/${file.path}`)) continue;
      const target = path.join(file.kind === "upstream" ? source : dependencies, file.path);
      if (!fs.existsSync(target)) continue;
      if (hash(fs.readFileSync(target)) !== file.sha256) throw new Error(`Refusing to prune edited imported source: ${file.path}`);
      fs.unlinkSync(target);
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const notices = path.join(root, "resources/legal/licenses/source/openclaw-memory");
    fs.mkdirSync(notices, { recursive: true });
    fs.copyFileSync(path.join(source, "LICENSE"), path.join(notices, "OPENCLAW.txt"));
    for (const name of dependencyPackages) {
      const directory = path.join(dependencies, name);
      const notice = fs.readdirSync(directory).find(file => /^licen[sc]e(?:\..*)?$/i.test(file));
      if (!notice) throw new Error(`Missing bundled dependency license: ${name}`);
      fs.copyFileSync(path.join(directory, notice), path.join(notices, name.split("/").at(-1) + ".txt"));
    }
    // Publish from the checked-in paths so another checkout builds identical bytes.
    execFileSync(process.execPath, [__filename], { cwd: root, stdio: "inherit" });
    return;
  }
  const output = result.outputFiles[0];
  if (args.includes("--check")) {
    if (!fs.readFileSync(output.path).equals(Buffer.from(output.contents))) throw new Error("Memory core bundle is stale");
  } else {
    fs.mkdirSync(path.dirname(output.path), { recursive: true });
    fs.writeFileSync(output.path, output.contents);
  }
  console.log(JSON.stringify({ revision, inputs: Object.keys(result.metafile.inputs).length, bytes: output.contents.length, sha256: hash(output.contents), checked: args.includes("--check") }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
