import syncFs, {} from "node:fs";
import fs, {} from "node:fs/promises";
import { assertAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
export function readErrorCode(error) {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") {
        return undefined;
    }
    try {
        return Reflect.get(error, "code");
    }
    catch {
        return undefined;
    }
}
export function hasErrorCode(error, expected) {
    return readErrorCode(error) === expected;
}
async function removeOwnedPath(params) {
    if (!params.identity)
        return "preserved";
    try {
        const current = syncFs.lstatSync(params.pathname, { bigint: true });
        if (current.isSymbolicLink() ||
            !current.isFile() ||
            current.nlink !== 1n ||
            !sameFileIdentityForCleanup(current, params.identity)) {
            return "preserved";
        }
        await fs.unlink(params.pathname);
        return "removed";
    }
    catch (error) {
        if (hasErrorCode(error, "ENOENT"))
            return "name-absent";
        throw error;
    }
}
// Borrowed handle: the caller retains it until guarded cleanup finishes.
export async function cleanupPinnedFilePath(params) {
    if (!params.identity)
        return "preserved";
    try {
        const guard = params.parentGuard;
        if ([guard.stat.dev, guard.stat.ino].some((value) => typeof value === "number" && !Number.isSafeInteger(value)))
            return "preserved";
        await assertAsyncDirectoryGuard(guard);
        const parent = syncFs.lstatSync(guard.dir, { bigint: true });
        if (parent.isSymbolicLink() || !parent.isDirectory() ||
            !sameFileIdentityForCleanup(parent, guard.stat))
            return "preserved";
        const opened = syncFs.fstatSync(params.handle.fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n ||
            !sameFileIdentityForCleanup(opened, params.identity))
            return "preserved";
    }
    catch (error) {
        // Unverifiable authority must preserve the path and the original write failure.
        if (params.throwOnCleanupError &&
            !(error instanceof FsSafeError && error.category === "policy") &&
            !hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR") &&
            !hasErrorCode(error, "ELOOP"))
            throw error;
        return "preserved";
    }
    try {
        return await removeOwnedPath({
            pathname: params.pathname,
            identity: params.identity,
        });
    }
    catch (error) {
        if (params.throwOnCleanupError)
            throw error;
        return "preserved";
    }
}
