#!/usr/bin/env node
"use strict";

// A task-owned Seatbelt feasibility probe. Its explicit synthetic-prompt phase
// sends one fixed public prompt with credential IPC and external HTTPS denied.
// The installed server, source Host and original settings remain unchanged.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const safeCode = error => /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code || "") ? error.code : "AGY_KERNEL_PROBE_FAILED";
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const q = value => JSON.stringify(value);
const SYNTHETIC_PROMPT = "Synthetic MCP startup probe. No user data. Return PROBE.";
const { waitForHelperInventory } = require("./fixtures/antigravity-helper-inventory-wait.cjs");
function availableBytes() {
  const lines = execFileSync("/bin/df", ["-k", "/private/tmp"], { encoding: "utf8" }).trim().split("\n");
  const fields = lines.at(-1).trim().split(/\s+/u), value = Number(fields[3]) * 1024;
  if (!Number.isSafeInteger(value)) throw fail("AGY_KERNEL_DISK_OBSERVATION_FAILED");
  return value;
}
function reserve() { const value = availableBytes(); if (value < 1024 ** 3) throw fail("AGY_KERNEL_DISK_RESERVE_LOW"); return value; }
function directory(target) { fs.mkdirSync(target, { mode: 0o700, recursive: true }); return fs.realpathSync(target); }
function write(target, value) { fs.writeFileSync(target, value, { mode: 0o600, flag: "wx" }); }
function ancestors(target) { const result = []; for (let dir = path.dirname(target); ; dir = path.dirname(dir)) { result.push(dir); if (dir === path.dirname(dir)) break; } return result; }
function publicDependencyFact(sourceRepo) {
  const logicalPath = path.join(sourceRepo, "node_modules"), stat = fs.lstatSync(logicalPath), realPath = fs.realpathSync(logicalPath), target = fs.statSync(realPath);
  const knownMain = fs.realpathSync(path.join(os.homedir(), "Documents/claude/Shoggoth/node_modules"));
  if (stat.uid !== process.getuid() || target.uid !== process.getuid() || !target.isDirectory()
    || (stat.isSymbolicLink() ? realPath !== knownMain : !inside(realPath, sourceRepo))) throw fail("AGY_KERNEL_PUBLIC_DEPENDENCY_ALIAS_INVALID");
  return { logicalPath, realPath, uid: stat.uid, dev: stat.dev, ino: stat.ino, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, isSymbolicLink: stat.isSymbolicLink(), targetUid: target.uid, targetDev: target.dev, targetIno: target.ino };
}
function prepareOwnedProcessMetadataReader(root) {
  const sourcePath = path.join(__dirname, "fixtures/antigravity-kernel-process-metadata.c"), binaryPath = path.join(root, "owned-process-metadata");
  const sourceSha256 = sha(fs.readFileSync(sourcePath)), sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
  const compiler = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang";
  reserve();
  const args = ["-isysroot", sdk, "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", binaryPath, "-lproc"];
  const compiled = spawnSync(compiler, args, { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root,
    CLANG_MODULE_CACHE_PATH: path.join(root, "clang-module-cache") }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  if (compiled.status !== 0 || sourceSha256 !== sha(fs.readFileSync(sourcePath))) throw fail("AGY_KERNEL_PROCESS_METADATA_READER_COMPILE_FAILED");
  fs.chmodSync(binaryPath, 0o700);
  const stat = fs.lstatSync(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw fail("AGY_KERNEL_PROCESS_METADATA_READER_OWNERSHIP_INVALID");
  return { sourcePath, sourceSha256, binaryPath, binarySha256: sha(fs.readFileSync(binaryPath)), compiler, compilerArgs: args,
    method: "actual-libproc-proc_pidinfo-PROC_PIDTBSDINFO-and-proc_pidpath-three-ancestor-chain",
    argvOrEnvironmentQueried: false, callerSuppliedPids: false,
    primaryHeaders: ["libproc.h", "sys/proc_info.h"].map(relative => { const file = path.join(sdk, "usr/include", relative); return { path: file, sha256: sha(fs.readFileSync(file)) }; }) };
}
function processMetadataPrefix({ root, reader, observationsPath }) {
  return `"use strict";
function __agyKernelProcessMetadataRuntime(){
 const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
 const reader=${q(reader.binaryPath)},expected=${q(reader.binarySha256)};
 if(crypto.createHash("sha256").update(fs.readFileSync(reader)).digest("hex")!==expected)throw Object.assign(new Error("AGY_KERNEL_PROCESS_METADATA_BINARY_CHANGED"),{code:"AGY_KERNEL_PROCESS_METADATA_BINARY_CHANGED"});
 const metadata=JSON.parse(require("node:child_process").execFileSync(reader,[],{encoding:"utf8",timeout:3000,maxBuffer:16384,env:{PATH:"/usr/bin:/bin",HOME:${q(root)},TMPDIR:${q(root)}}}));
 const rows=metadata.processes;
 if(metadata.version!==1||metadata.identityStable!==true||metadata.argvOrEnvironmentQueried!==false||!Array.isArray(rows)||rows.length!==3
 ||rows.some(row=>![row.pid,row.ppid,row.pgid,row.uid,row.birthEpochSeconds,row.birthMicroseconds].every(Number.isSafeInteger)||row.pid<=1||row.ppid<=1||row.pgid<=1||row.uid!==process.getuid()||row.birthEpochSeconds<=0||row.birthMicroseconds<0||row.birthMicroseconds>=1000000||!path.isAbsolute(row.executable||"")||typeof row.commandName!=="string"||row.commandName.length===0)
 ||rows[0].pid!==process.pid||rows[0].ppid!==process.ppid||rows[0].executable!==fs.realpathSync(process.execPath)||rows[1].pid!==process.ppid||rows[1].ppid!==rows[2].pid)
 throw Object.assign(new Error("AGY_KERNEL_ACTUAL_OS_PROCESS_CHAIN_INVALID"),{code:"AGY_KERNEL_ACTUAL_OS_PROCESS_CHAIN_INVALID"});
 fs.appendFileSync(${q(observationsPath)},JSON.stringify({method:"actual-libproc-three-layer-process-metadata",readerSha256:expected,sourceSha256:${q(reader.sourceSha256)},observedAt:new Date().toISOString(),identityStable:true,argvOrEnvironmentQueried:false,processes:rows})+"\\n",{mode:384});
 return {parent:{executable:rows[1].executable,command:rows[1].commandName,ppid:rows[1].ppid},ancestor:{executable:rows[2].executable}};
}
`;
}
function processFacts() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 })
    .split("\n").flatMap(line => { const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/u);
      return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], birth: match[4].trim(), commandName: match[5].trim(),
        executable: path.isAbsolute(match[5].trim()) ? match[5].trim() : null }] : []; });
}
function profile({ root, publicFiles = [], publicRoots = [], publicMetadataRoots = [], executableFiles = [], socketPath = null, authIpc = false, nativeTransport = authIpc }) {
  const node = fs.realpathSync(process.execPath), home = fs.realpathSync(os.homedir());
  const files = [...new Set([node, "/bin/cat", ...publicFiles].map(file => fs.realpathSync(file)))];
  // System/Volumes/Data is deliberately absent: it aliases the private Home.
  const roots = [...new Set(["/System/Library", "/usr/lib", "/usr/share", "/private/etc", "/private/var/db/timezone", ...publicRoots])];
  const readRoot = file => "(subpath " + q(file) + ")";
  const execs = [...new Set([node, "/bin/cat", ...executableFiles].map(file => fs.realpathSync(file)))];
  const metadata = [...new Set(files.flatMap(ancestors).concat(roots.flatMap(ancestors), publicMetadataRoots.flatMap(ancestors)))];
  // The installed Apple dyld bootstrap profile grants its named fcntl/mac
  // syscalls and public Cryptex reads. Without those even /bin/cat aborts
  // before main on this system; no user-home reads are granted by this import.
  const rules = ["(version 1)", "(deny default)", "(import \"dyld-support.sb\")", "(allow process-fork)", "(allow sysctl-read)",
    "(allow process-exec " + execs.map(file => "(literal " + q(file) + ")").join(" ") + " (subpath " + q(root) + "))",
    "(allow file-read-metadata (require-all (require-not (subpath " + q(home) + ")) (require-not (subpath " + q("/System/Volumes/Data" + home) + "))))",
    "(allow file-read-metadata " + metadata.map(file => "(literal " + q(file) + ")").join(" ") + ")",
    "(allow file-read* " + roots.map(readRoot).concat(files.map(file => "(literal " + q(file) + ")")).join(" ")
      + " (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-map-executable " + roots.map(readRoot).concat(files.map(file => "(literal " + q(file) + ")")).join(" ") + " (subpath " + q(root) + "))",
    "(allow file-read* file-write* (subpath " + q(root) + "))",
    "(allow file-write* (literal \"/dev/null\"))"];
  if (publicMetadataRoots.length) rules.push("(allow file-read-metadata " + publicMetadataRoots.map(readRoot).join(" ") + ")");
  if (socketPath) rules.push("(allow network-outbound (literal " + q(socketPath) + "))");
  if (authIpc) {
    // Apple trustd/securityd profiles name these credential IPC services. This
    // permission is inherited: it is not proof of an auth-only child boundary.
    rules.push("(allow mach-lookup (global-name \"com.apple.SecurityServer\") (global-name \"com.apple.securityd.xpc\")"
      + " (global-name \"com.apple.trustd\") (global-name \"com.apple.trustd.agent\"))");
    rules.push("(allow network-outbound (remote tcp \"*:443\"))");
  }
  if (nativeTransport) {
    // The unchanged bootstrap calls real os.userInfo() before relocating its
    // canonical Home. Apple profiles name this public user-directory API;
    // permitting it does not grant original Home file contents.
    rules.push("(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))");
    // The unmodified SDK starts its signed harness on an ephemeral loopback
    // WebSocket port. Only loopback TCP and the system DNS IPC endpoint are
    // enabled in addition to HTTPS; no private credential-file fallback.
    rules.push("(allow network-outbound (remote tcp \"localhost:*\"))");
    if (authIpc) rules.push("(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))");
    rules.push("(allow network-bind network-inbound (local tcp \"localhost:*\"))");
    // The source bootstrap-role reads only the actual parent/ancestor process
    // fields via /bin/ps; those identity checks are not replaced with fixtures.
    rules.push("(allow process-info*)");
  }
  return { text: rules.join("\n") + "\n", publicFiles: files, publicRoots: roots, publicMetadataRoots, executableFiles: execs,
    originalPrivateHomeAllowed: false, originalPrivateCredentialFilesAllowed: false,
    appleDyldBootstrap: { path: "/System/Library/Sandbox/Profiles/dyld-support.sb", sha256: sha(fs.readFileSync("/System/Library/Sandbox/Profiles/dyld-support.sb")) }, authIpc,
    authIpcChildRestriction: authIpc ? "not-proven-permissions-are-inherited" : "not-enabled", httpsMetadataAllowed: authIpc,
    networkScope: nativeTransport ? { https: authIpc ? "remote-tcp-any-host-443-metadata-only" : "disabled", dns: authIpc ? "/private/var/run/mDNSResponder" : "disabled",
      loopback: "ephemeral-localharness-WebSocket;not-a-port-specific-child-boundary" } : "not-enabled",
    publicUserDirectoryIpc: nativeTransport ? "com.apple.system.opendirectoryd.libinfo;inherited-not-a-credential-boundary" : "not-enabled",
    processInformation: { allowed: nativeTransport, purpose: "formal-bootstrap-actual-parent-and-ancestor-fields",
      foreignProcessEnvironmentIsolation: "UNPROVEN" } };
}
function createCanaries(root) {
  const workspace = directory(path.join(root, "workspace"));
  const artifactRoot = path.join(os.homedir(), "Documents/claude/Shoggoth/.artifacts/group-collaboration-optimization");
  directory(artifactRoot);
  const personal = fs.realpathSync(fs.mkdtempSync(path.join(artifactRoot, "agy-kernel-personal-"))); fs.chmodSync(personal, 0o700);
  const external = fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-agy-kernel-external-")); fs.chmodSync(external, 0o700);
  const ownFile = path.join(workspace, "owned.txt"), personalFile = path.join(personal, "public-canary.txt"), externalFile = path.join(external, "public-canary.txt");
  const secretFile = path.join(personal, "synthetic-private-credential-canary.json");
  for (const file of [ownFile, personalFile, externalFile]) write(file, "Task-owned public kernel canary\n");
  write(secretFile, JSON.stringify({ syntheticFixtureCredential: "synthetic-only-" + crypto.randomUUID() }) + "\n");
  fs.symlinkSync(externalFile, path.join(workspace, "external-link.txt"));
  fs.symlinkSync(personalFile, path.join(workspace, "personal-link.txt"));
  return { workspace, ownFile, personalFile, secretFile, externalFile, personal, external,
    outsideBefore: { personal: sha(fs.readFileSync(personalFile)), external: sha(fs.readFileSync(externalFile)), secret: sha(fs.readFileSync(secretFile)) } };
}
function canaryScript(fixtures) {
  return `"use strict";
const fs=require("node:fs"),{spawnSync}=require("node:child_process");const f=${q(fixtures)};
const checks={},denials={};const denied=(name,fn)=>{try{fn();checks[name]=false;}catch(e){denials[name]=e.code;checks[name]=["EPERM","EACCES"].includes(e.code);}};
checks.ownedRead=fs.readFileSync(f.ownFile,"utf8").startsWith("Task-owned");fs.writeFileSync(f.ownFile,"Task-owned positive write\\n");checks.ownedWrite=fs.readFileSync(f.ownFile,"utf8")==="Task-owned positive write\\n";
for(const [name,file]of[["personal",f.personalFile],["external",f.externalFile],["personalSymlink",f.workspace+"/personal-link.txt"],["externalSymlink",f.workspace+"/external-link.txt"]]){denied(name+"Read",()=>fs.readFileSync(file));denied(name+"Write",()=>fs.writeFileSync(file,"Task-owned negative write\\n"));}
denied("syntheticPrivateCredentialRead",()=>fs.readFileSync(f.secretFile));denied("syntheticPrivateCredentialWrite",()=>fs.writeFileSync(f.secretFile,"Task-owned denied secret fixture write\\n"));
if(fs.existsSync("/System/Volumes/Data")){denied("personalDataAliasRead",()=>fs.readFileSync("/System/Volumes/Data"+f.personalFile));denied("personalDataAliasWrite",()=>fs.writeFileSync("/System/Volumes/Data"+f.personalFile,"Task-owned alias write\\n"));}
const own=spawnSync("/bin/cat",[f.ownFile],{encoding:"utf8"});checks.childOwnedRead=own.status===0&&own.stdout.includes("positive write");
for(const[name,file]of[["childPersonalRead",f.personalFile],["childExternalRead",f.externalFile],["childSymlinkRead",f.workspace+"/external-link.txt"]]){const r=spawnSync("/bin/cat",[file],{encoding:"utf8"});checks[name]=r.status===1&&/Operation not permitted|Permission denied/.test(r.stderr||"");denials[name]=r.error?.code||r.status;}
const childSource='const fs=require("node:fs"),f=JSON.parse(process.argv[1]),checks={};fs.writeFileSync(f.ownFile,"Task-owned descendant write");checks.childOwnedWrite=fs.readFileSync(f.ownFile,"utf8")==="Task-owned descendant write";for(const[name,file]of[["childPersonalWrite",f.personalFile],["childExternalWrite",f.externalFile],["childSymlinkWrite",f.workspace+"/external-link.txt"]]){try{fs.writeFileSync(file,"Task-owned denied descendant write");checks[name]=false;}catch(e){checks[name]=["EPERM","EACCES"].includes(e.code);}}process.stdout.write(JSON.stringify(checks));process.exitCode=Object.values(checks).every(x=>x===true)?0:1;';
const childWrites=spawnSync(process.execPath,["-e",childSource,JSON.stringify(f)],{encoding:"utf8"});let childChecks;try{childChecks=JSON.parse(childWrites.stdout);}catch{}checks.childWriteProbeRan=childWrites.status===0&&childChecks?.childOwnedWrite===true;if(childChecks)Object.assign(checks,childChecks);
checks.sourceEnvGenericCredentialSentinelsAbsent=f.environment.genericKeys.every(key=>process.env[key]===undefined);
checks.sourceEnvSyntheticProxyCredentialPresent=process.env.HTTPS_PROXY?.includes(f.environment.sentinel)===true;
const envChildSource='const expected=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({genericAbsent:expected.genericKeys.every(key=>process.env[key]===undefined),proxyInherited:process.env.HTTPS_PROXY?.includes(expected.sentinel)===true}));';
const envChild=spawnSync(process.execPath,["-e",envChildSource,JSON.stringify(f.environment)],{encoding:"utf8"});let envResult;try{envResult=JSON.parse(envChild.stdout);}catch{}checks.envChildRan=envChild.status===0;checks.envChildGenericCredentialSentinelsAbsent=envResult?.genericAbsent===true;checks.envChildSyntheticProxyCredentialInherited=envResult?.proxyInherited===true;
if(f.externalNetworkDeniedRequired){const networkSource='const net=require("node:net"),socket=net.createConnection({host:"192.0.2.1",port:443});socket.once("connect",()=>{socket.destroy();process.stdout.write(JSON.stringify({denied:false}));process.exitCode=1;});socket.once("error",e=>{process.stdout.write(JSON.stringify({denied:["EPERM","EACCES"].includes(e.code),code:e.code}));});setTimeout(()=>{socket.destroy();process.exit(2);},1500).unref();';const network=spawnSync(process.execPath,["-e",networkSource],{encoding:"utf8",timeout:2500});let networkResult;try{networkResult=JSON.parse(network.stdout);}catch{}checks.childExternalTcp443DeniedBeforeConnect=network.status===0&&networkResult?.denied===true;denials.childExternalTcp443DeniedBeforeConnect=networkResult?.code??null;}
if(f.publicUserInfoRequired){try{checks.actualPublicUserInfoAvailable=typeof require("node:os").userInfo().homedir==="string";}catch(e){checks.actualPublicUserInfoAvailable=false;denials.actualPublicUserInfoAvailable=e.code;}}
if(f.publicHelperSourceRepo){try{for(const name of["app/agent-service/paths","app/shoggoth-mcp-helper","app/agent-service/mcp-product-tool-controller"])require(f.publicHelperSourceRepo+"/"+name);checks.publicHelperSourceImportsAvailable=true;}catch(e){checks.publicHelperSourceImportsAvailable=false;denials.publicHelperSourceImportsAvailable=e.code;}}
process.stdout.write(JSON.stringify({checks,denials,allPassed:Object.values(checks).every(x=>x===true)})+"\\n");process.exitCode=Object.values(checks).every(x=>x===true)?0:1;
`;
}
function runCanaries(root, policy, fixtures, { sourceRepo = path.join(__dirname, "..") } = {}) {
  const script = path.join(root, "kernel-canary.cjs"), policyFile = path.join(root, "kernel-policy.sb");
  const syntheticEnvironment = { sentinel: "synthetic-env-" + crypto.randomUUID(), genericKeys:
    ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "SHOGGOTH_CREDENTIAL_SENTINEL"] };
  const syntheticParent = { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: root,
    HTTPS_PROXY: "https://fixture-user:" + syntheticEnvironment.sentinel + "@127.0.0.1:9" };
  for (const key of syntheticEnvironment.genericKeys) syntheticParent[key] = syntheticEnvironment.sentinel;
  const spawnEnv = require(path.join(sourceRepo, "app/agent-service/antigravity-acp-runtime-host")).antigravityAcpSpawnEnvironment({
    parentEnv: syntheticParent, userHome: os.homedir(), home: root, geminiHome: path.join(root, ".gemini") });
  write(policyFile, policy.text);
  write(script, canaryScript({ ...fixtures, environment: syntheticEnvironment, externalNetworkDeniedRequired: policy.networkScope?.https === "disabled", publicUserInfoRequired: policy.publicUserDirectoryIpc !== "not-enabled",
    publicHelperSourceRepo: policy.publicUserDirectoryIpc !== "not-enabled" ? sourceRepo : null }));
  const child = spawnSync("/usr/bin/sandbox-exec", ["-f", policyFile, fs.realpathSync(process.execPath), script], {
    cwd: fixtures.workspace, env: spawnEnv, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  let result = null; try { result = JSON.parse(child.stdout.trim()); } catch {}
  const outsideAfter = { personal: sha(fs.readFileSync(fixtures.personalFile)), external: sha(fs.readFileSync(fixtures.externalFile)), secret: sha(fs.readFileSync(fixtures.secretFile)) };
  return { policyFile, policySha256: sha(policy.text), policy, command: "/usr/bin/sandbox-exec", childPid: child.pid, exitCode: child.status, signal: child.signal,
    errorCode: child.error?.code ?? null, stderr: String(child.stderr || "").slice(-4096), result,
    environmentObservation: { input: "synthetic-only-parentEnv", source: path.join(sourceRepo, "app/agent-service/antigravity-acp-runtime-host.js"),
      actualBuiltinRunCommandBodyProof: false, actualAuthIpcCredentialIsolation: "UNPROVEN", observedProxyInheritanceIsAllowedBySource: true },
    outsideCanariesUnchanged: JSON.stringify(outsideAfter) === JSON.stringify(fixtures.outsideBefore),
    passed: child.status === 0 && result?.allPassed === true && JSON.stringify(outsideAfter) === JSON.stringify(fixtures.outsideBefore) };
}
async function main(args) {
  const values = new Map(); for (let i = 0; i < args.length; i += 2) { if (!["--phase", "--source-repo", "--output"].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw fail("AGY_KERNEL_ARGS_INVALID"); values.set(args[i], args[i + 1]); }
  const phase = values.get("--phase") || "canary", sourceRepo = fs.realpathSync(values.get("--source-repo") || path.join(__dirname, ".."));
  if (!["canary", "metadata", "metadata-synthetic", "synthetic-prompt"].includes(phase)) throw fail("AGY_KERNEL_PHASE_INVALID");
  const output = values.get("--output"); if (!output || !path.isAbsolute(output) || !output.startsWith("/private/tmp/") || fs.existsSync(output)) throw fail("AGY_KERNEL_OUTPUT_INVALID");
  const report = { version: 1, startedAt: new Date().toISOString(), phase, sourceRepo, modelsStarted: 0, providerModelCalls: phase === "synthetic-prompt" ? "not-observed-count" : 0,
    promptCalls: 0, originalSdkModified: false, productionSourceModified: false, originalPrivateCredentialFilesAllowed: false,
    modelAdmission: "UNPROVEN", actualBuiltinRunCommandBodyProof: false };
  let root;
  try {
    report.availableBytesBefore = reserve();
    root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sggroup-live-agy-kernel-")); fs.chmodSync(root, 0o700); report.root = root;
    const fixtures = createCanaries(root); report.canaries = fixtures;
    if (phase === "canary") report.canary = runCanaries(root, profile({ root }), fixtures, { sourceRepo });
    else report.metadata = await nativeMetadata({ root, sourceRepo, fixtures, report, syntheticAuth: phase !== "metadata", syntheticPrompt: phase === "synthetic-prompt" });
    report.status = (phase === "canary" ? report.canary.passed : report.metadata.passed) ? "passed" : "failed";
  } catch (error) { report.status = "failed"; report.errorCode = safeCode(error); }
  report.finishedAt = new Date().toISOString();
  try { report.availableBytesAfter = availableBytes(); } catch {}
  write(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, phase, output, root, modelsStarted: 0, promptCalls: report.promptCalls, errorCode: report.errorCode ?? null }));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
async function nativeMetadata({ root, sourceRepo, fixtures, report, syntheticAuth = false, syntheticPrompt = false }) {
  const source = relative => require(path.join(sourceRepo, relative));
  const worker = require("./group-collaboration-live-worker.cjs");
  const { createAgentService } = source("app/agent-service/server");
  const { resolveServicePaths, resolveCanonicalServicePaths } = source("app/agent-service/paths");
  const { RuntimeMcpGateIssuer } = source("app/agent-service/runtime-mcp-gate");
  const { AntigravityAcpRuntimeHost } = source("app/agent-service/antigravity-acp-runtime-host");
  const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = source("app/agent-service/runtime-account");
  const { verifyAntigravityAcpServer } = source("app/agent-service/antigravity-acp-distribution");
  const monitoredFiles = ["app/agent-service/antigravity-acp-runtime-host.js", "app/agent-service/antigravity-runtime-pool.js",
    "app/agent-service/runtime-mcp-gate.js", "app/bootstrap-role.js", "app/runtime-mcp-relay.js", "app/agent-service/server.js"];
  const hashes = () => Object.fromEntries(monitoredFiles.map(relative => [relative, sha(fs.readFileSync(path.join(sourceRepo, relative)))]));
  const metadata = { phase: "real-unmodified-installed-server-auth-and-session-metadata-only", authenticationInput: syntheticAuth ? "synthetic-only-API-key-via-official-authenticate-meta" : "existing-native-auth-selector-and-SDK-credential-IPC", sourceHashesBefore: hashes(),
    initialize: false, authenticated: false, sessionCreated: false, modelSelectionChanged: false, promptCalls: 0,
    unexpectedRuntimeAcquires: 0, gateBindings: [], gateConsumptions: [], children: [], serviceStopped: false,
    credentialIpcScope: syntheticAuth ? "not-enabled" : "not-proven-auth-only;Seatbelt-permissions-are-inherited", processSubtreeSnapshots: [], shutdownSignals: [],
    sourceRpcTerminations: 0, processObservationErrors: [], modelAdmission: "UNPROVEN", executionRunProof: false, passed: false };
  report.metadata = metadata;
  const children = [], knownProcesses = new Map();
  const helperFactsPath = path.join(root, "helper-process-observations.jsonl");
  const helperOsMetadataPath = path.join(root, "helper-os-process-metadata.jsonl");
  const helperOsMetadata = () => fs.existsSync(helperOsMetadataPath) ? fs.readFileSync(helperOsMetadataPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const helperFacts = () => fs.existsSync(helperFactsPath) ? fs.readFileSync(helperFactsPath, "utf8").trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line)) : [];
  const captureTree = phase => {
    try {
    const rows = processFacts(), pids = new Set(children.map(child => child.pid));
    for (let changed = true; changed;) { changed = false; for (const row of rows) if (pids.has(row.ppid) && !pids.has(row.pid)) { pids.add(row.pid); changed = true; } }
    const observedHelpers = helperFacts();
    const subtree = rows.filter(row => pids.has(row.pid)).map(row => {
      const helper = observedHelpers.find(item => item.pid === row.pid && item.ppid === row.ppid && item.executable === fs.realpathSync(process.execPath));
      return helper ? { ...row, executable: helper.executable, executableObservation: "actual-node-process.execPath-joined-to-OS-pid-ppid-birth-group" } : row;
    });
    for (const row of subtree) knownProcesses.set(row.pid + ":" + row.birth, row);
    metadata.processSubtreeSnapshots.push({ phase, observedAt: new Date().toISOString(), processes: subtree });
    const queries = helperOsMetadata();
    if (queries.length && subtree.length) {
      const ownedQueryPids = [...new Set(queries.flatMap(query => query.processes.map(row => row.pid)))].filter(pid => subtree.some(row => row.pid === pid));
      const ucomm = new Map(execFileSync("/bin/ps", ["-p", ownedQueryPids.join(","), "-o", "pid=,ucomm="], { encoding: "utf8", timeout: 5000 })
        .trim().split("\n").map(line => line.trim().split(/\s+/u, 2)).map(([pid, name]) => [Number(pid), name]));
      for (const query of queries) {
        const matches = query.processes.map(row => { const actual = subtree.find(item => item.pid === row.pid);
          return { pid: row.pid, present: Boolean(actual), ppid: actual?.ppid === row.ppid, pgid: actual?.pgid === row.pgid,
            birth: Boolean(actual && Math.abs(Date.parse(actual.birth) - row.birthEpochSeconds * 1000) < 1000), uid: row.uid === process.getuid(),
            executable: actual?.executable === row.executable, commandName: ucomm.get(row.pid) === row.commandName }; });
        metadata.actualLibprocOsComparisons = [...(metadata.actualLibprocOsComparisons || []), { phase, sourceSha256: query.sourceSha256,
          readerSha256: query.readerSha256, identityStable: query.identityStable, matches,
          commandNameComparison: "BSD-pbi_comm-short-name-versus-full-ps-ucomm;separate-from-identity",
          allIdentityMatched: matches.every(row => Object.entries(row).filter(([key]) => !["pid", "commandName"].includes(key)).every(([, value]) => value === true)),
          allMatched: matches.every(row => Object.entries(row).filter(([key]) => key !== "pid").every(([, value]) => value === true)) }];
      }
    }
    return subtree;
    } catch (error) { metadata.processObservationErrors.push({ phase, code: safeCode(error) }); return []; }
  };
  const paths = resolveServicePaths({ homeDir: root }), installedPaths = resolveCanonicalServicePaths();
  const verified = await verifyAntigravityAcpServer({ paths: installedPaths });
  metadata.nativeBefore = { serverPath: verified.serverPath, harnessPath: verified.harnessPath, version: verified.version,
    serverSha256: sha(fs.readFileSync(verified.serverPath)), harnessSha256: sha(fs.readFileSync(verified.harnessPath)),
    helperNodePath: fs.realpathSync(process.execPath), helperNodeSha256: sha(fs.readFileSync(fs.realpathSync(process.execPath))) };
  const key = crypto.randomBytes(32); write(path.join(root, "mcp-key.bin"), key);
  metadata.processMetadataReader = prepareOwnedProcessMetadataReader(root);
  const bootstrapPath = worker.writeHelper(root, sourceRepo), mcpHelperLaunch = { command: fs.realpathSync(process.execPath), argsPrefix: [bootstrapPath] };
  // Observe only this generated helper's own process fields. The original
  // bootstrap-role, gate, argv and relay remain unchanged and perform their
  // real parent/ancestor checks. No credential or protocol data is logged.
  let generatedHelper = fs.readFileSync(bootstrapPath, "utf8");
  const originalRuntime = '{userInfo:()=>({...require("node:os").userInfo(),homedir:root})}';
  if (generatedHelper.split(originalRuntime).length !== 2) throw fail("AGY_KERNEL_HELPER_RUNTIME_DI_SHAPE_CHANGED");
  generatedHelper = generatedHelper.replace(originalRuntime, "Object.assign(" + originalRuntime + ",__agyKernelProcessMetadataRuntime())");
  const originalRecord = 'JSON.stringify(entry)+"\\n"', originalError = "if(frame.error)entry.rpcError=true;";
  if (generatedHelper.split(originalRecord).length !== 2 || generatedHelper.split(originalError).length !== 2) throw fail("AGY_KERNEL_HELPER_OBSERVER_SHAPE_CHANGED");
  generatedHelper = generatedHelper.replace(originalRecord, 'JSON.stringify({...entry,pid:process.pid,ppid:process.ppid,observedAt:new Date().toISOString()})+"\\n"')
    .replace(originalError, "if(frame.error){entry.rpcError=true;entry.rpcErrorCode=frame.error.code;}");
  fs.writeFileSync(bootstrapPath, processMetadataPrefix({ root, reader: metadata.processMetadataReader, observationsPath: helperOsMetadataPath })
    + `(()=>{require("node:fs").appendFileSync(${q(helperFactsPath)},JSON.stringify({pid:process.pid,ppid:process.ppid,executable:process.execPath})+"\\n",{mode:384});})();\n` + generatedHelper, { mode: 0o600 });
  metadata.generatedHelperSha256 = sha(fs.readFileSync(bootstrapPath));
  const gate = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch, bootstrapPath });
  const createMcpServer = gate.createMcpServer.bind(gate), consume = gate.consume.bind(gate);
  gate.createMcpServer = async input => { const result = await createMcpServer(input); metadata.gateBindings.push({ runtimeProfileId: input.runtimeProfileId,
    runtimeAccountId: input.runtimeAccountId, executionRunId: input.executionRunId ?? null, parentExecutable: input.parentExecutable,
    ancestorExecutable: input.ancestorExecutable, ancestorPid: input.ancestorPid }); return result; };
  gate.consume = input => { const result = consume(input); metadata.gateConsumptions.push({ parentPid: input.parentPid,
    runtimeProfileId: input.runtimeProfileId, runtimeAccountId: input.runtimeAccountId, gatePathInsideOwnedRoot: inside(input.gatePath, root),
    actualProductionGateAccepted: true }); captureTree("actual-production-gate-consume"); return result; };
  const service = createAgentService({ paths, repoRoot: sourceRepo, version: "owned-agy-kernel-metadata-only",
    parentEnv: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: root, NODE_DISABLE_COMPILE_CACHE: "1" },
    runtimeStorageHomedir: os.homedir(), safeStorage: worker.makeSafeStorage(key), prewarmMcpAuth: false,
    antigravityBinaryPath: verified.serverPath, mcpHelperLaunch, runtimeMcpGateIssuer: gate });
  metadata.guardedRuntimePools = Object.keys(service).filter(name => (name === "runtimePool" || /RuntimePool$/u.test(name)) && name !== "antigravityRuntimePool");
  for (const name of metadata.guardedRuntimePools) {
    if (service[name]?.get) service[name].get = async () => { metadata.unexpectedRuntimeAcquires += 1; throw fail("AGY_KERNEL_UNEXPECTED_RUNTIME_ACQUIRE"); };
  }
  const pool = service.antigravityRuntimePool;
  let ownedProfile, handle, selector, allocatedHost;
  try {
    await worker.bindInstalledAntigravityVerifier({ service, paths, installedPaths, selectedBinary: verified.serverPath, verifyServer: verifyAntigravityAcpServer });
    const accountId = DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.antigravity;
    if (syntheticAuth) {
      const { runtimeAccountIntegrationRoot } = source("app/agent-service/runtime-account-resolver");
      const { prepareAntigravityRuntimeAccountHome } = source("app/agent-service/antigravity-runtime-paths");
      const { prepareAntigravityAcpHome } = source("app/agent-service/antigravity-runtime-config");
      const { atomicWritePrivateFile } = source("app/agent-service/private-file");
      const originalSettingsPath = path.join(runtimeAccountIntegrationRoot(installedPaths, "antigravity", accountId), "home/.gemini/antigravity-acp/settings.json");
      const originalStat = fs.lstatSync(originalSettingsPath);
      const home = prepareAntigravityRuntimeAccountHome(paths, accountId), owned = prepareAntigravityAcpHome({ home, trustedRoot: paths.trustedRoot });
      atomicWritePrivateFile(owned.settingsPath, JSON.stringify({ auth: { type: "gemini-api-key" } }) + "\n", { trustedRoot: paths.trustedRoot });
      selector = { originalSettingsPath, originalSettingsSha256: sha(fs.readFileSync(originalSettingsPath)), originalSettingsBytes: originalStat.size,
        originalSettingsMtimeMs: originalStat.mtimeMs, originalSettingsCtimeMs: originalStat.ctimeMs, selectedMethodPresent: true,
        copiedFields: [], credentialFieldsCopied: false, ownedSettingsPath: owned.settingsPath };
    } else selector = worker.prepareExistingAntigravityAuthSelector({ paths, installedPaths, accountId, sourceRepo });
    metadata.authSelector = { selectedMethodPresent: selector.selectedMethodPresent, copiedFields: selector.copiedFields,
      credentialFieldsCopied: selector.credentialFieldsCopied, ownedSettingsPath: selector.ownedSettingsPath, originalSettingsModifiedByHarness: false };
    metadata.publicDependencyAliasBefore = publicDependencyFact(sourceRepo);
    const sourceReadRoots = ["app", "schemas", "resources", "node_modules"].map(relative => path.join(sourceRepo, relative))
      .filter(file => fs.existsSync(file)).map(file => fs.realpathSync(file));
    const extraFiles = [verified.serverPath, verified.harnessPath, "/bin/ps", "/usr/bin/codesign", path.join(sourceRepo, "package.json")];
    if (fs.existsSync("/private/var/db/DarwinDirectory/local/recordStore.data")) extraFiles.push("/private/var/db/DarwinDirectory/local/recordStore.data");
    const policy = profile({ root, publicFiles: extraFiles, publicRoots: sourceReadRoots,
      publicMetadataRoots: metadata.publicDependencyAliasBefore.isSymbolicLink ? [metadata.publicDependencyAliasBefore.logicalPath] : [],
      executableFiles: [verified.serverPath, verified.harnessPath, "/bin/ps", "/usr/bin/codesign"], socketPath: paths.socketPath, authIpc: !syntheticAuth, nativeTransport: true });
    metadata.canary = runCanaries(root, policy, fixtures, { sourceRepo });
    if (!metadata.canary.passed) throw fail("AGY_KERNEL_NATIVE_POLICY_CANARY_FAILED");
    metadata.availableBytesBeforeService = reserve();
    pool.hostFactory = options => {
      const host = new AntigravityAcpRuntimeHost(options);
      allocatedHost = host;
      if (!syntheticPrompt) host.turnStart = async () => { report.promptCalls += 1; metadata.promptCalls += 1; throw fail("AGY_KERNEL_MODEL_PROMPT_FORBIDDEN"); };
      const killProcessGroup = host.killProcessGroup;
      host.killProcessGroup = (pid, signal) => { if (pid !== host.child?.pid || !children.some(child => child.pid === pid)) throw fail("AGY_KERNEL_UNOWNED_SHUTDOWN_PID");
        captureTree("before-source-host-process-group-signal"); metadata.shutdownSignals.push({ pid, processGroup: pid, signal,
          source: "unmodified-AntigravityAcpRuntimeHost-stop-own-detached-group" }); return killProcessGroup(pid, signal); };
      const initialize = host.initialize.bind(host);
      host.initialize = async () => { await initialize(); const request = host.rpc.request.bind(host.rpc);
        const terminate = host.rpc.terminate.bind(host.rpc);
        host.rpc.terminate = (...args) => { captureTree("before-source-acp-rpc-terminate"); metadata.sourceRpcTerminations += 1; return terminate(...args); };
        host.rpc.request = (method, params, ...rest) => { if (method === "session/prompt" && syntheticPrompt) {
          if (report.promptCalls !== 0 || JSON.stringify(params.prompt) !== JSON.stringify([{ type: "text", text: "CURRENT USER REQUEST\n" + SYNTHETIC_PROMPT }]))
            throw fail("AGY_KERNEL_SYNTHETIC_PROMPT_BUDGET_OR_TEXT_INVALID");
          report.promptCalls += 1; metadata.promptCalls += 1;
        } else if (!["authenticate", "session/new", "session/load", "session/resume", "session/set_mode", "session/set_config_option"].includes(method)) {
          if (method === "session/prompt") { report.promptCalls += 1; metadata.promptCalls += 1; }
          throw fail("AGY_KERNEL_NON_METADATA_RPC_FORBIDDEN"); }
          if (method === "authenticate" && syntheticAuth) params = { ...params, methodId: "gemini-api-key", _meta: { "api-key": "synthetic-fixture-" + crypto.randomUUID() } };
          if (["session/new", "session/load", "session/resume"].includes(method)) {
            params = { ...params, _meta: { ...(params?._meta || {}), agy: { ...(params?._meta?.agy || {}), enabledTools: [] } } };
            metadata.toolFilterRequests = [...(metadata.toolFilterRequests || []), { method, officialField: "_meta.agy.enabledTools", enabledTools: [],
              mcpServerNames: (params.mcpServers || []).map(server => server.name) }];
          }
          return request(method, params, ...rest); }; return host; };
      return host;
    };
    Object.assign(pool.options, { initializeTimeoutMs: 30000, requestTimeoutMs: 30000, acceptanceTimeoutMs: 30000, shutdownGraceMs: 2000, killGraceMs: 1000,
      spawnProcess(command, args, options) {
        if (command !== verified.serverPath || args.length !== 0) throw fail("AGY_KERNEL_NATIVE_SPAWN_CHANGED");
        const child = spawn("/usr/bin/sandbox-exec", ["-f", metadata.canary.policyFile, command, ...args], options);
        const record = { pid: child.pid, command: verified.serverPath, wrapper: "/usr/bin/sandbox-exec", exitCode: null, exitSignal: null, closed: false };
        children.push(child); metadata.children.push(record);
        child.once("exit", (code, signal) => { record.exitCode = code; record.exitSignal = signal; }); child.once("close", () => { record.closed = true; });
        return child;
      } });
    await service.start();
    ownedProfile = worker.configureProfile(service, service.productStore.listAgentProfiles()[0], "antigravity", accountId, fixtures.workspace, "KernelMetadata");
    metadata.runtimeBinding = { runtime: "antigravity", runtimeProfileId: ownedProfile.runtimeProfileId, runtimeAccountId: accountId };
    metadata.availableBytesBeforeNative = reserve();
    handle = await pool.get(metadata.runtimeBinding, { workspace: fixtures.workspace, permissionPolicy: ownedProfile.permissionPolicy });
    metadata.initialize = handle.state === "ready";
    const initializedProcesses = captureTree("real-native-initialize-complete");
    metadata.actualDetachedServerGroup = initializedProcesses.find(row => row.pid === handle.child.pid)?.pgid === handle.child.pid;
    const comm = execFileSync("/bin/ps", ["-p", String(handle.child.pid), "-o", "comm="], { encoding: "utf8" }).trim();
    metadata.actualServerExecutable = comm; metadata.wrapperExecPreservedPid = comm === verified.serverPath;
    if (!metadata.wrapperExecPreservedPid) throw fail("AGY_KERNEL_REAL_ANCESTOR_EXECUTABLE_MISMATCH");
    metadata.availableBytesBeforeAuthenticate = reserve();
    const auth = await handle.authenticationState({ allowDeferred: false }); metadata.authenticated = auth.authenticated === true;
    if (!metadata.authenticated) throw fail("AGY_KERNEL_EXISTING_AUTH_NOT_VERIFIED");
    metadata.availableBytesBeforeSession = reserve();
    const created = await handle.sessionStart({ source: "owned-kernel-metadata-" + crypto.randomUUID(), cwd: fixtures.workspace, model: null });
    metadata.sessionCreated = typeof created.session?.id === "string" && created.session.id.length > 0;
    metadata.createdSessionId = created.session?.id ?? null;
    const sidecarPath = path.join(handle.acpHome.geminiHome, "antigravity-acp/conversations", created.session.id + ".meta");
    if (!inside(sidecarPath, root)) throw fail("AGY_KERNEL_NATIVE_SIDECAR_OUTSIDE_OWN_ROOT");
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    metadata.nativeToolFilter = { path: sidecarPath, sha256: sha(fs.readFileSync(sidecarPath)),
      acceptedBy: "unmodified-pinned-server-writes-after-real-sdk-agent-enter", cwdMatchesOwnedWorkspace: sidecar.cwd === fixtures.workspace,
      enabledTools: sidecar.tool_filter?.enabledTools ?? null,
      allBuiltinsDisabledPersisted: Array.isArray(sidecar.tool_filter?.enabledTools) && sidecar.tool_filter.enabledTools.length === 0,
      actualBuiltinToolBodiesExecuted: 0, modelToolContextObserved: false, implementationReviewFileToolCapability: "UNPROVEN" };
    const read = await handle.sessionRead({ sessionId: created.session.id, includeTurns: true });
    metadata.sourceSessionRead = { sameId: read.session?.id === created.session.id, zeroTurns: Array.isArray(read.session?.turns) && read.session.turns.length === 0 };
    captureTree("real-native-session-metadata-complete");
    metadata.actualNativeEnvironment = { source: "unmodified-source-Host-spawnEnvironment-with-explicit-task-parentEnv",
      privateCredentialVariableNamesAbsent: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].every(name => handle._spawnEnvironment()[name] === undefined),
      homeInsideOwnedRoot: inside(handle._spawnEnvironment().HOME, root), geminiHomeInsideOwnedRoot: inside(handle._spawnEnvironment().GEMINI_HOME, root), valuesExported: false };
    if (syntheticPrompt) {
      metadata.availableBytesBeforeSyntheticPrompt = reserve();
      metadata.syntheticPromptProbe = { authorizedAcpPromptBudget: 1, syntheticCredentialOnly: true, externalHttpsAllowedByKernel: false,
        externalProviderConnectionsSucceeded: 0, externalProviderConnectionAttempts: "not-observed-count", sdkInferenceRequests: "not-observed-count",
        classifiedAsL3ModelRun: false, promptTextSha256: sha(SYNTHETIC_PROMPT), bodyCanariesExecuted: 0 };
      try { const accepted = await handle.turnStart({ sessionId: created.session.id, operationId: "synthetic-mcp-startup-" + crypto.randomUUID(),
        prompt: SYNTHETIC_PROMPT, cwd: fixtures.workspace, model: null }); metadata.syntheticPromptProbe.sourceAccepted = typeof accepted.turn?.id === "string";
      } catch (error) { metadata.syntheticPromptProbe.safeRequestCode = safeCode(error); }
      captureTree("synthetic-ACP-prompt-request-attempted");
    }
    const readObservations = () => fs.existsSync(path.join(root, "helper-observations.jsonl")) ? fs.readFileSync(path.join(root, "helper-observations.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    metadata.inventoryWait = await waitForHelperInventory({ read: () => ({ observations: readObservations(), helpers: helperFacts(), gateConsumptions: metadata.gateConsumptions }),
      readFailure: () => children.some(child => child.exitCode !== null || child.signalCode !== null) ? "AGY_KERNEL_NATIVE_EXIT_BEFORE_INVENTORY" : null,
      timeoutMs: 10000, pollMs: 25 });
    const observations = readObservations();
    metadata.helperObservations = observations;
    metadata.formalGateConsumed = metadata.gateConsumptions.length > 0;
    metadata.formalInventorySeen = metadata.inventoryWait.status === "ready";
    metadata.noModelPromptInLedger = handle.ledger.snapshot().sessions.every(session => Array.isArray(session.turns) && session.turns.length === 0);
    metadata.syntheticPromptBounded = syntheticPrompt && report.promptCalls === 1 && handle.ledger.snapshot().sessions.reduce((sum, session) => sum + session.turns.length, 0) === 1;
    const afterSettings = fs.lstatSync(selector.originalSettingsPath);
    metadata.originalSettingsUnchanged = sha(fs.readFileSync(selector.originalSettingsPath)) === selector.originalSettingsSha256
      && [afterSettings.size, afterSettings.mtimeMs, afterSettings.ctimeMs].join(":") === [selector.originalSettingsBytes, selector.originalSettingsMtimeMs, selector.originalSettingsCtimeMs].join(":");
    metadata.passed = metadata.initialize && metadata.authenticated && metadata.sessionCreated && metadata.wrapperExecPreservedPid && metadata.actualDetachedServerGroup
      && metadata.formalGateConsumed && metadata.formalInventorySeen && (syntheticPrompt ? metadata.syntheticPromptBounded : metadata.noModelPromptInLedger === true)
      && metadata.unexpectedRuntimeAcquires === 0 && (syntheticPrompt ? report.promptCalls === 1 : report.promptCalls === 0) && metadata.originalSettingsUnchanged
      && metadata.nativeToolFilter.allBuiltinsDisabledPersisted && metadata.nativeToolFilter.cwdMatchesOwnedWorkspace
      && metadata.sourceSessionRead.sameId && metadata.sourceSessionRead.zeroTurns;
  } catch (error) {
    metadata.errorCode = safeCode(error);
    if (allocatedHost) { const text = allocatedHost.stderrTail.join("\n") + "\n" + allocatedHost.stderrBuffer; metadata.ownedNativeDiagnosticShape = {
      permissionDenied: /Operation not permitted|Permission denied/u.test(text), frames: allocatedHost.stderrTail.length,
      startupStage: allocatedHost.startupStage ?? null, hostState: allocatedHost.state };
    }
  } finally {
    if (allocatedHost) { const text = allocatedHost.stderrTail.join("\n") + "\n" + allocatedHost.stderrBuffer;
      metadata.ownedNativeDiagnosticShape = { ...(metadata.ownedNativeDiagnosticShape || {}), permissionDenied: /Operation not permitted|Permission denied/u.test(text),
        mcpMention: /MCP|mcp|shoggoth/u.test(text), authLoginRequired: allocatedHost.loginFlowSeen === true,
        keychainProbeFailed: /keychain probe failed|macOS keychain probe raised/u.test(text), keychainOsStatus: [...text.matchAll(/OSStatus (-?\d+)/gu)].map(match => Number(match[1])),
        frames: allocatedHost.stderrTail.length, startupStage: allocatedHost.startupStage ?? null, hostState: allocatedHost.state };
    }
    if (children.length) captureTree("before-source-service-stop");
    try { await service.stop(); metadata.serviceStopped = true; } catch (error) { metadata.stopErrorCode = safeCode(error); }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once("close", resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    metadata.nativeAfter = { serverSha256: sha(fs.readFileSync(verified.serverPath)), harnessSha256: sha(fs.readFileSync(verified.harnessPath)),
      helperNodeSha256: sha(fs.readFileSync(fs.realpathSync(process.execPath))) };
    metadata.generatedHelperUnchanged = sha(fs.readFileSync(bootstrapPath)) === metadata.generatedHelperSha256;
    if (selector) { const stat = fs.lstatSync(selector.originalSettingsPath);
      metadata.originalSettingsUnchanged = sha(fs.readFileSync(selector.originalSettingsPath)) === selector.originalSettingsSha256
        && [stat.size, stat.mtimeMs, stat.ctimeMs].join(":") === [selector.originalSettingsBytes, selector.originalSettingsMtimeMs, selector.originalSettingsCtimeMs].join(":"); }
    metadata.originalWholeHomeWriteObservation = "not-observed";
    metadata.keychainWriteObservation = "not-observed-through-auth-ipc";
    metadata.nativeUnchanged = metadata.nativeAfter.serverSha256 === metadata.nativeBefore.serverSha256
      && metadata.nativeAfter.harnessSha256 === metadata.nativeBefore.harnessSha256 && metadata.nativeAfter.helperNodeSha256 === metadata.nativeBefore.helperNodeSha256;
    metadata.sourceHashesAfter = hashes(); metadata.productionSourceUnchanged = JSON.stringify(metadata.sourceHashesBefore) === JSON.stringify(metadata.sourceHashesAfter);
    if (metadata.publicDependencyAliasBefore) {
      try { metadata.publicDependencyAliasAfter = publicDependencyFact(sourceRepo);
        metadata.publicDependencyAliasUnchanged = JSON.stringify(metadata.publicDependencyAliasBefore) === JSON.stringify(metadata.publicDependencyAliasAfter);
      } catch (error) { metadata.publicDependencyAliasError = safeCode(error); metadata.publicDependencyAliasUnchanged = false; }
    }
    const processRows = execFileSync("/bin/ps", ["eww", "-axo", "pid=,ppid=,state=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 }).split("\n");
    metadata.ownedLive = processRows.flatMap(line => { const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
      if (!match || +match[1] === process.pid || +match[1] === process.ppid || !match[4].includes(root)) return [];
      return [{ pid: +match[1], ppid: +match[2], state: match[3], executable: match[4].split(/\s+/u)[0] }]; });
    metadata.knownNativePidsAbsent = children.every(child => { try { process.kill(child.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
    const finalFacts = processFacts();
    metadata.ownedProcessIdentities = [...knownProcesses.values()];
    metadata.helperProcessObservations = helperFacts();
    metadata.helperActualOsMetadata = helperOsMetadata();
    metadata.processMetadataReaderUnchanged = sha(fs.readFileSync(metadata.processMetadataReader.sourcePath)) === metadata.processMetadataReader.sourceSha256
      && sha(fs.readFileSync(metadata.processMetadataReader.binaryPath)) === metadata.processMetadataReader.binarySha256;
    metadata.ownedProcessIdentitiesStillLive = finalFacts.filter(row => knownProcesses.has(row.pid + ":" + row.birth));
    metadata.ownedProcessGroupsStillLive = finalFacts.filter(row => children.some(child => row.pgid === child.pid));
    metadata.actualHelperSubtreeSeen = metadata.gateConsumptions.some(gateRow => metadata.processSubtreeSnapshots.some(snapshot =>
      snapshot.processes.some(row => row.pid === gateRow.parentPid && row.executable === verified.harnessPath)
      && snapshot.processes.some(row => row.ppid === gateRow.parentPid && row.executable === fs.realpathSync(process.execPath))));
    metadata.passed = metadata.passed && metadata.serviceStopped && metadata.children.every(row => row.closed) && metadata.ownedLive.length === 0
      && metadata.knownNativePidsAbsent && metadata.nativeUnchanged && metadata.productionSourceUnchanged && metadata.publicDependencyAliasUnchanged === true
      && metadata.sourceRpcTerminations > 0 && metadata.actualHelperSubtreeSeen && metadata.generatedHelperUnchanged && metadata.originalSettingsUnchanged === true
      && metadata.processMetadataReaderUnchanged && metadata.actualLibprocOsComparisons?.some(comparison => comparison.phase === "actual-production-gate-consume" && comparison.allIdentityMatched === true)
      && metadata.ownedProcessIdentitiesStillLive.length === 0 && metadata.ownedProcessGroupsStillLive.length === 0 && metadata.processObservationErrors.length === 0;
    key.fill(0);
  }
  return metadata;
}
module.exports = { profile, createCanaries, canaryScript, runCanaries, processFacts, prepareOwnedProcessMetadataReader, processMetadataPrefix, availableBytes, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
