"use strict";
const { EXECUTION_TIMEOUT_MS } = require("../execution-timeout");

// This is an execution capability, not a caller-supplied workspace grant. The
// Service obtains the workspace and permission mode from the frozen WorkRun.
const WORKSPACE_EXECUTION_TOOL = Object.freeze({
  name: "workspace_execute",
  inputSchema: { type: "object", properties: {
    command: { type: "string", minLength: 1, maxLength: 65536 },
    cwd: { type: "string", maxLength: 4096 },
    timeoutMs: { type: "integer", minimum: 1, maximum: EXECUTION_TIMEOUT_MS,
      description: "Execution deadline in milliseconds; defaults to 1800000 (30 minutes), which is also the maximum." },
    access: { type: "object", properties: {
      readPaths: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } },
      writePaths: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } },
      network: { type: "boolean" },
    }, additionalProperties: false },
    reason: { type: "string", minLength: 1, maxLength: 1024 },
  }, required: ["command"], additionalProperties: false },
});
const WORKSPACE_EXECUTION_CAPABILITY = Object.freeze({ domain: "workspace", feature: "execute",
  tool: WORKSPACE_EXECUTION_TOOL.name, risk: "write", uiVisible: false,
  description: "Run a shell command, script, build, test or file operation inside the current WorkRun workspace without another approval in Approve for me mode. Available for Antigravity, Pi, OpenCode and DeepSeek Harness. The Service enforces an OS sandbox: workspace read/write, public system tools read-only, private temporary HOME, no network, no other user files or desktop access. cwd is relative to this workspace. Use this for all workspace operations in this mode, including node -e and dotfiles. Background processes stop when this invocation ends. When wider access is necessary, supply access with exact absolute readPaths/writePaths and/or network=true for outgoing IP connections, plus reason; the user must approve those final arguments once before execution. A wider request still uses the sandbox and does not grant desktop access, Runtime credentials or Service storage. Nonzero exits, timeouts and blocked accesses are real failures; never automatically replay a partially completed command, expand its access or claim it ran outside the sandbox. Use existing browser and computer tools for those capabilities." });

const WORKSPACE_AUTO_RUNTIMES = new Set(["antigravity", "pi", "opencode", "deepseek-harness"]);
function workspaceAutoExecution(contract) {
  return !!contract && contract.workspaceExecutionVersion === 1 && contract.permissionMode === "auto-review"
    && WORKSPACE_AUTO_RUNTIMES.has(contract.runtime)
    && ["workspace-write", "danger-full-access"].includes(contract.permissionPolicy?.sandbox)
    && contract.permissionPolicy?.approvalPolicy === "on-request"
    && !["compaction", "proactive", "memory_extraction"].includes(contract.source);
}
function workspaceExecutionInstructions(contract) {
  return workspaceAutoExecution(contract) ? [
    "WORKSPACE AUTOMATIC EXECUTION",
    "Use the Shoggoth workspace_execute tool for workspace file operations and commands, including scripts, builds, tests, moves and deletions. This is the automatically authorized execution path in Approve for me mode.",
    "The selected mode already authorizes file changes, moves and deletions inside this workspace through this tool; do not ask again for those workspace operations. Other Shoggoth tools keep their own confirmation rules.",
    "The tool runs in an enforced OS sandbox with no network, other user files or desktop access. Its HOME and temporary directory are private scratch space. System developer tools are read-only. Use relative paths and preserve the current workspace.",
    "Do not request native file or shell approval for workspace work: that path is declined by the host routing policy so you can use workspace_execute. This routing decline does not cancel the user's task. A user's denial of an actual wider-access request must be respected. Native tools do not acquire broader authorization from this mode. When wider file or network access is necessary, request exact extra readPaths/writePaths or network=true in workspace_execute.access with a reason; the Service asks the user before that one invocation. It remains sandboxed. Use existing separately authorized system, browser and computer tools for those capabilities. If a command fails or has an unknown outcome, inspect its result before attempting new work; never replay it automatically with broader access.",
  ].join("\n") : "";
}
function validWorkspaceExecutionArguments(args) {
  const dataObject = value => {
    try {
      return !!value && Object.getPrototypeOf(value) === Object.prototype
        && Reflect.ownKeys(value).every(key => {
          if (typeof key !== "string") return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
        });
    } catch { return false; }
  };
  if (!dataObject(args)
    || Object.keys(args).some(key => !["command", "cwd", "timeoutMs", "access", "reason"].includes(key))) return false;
  const text = (value, maximum, empty = false) => typeof value === "string" && (empty || value.length > 0)
    && value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= maximum;
  const access = args.access;
  if (access !== undefined) {
    if (!dataObject(access)
      || Object.keys(access).some(key => !["readPaths", "writePaths", "network"].includes(key))
      || (access.network !== undefined && typeof access.network !== "boolean")) return false;
    for (const paths of [access.readPaths, access.writePaths]) {
      if (paths !== undefined) {
        if (!Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype || paths.length > 8
          || Reflect.ownKeys(paths).length !== paths.length + 1) return false;
        const values = [];
        for (let index = 0; index < paths.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
          const value = descriptor.value;
          if (!text(value, 4096) || !value.startsWith("/") || /[\x00-\x1f]/u.test(value)) return false;
          values.push(value);
        }
        if (new Set(values).size !== values.length) return false;
      }
    }
  }
  if ((access?.network === true || access?.readPaths?.length || access?.writePaths?.length) && !text(args.reason, 1024)) return false;
  return text(args.command, 65536) && args.command.trim().length > 0
    && (args.cwd === undefined || text(args.cwd, 4096, true))
    && (args.reason === undefined || text(args.reason, 1024))
    && (args.timeoutMs === undefined || Number.isInteger(args.timeoutMs) && args.timeoutMs >= 1 && args.timeoutMs <= EXECUTION_TIMEOUT_MS);
}

function widerWorkspaceAccess(args) {
  return args.access?.network === true || !!args.access?.readPaths?.length || !!args.access?.writePaths?.length;
}

module.exports = { WORKSPACE_EXECUTION_TOOL, WORKSPACE_EXECUTION_CAPABILITY,
  workspaceAutoExecution, workspaceExecutionInstructions, validWorkspaceExecutionArguments, widerWorkspaceAccess };
