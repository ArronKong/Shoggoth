"use strict";
// Main only discovers cheap paths. All closure hashing/copying, native checks,
// and immutable publication below require a private Worker and fixed policy.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { isMainThread } = require("node:worker_threads");
const { snapshotRuntimeTree, hashFile } = require("./managed-plugin-host-runtime");
const pins = require("./managed-hermes-runtime-pins.json");
const pin = pins.hosts.hermes, normalizationPin = pins.provenance.inputNormalization;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const demand = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const excluded = name => name === "__pycache__" || name === ".DS_Store" || name === ".lock" || /\.py[co]$/u.test(name);
const cleanEnv = { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: "", PYTHONHOME: "" };
function resolveManagedHermesProductInputs({ hermesBin = "hermes", runtimePath = process.env.PATH,
  homeDir = os.homedir(), architecture = process.arch } = {}) {
  const fail = () => { throw Object.assign(new Error("MANAGED_HERMES_LOCAL_RUNTIME_UNAVAILABLE"), {
    code: "MANAGED_HERMES_LOCAL_RUNTIME_UNAVAILABLE", status: 503,
  }); };
  if (typeof hermesBin !== "string" || !hermesBin || !path.isAbsolute(homeDir || "") || architecture !== pin.interpreter.architecture) fail();
  const paths = String(runtimePath || "").split(path.delimiter).filter(value => path.isAbsolute(value));
  const entries = path.isAbsolute(hermesBin) ? [hermesBin] : paths.map(root => path.join(root, hermesBin));
  const roots = [path.join(homeDir, ".hermes", "hermes-agent")];
  for (const entry of entries) try {
    const actual = fs.realpathSync(entry);
    if (path.basename(path.dirname(actual)) === "bin" && path.basename(path.dirname(path.dirname(actual))) === "venv") {
      roots.unshift(path.dirname(path.dirname(path.dirname(actual))));
    }
  } catch { /* missing launchers cannot produce readiness */ }
  for (const root of roots) try {
    const sourceRoot = fs.realpathSync(root), interpreterPath = path.join(sourceRoot, "venv/bin/python");
    const executable = fs.statSync(fs.realpathSync(interpreterPath));
    if (!executable.isFile() || !(executable.mode & 0o111)
      || !fs.statSync(path.join(sourceRoot, ".git")).isDirectory()
      || !fs.statSync(path.join(sourceRoot, "hermes_cli/main.py")).isFile()
      || !fs.statSync(path.join(sourceRoot, "hermes_cli/web_dist/index.html")).isFile()
      || !fs.statSync(path.join(sourceRoot, ".hermes-runtime/python")).isDirectory()) continue;
    // Fixed commit/complete Python+venv+web closure verification runs in Worker.
    return Object.freeze({ sourceRoot, interpreterPath, architecture, inputMode: "original" });
  } catch { /* absence/unsupported install remains explicitly unavailable */ }
  fail();
}
function privateDirectory(root, create = false) {
  demand(path.isAbsolute(root), "MANAGED_HERMES_INPUT_DIRECTORY_INVALID");
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  const stat = fs.lstatSync(root);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (!process.getuid || stat.uid === process.getuid()) && fs.realpathSync(root) === root, "MANAGED_HERMES_INPUT_DIRECTORY_UNSAFE");
  return root;
}
function pythonProbe(executable, cwd) {
  return JSON.parse(execFileSync(executable, ["-I", "-B", "-c",
    "import sys,json,platform,importlib.util; print(json.dumps({'version':platform.python_version(),'architecture':{'arm64':'arm64','aarch64':'arm64','x86_64':'x64'}.get(platform.machine(),platform.machine()),'platform':sys.platform,'executable':sys.executable,'baseExecutable':sys._base_executable,'prefix':sys.prefix,'basePrefix':sys.base_prefix,'paths':sys.path,'uvicorn':importlib.util.find_spec('uvicorn') is not None,'hermesOrigin':importlib.util.find_spec('hermes_cli').origin}))"],
  { cwd, env: cleanEnv, encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] }));
}
function assertClosure(root, probe) {
  root = fs.realpathSync(root);
  const owned = value => typeof value === "string" && inside(root, path.resolve(value))
    && (!fs.existsSync(value) || inside(root, fs.realpathSync(value)));
  demand(inside(root, fs.realpathSync(probe.executable)) && inside(root, fs.realpathSync(probe.prefix))
    && inside(root, fs.realpathSync(probe.basePrefix)) && probe.paths.filter(Boolean).every(owned)
    && owned(probe.hermesOrigin) && probe.version === pin.interpreter.version
    && probe.architecture === pin.interpreter.architecture && probe.platform === pin.interpreter.platform && probe.uvicorn,
  "HERMES_RUNTIME_NOT_SELF_CONTAINED");
}
function collect(root, checkpoint) {
  const rows = [];
  const walk = (directory, prefix) => {
    checkpoint(); const before = fs.lstatSync(directory);
    demand(before.isDirectory() && !before.isSymbolicLink(), "HERMES_INPUT_DIRECTORY_CHANGED");
    for (const name of fs.readdirSync(directory).sort()) {
      checkpoint(); if (excluded(name)) continue;
      const file = path.join(directory, name), rel = prefix ? prefix + "/" + name : name, stat = fs.lstatSync(file);
      demand((stat.mode & 2) === 0 || stat.isSymbolicLink(), "HERMES_INPUT_WORLD_WRITABLE");
      if (stat.isDirectory()) { rows.push({ path: rel, kind: "directory" }); walk(file, rel); }
      else if (stat.isSymbolicLink()) {
        const real = fs.realpathSync(file); demand(inside(root, real), "HERMES_DEPENDENCY_LINK_ESCAPE");
        rows.push({ path: rel, kind: "link", target: path.relative(root, real).split(path.sep).join("/") });
      } else {
        demand(stat.isFile() && stat.nlink >= 1, "HERMES_INPUT_SPECIAL_FILE");
        rows.push({ path: rel, kind: "file", executable: !!(stat.mode & 73), size: stat.size, sha256: hashFile(file) });
      }
    }
    const after = fs.lstatSync(directory);
    demand(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      "HERMES_INPUT_DIRECTORY_CHANGED");
  };
  walk(root, ""); return { records: rows, sha256: sha(JSON.stringify(rows)), bytes: rows.reduce((n, row) => n + (row.size || 0), 0) };
}
function copyRecords(source, target, inventory, checkpoint) {
  checkpoint(); fs.mkdirSync(target, { mode: 0o700 });
  for (const item of inventory.records) {
    checkpoint(); const dest = path.join(target, item.path);
    if (item.kind === "directory") fs.mkdirSync(dest, { mode: 0o700 });
    else if (item.kind === "link") fs.symlinkSync(path.relative(path.dirname(dest), path.join(target, item.target)), dest);
    else {
      demand(hashFile(path.join(source, item.path)) === item.sha256, "HERMES_SOURCE_CHANGED"); checkpoint();
      fs.copyFileSync(path.join(source, item.path), dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, item.executable ? 0o700 : 0o600);
      demand(hashFile(dest) === item.sha256, "HERMES_COPY_CHANGED");
    }
  }
}
function parseMach(file) {
  const text = execFileSync("/usr/bin/otool", ["-l", file], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  const blocks = text.split(/Load command \d+\n/u).slice(1);
  return { deps: blocks.filter(value => /cmd LC_(?:LOAD|LOAD_WEAK|REEXPORT|LAZY_LOAD)_DYLIB\n/u.test(value)).map(value => value.match(/name (.*?) \(offset/u)[1]),
    rpaths: blocks.filter(value => /cmd LC_RPATH\n/u.test(value)).map(value => value.match(/path (.*?) \(offset/u)[1]) };
}
function auditNative(root, executable, checkpoint) {
  const files = [], rows = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory)) {
      checkpoint(); const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && stat.size >= 4) {
        const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(4);
        try { fs.readSync(fd, bytes, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (["cffaedfe", "cefaedfe", "cafebabe", "bebafeca", "feedfacf", "feedface"].includes(bytes.toString("hex"))) files.push(file);
      }
    }
  };
  walk(root);
  for (const file of files.sort()) {
    checkpoint(); const value = parseMach(file);
    const expand = item => item.replace(/^@loader_path/u, path.dirname(file)).replace(/^@executable_path/u, path.dirname(fs.realpathSync(executable)));
    const system = item => item.startsWith("/usr/lib/") || item.startsWith("/System/Library/");
    for (const rpath of value.rpaths) {
      const location = expand(rpath);
      demand(!path.isAbsolute(location) || inside(root, path.resolve(location)) || system(location), "HERMES_NATIVE_RPATH_ESCAPE");
    }
    for (const dep of value.deps) {
      if (system(dep)) continue;
      const candidates = dep.startsWith("@rpath/") ? value.rpaths.map(rpath => path.resolve(expand(rpath), dep.slice(7))) : [path.resolve(expand(dep))];
      demand(candidates.some(location => fs.existsSync(location) && inside(root, fs.realpathSync(location))), "HERMES_NATIVE_DEPENDENCY_ESCAPE");
    }
    rows.push({ path: path.relative(root, file).split(path.sep).join("/"), sha256: hashFile(file), deps: value.deps, rpaths: value.rpaths });
  }
  return rows;
}
async function archive(source, output, checkpoint, signal) {
  checkpoint();
  await new Promise((resolve, reject) => {
    const git = spawn("/usr/bin/git", ["archive", "--format=tar", pin.hostVersion], { cwd: source, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("/usr/bin/tar", ["-x", "-C", output], { env: cleanEnv, stdio: ["pipe", "ignore", "pipe"] });
    git.stdout.pipe(tar.stdin); git.stderr.resume(); tar.stderr.resume();
    let gitCode, tarCode, ended = false, originalError = null;
    const fail = error => { if (ended) return; originalError ||= error; git.kill("SIGTERM"); tar.kill("SIGTERM"); };
    const settle = () => { if (ended || gitCode === undefined || tarCode === undefined) return; ended = true;
      clearInterval(timer); signal?.removeEventListener("abort", abort);
      if (originalError) reject(originalError);
      else if (gitCode === 0 && tarCode === 0) resolve(); else reject(Object.assign(new Error("HERMES_ARCHIVE_FAILED"), { code: "HERMES_ARCHIVE_FAILED" })); };
    const abort = () => fail(Object.assign(new Error("MANAGED_WORKER_OPERATION_RETIRED"), { code: "MANAGED_WORKER_OPERATION_RETIRED" }));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setInterval(() => { try { checkpoint(); } catch (error) { fail(error); } }, 25);
    git.on("error", error => { gitCode = -1; fail(error); settle(); }); tar.on("error", error => { tarCode = -1; fail(error); settle(); });
    tar.stdin.on("error", () => fail(Object.assign(new Error("HERMES_ARCHIVE_FAILED"), { code: "HERMES_ARCHIVE_FAILED" })));
    git.on("close", code => { gitCode = code; settle(); }); tar.on("close", code => { tarCode = code; settle(); });
  }); checkpoint();
}
function notices(root, checkpoint) {
  const site = path.join(root, "venv/lib/python3.11/site-packages"), rows = [];
  for (const name of fs.readdirSync(site).sort()) {
    checkpoint(); if (!name.endsWith(".dist-info")) continue;
    const directory = path.join(site, name), metadata = path.join(directory, "METADATA"); if (!fs.existsSync(metadata)) continue;
    const text = fs.readFileSync(metadata, "utf8"), licenseFiles = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir)) {
      checkpoint(); const file = path.join(dir, entry), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file); else if (stat.isFile() && /license|notice|copying/iu.test(entry)) {
        licenseFiles.push({ path: path.relative(root, file).split(path.sep).join("/"), sha256: hashFile(file) });
      }
    } };
    walk(directory); rows.push({ name: text.match(/^Name: (.+)$/mu)?.[1] || name, version: text.match(/^Version: (.+)$/mu)?.[1] || null,
      declaredLicense: text.match(/^License(?:-Expression)?: (.+)$/mu)?.[1] || null, metadataSha256: hashFile(metadata), licenseFiles });
  }
  return { version: 1, scope: "Installed dependency metadata; retains notices but does not approve redistribution", distributions: rows };
}
function verifySource(source, resourcesRoot, checkpoint) {
  checkpoint(); demand(fs.realpathSync(source) === source, "HERMES_SOURCE_NOT_CANONICAL");
  const payload = path.join(resourcesRoot, "hermes/v1-c7c2df1");
  demand(hashFile(path.join(payload, "manifest.json")) === normalizationPin.selectionPayloadManifestSha256, "HERMES_SELECTION_PAYLOAD_CHANGED");
  const manifest = JSON.parse(fs.readFileSync(path.join(payload, "manifest.json"), "utf8"));
  const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: source, env: cleanEnv, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  demand(commit === pin.hostVersion && manifest.sourceCommit === commit, "HERMES_ORIGINAL_VERSION_UNPINNED");
  for (const item of manifest.files) {
    checkpoint(); demand(typeof item.path === "string" && !path.isAbsolute(item.path) && item.path.split("/").every(part => part && part !== ".." && part !== "."), "HERMES_INPUT_MANIFEST_INVALID");
    const input = path.join(source, item.path);
    demand(item.originalSha256 === null ? !fs.existsSync(input) : hashFile(input) === item.originalSha256, "HERMES_ORIGINAL_SOURCE_UNPINNED");
    demand(hashFile(path.join(payload, "patched", item.path)) === item.patchedSha256, "HERMES_SELECTION_PAYLOAD_CHANGED");
  }
}
function discardOwnedStage(root) {
  if (!fs.existsSync(root)) return;
  const loosen = directory => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    fs.chmodSync(directory, 0o700);
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(directory, name), childStat = fs.lstatSync(child);
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) loosen(child);
    }
  };
  loosen(root); fs.rmSync(root, { recursive: true, force: true });
}
function seal(root, checkpoint) {
  for (const name of fs.readdirSync(root)) {
    checkpoint(); const file = path.join(root, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) seal(file, checkpoint); else if (stat.isFile()) fs.chmodSync(file, stat.mode & 0o111 ? 0o500 : 0o400);
    else demand(stat.isSymbolicLink(), "HERMES_INPUT_SPECIAL_FILE");
  }
  checkpoint(); fs.chmodSync(root, 0o500);
}
// Uses exactly the frozen normalization bytes/provenance, with Worker-only
// checkpoints around every file/effect and immutable atomic input publication.
async function materializeManagedHermesInput({ sourceRoot, outputRoot, resourcesRoot, architecture,
  assertCurrent = () => {}, onProgress = () => {}, signal } = {}) {
  demand(!isMainThread, "MANAGED_HERMES_NORMALIZATION_WORKER_REQUIRED");
  demand(architecture === pin.interpreter.architecture && path.isAbsolute(sourceRoot || "")
    && path.isAbsolute(outputRoot || "") && path.isAbsolute(resourcesRoot || "") && !fs.existsSync(outputRoot), "MANAGED_HERMES_INPUT_INVALID");
  const checkpoint = () => { demand(!signal?.aborted, "MANAGED_WORKER_OPERATION_RETIRED"); assertCurrent(); };
  const progress = stage => { checkpoint(); onProgress(stage); };
  privateDirectory(path.dirname(outputRoot)); checkpoint();
  const source = fs.realpathSync(sourceRoot); verifySource(source, resourcesRoot, checkpoint);
  progress("verify_original_closure"); const initial = pythonProbe(path.join(source, "venv/bin/python"), source);
  const base = fs.realpathSync(initial.basePrefix); demand(inside(source, base), "HERMES_BASE_OUTSIDE_SOURCE");
  const deps = collect(path.join(source, "venv"), checkpoint), python = collect(base, checkpoint), web = collect(path.join(source, "hermes_cli/web_dist"), checkpoint);
  demand(normalizationPin.sourceDependencyTreeSha256 === deps.sha256 && normalizationPin.sourcePythonTreeSha256 === python.sha256
    && normalizationPin.webDistTreeSha256 === web.sha256, "HERMES_ORIGINAL_CLOSURE_UNPINNED");
  const tracked = execFileSync("/usr/bin/git", ["ls-tree", "-r", "-l", pin.hostVersion], { cwd: source, env: cleanEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
    .split("\n").reduce((n, line) => n + (Number(line.match(/^\d+ blob [a-f0-9]+\s+(\d+)\t/u)?.[1]) || 0), 0);
  const estimated = tracked + deps.bytes + python.bytes + web.bytes, disk = fs.statfsSync(path.dirname(outputRoot));
  demand(Number(disk.bavail) * Number(disk.bsize) >= 2 * 1024 ** 3 + 2 * estimated, "HERMES_DISK_PREFLIGHT_FAILED");
  checkpoint(); fs.mkdirSync(outputRoot, { mode: 0o700 });
  try {
    progress("archive_fixed_source"); await archive(source, outputRoot, checkpoint, signal);
    demand(!fs.existsSync(path.join(outputRoot, ".venv")), "HERMES_ARCHIVE_OLD_VENV");
    progress("copy_python_dependencies"); copyRecords(path.join(source, "venv"), path.join(outputRoot, "venv"), deps, checkpoint);
    progress("copy_python_base"); copyRecords(base, path.join(outputRoot, "python"), python, checkpoint);
    const webDest = path.join(outputRoot, "hermes_cli/web_dist");
    if (fs.existsSync(webDest)) { checkpoint(); fs.rmSync(webDest, { recursive: true }); }
    copyRecords(path.join(source, "hermes_cli/web_dist"), webDest, web, checkpoint);
    progress("normalize_fixed_anchors");
    const cfg = path.join(outputRoot, "venv/pyvenv.cfg"), cfgBefore = hashFile(cfg);
    fs.writeFileSync(cfg, "implementation = CPython\nversion_info = 3.11\ninclude-system-site-packages = false\nrelocatable = true\n");
    const executable = path.join(outputRoot, "venv/bin/python"); fs.unlinkSync(executable); fs.symlinkSync("../../python/bin/python3.11", executable);
    const finder = path.join(outputRoot, "venv/lib/python3.11/site-packages/__editable___hermes_agent_0_21_4_finder.py"), finderBefore = hashFile(finder);
    let text = fs.readFileSync(finder, "utf8");
    demand(text.includes(source + "/") && text.includes("PATH_PLACEHOLDER = '__editable__.hermes_agent-0.21.4.finder' + \".__path_hook__\""), "HERMES_EDITABLE_ANCHOR_MISMATCH");
    text = text.replace(/MAPPING: dict\[str, str\] = (.+)\n/u, (_, literal) => "_ROOT = Path(__file__).resolve().parents[4]\nMAPPING: dict[str, str] = {key: str(_ROOT / value.removeprefix(" + JSON.stringify(source + "/") + ")) for key, value in " + literal + ".items()}\n")
      .replace(/NAMESPACES: dict\[str, list\[str\]\] = (.+)\n/u, (_, literal) => "NAMESPACES: dict[str, list[str]] = {key: [str(_ROOT / value.removeprefix(" + JSON.stringify(source + "/") + ")) for value in values] for key, values in " + literal + ".items()}\n");
    text = text.split(source + "/").join("").replace("value.removeprefix(\"\")", "value")
      .replace("PATH_PLACEHOLDER = '__editable__.hermes_agent-0.21.4.finder' + \".__path_hook__\"", "PATH_PLACEHOLDER = str(_ROOT / '.hermes-editable-finder')");
    demand(!text.includes(source), "HERMES_EDITABLE_PATH_REMAINS"); fs.writeFileSync(finder, text);
    const jpeg = path.join(outputRoot, "venv/lib/python3.11/site-packages/PIL/.dylibs/libjpeg.62.4.0.dylib"), jpegBefore = hashFile(jpeg);
    const foreign = "/Users/runner/work/Pillow/Pillow/build/deps/darwin/lib";
    demand(parseMach(jpeg).rpaths.join("\n") === foreign, "HERMES_NATIVE_NORMALIZATION_ANCHOR"); checkpoint();
    execFileSync("/usr/bin/install_name_tool", ["-delete_rpath", foreign, jpeg], { stdio: "ignore", timeout: 10000 }); checkpoint();
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", jpeg], { stdio: "ignore", timeout: 10000 });
    const note = notices(outputRoot, checkpoint);
    fs.writeFileSync(path.join(outputRoot, "hermes-managed-dependency-notices.json"), JSON.stringify(note, null, 2) + "\n");
    const normalized = { version: 1, sourceCommit: pin.hostVersion, selectionPayloadManifestSha256: normalizationPin.selectionPayloadManifestSha256,
      exclude: ["old .venv (not archived)", "__pycache__", "*.pyc", "*.pyo", ".lock", ".DS_Store"],
      sourceDependencyTreeSha256: deps.sha256, sourcePythonTreeSha256: python.sha256, webDistTreeSha256: web.sha256,
      normalized: [{ path: "venv/pyvenv.cfg", before: cfgBefore, after: hashFile(cfg) },
        { path: path.relative(outputRoot, finder), before: finderBefore, after: hashFile(finder) },
        { path: path.relative(outputRoot, jpeg), before: jpegBefore, after: hashFile(jpeg) },
        { path: "venv/bin/python", target: "../../python/bin/python3.11" }],
      nativeFiles: auditNative(outputRoot, executable, checkpoint).length, distributions: note.distributions.length };
    fs.writeFileSync(path.join(outputRoot, "hermes-managed-input-provenance.json"), JSON.stringify(normalized, null, 2) + "\n");
    progress("verify_normalized_closure"); assertClosure(outputRoot, pythonProbe(executable, outputRoot)); checkpoint();
    const tree = snapshotRuntimeTree(outputRoot); checkpoint(); demand(tree.sha256 === pin.inputTreeSha256, "HERMES_NORMALIZED_INPUT_UNPINNED");
    demand(collect(path.join(source, "venv"), checkpoint).sha256 === deps.sha256 && collect(base, checkpoint).sha256 === python.sha256
      && collect(path.join(source, "hermes_cli/web_dist"), checkpoint).sha256 === web.sha256, "HERMES_SOURCE_CHANGED");
    progress("seal_normalized_input"); seal(outputRoot, checkpoint); checkpoint();
    return { sourceRoot: outputRoot, interpreterPath: executable, architecture, inputTreeSha256: tree.sha256, bytes: tree.bytes, files: tree.files };
  } catch (error) {
    // Only this new private unpublished staging root belongs to this operation.
    discardOwnedStage(outputRoot); throw error;
  }
}
function immutableCachedInput(root, architecture, checkpoint) {
  checkpoint(); const tree = snapshotRuntimeTree(root, { immutable: true }); checkpoint();
  demand(tree.sha256 === pin.inputTreeSha256, "HERMES_NORMALIZED_INPUT_UNPINNED");
  const executable = path.join(root, "venv/bin/python"); assertClosure(root, pythonProbe(executable, root)); checkpoint();
  return { sourceRoot: root, interpreterPath: executable, architecture, inputTreeSha256: tree.sha256, bytes: tree.bytes, files: tree.files };
}
async function prepareManagedHermesProductInput({ sourceRoot, inputStateDir, resourcesRoot, architecture,
  assertCurrent = () => {}, onProgress = () => {}, signal } = {}) {
  demand(!isMainThread, "MANAGED_HERMES_NORMALIZATION_WORKER_REQUIRED");
  demand(typeof inputStateDir === "string" && path.isAbsolute(inputStateDir) && architecture === pin.interpreter.architecture,
    "MANAGED_HERMES_INPUT_INVALID");
  const checkpoint = () => { demand(!signal?.aborted, "MANAGED_WORKER_OPERATION_RETIRED"); assertCurrent(); };
  checkpoint(); privateDirectory(path.dirname(inputStateDir)); privateDirectory(inputStateDir, true);
  const final = path.join(inputStateDir, "input-" + pin.inputTreeSha256);
  if (fs.existsSync(final)) return { ...immutableCachedInput(final, architecture, checkpoint), reused: true };
  const staging = path.join(inputStateDir, ".staging-" + crypto.randomUUID());
  let published = false;
  try {
    const result = await materializeManagedHermesInput({ sourceRoot, outputRoot: staging, resourcesRoot, architecture, assertCurrent, onProgress, signal });
    checkpoint(); demand(!fs.existsSync(final), "MANAGED_HERMES_INPUT_PUBLISH_CONFLICT");
    fs.renameSync(staging, final); published = true;
    return { ...result, sourceRoot: final, interpreterPath: path.join(final, "venv/bin/python"), reused: false };
  } finally { if (!published && fs.existsSync(staging)) discardOwnedStage(staging); }
}
module.exports = { resolveManagedHermesProductInputs, prepareManagedHermesProductInput, materializeManagedHermesInput,
  _test: { collect, copyRecords, privateDirectory, assertClosure, immutableCachedInput, verifySource, discardOwnedStage } };
