import fsSync from "node:fs";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { removeSidecarLockIfUnchanged, sidecarLockSnapshotMatches, } from "./sidecar-lock-reclaim.js";
import { acquireSidecarLock } from "./sidecar-lock-acquire.js";
import { createHeldSidecarLockHandle, stopSidecarLockMonitoring } from "./sidecar-lock-handle.js";
import { createSuppressedError } from "./suppressed-error.js";
import { ensureSidecarLockCleanupRegistered } from "./sidecar-lock-registration.js";
const GLOBAL_STATE_KEY = Symbol.for("fsSafe.sidecarLockManagers");
const GLOBAL_CLEANUP_KEY = Symbol.for("fsSafe.sidecarLockCleanupRegistered");
const GLOBAL_CLEANUP_HANDLER_KEY = Symbol.for("fsSafe.sidecarLockCleanupHandler");
const GLOBAL_CLEANUP_REGISTRATION_KEY = Symbol.for("fsSafe.sidecarLockCleanupRegistration");
const GLOBAL_BEFORE_EXIT_KEY = Symbol.for("fsSafe.sidecarLockBeforeExitCleanup");
const GLOBAL_BEFORE_EXIT_HANDLER_KEY = Symbol.for("fsSafe.sidecarLockBeforeExitCleanupHandler");
const GLOBAL_BEFORE_EXIT_REGISTRATION_KEY = Symbol.for("fsSafe.sidecarLockBeforeExitCleanupRegistration");
// Set by copies whose exit handlers honor retainOnExit. When an older package
// copy registered the handlers first, this marker stays absent and retained
// acquisitions must fail closed rather than silently lose the guarantee.
const GLOBAL_RETAIN_AWARE_KEY = Symbol.for("fsSafe.sidecarLockRetainAwareCleanup");
function getGlobalManagers() {
    const globalWithState = globalThis;
    if (!globalWithState[GLOBAL_STATE_KEY]) {
        globalWithState[GLOBAL_STATE_KEY] = new Map();
    }
    return globalWithState[GLOBAL_STATE_KEY];
}
function resolveManagerState(key) {
    const managers = getGlobalManagers();
    let state = managers.get(key);
    if (!state) {
        state = {
            cleanupRegistered: false,
            held: new Map(),
            admissions: new Map(),
            reclaimCleanupRegistered: false,
            reclaimGuards: new Set(),
        };
        managers.set(key, state);
    }
    else {
        // The global manager symbol is shared across package copies and hot reloads.
        // Backfill state created by fs-safe versions that predate admission tokens
        // or reclaim guards without placing an incomplete value in the held map.
        state.admissions ??= new Map();
        state.reclaimCleanupRegistered ??= false;
        state.reclaimGuards ??= new Set();
    }
    return state;
}
function snapshotMatchesSync(lockPath, observed) {
    let fd;
    try {
        const beforeStat = fsSync.lstatSync(lockPath, { bigint: true });
        if (!beforeStat.isFile()) {
            return false;
        }
        const openFlags = fsSync.constants.O_RDONLY |
            (process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
                ? fsSync.constants.O_NOFOLLOW
                : 0) |
            (typeof fsSync.constants.O_NONBLOCK === "number" ? fsSync.constants.O_NONBLOCK : 0);
        fd = fsSync.openSync(lockPath, openFlags);
        const openedStat = fsSync.fstatSync(fd, { bigint: true });
        // Token-owned files can have different descriptor/path identities on VirtioFS.
        // Require a known descriptor identity without rejecting that supported drift.
        if (!openedStat.isFile() || !sameFileIdentityForCleanup(openedStat, openedStat)) {
            return false;
        }
        if (observed.raw !== undefined && openedStat.size !== BigInt(Buffer.byteLength(observed.raw))) {
            return false;
        }
        const raw = fsSync.readFileSync(fd, "utf8");
        const afterStat = fsSync.lstatSync(lockPath, { bigint: true });
        if (!afterStat.isFile() || !sameFileIdentityForCleanup(beforeStat, afterStat)) {
            return false;
        }
        return sidecarLockSnapshotMatches({ raw, payload: null, stat: afterStat }, observed);
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined) {
            try {
                fsSync.closeSync(fd);
            }
            catch {
                // Best-effort process-exit cleanup.
            }
        }
    }
}
function releaseAllReclaimGuardsSync(state) {
    // Exit cleanup also visits managers created by older copies and never reopened here.
    for (const reclaimGuardPath of state.reclaimGuards ?? []) {
        try {
            fsSync.rmdirSync(reclaimGuardPath);
            state.reclaimGuards.delete(reclaimGuardPath);
        }
        catch {
            // Best-effort process-exit cleanup. A surviving guard fails closed.
        }
    }
}
function releaseAllLocksSync(state, options) {
    for (const [normalizedTargetPath, held] of state.held) {
        stopSidecarLockMonitoring(held);
        void held.handle.close().catch(() => undefined);
        try {
            const retained = options?.preserveRetained === true && held.retainOnExit;
            if (!retained && !held.lockRoot && snapshotMatchesSync(held.lockPath, held.snapshot)) {
                fsSync.rmSync(held.lockPath, { force: true });
            }
        }
        catch {
            // Best-effort process-exit cleanup.
        }
        state.held.delete(normalizedTargetPath);
    }
    state.admissions?.clear();
    releaseAllReclaimGuardsSync(state);
}
function ensureGlobalExitCleanupRegistered() {
    const cleanup = () => {
        for (const state of getGlobalManagers().values()) {
            releaseAllLocksSync(state, { preserveRetained: true });
        }
    };
    ensureSidecarLockCleanupRegistered({
        event: "exit",
        registered: GLOBAL_CLEANUP_KEY,
        registering: GLOBAL_CLEANUP_REGISTRATION_KEY,
        handler: GLOBAL_CLEANUP_HANDLER_KEY,
        retainAware: GLOBAL_RETAIN_AWARE_KEY,
        reentryError: () => new FsSafeError("helper-unavailable", "sidecar lock exit cleanup registration is already in progress"),
    }, cleanup, true);
}
/** True when a retain-unaware package copy registered the process-exit handlers first. */
export function exitCleanupCannotRetain() {
    const globalWithCleanup = globalThis;
    return globalWithCleanup[GLOBAL_CLEANUP_KEY] === true && globalWithCleanup[GLOBAL_RETAIN_AWARE_KEY] !== true;
}
function ensureGlobalBeforeExitCleanupRegistered() {
    // Independent of the exit registration, which an older package copy may own.
    const lifecycle = { armed: false };
    const cleanup = () => {
        if (!lifecycle.armed)
            return;
        // Cleanup itself schedules I/O; retry only after another acquisition.
        lifecycle.armed = false;
        for (const state of getGlobalManagers().values()) {
            for (const [normalizedTargetPath, held] of Array.from(state.held.entries())) {
                if (held.lockRoot && !held.retainOnExit) {
                    void releaseHeldLock(state, normalizedTargetPath, held, { force: true }).catch(() => undefined);
                }
            }
        }
    };
    return ensureSidecarLockCleanupRegistered({
        event: "beforeExit",
        registered: GLOBAL_BEFORE_EXIT_KEY,
        registering: GLOBAL_BEFORE_EXIT_REGISTRATION_KEY,
        handler: GLOBAL_BEFORE_EXIT_HANDLER_KEY,
        reentryError: () => new FsSafeError("helper-unavailable", "sidecar lock before-exit cleanup registration is already in progress"),
    }, cleanup, lifecycle);
}
async function releaseHeldLock(state, normalizedTargetPath, held, options = {}) {
    const current = state.held.get(normalizedTargetPath);
    if (current !== held) {
        return false;
    }
    if (held.releasePromise) {
        await held.releasePromise;
        return true;
    }
    // Older package copies can add holders after this manager was constructed.
    held.refCount ??= 1;
    if (options.force) {
        held.refCount = 0;
    }
    else if (!options.retry && held.refCount > 0) {
        held.refCount -= 1;
    }
    if (held.refCount > 0) {
        return false;
    }
    held.releasePromise = (async () => {
        await held.handle.close().catch(() => undefined);
        await removeSidecarLockIfUnchanged(held.lockPath, held.snapshot, {
            lockRoot: held.lockRoot,
            parsePayload: held.parsePayload,
        });
        if (state.held.get(normalizedTargetPath) === held) {
            state.held.delete(normalizedTargetPath);
        }
        stopSidecarLockMonitoring(held);
    })();
    try {
        await held.releasePromise;
        return true;
    }
    finally {
        held.releasePromise = undefined;
    }
}
function handleForHeldLock(state, normalizedTargetPath, held) {
    return createHeldSidecarLockHandle({
        normalizedTargetPath,
        held,
        release: async (options) => await releaseHeldLock(state, normalizedTargetPath, held, { retry: options?.retry }),
    });
}
export function createSidecarLockManager(key) {
    const state = resolveManagerState(key);
    function ensureExitCleanupRegistered() {
        ensureGlobalExitCleanupRegistered();
        const lifecycle = ensureGlobalBeforeExitCleanupRegistered();
        state.cleanupRegistered = true;
        state.reclaimCleanupRegistered = true;
        return lifecycle;
    }
    function armExitCleanup(lifecycle) {
        lifecycle.armed = true;
    }
    function assertRetainOnExitSupported(retainOnExit) {
        if (retainOnExit !== true || !exitCleanupCannotRetain())
            return;
        throw new FsSafeError("helper-unavailable", "retainOnExit requires this process's exit handlers to be retain-aware; an older package copy registered them first");
    }
    async function acquire(options) {
        return await acquireSidecarLock(options, {
            held: state.held,
            admissions: state.admissions,
            reclaimGuards: state.reclaimGuards,
            ensureExitCleanupRegistered,
            armExitCleanup,
            assertRetainOnExitSupported,
            handleForHeldLock: (normalizedTargetPath, held) => handleForHeldLock(state, normalizedTargetPath, held),
        });
    }
    async function withLock(options, fn) {
        const lock = await acquire(options);
        let result;
        try {
            result = await fn();
        }
        catch (bodyError) {
            try {
                await lock.release();
            }
            catch (releaseError) {
                throw createSuppressedError(releaseError, bodyError, "file lock callback and release both failed");
            }
            throw bodyError;
        }
        await lock.release();
        return result;
    }
    async function drain() {
        for (const [normalizedTargetPath, held] of Array.from(state.held.entries())) {
            await releaseHeldLock(state, normalizedTargetPath, held, { force: true }).catch(() => undefined);
        }
    }
    function reset() {
        releaseAllLocksSync(state);
    }
    function heldEntries() {
        return Array.from(state.held.entries()).map(([normalizedTargetPath, held]) => ({
            normalizedTargetPath,
            lockPath: held.lockPath,
            acquiredAt: held.acquiredAt,
            metadata: held.metadata,
            forceRelease: () => releaseHeldLock(state, normalizedTargetPath, held, { force: true }),
        }));
    }
    return { acquire, withLock, drain, reset, heldEntries };
}
export async function withSidecarLock(targetPath, options, fn) {
    const manager = createSidecarLockManager(options.managerKey ?? `fs-safe.sidecar-lock:${targetPath}`);
    const { managerKey: _managerKey, ...acquireOptions } = options;
    return await manager.withLock({ ...acquireOptions, targetPath }, fn);
}
