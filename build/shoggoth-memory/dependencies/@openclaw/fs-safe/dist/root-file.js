import fs from "node:fs";
import path from "node:path";
import { resolveRootPathSyncWithCanonicalRootObservation, resolveRootPathWithCanonicalRootObservation, } from "./root-path.js";
import { readSymlinkResolution } from "./root-symlink-policy.js";
import { isExpectedPathError, openPinnedFileSync, } from "./pinned-open.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { FsSafeError } from "./errors.js";
import { createRootFileFinalAdmission, observeCanonicalRoot, } from "./root-file-final-admission.js";
export function canUseRootFileOpen(ioFs) {
    return (typeof ioFs.openSync === "function" &&
        typeof ioFs.closeSync === "function" &&
        typeof ioFs.fstatSync === "function" &&
        typeof ioFs.lstatSync === "function" &&
        typeof ioFs.realpathSync === "function" &&
        typeof ioFs.readFileSync === "function" &&
        typeof ioFs.constants === "object" &&
        ioFs.constants !== null);
}
function absoluteRootFilePath(filePath) {
    if (path.isAbsolute(filePath))
        return filePath;
    const drive = path.parse(filePath).root;
    const base = drive ? path.resolve(drive) : process.cwd();
    return `${base}${path.sep}${filePath.slice(drive.length)}`;
}
export function openRootFileSync(params) {
    const ioFs = params.ioFs ?? fs;
    const rawAbsolutePath = params.absolutePath;
    let resolved;
    try {
        const absolutePath = absoluteRootFilePath(rawAbsolutePath);
        assertNoWindowsPathAlias(absolutePath);
        const rootPath = params.rootPath;
        const rootRealPath = params.rootRealPath;
        const boundaryLabel = params.boundaryLabel;
        let rootObservation;
        const resolvedPath = resolveRootPathSyncWithCanonicalRootObservation({
            absolutePath,
            rootPath,
            rootCanonicalPath: rootRealPath,
            boundaryLabel,
            ...readSymlinkResolution(params.symlinks ??
                (params.rejectSymlinks === false ? "follow-within-root" : "reject")),
            skipLexicalRootCheck: params.skipLexicalRootCheck,
        }, rootCanonicalPath => {
            rootObservation = observeCanonicalRoot(ioFs, rootCanonicalPath);
        });
        resolved = mapResolvedRootPath(absolutePath, boundaryLabel, resolvedPath, rootObservation);
    }
    catch (error) {
        resolved = toBoundaryValidationError(error);
    }
    return finalizeRootFileOpen({
        resolved,
        maxBytes: params.maxBytes,
        rejectHardlinks: params.rejectHardlinks,
        allowedType: params.allowedType,
        ioFs,
    });
}
export function matchRootFileOpenFailure(failure, handlers) {
    switch (failure.reason) {
        case "path":
            return handlers.path ? handlers.path(failure) : handlers.fallback(failure);
        case "validation":
            return handlers.validation ? handlers.validation(failure) : handlers.fallback(failure);
        case "io":
            return handlers.io ? handlers.io(failure) : handlers.fallback(failure);
    }
    return handlers.fallback(failure);
}
function finalizeRootFileOpen(params) {
    if ("ok" in params.resolved) {
        return params.resolved;
    }
    const resolved = params.resolved;
    const rejectHardlinks = params.rejectHardlinks ?? true;
    const opened = openPinnedFileSync({
        filePath: resolved.absolutePath,
        resolvedPath: resolved.resolvedPath,
        rejectHardlinks,
        maxBytes: params.maxBytes,
        allowedType: params.allowedType,
        ioFs: params.ioFs,
        finalAdmission: createRootFileFinalAdmission(params.ioFs, resolved.rootObservation, resolved.boundaryLabel, rejectHardlinks),
    });
    if (!opened.ok) {
        return opened;
    }
    return {
        ok: true,
        path: opened.path,
        fd: opened.fd,
        stat: opened.stat,
        rootRealPath: resolved.rootRealPath,
    };
}
export async function openRootFile(params) {
    const ioFs = params.ioFs ?? fs;
    const rawAbsolutePath = params.absolutePath;
    let resolutionSnapshot;
    try {
        const absolutePath = absoluteRootFilePath(rawAbsolutePath);
        assertNoWindowsPathAlias(absolutePath);
        resolutionSnapshot = snapshotAsyncResolution(params, absolutePath);
    }
    catch (error) {
        resolutionSnapshot = toBoundaryValidationError(error);
    }
    const openSnapshot = {
        maxBytes: params.maxBytes,
        rejectHardlinks: params.rejectHardlinks,
        allowedType: params.allowedType,
    };
    let resolved;
    if ("ok" in resolutionSnapshot) {
        resolved = resolutionSnapshot;
    }
    else {
        try {
            let rootObservation;
            const resolvedPath = await resolveRootPathWithCanonicalRootObservation({
                absolutePath: resolutionSnapshot.absolutePath,
                rootPath: resolutionSnapshot.rootPath,
                rootCanonicalPath: resolutionSnapshot.rootRealPath,
                boundaryLabel: resolutionSnapshot.boundaryLabel,
                policy: resolutionSnapshot.aliasPolicy,
                rejectSymlinks: resolutionSnapshot.rejectSymlinks,
                rejectFinalSymlink: resolutionSnapshot.rejectFinalSymlink,
                skipLexicalRootCheck: resolutionSnapshot.skipLexicalRootCheck,
            }, rootCanonicalPath => {
                rootObservation = observeCanonicalRoot(ioFs, rootCanonicalPath);
            });
            resolved = mapResolvedRootPath(resolutionSnapshot.absolutePath, resolutionSnapshot.boundaryLabel, resolvedPath, rootObservation);
        }
        catch (error) {
            resolved = toBoundaryValidationError(error);
        }
    }
    return finalizeRootFileOpen({
        resolved,
        maxBytes: openSnapshot.maxBytes,
        rejectHardlinks: openSnapshot.rejectHardlinks,
        allowedType: openSnapshot.allowedType,
        ioFs,
    });
}
function toBoundaryValidationError(error) {
    return { ok: false, reason: "validation", error };
}
function mapResolvedRootPath(absolutePath, boundaryLabel, resolved, rootObservation) {
    if (!rootObservation) {
        return toBoundaryValidationError(new FsSafeError("path-mismatch", "canonical root identity was not observed"));
    }
    if (!rootObservation.ok) {
        return toRootObservationError(rootObservation.error);
    }
    return {
        absolutePath,
        resolvedPath: resolved.canonicalPath,
        rootRealPath: rootObservation.path,
        boundaryLabel,
        rootObservation,
    };
}
function snapshotAsyncResolution(params, absolutePath) {
    const rootPath = params.rootPath;
    const rootRealPath = params.rootRealPath;
    const boundaryLabel = params.boundaryLabel;
    const sourceAliasPolicy = params.aliasPolicy;
    const aliasPolicy = sourceAliasPolicy == null ? undefined : {
        allowFinalSymlinkForUnlink: sourceAliasPolicy.allowFinalSymlinkForUnlink,
        allowFinalHardlinkForUnlink: sourceAliasPolicy.allowFinalHardlinkForUnlink,
    };
    const symlinkResolution = readSymlinkResolution(params.symlinks ?? (params.rejectSymlinks === false ? "follow-within-root" : "reject"));
    return {
        absolutePath,
        rootPath,
        rootRealPath,
        boundaryLabel,
        aliasPolicy,
        ...symlinkResolution,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
    };
}
function toRootObservationError(error) {
    if (error instanceof FsSafeError)
        return toBoundaryValidationError(error);
    if (isExpectedPathError(error)) {
        return { ok: false, reason: "path", error };
    }
    return { ok: false, reason: "io", error };
}
