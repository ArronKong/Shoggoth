import fsSync from "node:fs";
import { assertDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
function helperUnavailable(message, cause) {
    return new FsSafeError("helper-unavailable", message, {
        ...(cause instanceof Error ? { cause } : {}),
    });
}
export function copyOperationalCode(target, source) {
    const code = source?.code;
    if (typeof code === "string") {
        Object.defineProperty(target, "code", { configurable: true, value: code });
    }
}
function primaryWithCloseFailure(error, closeError, message) {
    const cause = new AggregateError([error, closeError], message);
    if (error instanceof FsSafeError) {
        return new FsSafeError(error.code, message, {
            cause,
            ...(error.details ? { details: error.details } : {}),
        });
    }
    const wrapped = new Error(message, { cause });
    copyOperationalCode(wrapped, error);
    return wrapped;
}
function supportsRename(binding) {
    return typeof binding?.renameNoReplaceWithIdentity === "function";
}
function supportsCleanup(binding) {
    return typeof binding.ownedTreeRemovalAvailable === "function" &&
        typeof binding.removeOwnedTree === "function";
}
function closeDescriptors(descriptors) {
    const errors = [];
    const closed = new Set();
    for (const fd of descriptors) {
        if (fd === undefined || closed.has(fd))
            continue;
        closed.add(fd);
        try {
            fsSync.closeSync(fd);
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 1)
        throw errors[0];
    if (errors.length > 1) {
        throw new AggregateError(errors, "retained directory replacement descriptors failed to close");
    }
}
const retainedDirectoryOpenFlags = fsSync.constants.O_RDONLY |
    fsSync.constants.O_DIRECTORY |
    fsSync.constants.O_NOFOLLOW |
    fsSync.constants.O_NONBLOCK;
function openRetainedDirectory(label, expected) {
    let fd;
    try {
        fd = fsSync.openSync(expected.path, retainedDirectoryOpenFlags);
    }
    catch (error) {
        const code = error?.code;
        if (code === "EACCES" || code === "EPERM") {
            const purpose = label === "original target"
                ? "original target for bounded cleanup"
                : label;
            throw helperUnavailable(`atomic directory replacement cannot retain the ${purpose}`, error);
        }
        throw error;
    }
    try {
        const descriptor = fsSync.fstatSync(fd, { bigint: true });
        if (!descriptor.isDirectory()) {
            throw new FsSafeError("not-file", `directory replacement ${label} must be a directory`);
        }
        if (descriptor.dev !== expected.identity.dev || descriptor.ino !== expected.identity.ino) {
            throw new FsSafeError("path-mismatch", `directory replacement ${label} changed during admission`);
        }
        assertDirectoryIdentitySync(expected.path, {
            dev: expected.identity.dev,
            ino: expected.identity.ino,
            ...(expected.realPath === undefined ? {} : { realPath: expected.realPath }),
        });
    }
    catch (error) {
        try {
            fsSync.closeSync(fd);
        }
        catch (closeError) {
            throw primaryWithCloseFailure(error, closeError, `directory replacement ${label} admission and close failed`);
        }
        throw error;
    }
    return fd;
}
export class RetainedDirectoryReplacement {
    #binding;
    #originalDirectoryFd;
    #stagedParentFd;
    #targetParentFd;
    #cleanupUsed = false;
    #closed = false;
    constructor(binding, targetParentFd, stagedParentFd, originalDirectoryFd) {
        this.#binding = binding;
        this.#targetParentFd = targetParentFd;
        this.#stagedParentFd = stagedParentFd;
        this.#originalDirectoryFd = originalDirectoryFd;
    }
    static requireBinding() {
        const binding = getNativeBinding();
        if (!supportsRename(binding)) {
            throw helperUnavailable("atomic directory replacement requires native identity-fenced no-replace rename support");
        }
        return binding;
    }
    static retain(params, binding = RetainedDirectoryReplacement.requireBinding()) {
        let targetParentFd;
        let stagedParentFd;
        let originalDirectoryFd;
        try {
            targetParentFd = openRetainedDirectory("target parent", params.targetParent);
            stagedParentFd = params.stagedParent.path === params.targetParent.path
                ? targetParentFd
                : openRetainedDirectory("staged parent", params.stagedParent);
            if (params.originalTarget) {
                if (!supportsCleanup(binding)) {
                    throw helperUnavailable("replacing an existing directory requires native bounded owned-tree cleanup");
                }
                let available = false;
                try {
                    available = binding.ownedTreeRemovalAvailable(targetParentFd) === true;
                }
                catch (error) {
                    throw helperUnavailable("native owned-tree cleanup capability probe failed", error);
                }
                if (!available) {
                    throw helperUnavailable("native owned-tree cleanup is unavailable for the target parent");
                }
                originalDirectoryFd = openRetainedDirectory("original target", {
                    path: params.originalTarget.path,
                    identity: params.originalTarget.identity,
                });
            }
            return new RetainedDirectoryReplacement(binding, targetParentFd, stagedParentFd, originalDirectoryFd);
        }
        catch (error) {
            try {
                closeDescriptors([originalDirectoryFd, stagedParentFd, targetParentFd]);
            }
            catch (closeError) {
                throw primaryWithCloseFailure(error, closeError, "retained directory replacement admission and descriptor close failed");
            }
            throw error;
        }
    }
    renameNoReplace(sourceParent, sourceBasename, targetBasename, expectedSource) {
        if (this.#closed) {
            throw new FsSafeError("path-mismatch", "retained directory rename authority is unavailable");
        }
        this.#binding.renameNoReplaceWithIdentity(sourceParent === "staged" ? this.#stagedParentFd : this.#targetParentFd, sourceBasename, this.#targetParentFd, targetBasename, expectedSource.dev, expectedSource.ino);
    }
    async removeOriginal(backupBasename) {
        if (this.#closed || this.#cleanupUsed || this.#originalDirectoryFd === undefined ||
            !supportsCleanup(this.#binding)) {
            throw new FsSafeError("path-mismatch", "retained owned-tree cleanup authority is unavailable");
        }
        this.#cleanupUsed = true;
        const result = await this.#binding.removeOwnedTree(this.#targetParentFd, backupBasename, this.#originalDirectoryFd);
        if (result.errorCode) {
            if (result.errorCode === "path-mismatch") {
                throw new FsSafeError("path-mismatch", result.errorMessage ?? "native owned-tree cleanup lost retained identity");
            }
            throw Object.assign(new Error(result.errorMessage ?? "native owned-tree cleanup failed"), { code: result.errorCode });
        }
        if (result.outcome !== "removed" && result.outcome !== "preserved") {
            throw helperUnavailable("native owned-tree cleanup returned an invalid result");
        }
        return result.outcome;
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        closeDescriptors([
            this.#originalDirectoryFd,
            this.#stagedParentFd,
            this.#targetParentFd,
        ]);
    }
}
