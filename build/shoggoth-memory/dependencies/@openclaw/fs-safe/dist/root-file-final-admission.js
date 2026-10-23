import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import { isExpectedPathError } from "./pinned-open.js";
import { realpathSync } from "./realpath.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { hardlinkedPathNotAllowedError } from "./root-errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";
function rootIdentityMismatch(cause) {
    return new FsSafeError("path-mismatch", "canonical root directory identity changed or could not be verified", cause === undefined ? {} : { cause });
}
function inspectCanonicalRoot(ioFs, rootPath, expected) {
    try {
        assertNoWindowsPathAlias(rootPath);
        const operationPath = ioFs === fs ? pathForWindowsFilesystem(rootPath) : rootPath;
        return inspectFileIdentitySync(() => {
            const stat = ioFs.lstatSync(operationPath, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw rootIdentityMismatch();
            return stat;
        }, expected);
    }
    catch (error) {
        if (expected && isExpectedPathError(error))
            throw rootIdentityMismatch(error);
        throw error;
    }
}
export function observeCanonicalRoot(ioFs, rootPath) {
    try {
        const stat = inspectCanonicalRoot(ioFs, rootPath);
        const identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
        let observedPath = rootPath;
        if (process.platform === "win32" && ioFs === fs) {
            // Native leaf resolution expands Windows short names. Bind that root
            // spelling before traversal without replacing the observed identity.
            observedPath = realpathSync.native(pathForWindowsFilesystem(rootPath));
            if (observedPath !== rootPath)
                inspectCanonicalRoot(ioFs, observedPath, identity);
        }
        return { ok: true, path: observedPath, identity };
    }
    catch (error) {
        return { ok: false, error };
    }
}
function resolveConsumedPath(ioFs, filePath) {
    return ioFs === fs ? realpathSync.native(filePath) : ioFs.realpathSync(filePath);
}
export function createRootFileFinalAdmission(ioFs, root, boundaryLabel, rejectHardlinks = true) {
    const inspectRoot = (candidateRootPath, expected) => {
        inspectCanonicalRoot(ioFs, candidateRootPath, expected);
    };
    return ({ path: consumedPath, descriptorIdentity }) => {
        inspectCanonicalRoot(ioFs, root.path, root.identity);
        const canonicalPath = resolveConsumedPath(ioFs, consumedPath);
        assertNoWindowsPathAlias(canonicalPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
        const admitted = admitPathInsideRoot({
            rootPath: root.path,
            candidatePath: canonicalPath,
            rootIdentity: root.identity,
            inspectCandidateRoot: inspectRoot,
        });
        if (!admitted) {
            throw new FsSafeError("outside-workspace", `resolved path escapes ${boundaryLabel}`);
        }
        try {
            const current = inspectFileIdentitySync(() => ioFs.lstatSync(admitted.path, { bigint: true }), descriptorIdentity);
            if (rejectHardlinks && current.isFile() && current.nlink > 1n)
                throw hardlinkedPathNotAllowedError();
        }
        catch (error) {
            if (isExpectedPathError(error)) {
                throw new FsSafeError("path-mismatch", "canonical file identity changed or could not be verified", { cause: error });
            }
            throw error;
        }
        inspectCanonicalRoot(ioFs, root.path, root.identity);
        return admitted.path;
    };
}
