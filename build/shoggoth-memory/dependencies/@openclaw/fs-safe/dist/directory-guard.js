import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem, resolvePathPreservingWindowsRoot, } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";
import { directoryEntryPath } from "./directory-entry-path.js";
import { assertStatObservationSync, inspectStatObservationSync, } from "./stat-observation.js";
export async function readDirectoryIdentity(dir) {
    const guard = await createAsyncDirectoryGuard(dir, { bigint: true });
    return Object.freeze({ dev: guard.stat.dev, ino: guard.stat.ino, realPath: guard.realPath });
}
export function assertDirectoryIdentitySync(observedPath, expected) {
    const operationPath = directoryOperationPath(observedPath);
    const expectedDev = expected.dev;
    const expectedIno = expected.ino;
    const expectedRealPath = expected.realPath;
    if (expectedRealPath !== undefined)
        assertNoWindowsPathAlias(expectedRealPath, "filesystem");
    inspectDirectoryIdentityAtPathSync(operationPath, { dev: expectedDev, ino: expectedIno });
    if (expectedRealPath === undefined)
        return;
    const realPath = realpathSync.native(operationPath);
    assertNoWindowsPathAlias(realPath, "filesystem");
    if (realPath !== expectedRealPath) {
        throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
}
export async function createAsyncDirectoryGuard(dir, options) {
    return captureDirectoryGuard(dir, "native", options);
}
export function createSyncDirectoryGuard(dir) {
    return captureDirectoryGuard(dir, "normalized");
}
export function captureDirectoryGuard(dir, mode, options) {
    const operationPath = directoryOperationPath(dir);
    const stat = options?.bigint
        ? inspectDirectoryIdentityAtPathSync(operationPath, undefined, options.initial)
        : fsSync.lstatSync(operationPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw directoryComponentNotDirectoryError();
    }
    const realPath = mode === "native" ? realpathSync.native(operationPath) : realpathSync(operationPath);
    assertNoWindowsPathAlias(realPath, "filesystem");
    return { dir, realPath, stat };
}
export async function assertAsyncDirectoryGuard(guard) {
    assertDirectoryGuard(guard, "native");
}
export function assertSyncDirectoryGuard(guard) {
    assertDirectoryGuard(guard, "normalized");
}
export function assertDirectoryGuard(guard, mode) {
    const dir = guard.dir;
    const operationPath = directoryOperationPath(dir);
    const expectedRealPath = guard.realPath;
    assertNoWindowsPathAlias(expectedRealPath, "filesystem");
    const expectedStat = guard.stat;
    const expectedIdentity = { dev: expectedStat.dev, ino: expectedStat.ino };
    const stat = typeof expectedIdentity.dev === "bigint" && typeof expectedIdentity.ino === "bigint"
        ? inspectDirectoryIdentityAtPathSync(operationPath, {
            dev: expectedIdentity.dev,
            ino: expectedIdentity.ino,
        })
        : fsSync.lstatSync(operationPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw directoryComponentNotDirectoryError();
    }
    // Native guards check identity first; normalized numeric guards preserve
    // canonicalization errors before their final identity comparison.
    if (mode === "native" && !sameFileIdentity(stat, expectedIdentity)) {
        throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
    const realPath = mode === "native" || typeof expectedIdentity.ino === "bigint"
        ? realpathSync.native(operationPath) : realpathSync(operationPath);
    assertNoWindowsPathAlias(realPath, "filesystem");
    if ((mode === "normalized" && !sameFileIdentity(stat, expectedIdentity)) || realPath !== expectedRealPath) {
        throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
}
export async function createNearestExistingDirectoryGuard(rootReal, targetPath, options = { bigint: false }) {
    assertNoWindowsPathAlias(rootReal, "filesystem");
    assertNoWindowsPathAlias(targetPath, "filesystem");
    let current = resolvePathPreservingWindowsRoot(targetPath);
    const root = resolvePathPreservingWindowsRoot(rootReal);
    while (current !== root) {
        try {
            return captureDirectoryGuard(current, "native", options);
        }
        catch (error) {
            if (!isNotFoundPathError(error)) {
                throw error;
            }
            current = path.dirname(current);
        }
    }
    return captureDirectoryGuard(root, "native", options);
}
// Recovery receipts must retain every identity bit, including on Windows.
export async function inspectDirectoryIdentity(dir, expected) {
    return inspectDirectoryIdentitySync(dir, expected);
}
function directoryOperationPath(dir) {
    assertNoWindowsPathAlias(dir, "filesystem");
    return pathForWindowsFilesystem(directoryEntryPath(dir));
}
export function observeDirectoryIdentitySync(dir, options) {
    const entryPath = directoryOperationPath(dir);
    const stat = options?.bigint
        ? fsSync.lstatSync(entryPath, { bigint: true })
        : fsSync.lstatSync(entryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw directoryComponentNotDirectoryError();
    return stat;
}
export function inspectDirectoryIdentitySync(dir, expected, initial, platform = process.platform) {
    const operationPath = directoryOperationPath(dir);
    const expectedIdentity = expected === undefined
        ? undefined
        : { dev: expected.dev, ino: expected.ino };
    return inspectDirectoryIdentityAtPathSync(operationPath, expectedIdentity, initial, platform);
}
function inspectDirectoryIdentityAtPathSync(operationPath, expected, initial, platform = process.platform) {
    return inspectFileIdentitySync(() => {
        // Traversal can supply the first exact observation. A bounded retry still
        // uses the admitted operation path and retains every known identity bit.
        const stat = initial ?? fsSync.lstatSync(operationPath, { bigint: true });
        initial = undefined;
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw directoryComponentNotDirectoryError();
        return stat;
    }, expected, platform);
}
export function extendDirectoryObservationGuard(observation, dir, realPath) {
    const guard = observation;
    guard.dir = dir;
    guard.realPath = realPath;
    return guard;
}
// Only stat/list receipts use this metadata fast path. Recovery and publication
// callers retain the BigIntStats contract of inspectDirectoryIdentitySync.
export function inspectDirectoryObservationSync(dir, expected) {
    const entryPath = directoryOperationPath(dir);
    return inspectStatObservationSync(bigint => {
        const stat = bigint ? fsSync.lstatSync(entryPath, { bigint: true }) : fsSync.lstatSync(entryPath);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw directoryComponentNotDirectoryError();
        return stat;
    }, expected);
}
export function assertDirectoryObservationSync(dir, expected) {
    const entryPath = directoryOperationPath(dir);
    return assertStatObservationSync(bigint => {
        const stat = bigint ? fsSync.lstatSync(entryPath, { bigint: true }) : fsSync.lstatSync(entryPath);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw directoryComponentNotDirectoryError();
        return stat;
    }, expected);
}
export function assertDirectoryObservationGuardSync(guard) {
    const dir = guard.dir;
    const expectedRealPath = guard.realPath;
    assertNoWindowsPathAlias(expectedRealPath, "filesystem");
    assertDirectoryObservationSync(dir, guard.identity);
    const realPath = realpathSync.native(directoryOperationPath(dir));
    assertNoWindowsPathAlias(realPath, "filesystem");
    if (realPath !== expectedRealPath) {
        throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
}
