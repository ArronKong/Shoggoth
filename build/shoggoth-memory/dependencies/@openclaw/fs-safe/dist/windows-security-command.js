import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FsSafeError } from "./errors.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, PermissionCommandError } from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { parseWindowsOwnerAndDaclFacts, parseWindowsSecurityCommandFacts, unverified } from "./windows-security-facts.js";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const FULL_IDENTITY = /^[0-9a-f]{16}:[0-9a-f]{32}$/;
export const WINDOWS_SECURITY_BATCH_MAX_BYTES = 16 * 1024 * 1024;
function isFullIdentity(identity) {
    return typeof identity === "string" && identity.length === 49 && FULL_IDENTITY.test(identity);
}
function assertIdentity(identity) {
    if (!isFullIdentity(identity)) {
        throw new TypeError("Windows security operation requires a complete file identity");
    }
}
function command(operation, params) {
    const targetPath = params.targetPath ?? "";
    // Preserve native EINVAL before child-process environment validation runs.
    if (targetPath.includes("\0")) {
        throw Object.assign(new Error("Windows path contains a NUL byte"), { code: "EINVAL" });
    }
    if (params.fd !== undefined || operation === "descriptor" || operation === "protect-file" || operation === "verify-file") {
        if (typeof params.fd !== "number" || !Number.isInteger(params.fd) || params.fd < 0 || params.fd > 0x7fff_ffff) {
            unverified("Windows security inspection requires a valid descriptor");
        }
    }
    if (params.expectedParentIdentity !== undefined)
        assertIdentity(params.expectedParentIdentity);
    if (params.expectedFileIdentity !== undefined)
        assertIdentity(params.expectedFileIdentity);
    if (params.expectedLinks !== undefined &&
        (!Number.isInteger(params.expectedLinks) || params.expectedLinks < 1 || params.expectedLinks > 0xffff_ffff)) {
        throw new TypeError("Windows security operation requires a positive uint32 link count");
    }
    const script = fileURLToPath(new URL("./windows-security-bridge.ps1", import.meta.url));
    return {
        file: resolveWindowsSystemCommand(String.raw `WindowsPowerShell\v1.0\powershell.exe`),
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Operation", operation],
        // Preserve Windows UTF-16 spelling and leave long paths out of the bounded
        // command line. This overrides any inherited value only in this child.
        env: {
            ...process.env,
            FS_SAFE_WINDOWS_SECURITY_PATH: targetPath,
            FS_SAFE_WINDOWS_SECURITY_REQUIRE_PRIVATE: params.requirePrivate ? "1" : "0",
            FS_SAFE_WINDOWS_SECURITY_PARENT_IDENTITY: params.expectedParentIdentity ?? "",
            FS_SAFE_WINDOWS_SECURITY_FILE_IDENTITY: params.expectedFileIdentity ?? "",
            FS_SAFE_WINDOWS_SECURITY_EXPECTED_LINKS: String(params.expectedLinks ?? 1),
        },
    };
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseReply(stdout, operation) {
    try {
        return parseReplyValue(stdout, operation);
    }
    catch (error) {
        if (operation === "create" && error instanceof Error && error.code !== "EEXIST") {
            Object.assign(error, { creationOutcome: "unconfirmed" });
        }
        throw error;
    }
}
function parseReplyValue(stdout, operation) {
    let response;
    try {
        response = JSON.parse(stdout.trim());
    }
    catch (cause) {
        unverified("Windows security command returned invalid data", cause);
    }
    if (!record(response) || typeof response.ok !== "boolean") {
        unverified("Windows security command returned an incomplete response");
    }
    if (!response.ok) {
        if (operation === "paths" &&
            (response.code === "helper-unavailable" || response.code === "too-large") && typeof response.message === "string") {
            throw new FsSafeError(response.code, response.message);
        }
        const codes = new Set(["EACCES", "EPERM", "EEXIST", "ENOENT", "ENOTSUP", "EIO", "EBADF", "ELOOP", "ENOTDIR", "EINVAL", "ENOSPC", "EBUSY"]);
        if (typeof response.code !== "string" || !codes.has(response.code) || typeof response.message !== "string") {
            unverified("Windows security command returned an invalid failure");
        }
        throw Object.assign(new Error(response.message), { code: response.code });
    }
    if (operation === "create" && (!record(response.result) || response.result.created !== true || !isFullIdentity(response.result.identity))) {
        unverified("Windows security command did not verify private-directory creation");
    }
    return response.result;
}
function executeSync(operation, params) {
    const { file, args, env } = command(operation, params);
    const startedAt = performance.now();
    const result = spawnSync(file, args, {
        encoding: "utf8", windowsHide: true, env, stdio: [params.fd ?? "ignore", "pipe", "pipe"],
        timeout: DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error || result.status !== 0) {
        const error = new PermissionCommandError(file, performance.now() - startedAt, {
            cause: result.error, code: result.status,
            signal: result.error?.code === "ETIMEDOUT" ? "SIGKILL" : result.signal,
            stderr: result.stderr,
            killed: result.error?.code === "ETIMEDOUT",
            ...(operation === "create" ? { creationOutcome: "unconfirmed" } : {}),
        });
        if (operation === "create")
            Object.assign(error, { creationOutcome: "unconfirmed" });
        throw error;
    }
    return parseReply(result.stdout, operation);
}
class WindowsSecurityCommandError extends PermissionCommandError {
    timedOut;
    creationOutcome;
    processExitConfirmed;
    constructor(file, durationMs, receipt, timedOut, timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS) {
        super(file, durationMs, receipt, timeoutMs);
        this.timedOut = timedOut;
        this.creationOutcome = receipt.creationOutcome;
        this.processExitConfirmed = receipt.processExitConfirmed;
        if (timedOut)
            this.message = `Windows permission inspection timed out after ${timeoutMs}ms`;
        if (!receipt.processExitConfirmed)
            this.message += "; process exit was not confirmed";
        else if (!receipt.outputClosed)
            this.message += "; command output did not close";
        if (receipt.creationOutcome)
            this.message += "; private-directory creation outcome is unconfirmed";
    }
}
/** Cleanup must preserve stages still reachable by an unsettled command. */
export function hasUnsettledWindowsSecurityCommand(error) {
    const pending = [error];
    const seen = new Set();
    for (let inspected = 0; pending.length && inspected < 32; inspected++) {
        const current = pending.pop();
        if (current === null || typeof current !== "object" || seen.has(current))
            continue;
        seen.add(current);
        try {
            if (current instanceof WindowsSecurityCommandError && !current.processExitConfirmed)
                return true;
            const cause = Object.getOwnPropertyDescriptor(current, "cause");
            if (cause && "value" in cause)
                pending.push(cause.value);
            if (current instanceof AggregateError) {
                const errors = Object.getOwnPropertyDescriptor(current, "errors");
                if (errors && "value" in errors && Array.isArray(errors.value))
                    pending.push(...errors.value.slice(0, 32));
            }
        }
        catch {
            // Unknown error wrappers cannot prove that command-owned handles settled.
            return true;
        }
    }
    return pending.length > 0;
}
function ignoreLateError() { }
async function execute(operation, params, request) {
    const selected = request ?? command(operation, params);
    const { file, args, env, input, timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES } = selected;
    const startedAt = performance.now();
    return await new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, env, stdio: [input === undefined ? params.fd ?? "ignore" : "pipe", "pipe", "pipe"] });
        const output = [];
        const errors = [];
        let bytes = 0;
        let failure;
        let failed = false;
        let timedOut = false;
        let stopping = false;
        let settled = false;
        let processExitConfirmed = false;
        let exitCode = null;
        let exitSignal = null;
        let terminationSignalSent;
        let terminationError;
        let grace;
        let missingPipes;
        const deadlineError = () => new Error("Windows security command exceeded its inspection deadline");
        const timeout = setTimeout(() => {
            timedOut = true;
            fail(deadlineError());
        }, timeoutMs);
        const finish = (outputClosed) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(grace);
            clearImmediate(missingPipes);
            child.removeListener("exit", onExit);
            child.removeListener("close", onClose);
            child.removeListener("error", onChildError);
            child.on("error", ignoreLateError);
            const cleanupErrors = [];
            if (input !== undefined && child.stdin) {
                child.stdin.removeListener("error", fail);
                child.stdin.on("error", ignoreLateError);
                if (!outputClosed) {
                    try {
                        child.stdin.destroy();
                    }
                    catch (error) {
                        cleanupErrors.push(error);
                    }
                }
            }
            for (const [stream, collect] of [[child.stdout, collectOutput], [child.stderr, collectErrors]]) {
                if (!stream)
                    continue;
                stream.removeListener("data", collect);
                stream.removeListener("error", fail);
                stream.on("error", ignoreLateError);
                if (!outputClosed) {
                    try {
                        stream.destroy();
                    }
                    catch (error) {
                        cleanupErrors.push(error);
                    }
                }
            }
            if (!outputClosed && !processExitConfirmed) {
                try {
                    child.unref();
                }
                catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (failed || exitCode !== 0 || !outputClosed) {
                reject(new WindowsSecurityCommandError(file, performance.now() - startedAt, {
                    cause: failure, pid: child.pid ?? null, code: exitCode, signal: exitSignal, stderr: Buffer.concat(errors),
                    processExitConfirmed, outputClosed, terminationSignalSent, terminationError, cleanupErrors,
                    ...(operation === "create" ? { creationOutcome: "unconfirmed" } : {}),
                }, timedOut, timeoutMs));
            }
            else {
                try {
                    resolve(parseReply(Buffer.concat(output).toString("utf8"), operation));
                }
                catch (error) {
                    reject(error);
                }
            }
            output.length = 0;
            errors.length = 0;
        };
        const fail = (error) => {
            if (settled)
                return;
            if (!failed) {
                failed = true;
                failure = error;
            }
            if (stopping)
                return;
            stopping = true;
            clearTimeout(timeout);
            // kill() can synchronously emit error, throw, or return false. None proves exit.
            grace = setTimeout(() => finish(false), TERMINATION_GRACE_MS);
            if (!processExitConfirmed) {
                try {
                    terminationSignalSent = child.kill("SIGKILL");
                }
                catch (error) {
                    terminationError ??= error;
                }
            }
        };
        const collect = (chunks) => (chunk) => {
            if (failed || settled)
                return;
            bytes += chunk.length;
            if (bytes <= maxOutputBytes)
                chunks.push(chunk);
            else
                fail(new Error("Windows security command exceeded its output budget"));
        };
        const collectOutput = collect(output);
        const collectErrors = collect(errors);
        const onChildError = (error) => {
            if (settled)
                return;
            if (stopping)
                terminationError ??= error;
            else
                fail(error);
        };
        const onExit = (code, signal) => {
            processExitConfirmed = true;
            exitCode = code;
            exitSignal = signal;
        };
        const onClose = (code, signal) => {
            onExit(code, signal);
            if (!failed && performance.now() - startedAt >= timeoutMs) {
                timedOut = true;
                failed = true;
                failure = deadlineError();
            }
            finish(true);
        };
        child.on("error", onChildError);
        child.once("exit", onExit);
        // Success still joins exit and both pipes. Failure releases only owned endpoints
        // after grace; the child inherited its own HANDLE, independent of the caller fd.
        child.once("close", onClose);
        child.stdout?.on("error", fail);
        child.stderr?.on("error", fail);
        child.stdout?.on("data", collectOutput);
        child.stderr?.on("data", collectErrors);
        if (!child.stdout || !child.stderr || (input !== undefined && !child.stdin)) {
            // Node reports spawn errors on nextTick, which can follow the current microtask.
            missingPipes = setImmediate(() => { if (!failed && !settled)
                fail(new Error("Windows security command output pipes are unavailable")); });
        }
        if (input !== undefined && child.stdin) {
            child.stdin.on("error", fail);
            try {
                child.stdin.end(input, "utf8");
            }
            catch (error) {
                fail(error);
            }
        }
    });
}
export async function readWindowsSecurityFactsBatch(paths, options) {
    const invocation = command("paths", {});
    const request = {
        ...invocation,
        input: JSON.stringify(paths),
        timeoutMs: options.timeoutMs,
        maxOutputBytes: WINDOWS_SECURITY_BATCH_MAX_BYTES,
    };
    if (options.native) {
        request.file = process.execPath;
        request.args = ["--", fileURLToPath(new URL("./owner-dacl-batch-worker.js", import.meta.url))];
        request.env = {
            ...Object.fromEntries(Object.entries(invocation.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH", "FS_SAFE_OWNER_DACL_BATCH_MODE"].includes(key.toUpperCase()))),
            FS_SAFE_OWNER_DACL_BATCH_MODE: options.mode,
        };
    }
    const response = await execute("paths", {}, request);
    if (!Array.isArray(response) || response.length !== paths.length) {
        unverified("Windows security command returned an incomplete path batch");
    }
    return response.map((row, index) => {
        if (!record(row) || row.path !== paths[index]) {
            unverified("Windows security command returned a mismatched path batch");
        }
        return parseWindowsOwnerAndDaclFacts(row.security);
    });
}
export function readWindowsSecurityFactsCommand(targetPath) {
    return parseWindowsSecurityCommandFacts(executeSync("path", { targetPath }));
}
export async function inspectWindowsDescriptorCommand(fd) {
    const response = await execute("descriptor", { fd });
    if (!record(response) || typeof response.identity !== "string") {
        unverified("Windows security command returned incomplete handle facts");
    }
    return { identity: response.identity, security: parseWindowsSecurityCommandFacts(response.security) };
}
export async function createPrivateWindowsDirectoryCommand(targetPath, expectedParentIdentity) {
    return fullIdentityReceipt(await execute("create", { targetPath, expectedParentIdentity }));
}
export function createPrivateWindowsDirectoryCommandSync(targetPath, expectedParentIdentity) {
    return fullIdentityReceipt(executeSync("create", { targetPath, expectedParentIdentity }));
}
function fullIdentityReceipt(response, expected) {
    if (!record(response) || !isFullIdentity(response.identity)) {
        unverified("Windows security command returned an incomplete file identity");
    }
    if (expected !== undefined && response.identity !== expected) {
        throw new FsSafeError("path-mismatch", "Windows security command observed a different file");
    }
    return { identity: response.identity };
}
export function inspectWindowsDirectoryCommandSync(targetPath, requirePrivate) {
    return fullIdentityReceipt(executeSync("directory", { targetPath, requirePrivate }));
}
export async function inspectWindowsDirectoryCommand(targetPath, requirePrivate) {
    return fullIdentityReceipt(await execute("directory", { targetPath, requirePrivate }));
}
export function protectPrivateWindowsFileCommandSync(fd, targetPath, expectedParentIdentity) {
    assertIdentity(expectedParentIdentity);
    return fullIdentityReceipt(executeSync("protect-file", { fd, targetPath, expectedParentIdentity }));
}
export async function protectPrivateWindowsFileCommand(fd, targetPath, expectedParentIdentity) {
    assertIdentity(expectedParentIdentity);
    return fullIdentityReceipt(await execute("protect-file", { fd, targetPath, expectedParentIdentity }));
}
export function verifyPrivateWindowsFileCommandSync(fd, targetPath, expectedFileIdentity, expectedParentIdentity, expectedLinks = 1) {
    assertIdentity(expectedFileIdentity);
    assertIdentity(expectedParentIdentity);
    fullIdentityReceipt(executeSync("verify-file", {
        fd, targetPath, expectedFileIdentity, expectedParentIdentity, expectedLinks,
    }), expectedFileIdentity);
}
export async function verifyPrivateWindowsFileCommand(fd, targetPath, expectedFileIdentity, expectedParentIdentity, expectedLinks = 1) {
    assertIdentity(expectedFileIdentity);
    assertIdentity(expectedParentIdentity);
    fullIdentityReceipt(await execute("verify-file", {
        fd, targetPath, expectedFileIdentity, expectedParentIdentity, expectedLinks,
    }), expectedFileIdentity);
}
