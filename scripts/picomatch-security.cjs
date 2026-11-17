"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// Both parsers implement the same extglob-close step. Keep upstream's safe
// rewrites and reject the unsupported repetition before it can produce a RegExp.
const anchor = "const analysis = analyzeRepeatedExtglob(body, opts);";
const guard = [
  "// Shoggoth security backport for CVE-2026-112366.",
  'if ((token.type === "plus" || token.type === "star") && !analysis.risky',
  '    && body.includes("*") && !isPlainBranch(body) && splitTopLevel(body).length === 1) {',
  '  throw new SyntaxError("Unsupported wildcard in repeated single-branch extglob");',
  "}",
];

const pico = {
  name: "picomatch", version: "4.0.7", file: "lib/parse.js", dev: true,
  integrity: "sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==",
  original: "4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4",
  patched: "fa04f0a8087d1114276651a824c1467c4d81b000d24b89741b5c3ec361ab6666",
  unchanged: {
    "package.json": "479b70b87aa7b44344d62c8a459ae7e53dd2bca6c61f1396bd55e63e9de73fc6",
    "index.js": "02ae26406508e28f9ba0865be16cf77f0b33de6c4d4d49c212c4176df1d5625a",
    "posix.js": "5695ff5dfcd5a338a40630bd506056f2950bcb08fe1cc068519cbbfe60add480",
    "lib/constants.js": "c28f952d2758261fe5428a121add485cc25b03e0193633f649de903dc0e5e222",
    "lib/picomatch.js": "fdd249d7ffff853f3bb1c77eafc8baa1a437bea85a94c35877b83c6a40d9ca94",
    "lib/scan.js": "6457a1764e5c2e543cc3a0c00ce12ebb3764097628868198370b64d4e642aaae",
    "lib/utils.js": "f04604f70cd1a3f6ace80b84766468674ff38b4bb83818d2ef1d81fc6355f935",
  },
};
const playwright = {
  name: "playwright", version: "1.64.0-alpha-1789764292000", file: "lib/matchers/expect.js", dev: false,
  integrity: "sha512-3Ngs4ERGdC912uW3srEDtNVey4u1wSaQ/EFcKhxMpz0by0K6nidaJgM087pLpJc1osytiVnL7ack5gvgPArPNw==",
  original: "6f6d406a411e9a3e0cdecff94dd3ffe4e42309c52fe422849bfc6ebc933fea57",
  patched: "77a294b2ba8f6cbe1ecdec63eaa00cf71e6afec93af9428db51750e81702dcb5",
  unchanged: { "package.json": "8b62490a181fd5a9824d398fce11f88d6a1840ec9a800b9383ded15be8fa6c95" },
};

function patchedSource(original) {
  const lines = original.toString("utf8").split("\n");
  const index = lines.findIndex(line => line.trim() === anchor);
  if (index < 0 || lines.some((line, n) => n !== index && line.trim() === anchor)) throw new Error("Unknown picomatch parser layout");
  const indent = lines[index].slice(0, lines[index].indexOf(anchor));
  lines.splice(index + 1, 0, ...guard.map(line => indent + line));
  return Buffer.from(lines.join("\n"));
}

function regularFile(file) {
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error(`Unexpected dependency path: ${file}`);
  return fs.readFileSync(file);
}

function secureInstall(directory, { apply = false, omitDev = false } = {}) {
  const root = fs.realpathSync(directory);
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const desktop = lock.packages?.[""]?.name === "shoggoth-desktop";
  if (!desktop && lock.packages?.[""]?.name !== "openclaw-manage-ui") throw new Error("Unknown picomatch install scope");
  const targets = desktop ? [pico, playwright] : [pico];
  const writes = [];
  for (const target of targets) {
    const location = "node_modules/" + target.name;
    const copies = Object.entries(lock.packages).filter(([name, entry]) =>
      name === location || name.endsWith("/" + location) || entry.name === target.name);
    const entry = lock.packages[location];
    if (copies.length !== 1 || entry?.version !== target.version || entry.integrity !== target.integrity
      || entry.resolved !== `https://registry.npmjs.org/${target.name}/-/${target.name}-${target.version}.tgz`
      || (entry.dev === true) !== target.dev || entry.devOptional || entry.link) throw new Error(`Review locked ${target.name} sources`);
    const dir = path.join(root, location);
    if (omitDev && target.dev && !fs.lstatSync(dir, { throwIfNoEntry: false })) continue;
    for (const [name, expected] of Object.entries(target.unchanged)) {
      if (sha256(regularFile(path.join(dir, name))) !== expected) throw new Error(`Unexpected ${location}/${name}`);
    }
    const file = path.join(dir, target.file);
    const original = regularFile(file);
    const current = sha256(original);
    if (current === target.patched) continue;
    if (!apply || current !== target.original) throw new Error(`Missing reviewed patch or unexpected bytes in ${location}/${target.file}`);
    const bytes = patchedSource(original);
    if (sha256(bytes) !== target.patched) throw new Error(`Incorrect security patch for ${location}/${target.file}`);
    writes.push({ file, bytes });
  }
  for (const { file, bytes } of writes) {
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, bytes, { flag: "wx", mode: fs.statSync(file).mode & 0o777 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  return { desktop, packages: lock.packages };
}

function verifyPackagedMatcher(appPath) {
  const { extractFile, statFile } = require("@electron/asar");
  const archive = path.join(appPath, "Contents", "Resources", "app.asar");
  const filename = "node_modules/playwright/" + playwright.file;
  if (statFile(archive, filename).unpacked !== true
    || sha256(extractFile(archive, filename)) !== playwright.patched
    || sha256(regularFile(path.join(fs.realpathSync(archive) + ".unpacked", filename))) !== playwright.patched) {
    throw new Error("Packaged Playwright matcher is missing its reviewed picomatch patch");
  }
}

if (require.main === module) {
  try {
    const [command, directory = ".", ...extra] = process.argv.slice(2);
    if (!["install", "apply", "check"].includes(command) || extra.length) throw new Error("Usage: picomatch-security.cjs install|apply|check [directory]");
    const omitDev = command === "install" && (process.env.NODE_ENV === "production" || /\bdev\b/u.test(process.env.npm_config_omit || ""));
    secureInstall(directory, { apply: command !== "check", omitDev });
    console.log("Verified picomatch security patch in " + directory);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { advisory, pico, playwright, patchedSource, secureInstall, verifyPackagedMatcher };
