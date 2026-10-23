import { createSidecarLockManager, } from "./sidecar-lock.js";
import { getFsSafeLockConfig } from "./lock-config.js";
export { acquireFileLockSync, withFileLockSync, } from "./file-lock-sync.js";
function resolveFileLockManagerKey(targetPath, managerKey) {
    return managerKey ?? `fs-safe.file-lock:${targetPath}`;
}
function withLockDefaults(options) {
    const { managerKey: _managerKey, lockPath } = options;
    const acquireOptions = {};
    for (const key of Reflect.ownKeys(options)) {
        // Node 22 object-rest can read excluded accessors; exclude before copying.
        if (key === "managerKey" || key === "lockPath")
            continue;
        if (!Object.getOwnPropertyDescriptor(options, key)?.enumerable)
            continue;
        Object.defineProperty(acquireOptions, key, {
            value: Reflect.get(options, key),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    const defaults = getFsSafeLockConfig();
    return {
        ...acquireOptions,
        retry: acquireOptions.retry ?? defaults.retry,
        staleMs: acquireOptions.staleMs ?? defaults.staleMs ?? 30_000,
        staleRecovery: acquireOptions.staleRecovery ?? defaults.staleRecovery,
        timeoutMs: acquireOptions.timeoutMs ?? defaults.timeoutMs,
        ...(lockPath === undefined ? {} : { lockPath }),
    };
}
export async function acquireFileLock(targetPath, options) {
    return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey))
        .acquire(targetPath, options);
}
export async function withFileLock(targetPath, options, fn) {
    return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey))
        .withLock(targetPath, options, fn);
}
export function createFileLockManager(key) {
    const manager = createSidecarLockManager(key);
    return {
        acquire: async (targetPath, options) => {
            return await manager.acquire({
                ...withLockDefaults(options),
                targetPath,
            });
        },
        withLock: async (targetPath, options, fn) => {
            return await manager.withLock({
                ...withLockDefaults(options),
                targetPath,
            }, fn);
        },
        drain: manager.drain,
        reset: manager.reset,
        heldEntries: manager.heldEntries,
    };
}
export async function drainFileLockManagerForTest(targetPath, managerKey) {
    await createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).drain();
}
export function resetFileLockManagerForTest(targetPath, managerKey) {
    createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).reset();
}
