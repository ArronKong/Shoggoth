import fs from "node:fs";
import { sidecarLockPayloadCreatedAtMs, sidecarLockTimeout } from "./sidecar-lock-policy.js";
import { ensureSidecarLockCleanupRegistered } from "./sidecar-lock-registration.js";
const SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncSidecarLocks");
const SYNC_ADMISSIONS_KEY = Symbol.for("fsSafe.syncSidecarLockAdmissions");
const SYNC_CLEANUP_REGISTERED_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupRegistered");
const SYNC_CLEANUP_HANDLER_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");
const SYNC_CLEANUP_REGISTRATION_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupRegistration");
const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");
export function foreignSyncHeldLock(route, target) {
    const key = route === "raw" ? ROOT_SYNC_HELD_LOCKS_KEY : SYNC_HELD_LOCKS_KEY;
    const state = globalThis;
    return state[key]?.get(target);
}
export function getSyncHeldLocks() {
    const globalWithState = globalThis;
    if (!globalWithState[SYNC_HELD_LOCKS_KEY]) {
        globalWithState[SYNC_HELD_LOCKS_KEY] = new Map();
    }
    return globalWithState[SYNC_HELD_LOCKS_KEY];
}
export function getSyncLockAdmissions() {
    const globalWithState = globalThis;
    if (!globalWithState[SYNC_ADMISSIONS_KEY]) {
        globalWithState[SYNC_ADMISSIONS_KEY] = new Map();
    }
    return globalWithState[SYNC_ADMISSIONS_KEY];
}
export function defaultSyncShouldReclaim(snapshot, staleMs, nowMs) {
    const createdAtMs = sidecarLockPayloadCreatedAtMs(snapshot.payload);
    if (createdAtMs !== null)
        return nowMs - createdAtMs > staleMs;
    if (!snapshot.stat)
        return true;
    const mtimeMs = "mtimeNs" in snapshot.stat
        ? Number(snapshot.stat.mtimeNs) / 1e6 : snapshot.stat.mtimeMs;
    return nowMs - mtimeMs > staleMs;
}
export function syncReclaimGuardExists(reclaimGuardPath) {
    try {
        fs.lstatSync(reclaimGuardPath);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
export function ensureSyncLockExitCleanupRegistered(cleanup, lockPath, normalizedTargetPath) {
    ensureSidecarLockCleanupRegistered({
        event: "exit",
        registered: SYNC_CLEANUP_REGISTERED_KEY,
        registering: SYNC_CLEANUP_REGISTRATION_KEY,
        handler: SYNC_CLEANUP_HANDLER_KEY,
        reentryError: () => sidecarLockTimeout(lockPath, normalizedTargetPath),
    }, cleanup, true);
}
