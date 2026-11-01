"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { unzipSync } = require("fflate");
const { portableSkillManifest } = require("./skill-package-format");
const { scanPackage } = require("./native-skill-store");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const RELEASE = require("./data/lark-cli-release.json");

const exec = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SKILLS_BYTES = 16 * 1024 * 1024;
const DEADLINE_MS = 90 * 60 * 1000;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const fail = code => { throw serviceError(code, code); };

function installerEnvironment(homeDir, env = process.env) {
  // No provider keys or application control-plane credentials reach curl or the CLI.
  const result = { HOME: homeDir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (typeof env[key] === "string") result[key] = env[key];
  }
  return result;
}

async function download(url, destination, { signal, env }) {
  try {
    await exec("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error",
      "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3",
      "--connect-timeout", "60", "--max-time", String(DEADLINE_MS / 1000),
      "--max-filesize", String(MAX_DOWNLOAD_BYTES), "--output", destination, url],
    { env, signal, timeout: DEADLINE_MS, maxBuffer: 64 * 1024 });
    fs.chmodSync(destination, 0o600);
  } catch { fail(signal.aborted ? "LARK_CLI_INTERRUPTED" : "LARK_CLI_DOWNLOAD_FAILED"); }
}

function verifiedArchive(file, expectedHash) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_DOWNLOAD_BYTES) fail("LARK_CLI_INTEGRITY_FAILED");
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expectedHash) fail("LARK_CLI_INTEGRITY_FAILED");
  return bytes;
}

function extractSkills(bytes, destination, release = RELEASE, licensePath = null) {
  const prefix = `cli-${release.commit}/skills/`;
  const licenseName = `cli-${release.commit}/LICENSE`;
  let size = 0, count = 0;
  const files = unzipSync(bytes, { filter(entry) {
    if (licensePath && entry.name === licenseName) {
      if (entry.originalSize > 64 * 1024) fail("LARK_CLI_INTEGRITY_FAILED");
      return true;
    }
    if (!entry.name.startsWith(prefix) || entry.name.endsWith("/")) return false;
    const parts = entry.name.slice(prefix.length).split("/");
    if (parts.length < 2 || parts.length > 12 || !/^lark-[a-z0-9-]+$/u.test(parts[0])
      || parts.some(part => !part || part === "." || part === ".." || /[\\\0]/u.test(part) || part.length > 255)
      || entry.originalSize > 4 * 1024 * 1024 || ++count > 2048
      || (size += entry.originalSize) > MAX_SKILLS_BYTES) fail("LARK_CLI_INTEGRITY_FAILED");
    return true;
  } });
  if (licensePath && !files[licenseName]) fail("LARK_CLI_INTEGRITY_FAILED");
  for (const [name, content] of Object.entries(files)) {
    if (name === licenseName) { fs.writeFileSync(licensePath, content, { flag: "wx", mode: 0o600 }); continue; }
    const target = path.join(destination, name.slice(prefix.length));
    ensurePrivateDirectoryTree(path.dirname(target), destination);
    fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  }
  const names = fs.readdirSync(destination).sort();
  if (names.length !== release.skillCount || !names.includes("lark-shared")
    || names.some(name => !fs.existsSync(path.join(destination, name, "SKILL.md")))) fail("LARK_CLI_INTEGRITY_FAILED");
  return names;
}

function createSkillAdapters(root, names, release = RELEASE) {
  const executable = path.join(root, "bin", "lark-cli");
  return names.map(name => {
    const packageRoot = path.join(root, "skills", name);
    const content = fs.readFileSync(path.join(packageRoot, "SKILL.md"), "utf8");
    const manifest = portableSkillManifest(content, sha256(content));
    if (manifest.name !== name) fail("LARK_CLI_INTEGRITY_FAILED");
    const header = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content);
    const guidance = ["", "## Shoggoth installation", "",
      `This official Feishu / Lark skill belongs to the CLI connector (CLI ${release.version}).`,
      `Use ${shellQuote(executable)} in place of every lark-cli command below.`,
      `The complete official skill package, including scripts, assets and relative references, is at ${shellQuote(packageRoot)}. Resolve relative paths below against that directory.`,
      `For markdown references you can also run: ${shellQuote(executable)} skills read ${name}/<relative-path>`,
      `Read shared rules before using any business command: ${shellQuote(executable)} skills read lark-shared`,
      `When running helper scripts that invoke lark-cli, prefix that command with PATH=${shellQuote(path.dirname(executable))}:"$PATH".`,
      "Manage installation and removal in Shoggoth's Connectors page. Account configuration and sign-in use the official CLI; installing this skill does not authorize an account.", "", ""].join("\n");
    const adapterRoot = path.join(root, "adapters", name);
    ensurePrivateDirectoryTree(adapterRoot, root);
    fs.writeFileSync(path.join(adapterRoot, "SKILL.md"), content.slice(0, header[0].length) + guidance + content.slice(header[0].length), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(adapterRoot, "skill.json"), JSON.stringify({ ...manifest,
      version: release.skillVersion, description: `飞书 / Lark · ${manifest.description}` }), { flag: "wx", mode: 0o600 });
    const scan = scanPackage(adapterRoot);
    return { id: scan.manifest.id, version: scan.manifest.version, contentHash: scan.contentHash, sourcePath: adapterRoot };
  });
}

async function prepareLarkCli({ root, homeDir, platform = process.platform, arch = process.arch,
  signal, onStage, release = RELEASE, downloadFile = download, env = process.env }) {
  const archive = release.archives[`${platform}-${arch}`];
  if (!archive) fail("LARK_CLI_UNSUPPORTED");
  const childEnv = installerEnvironment(homeDir, env);
  const cliArchive = path.join(root, ".cli.tar.gz"), skillsArchive = path.join(root, ".skills.zip");
  onStage("downloadCli");
  await downloadFile(`${release.repository}/releases/download/v${release.version}/${archive.name}`, cliArchive, { signal, env: childEnv });
  signal.throwIfAborted();
  verifiedArchive(cliArchive, archive.sha256);
  const binDir = path.join(root, "bin");
  ensurePrivateDirectoryTree(binDir, root);
  // The archive is authenticated before extraction. Only the single binary is extracted.
  await exec("/usr/bin/tar", ["-xzf", cliArchive, "-C", binDir, "lark-cli"], { env: childEnv, signal, timeout: 180_000, maxBuffer: 64 * 1024 });
  const executable = path.join(binDir, "lark-cli"), stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("LARK_CLI_INTEGRITY_FAILED");
  fs.chmodSync(executable, 0o700);
  onStage("downloadSkills");
  await downloadFile(`https://codeload.github.com/larksuite/cli/zip/${release.commit}`, skillsArchive, { signal, env: childEnv });
  signal.throwIfAborted();
  onStage("verify");
  const skillsDir = path.join(root, "skills");
  ensurePrivateDirectoryTree(skillsDir, root);
  const names = extractSkills(verifiedArchive(skillsArchive, release.skillsArchiveSha256), skillsDir, release, path.join(root, "LICENSE"));
  const { stdout } = await exec(executable, ["--version"], { env: childEnv, signal, timeout: 15_000, maxBuffer: 4096 });
  if (stdout.trim() !== `lark-cli version ${release.version}`) fail("LARK_CLI_INTEGRITY_FAILED");
  const skills = createSkillAdapters(root, names, release);
  fs.unlinkSync(cliArchive); fs.unlinkSync(skillsArchive);
  return { cliSha256: sha256(fs.readFileSync(executable)), skills };
}

module.exports = { RELEASE, DEADLINE_MS, prepareLarkCli, extractSkills, createSkillAdapters, installerEnvironment, sha256 };
