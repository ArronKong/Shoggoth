import fs, {} from "node:fs";
import path from "node:path";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { sameAbsolutePath } from "./path-segment-route.js";
import { assertRootIdentityCurrentSync } from "./root-context.js";
import { hardlinkedPathNotAllowedError } from "./root-errors.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { realpathSync } from "./realpath.js";
import { sidecarLockSnapshotMatches, } from "./sidecar-lock-reclaim.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { assertFileLockSyncRootResolvedPathCurrent, } from "./file-lock-sync-root.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";
const MAX_SIDECAR_LOCK_PAYLOAD_BYTES = 1024 * 1024;
export function observeDirectory(pathname, initial) {
    const stat = inspectDirectoryIdentitySync(pathname, undefined, initial);
    const realPath = realpathSync.native(pathForWindowsFilesystem(pathname));
    assertNoWindowsPathAlias(realPath, "filesystem", "sidecar lock parent uses a Windows filesystem namespace alias");
    if (!sameAbsolutePath(realPath, pathname)) {
        throw new FsSafeError("path-mismatch", "sidecar lock parent changed during operation");
    }
    return Object.freeze({
        identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
        path: pathname,
        realPath,
    });
}
export function assertDirectoryCurrent(receipt, initial) {
    inspectDirectoryIdentitySync(receipt.path, receipt.identity, initial);
    const currentReal = realpathSync.native(pathForWindowsFilesystem(receipt.path));
    assertNoWindowsPathAlias(currentReal, "filesystem", "sidecar lock parent uses a Windows filesystem namespace alias");
    if (currentReal !== receipt.realPath) {
        throw new FsSafeError("path-mismatch", "sidecar lock parent changed during operation");
    }
}
export function assertRetainedParentCurrent(pathAuthority, parent) {
    const context = pathAuthority.authority.context;
    const sharedIdentity = parent.path === context.rootReal &&
        parent.identity.dev === context.rootIdentity.dev && parent.identity.ino === context.rootIdentity.ino;
    let rootStat;
    assertRootIdentityCurrentSync(context, sharedIdentity ? stat => { rootStat = stat; } : undefined);
    assertDirectoryCurrent(parent, rootStat);
    assertRootIdentityCurrentSync(context);
}
export function exactFileIdentity(stat) {
    return Object.freeze({ dev: stat.dev, ino: stat.ino });
}
export function assertRegularFile(stat, hardlinks) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FsSafeError("not-file", "sidecar lock is not a regular file");
    }
    if (hardlinks !== "allow" && stat.nlink > 1n)
        throw hardlinkedPathNotAllowedError();
}
export function sameExactIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function assertFreshPathCurrent(pathAuthority) {
    // The exact Root observation is deliberately last: this helper is used both
    // immediately before fresh pathname I/O and immediately before returning it.
    assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
    assertRootIdentityCurrentSync(pathAuthority.authority.context);
}
function missingAfterCurrentRead(pathAuthority, expectedReceipt) {
    if (expectedReceipt) {
        assertRetainedParentCurrent(pathAuthority, expectedReceipt.parent);
    }
    else {
        assertFreshPathCurrent(pathAuthority);
    }
    return null;
}
export function readFileLockSyncRootSnapshot(pathAuthority, options = {}) {
    const expectedReceipt = options.expectedReceipt;
    if (expectedReceipt) {
        assertRetainedParentCurrent(pathAuthority, expectedReceipt.parent);
    }
    else {
        assertFreshPathCurrent(pathAuthority);
    }
    let before;
    try {
        before = inspectFileIdentitySync(() => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }), expectedReceipt?.identity);
    }
    catch (error) {
        if (isNotFoundPathError(error) || (expectedReceipt && error instanceof FsSafeError && error.code === "path-mismatch"))
            return missingAfterCurrentRead(pathAuthority, expectedReceipt);
        throw error;
    }
    assertRegularFile(before, pathAuthority.authority.hardlinks);
    const parent = expectedReceipt?.parent ?? observeDirectory(path.dirname(pathAuthority.path));
    let fd;
    let operationError;
    let operationFailed = false;
    try {
        try {
            fd = fs.openSync(pathForWindowsFilesystem(pathAuthority.path), resolveReadOpenFlags());
        }
        catch (error) {
            if (isNotFoundPathError(error))
                return missingAfterCurrentRead(pathAuthority, expectedReceipt);
            options.onOpenFailure?.(error);
            throw error;
        }
        let opened;
        try {
            opened = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), exactFileIdentity(before));
        }
        catch (error) {
            if (error instanceof FsSafeError && error.code === "path-mismatch") {
                if (expectedReceipt) {
                    assertRetainedParentCurrent(pathAuthority, parent);
                }
                else {
                    assertDirectoryCurrent(parent);
                    assertFreshPathCurrent(pathAuthority);
                }
                return null;
            }
            throw error;
        }
        assertRegularFile(opened, pathAuthority.authority.hardlinks);
        const raw = readFileDescriptorBoundedSync(fd, MAX_SIDECAR_LOCK_PAYLOAD_BYTES).toString("utf8");
        let after;
        try {
            after = inspectFileIdentitySync(() => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }), exactFileIdentity(opened));
        }
        catch (error) {
            if (isNotFoundPathError(error) ||
                (error instanceof FsSafeError && error.code === "path-mismatch")) {
                if (expectedReceipt) {
                    assertRetainedParentCurrent(pathAuthority, parent);
                }
                else {
                    assertDirectoryCurrent(parent);
                    assertFreshPathCurrent(pathAuthority);
                }
                return null;
            }
            throw error;
        }
        assertRegularFile(after, pathAuthority.authority.hardlinks);
        const stat = fs.fstatSync(fd, { bigint: true });
        if (expectedReceipt) {
            assertRetainedParentCurrent(pathAuthority, parent);
        }
        else {
            assertDirectoryCurrent(parent);
            assertFreshPathCurrent(pathAuthority);
        }
        const snapshot = {
            raw,
            payload: null,
            stat,
        };
        return Object.freeze({
            receipt: Object.freeze({ identity: exactFileIdentity(opened), parent }),
            snapshot,
        });
    }
    catch (error) {
        operationFailed = true;
        operationError = error;
        throw error;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch (closeError) {
                if (operationFailed) {
                    throw createSuppressedError(closeError, operationError, "sidecar snapshot admission and descriptor close both failed");
                }
                throw closeError;
            }
        }
    }
}
export function fileLockSyncRootSnapshotStillCurrent(pathAuthority, observed) {
    const current = readFileLockSyncRootSnapshot(pathAuthority, {
        expectedReceipt: observed.receipt,
    });
    return !!current &&
        sameExactIdentity(current.receipt.identity, observed.receipt.identity) &&
        sidecarLockSnapshotMatches(current.snapshot, observed.snapshot);
}
export function fileReceiptCurrentAfterParentCheck(pathAuthority, receipt) {
    let current;
    try {
        current = inspectFileIdentitySync(() => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }), receipt.identity);
    }
    catch (error) {
        if (isNotFoundPathError(error) ||
            (error instanceof FsSafeError && error.code === "path-mismatch"))
            return false;
        throw error;
    }
    assertRegularFile(current, pathAuthority.authority.hardlinks);
    assertRetainedParentCurrent(pathAuthority, receipt.parent);
    return true;
}
export function fileLockSyncRootReceiptStillCurrent(pathAuthority, receipt) {
    assertRetainedParentCurrent(pathAuthority, receipt.parent);
    return fileReceiptCurrentAfterParentCheck(pathAuthority, receipt);
}
