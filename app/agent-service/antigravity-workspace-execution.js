"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

// ACP 1.2.1 reads hooks and global MCP servers from GEMINI_HOME, and reads
// workspace hooks from the native session cwd. The managed execution mode must
// not inherit those executable surfaces. Keep auth, trajectories and MCP schema
// artifacts in the account's existing ACP store, while giving this one host an
// empty private config directory and cwd. The actual project remains the frozen
// WorkRun workspace used by workspace_execute, never this native scratch cwd.
function prepareAntigravityWorkspaceExecution(options) {
  const fileSystem = options.fs || fs;
  const { paths, acpHome } = options;
  const source = path.join(acpHome.geminiHome, "antigravity-acp");
  const parent = path.join(paths.stateDir, "runtime-integration", "antigravity-workspace");
  ensurePrivateDirectoryTree(source, paths.trustedRoot);
  ensurePrivateDirectoryTree(parent, paths.trustedRoot);
  const root = fileSystem.mkdtempSync(path.join(parent, "host-"));
  try {
    fileSystem.chmodSync(root, 0o700);
    const cwd = path.join(root, "workspace");
    const config = path.join(root, "config");
    fileSystem.mkdirSync(cwd, { mode: 0o700 });
    fileSystem.mkdirSync(config, { mode: 0o700 });
    const canonical = fileSystem.realpathSync(source);
    // Only our dedicated account ACP directory is linked. The parent and the
    // real project are never linked into the private native config/cwd.
    fileSystem.symlinkSync(canonical, path.join(root, "antigravity-acp"), "dir");
    const identity = fileSystem.lstatSync(root);
    let disposed = false;
    return Object.freeze({ geminiHome: root, cwd,
      dispose() {
        if (disposed) return;
        const current = fileSystem.lstatSync(root);
        if (!current.isDirectory() || current.isSymbolicLink()
          || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw serviceError("WORKSPACE_RUNTIME_GUARD_UNSAFE", "Antigravity's managed native directory changed");
        }
        // rm removes the ACP directory link itself; the shared session/auth
        // directory remains intact. Call only after the native group stopped.
        fileSystem.rmSync(root, { recursive: true });
        disposed = true;
      },
    });
  } catch (error) {
    fileSystem.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function antigravityWorkspaceSessionMeta(workspaceExecutionVersion) {
  // ACP persists filters. Send a real empty denylist when leaving this mode,
  // since omitting metadata would restore the previous persisted allowlist.
  return { agy: workspaceExecutionVersion === 1
    ? { enabledTools: ["ask_question", "finish"] } : { disabledTools: [] } };
}

module.exports = { prepareAntigravityWorkspaceExecution, antigravityWorkspaceSessionMeta };
