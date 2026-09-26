"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

/** @typedef {{ id: string, label: string, order: number }} CliCategoryDef */
/** @typedef {{ name: string, path: string, category: string, version?: string | null, source?: string, userInstalled?: boolean }} CliTool */

/** @type {CliCategoryDef[]} */
const CLI_CATEGORIES = [
  { id: "ai", label: "AI 与助手", order: 1 },
  { id: "package", label: "包管理与运行时", order: 2 },
  { id: "dev", label: "开发与构建", order: 3 },
  { id: "cloud", label: "云与 DevOps", order: 4 },
  { id: "language", label: "语言工具链", order: 5 },
  { id: "system", label: "系统与网络", order: 6 },
  { id: "other", label: "其他", order: 99 },
];

const CATEGORY_BY_ID = new Map(CLI_CATEGORIES.map((entry) => [entry.id, entry]));

/** @type {Array<{ id: string, patterns: RegExp[] }>} */
const CATEGORY_RULES = [
  {
    id: "ai",
    patterns: [
      /^(claude|codex|cursor|openclaw|aider|copilot|gemini|ollama|lmstudio|llama|mlx|vllm|sgpt|fabric|pi)$/i,
      /^(chatgpt|gpt|anthropic|openai-cli|cursor-agent|agent)$/i,
    ],
  },
  {
    id: "package",
    patterns: [
      /^(npm|pnpm|yarn|bun|node|npx|corepack|pip|pip3|poetry|uv|conda|mamba|brew|port|gem|cargo|rustup|go)$/i,
      /^(composer|pear|pecl|nix|nix-env|flatpak|snap|mas|pipx|virtualenv|venv)$/i,
    ],
  },
  {
    id: "dev",
    patterns: [
      /^(git|gh|hub|docker|podman|compose|kubectl|helm|k9s|kind|minikube|colima|lima|make|cmake|ninja|gradle|mvn|ant)$/i,
      /^(terraform|tofu|pulumi|ansible|vagrant|packer|skaffold|tilt|act|pre-commit|husky|eslint|prettier|biome|oxlint)$/i,
      /^(vite|webpack|rollup|esbuild|turbo|nx|lerna|jest|vitest|playwright|cypress|pytest|rg|ripgrep|fd|bat|fzf|jq|yq)$/i,
    ],
  },
  {
    id: "cloud",
    patterns: [
      /^(aws|gcloud|az|azure|doctl|fly|flyctl|vercel|netlify|heroku|railway|render|supabase|firebase|cloudflared|wrangler)$/i,
      /^(kubectl|eksctl|gke-gcloud|terraform|pulumi|serverless|sam|cdk|pulumi|sst|pulumi)$/i,
    ],
  },
  {
    id: "language",
    patterns: [
      /^(python|python3|python2|node|deno|bun|go|rustc|cargo|java|javac|kotlin|kotlinc|scala|scalac|ruby|irb|perl|php|lua|swift|swiftc|clang|clang\+\+|gcc|g\+\+)$/i,
      /^(tsc|ts-node|tsx|babel|esbuild|swift|dart|flutter|elixir|mix|erlang|erl|haskell|ghc|cabal|stack|zig|nim|crystal)$/i,
    ],
  },
  {
    id: "system",
    patterns: [
      /^(curl|wget|http|httpie|xh|ssh|scp|rsync|ping|dig|nslookup|traceroute|nc|netcat|telnet|openssl|gpg|ssh-keygen)$/i,
      /^(tar|zip|unzip|gzip|gunzip|xz|7z|chmod|chown|ls|cp|mv|rm|mkdir|find|grep|sed|awk|sort|uniq|head|tail|cat|less|more|vim|nvim|nano|code|cursor)$/i,
      /^(htop|top|ps|kill|pkill|lsof|df|du|mount|diskutil|system_profiler|defaults|launchctl|pmset|osascript)$/i,
    ],
  },
];

/**
 * @param {string} name
 * @returns {string}
 */
function categorizeCli(name) {
  const base = String(name || "").trim();
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(base))) {
      return rule.id;
    }
  }
  return "other";
}

/**
 * @returns {string[]}
 */
function getPathDirs() {
  const raw = process.env.PATH || "";
  return [...new Set(raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Locations the OS ships — never "installed by the user".
const SYSTEM_DIR_PREFIXES = ["/bin/", "/usr/bin/", "/sbin/", "/usr/sbin/", "/Library/Apple/", "/System/"];

/** @param {string} p @returns {boolean} an OS-shipped location (not user-installed) */
function isSystemToolPath(p) {
  return SYSTEM_DIR_PREFIXES.some((pre) => p.startsWith(pre));
}

/** @param {string} p @returns {string} symlink target, or "" if not a link / unreadable */
function readlinkSafe(p) {
  try { return fs.readlinkSync(p); } catch { return ""; }
}

/**
 * Collect "what the user actively installed" hints. Currently Homebrew
 * top-level formulae (`brew leaves` = installed on request, NOT pulled in as a
 * transitive dependency). Best-effort + bounded: if brew is missing/slow/fails
 * the set stays empty and classifyTool falls back to NOT over-filtering brew bins.
 * @returns {Promise<{brewLeaves: Set<string>}>}
 */
async function collectInstallHints() {
  const brewLeaves = new Set();
  for (const brewBin of ["brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    try {
      const { stdout } = await execFileAsync(brewBin, ["leaves"], { timeout: 5000, maxBuffer: 1024 * 1024 });
      for (const line of String(stdout).split(/\r?\n/)) {
        const short = line.trim().split("/").pop(); // tap/owner/name → name
        if (short) brewLeaves.add(short);
      }
      break; // succeeded — don't try the other brew locations
    } catch { /* try next brew location */ }
  }
  return { brewLeaves };
}

/**
 * Classify one executable by install provenance → { source, userInstalled }.
 * userInstalled = the user (or a tool they installed) put it here on purpose;
 * excludes OS built-ins, version-manager shims, and transitive Homebrew deps.
 * @param {string} fullPath
 * @param {{brewLeaves: Set<string>}} hints
 * @returns {{source: string, userInstalled: boolean}}
 */
function classifyTool(fullPath, hints) {
  if (isSystemToolPath(fullPath)) return { source: "system", userInstalled: false };
  if (fullPath.includes("/.pyenv/")) return { source: "pyenv", userInstalled: false };
  if (fullPath.includes("/opt/homebrew/")) {
    const target = readlinkSafe(fullPath);
    if (target.includes("/Cellar/")) {
      const formula = target.split("/Cellar/")[1].split("/")[0];
      const known = hints.brewLeaves.size > 0;
      // brew unavailable → keep all (don't silently drop everything); otherwise
      // only top-level formulae count as user-installed, deps fall to homebrew-dep.
      const isLeaf = !known || hints.brewLeaves.has(formula) || hints.brewLeaves.has(formula.split("@")[0]);
      return { source: isLeaf ? "homebrew" : "homebrew-dep", userInstalled: isLeaf };
    }
    // npm global bins live in opt/homebrew/bin too (prefix=/opt/homebrew),
    // symlinked into the node package, not Cellar.
    if (target.includes("/lib/node_modules/")) return { source: "npm", userInstalled: true };
    return { source: "homebrew", userInstalled: true };
  }
  if (fullPath.includes("/.cargo/")) return { source: "cargo", userInstalled: true };
  if (fullPath.includes("/.local/")) return { source: "local", userInstalled: true };
  return { source: "other", userInstalled: true };
}

/**
 * @returns {Promise<CliTool[]>}
 */
// Cache the $PATH scan: `brew leaves` + statting every executable is ~2s, and the
// CLI page re-scans on every visit (it remounts on tab switch). Signature = each
// PATH dir's mtime (a new install/uninstall bumps its bin dir), 60s TTL backstop.
// R106 SWR：过期时先回旧结果、后台单飞重扫——除进程首扫外请求不再等扫描。
let _scanCache = null; // { sig, at, tools }
let _scanInFlight = null; // Promise | null

async function scanInstalledClis() {
  const dirs = getPathDirs();
  const sigParts = [];
  for (const dir of dirs) {
    try { sigParts.push(`${dir}:${Math.round(fs.statSync(dir).mtimeMs)}`); }
    catch { /* dir gone from $PATH */ }
  }
  const sig = sigParts.join("|");
  if (_scanCache && _scanCache.sig === sig && Date.now() - _scanCache.at < 60_000) {
    return _scanCache.tools;
  }
  if (_scanCache) {
    if (!_scanInFlight) {
      _scanInFlight = new Promise((resolve) => setImmediate(resolve))
        .then(() => scanClis(dirs, sig))
        .catch((err) => console.error("[cli-scanner] rescan failed:", err?.message || err))
        .finally(() => { _scanInFlight = null; });
    }
    return _scanCache.tools;
  }
  return scanClis(dirs, sig); // 进程首扫：只能等
}

/**
 * @param {string[]} dirs
 * @param {string} sig
 * @returns {Promise<CliTool[]>}
 */
async function scanClis(dirs, sig) {
  const seen = new Set();
  /** @type {CliTool[]} */
  const tools = [];
  const hints = await collectInstallHints();

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      const fullPath = path.join(dir, name);
      if (!isExecutableFile(fullPath)) {
        continue;
      }
      seen.add(key);
      const { source, userInstalled } = classifyTool(fullPath, hints);
      tools.push({
        name,
        path: fullPath,
        category: categorizeCli(name),
        source,
        userInstalled,
      });
    }
  }

  tools.sort((left, right) => {
    const leftCat = CATEGORY_BY_ID.get(left.category)?.order ?? 99;
    const rightCat = CATEGORY_BY_ID.get(right.category)?.order ?? 99;
    if (leftCat !== rightCat) {
      return leftCat - rightCat;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  _scanCache = { sig, at: Date.now(), tools };
  return tools;
}

/**
 * @param {string} cliPath
 * @returns {Promise<string | null>}
 */
async function resolveCliVersion(cliPath) {
  // Flags only — never a bare `version` operand. Tools that reject all three
  // flags are often ones that treat the first operand as a FILENAME, so
  // `version` would run `rm version` / `touch version` / `mkdir version`
  // against the cwd. Losing the version string for such a tool beats
  // silently creating or deleting files.
  const candidates = [
    ["--version"],
    ["-V"],
    ["-v"],
  ];

  for (const args of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(cliPath, args, {
        timeout: 2500,
        maxBuffer: 64 * 1024,
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
      });
      const text = String(stdout || stderr || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (text) {
        return text.slice(0, 160);
      }
    } catch {
      /* try next flag */
    }
  }

  return null;
}

/**
 * Resolve real reference info for one CLI on demand (lazy; fetched when the
 * detail drawer opens, one tool at a time). Same execFile safety envelope as
 * resolveCliVersion (bounded timeout + maxBuffer + CI/NO_COLOR env).
 * @param {string} name
 * @param {string} cliPath
 * @returns {Promise<{ version: string | null, summary: string | null, help: string | null }>}
 */
async function resolveCliInfo(name, cliPath) {
  const execOpts = {
    timeout: 2500,
    maxBuffer: 256 * 1024,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  };

  async function runHelp() {
    try {
      const { stdout, stderr } = await execFileAsync(cliPath, ["--help"], execOpts);
      const text = String(stdout || stderr || "").trim();
      return text ? text.slice(0, 8000) : null;
    } catch (err) {
      // Some CLIs print usage then exit non-zero; execFile rejects but the
      // captured output still lives on the error object.
      const text = String(err?.stdout || err?.stderr || "").trim();
      return text ? text.slice(0, 8000) : null;
    }
  }

  async function runWhatis() {
    try {
      const { stdout } = await execFileAsync("whatis", [name], execOpts);
      const line = String(stdout || "")
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find(Boolean);
      if (!line || /nothing appropriate/i.test(line)) {
        return null;
      }
      const dash = line.indexOf(" - ");
      return (dash >= 0 ? line.slice(dash + 3) : line).trim().slice(0, 200) || null;
    } catch {
      return null;
    }
  }

  const [version, help, whatis] = await Promise.all([
    resolveCliVersion(cliPath),
    runHelp(),
    runWhatis(),
  ]);

  let summary = whatis;
  if (!summary && help) {
    summary =
      help
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" ")
        .slice(0, 200) || null;
  }

  return { version, summary: summary || null, help };
}

module.exports = {
  CLI_CATEGORIES,
  categorizeCli,
  scanInstalledClis,
  resolveCliVersion,
  resolveCliInfo,
};
