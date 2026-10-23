import path from "node:path";
import { withFileLock, withFileLockSync } from "./file-lock.js";
import { sha256Hex } from "./file-identity.js";
export function validateRenameIdentity(policy) {
    if (policy !== undefined && policy !== "strict" && policy !== "verify-content-with-lock") {
        throw new RangeError("renameIdentity must be strict or verify-content-with-lock");
    }
}
export function atomicExpectedContentHash(policy, content) {
    if (policy !== "verify-content-with-lock")
        return undefined;
    return sha256Hex(typeof content === "string" ? content : Buffer.from(content));
}
function lockOptions(filePath) {
    const resolved = path.resolve(filePath);
    return {
        managerKey: `fs-safe.atomic:${resolved}`,
        lockPath: path.join(path.dirname(resolved), `.fs-safe-atomic-${sha256Hex(resolved)}.lock`),
        staleMs: 30_000,
        timeoutMs: 5_000,
        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
        retry: { retries: 5, minTimeout: 100, maxTimeout: 2_000, factor: 2 },
    };
}
export async function withAtomicRenameIdentityLock(filePath, fn) {
    return await withFileLock(filePath, lockOptions(filePath), fn);
}
export function withAtomicRenameIdentityLockSync(filePath, fn) {
    return withFileLockSync(filePath, lockOptions(filePath), fn);
}
