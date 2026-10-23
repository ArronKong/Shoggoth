"use strict";
// Frozen test-only tool policy. The installed Runtime remains unchanged.
// Policies contain only newly-owned workspaces, tool names and scenario facts.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
const plain = value => value && typeof value === "object" && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
function safeKeys(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.includes(key)); }
function ownedPath(value, root, { missing = false, directory = false } = {}) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\\]/u.test(value) || value.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    || value.split("/").includes("..")) return null;
  const realRoot = fs.realpathSync(root), target = path.resolve(realRoot, value);
  if (realRoot !== path.resolve(root) || target !== realRoot && !target.startsWith(realRoot + path.sep)) return null;
  let current = realRoot;
  for (const part of path.relative(realRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || stat.uid !== process.getuid()) return null; }
    catch (error) { if (error.code !== "ENOENT" || !missing) return null; }
  }
  if (directory && fs.existsSync(target) && !fs.statSync(target).isDirectory()) return null;
  return target;
}
function noLinksBelow(target, budget = 4096) {
  let remaining = budget;
  const walk = value => { if (--remaining < 0) return false; const stat = fs.lstatSync(value);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid()) return false;
    if (stat.isDirectory()) for (const entry of fs.readdirSync(value)) if (!walk(path.join(value, entry))) return false;
    return stat.isFile() || stat.isDirectory(); };
  try { return walk(target); } catch { return false; }
}
function loadPolicy(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o400 || before.size > 64 * 1024)
    throw fail("GROUP_LIVE_POLICY_FILE_UNSAFE");
  const bytes = fs.readFileSync(file), policy = JSON.parse(bytes);
  if (policy.version !== 1 || !["hermes", "deepseek-harness", "codex", "openclaw", "antigravity"].includes(policy.runtime)
    || !Array.isArray(policy.groupTools) || policy.groupTools.length < 3 || policy.groupTools.length > 4
    || policy.groupTools.some(name => !/^group_(?:member_role_read|messages_read|task|collaborate)$/u.test(name))
    || !path.isAbsolute(policy.workspace) || !policy.workspace.startsWith("/private/tmp/sggroup-")
    || fs.realpathSync(policy.workspace) !== policy.workspace || !Array.isArray(policy.readRoots) || !policy.readRoots.length
    || policy.readRoots.some(root => !path.isAbsolute(root) || !root.startsWith("/private/tmp/sggroup-") || fs.realpathSync(root) !== root)
    || policy.runtime === "hermes" && (typeof policy.hookCwd !== "string" || !policy.hookCwd.startsWith("/private/tmp/sggroup-live-") || fs.realpathSync(policy.hookCwd) !== policy.hookCwd)
    || typeof policy.logPath !== "string" || !policy.logPath.startsWith("/private/tmp/sggroup-live-")) throw fail("GROUP_LIVE_POLICY_INVALID");
  return { policy, digest: sha(bytes) };
}
function exactApprovalCommand(command, workspace) {
  if (typeof command !== "string" || command.length > 2048 || /[\r\n$\\`]/u.test(command)) return false;
  const quote = value => [value, "'" + value + "'", '"' + value + '"'];
  const commands = new Set();
  for (const executable of ["printf", "/usr/bin/printf"]) for (const format of quote("%s")) for (const value of quote("approval-evidence-v1"))
    for (const target of [...quote("approval-proof.txt"), ...quote(path.join(workspace, "approval-proof.txt"))]) commands.add(executable + " " + format + " " + value + " > " + target);
  return commands.has(command.trim());
}
function decide(policy, { name, arguments: args, cwd }) {
  if (typeof name !== "string" || !plain(args) || typeof cwd !== "string" || cwd !== policy.workspace) return "GROUP_LIVE_TOOL_CONTEXT_UNBOUND";
  const mcpPrefix = policy.runtime === "hermes" ? "mcp__shoggoth_group__" : "mcp__shoggoth__";
  if (policy.groupTools.some(tool => name === mcpPrefix + tool)) return undefined;
  // Discovery never runs an advertised tool. Group admission and fixed result
  // version checks still occur in the real production tool body.
  if (["tool_search", "tool_describe"].includes(name)) return undefined;
  if (policy.caseId === "approval-wait" && ["terminal", "bash"].includes(name)) {
    const allowed = policy.runtime === "hermes" ? ["command", "workdir", "timeout", "background", "risk"] : ["command", "description", "workdir", "timeoutMs", "run_in_background", "sandbox_permissions", "justification"];
    if (!safeKeys(args, allowed) || args.background === true || args.run_in_background === true
      || args.workdir !== undefined && args.workdir !== policy.workspace
      || args.sandbox_permissions !== undefined && (args.sandbox_permissions !== "danger-full-access" || typeof args.justification !== "string" || !args.justification || args.justification.length > 2048)
      || !exactApprovalCommand(args.command, policy.workspace))
      return "GROUP_LIVE_SHELL_OUTSIDE_FROZEN_APPROVAL";
    const target = ownedPath("approval-proof.txt", policy.workspace, { missing: true });
    return target ? undefined : "GROUP_LIVE_FILE_PATH_OUTSIDE_OWNED_WORKSPACE";
  }
  if (policy.caseId !== "implementation-review") return "GROUP_LIVE_TOOL_OUTSIDE_SYNTHETIC_GROUP_SCOPE";
  const tools = policy.runtime === "hermes" ? {
    read_file: { field: "path", keys: ["path", "offset", "limit"], write: false },
    write_file: { field: "path", keys: ["path", "content"], write: true },
    patch: { field: "path", keys: ["path", "old_string", "new_string", "replace_all"], write: true },
    search_files: { field: "path", keys: ["path", "pattern", "target", "file_glob", "limit", "offset", "order", "output_mode", "context"], search: true },
  } : {
    read: { field: "file_path", keys: ["file_path", "offset", "limit"], write: false },
    read_image: { field: "file_path", keys: ["file_path", "offset", "limit"], write: false },
    write: { field: "file_path", keys: ["file_path", "content"], write: true },
    edit: { field: "file_path", keys: ["file_path", "old_string", "new_string", "replace_all"], write: true },
    glob: { field: "path", keys: ["path", "pattern"], search: true },
    grep: { field: "path", keys: ["path", "pattern", "glob", "output_mode", "head_limit", "offset", "multiline", "-A", "-B", "-C", "-i", "-n", "type"], search: true },
  };
  const tool = tools[name];
  if (!tool || !safeKeys(args, tool.keys)) return "GROUP_LIVE_TOOL_OR_FIELDS_OUTSIDE_FROZEN_SCOPE";
  const requested = args[tool.field] ?? (tool.search ? "." : null);
  const roots = tool.write ? [policy.workspace] : policy.readRoots;
  const target = roots.map(root => ownedPath(requested, root, { missing: tool.write })).find(Boolean);
  if (!target) return "GROUP_LIVE_FILE_PATH_OUTSIDE_OWNED_WORKSPACE";
  // The only model-created executable artifact in the fixed scenario. Prevent
  // a generated lint/project/hook configuration from executing indirectly.
  if (tool.write && target !== path.join(policy.workspace, "sum-valid.cjs")) return "GROUP_LIVE_FILE_NOT_FROZEN_ARTIFACT";
  if (tool.search && (!noLinksBelow(target) || [args.pattern, args.file_glob, args.glob].some(value => typeof value === "string" && (value.includes("../") || value.includes("..\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)))))
    return "GROUP_LIVE_SEARCH_ESCAPE_OR_UNVERIFIED_TREE";
  return undefined;
}
function recordDecision(policy, input, reason) {
  const safe = { at: Date.now(), runtime: policy.runtime, caseId: policy.caseId, toolName: input.name, decision: reason ? "blocked" : "allowed", reason: reason ?? null,
    sessionId: input.sessionId ?? null, cwd: input.cwd, observedHookCwd: input.observedHookCwd ?? null, argumentsDigest: sha(JSON.stringify(input.arguments)) };
  const fd = fs.openSync(policy.logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0) throw fail("GROUP_LIVE_POLICY_LOG_UNSAFE");
    fs.writeFileSync(fd, JSON.stringify(safe) + "\n");
  } finally { fs.closeSync(fd); }
}
function evaluate(policy, input) { const reason = decide(policy, input); recordDecision(policy, input, reason); return reason; }
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function preparePolicy({ root, workspace, readRoots, runtime, caseId, groupTools, hookCwd }) {
  const directory = path.join(root, "policy");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, runtime + "-" + sha(workspace).slice(0, 16) + ".json"), logPath = file + ".decisions.jsonl";
  const policy = { version: 1, runtime, caseId: caseId ?? "source-handoff", workspace: fs.realpathSync(workspace), readRoots: readRoots.map(root => fs.realpathSync(root)), groupTools, logPath, ...(runtime === "hermes" ? { hookCwd: fs.realpathSync(hookCwd ?? workspace) } : {}) };
  const bytes = JSON.stringify(policy) + "\n";
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o400 });
  return { policy, file, sha256: sha(bytes), module: __filename, moduleSha256: sha(fs.readFileSync(__filename)) };
}
function writeHermesHook({ root, prepared, nodePath }) {
  const hook = path.join(root, "policy/hermes-pre-tool-hook.cjs"), source = '"use strict";\nconst fs=require("node:fs"),p=require(' + JSON.stringify(__filename) + ');\ntry{const data=JSON.parse(fs.readFileSync(0,"utf8"));const {policy}=p.loadPolicy(' + JSON.stringify(prepared.file) + ');if(data.hook_event_name!=="pre_tool_call"||data.cwd!==policy.hookCwd||typeof data.session_id!=="string"||!data.session_id)throw new Error("GROUP_LIVE_HERMES_HOOK_CONTEXT_UNBOUND");const reason=p.evaluate(policy,{name:data.tool_name,arguments:data.tool_input,cwd:policy.workspace,sessionId:data.session_id,observedHookCwd:data.cwd});process.stdout.write(JSON.stringify(reason?{action:"block",message:reason}:{})+"\\n");}catch{process.stdout.write("{\\"action\\":\\"block\\",\\"message\\":\\"GROUP_LIVE_POLICY_UNAVAILABLE\\"}\\n");process.exitCode=2;}\n';
  fs.writeFileSync(hook, source, { flag: "wx", mode: 0o400 });
  return { hook, command: shellQuote(nodePath) + " " + shellQuote(hook), sha256: sha(source) };
}
function writeDeepSeekPlugin({ root, prepared }) {
  const plugin = path.join(root, "policy/deepseek-tool-guard-" + sha(prepared.file).slice(0, 16) + ".mjs"), source = 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);const p=require(' + JSON.stringify(__filename) + ');\nexport const name="synthetic-owned-tool-guard";export const inject=["tools"];export function apply(ctx){const {policy}=p.loadPolicy(' + JSON.stringify(prepared.file) + ');ctx.tools.guard(exec=>{try{return p.evaluate(policy,{name:exec.name,arguments:exec.arguments,cwd:exec.agent?.session?.header?.cwd,sessionId:exec.agent?.session?.header?.id});}catch{return "GROUP_LIVE_POLICY_UNAVAILABLE";}});}\n';
  fs.writeFileSync(plugin, source, { flag: "wx", mode: 0o400 });
  return { plugin, sha256: sha(source) };
}
function verifyDeepSeekContextComposition({ binaryPath, home, profile }) {
  if (profile !== "headless" || typeof home !== "string" || !path.isAbsolute(home) || fs.realpathSync(home) !== home) throw fail("GROUP_LIVE_DEEPSEEK_CONTEXT_COMPOSITION_UNPROVEN");
  const requireSdk = require("node:module").createRequire(require("node:url").pathToFileURL(binaryPath));
  const publicSource = requireSdk.resolve("@deepseek-ai/dsh-app-boot"), publicBytes = fs.readFileSync(publicSource), sourceText = publicBytes.toString("utf8");
  const start = sourceText.indexOf("const PROFILE_PATCH_TEMPLATE = `"), end = sourceText.indexOf("`;", start + 32);
  if (start < 0 || end < 0 || !sourceText.includes('headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]')) throw fail("GROUP_LIVE_DEEPSEEK_PUBLIC_TEMPLATE_UNRECOGNIZED");
  const expectedPatch = sourceText.slice(start + "const PROFILE_PATCH_TEMPLATE = `".length, end).replaceAll("\\`", "`");
  const expectedManifest = JSON.stringify({ name: "dsh-profile-headless", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }, null, 2) + "\n";
  const homePatch = path.join(home,"cordis.patch.yml");
  try { fs.lstatSync(homePatch); throw fail("GROUP_LIVE_DEEPSEEK_HOME_PATCH_PRESENT"); } catch(error) { if(error.code!=="ENOENT") throw error; }
  const profileRoot = path.join(home,"profiles",profile), rootStat = fs.lstatSync(profileRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || fs.realpathSync(profileRoot)!==profileRoot) throw fail("GROUP_LIVE_DEEPSEEK_PROFILE_UNSAFE");
  const files = [];
  for(const [relative,expected] of [["cordis.patch.yml",expectedPatch],["package.json",expectedManifest]]) {
    const file=path.join(profileRoot,relative), before=fs.lstatSync(file);
    if(!before.isFile() || before.isSymbolicLink() || before.uid!==process.getuid() || before.size>64*1024) throw fail("GROUP_LIVE_DEEPSEEK_PROFILE_UNSAFE");
    const bytes=fs.readFileSync(file), after=fs.lstatSync(file);
    if(["dev","ino","size","mtimeMs","ctimeMs"].some(key=>before[key]!==after[key]) || !bytes.equals(Buffer.from(expected))) throw fail("GROUP_LIVE_DEEPSEEK_PROFILE_TEMPLATE_CHANGED");
    files.push({relative,bytes:bytes.length,sha256:sha(bytes),installedTemplateSha256:sha(expected),matchesInstalledTemplate:true});
  }
  const sdkFiles = ["dsh-app-boot", "dsh-tools", "dsh-agent-loop", "dsh-llm", "dsh-system-prompt", "dsh-agent-instructions", "dsh-mcp-client"].map(name=>{
    const file=requireSdk.resolve("@deepseek-ai/"+name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw fail("GROUP_LIVE_DEEPSEEK_SDK_SOURCE_UNSAFE");return {module:"@deepseek-ai/"+name,path:file,sha256:sha(fs.readFileSync(file))};
  });
  return {method:"actual-native-home-profile-byte-equality-to-installed-public-template-before-owned-patch;no-original-context-body-export",home,profile,homePatchPresent:false,publicTemplateSource:publicSource,publicTemplateSourceSha256:sha(publicBytes),files,sdkFiles};
}
module.exports = { ownedPath, noLinksBelow, loadPolicy, decide, evaluate, exactApprovalCommand, preparePolicy, writeHermesHook, writeDeepSeekPlugin, verifyDeepSeekContextComposition };
