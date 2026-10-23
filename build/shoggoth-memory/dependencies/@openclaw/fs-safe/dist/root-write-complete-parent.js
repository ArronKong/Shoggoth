import fsSync from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync, createAsyncDirectoryGuard, inspectDirectoryIdentitySync, } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { admitPathInsideRoot, sameNormalizedPathSpelling } from "./root-boundary.js";
import { ordinaryWindowsSegments } from "./pinned-mutation-shared-route.js";
import { prepareRootWriteTarget } from "./root-directory-creation.js";
import { errorCauseOptions } from "./root-errors.js";
import { canReuseParentWithMutationAssertion } from "./root-write-lock-binding.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
export function writeSelectionChanged(cause) {
    return new FsSafeError("path-mismatch", "write target changed during operation", errorCauseOptions(cause));
}
function ordinarySharedWriteRoute(root, relativePath, operationTargetPath) {
    if (process.versions.bun || relativePath === "" || relativePath.startsWith("~") ||
        relativePath.includes("\0") || path.isAbsolute(relativePath))
        return false;
    if (process.platform === "win32") {
        if (!ordinaryWindowsSegments(relativePath))
            return false;
    }
    else if (relativePath.includes("\\") || relativePath.split("/").some(segment => segment === "" || segment === "." || segment === ".."))
        return false;
    const routed = path.resolve(root.rootReal, relativePath);
    const admitted = admitPathInsideRoot({
        rootPath: root.rootReal,
        candidatePath: routed,
        rootIdentity: root.rootIdentity,
    });
    return admitted?.admission === "exact" &&
        sameNormalizedPathSpelling(admitted.path, routed) &&
        sameNormalizedPathSpelling(routed, operationTargetPath);
}
// Preparation is optional evidence. An exact identity mismatch is conclusive
// and remains fail-closed; every other probe failure must let the established
// ordered component admission classify the same filesystem state.
function deoptPreparationFailure(error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch")
        throw error;
    return undefined;
}
function capturePreparedTargetObservation(targetPath) {
    let stat;
    try {
        stat = inspectFileIdentitySync(() => fsSync.lstatSync(targetPath, { bigint: true }));
    }
    catch (error) {
        if (hasNodeErrorCode(error, "ENOENT"))
            return Object.freeze({ exists: false });
        return deoptPreparationFailure(error);
    }
    // Final aliases retain the established full component walk and selected-path
    // admission. The shortcut is intentionally limited to an ordinary spelling.
    if (stat.isSymbolicLink())
        return undefined;
    let realPath;
    try {
        realPath = realpathSync.native(targetPath);
    }
    catch (error) {
        return deoptPreparationFailure(error);
    }
    if (!sameNormalizedPathSpelling(realPath, targetPath))
        return undefined;
    return Object.freeze({ exists: true, stat });
}
function samePreparedTargetFacts(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
        left.nlink === right.nlink;
}
function assertPreparedTargetCurrent(prepared) {
    if (!prepared.target.exists) {
        try {
            fsSync.lstatSync(prepared.selectedTargetPath, { bigint: true });
        }
        catch (error) {
            if (hasNodeErrorCode(error, "ENOENT"))
                return;
            throw writeSelectionChanged(error);
        }
        throw writeSelectionChanged();
    }
    try {
        const current = inspectFileIdentitySync(() => fsSync.lstatSync(prepared.selectedTargetPath, { bigint: true }), prepared.target.stat);
        if (current.isSymbolicLink() || !samePreparedTargetFacts(prepared.target.stat, current)) {
            throw writeSelectionChanged();
        }
    }
    catch (error) {
        if (error instanceof FsSafeError && error.code === "path-mismatch")
            throw error;
        throw writeSelectionChanged(error);
    }
}
export function assertPreparedRootWriteParentCurrent(prepared, verifyTarget = false) {
    try {
        if (getFsSafeNativeConfig().mode !== prepared.nativeMode)
            throw writeSelectionChanged();
        if (!sameNormalizedPathSpelling(prepared.parentGuard.dir, prepared.rootPath)) {
            assertDirectoryIdentitySync(prepared.rootPath, prepared.rootIdentity);
        }
        else if (prepared.parentGuard.stat.dev !== prepared.rootIdentity.dev ||
            prepared.parentGuard.stat.ino !== prepared.rootIdentity.ino) {
            throw writeSelectionChanged();
        }
        const parent = inspectDirectoryIdentitySync(prepared.parentGuard.dir, prepared.parentGuard.stat);
        if (parent.mode !== prepared.parentGuard.stat.mode ||
            parent.nlink !== prepared.parentGuard.stat.nlink ||
            !sameNormalizedPathSpelling(realpathSync.native(prepared.parentGuard.dir), prepared.parentGuard.realPath))
            throw writeSelectionChanged();
        if (verifyTarget)
            assertPreparedTargetCurrent(prepared);
    }
    catch (error) {
        if (error instanceof FsSafeError && error.code === "path-mismatch")
            throw error;
        throw writeSelectionChanged(error);
    }
}
async function prepareCompleteRootWriteParent(root, guarded, relativePath) {
    if (!guarded.mutationAdmission || !guarded.selectedTargetAdmission ||
        typeof root.rootIdentity.dev !== "bigint" || typeof root.rootIdentity.ino !== "bigint" ||
        !ordinarySharedWriteRoute(root, relativePath, guarded.targetPath) ||
        !sameNormalizedPathSpelling(guarded.resolvedPath.resolved, guarded.targetPath))
        return undefined;
    const parentPath = path.dirname(guarded.targetPath);
    const admittedParent = admitPathInsideRoot({
        rootPath: root.rootReal,
        candidatePath: parentPath,
        rootIdentity: root.rootIdentity,
    });
    if (admittedParent?.admission !== "exact" ||
        !sameNormalizedPathSpelling(admittedParent.path, parentPath))
        return undefined;
    let parentGuard;
    try {
        parentGuard = await createAsyncDirectoryGuard(parentPath, { bigint: true });
    }
    catch (error) {
        return deoptPreparationFailure(error);
    }
    if (!sameNormalizedPathSpelling(parentGuard.dir, parentPath) ||
        !sameNormalizedPathSpelling(parentGuard.realPath, parentPath))
        return undefined;
    const target = capturePreparedTargetObservation(guarded.targetPath);
    if (!target)
        return undefined;
    return Object.freeze({
        operationTargetPath: guarded.targetPath,
        selectedTargetPath: guarded.targetPath,
        parentGuard,
        rootPath: root.rootReal,
        rootIdentity: Object.freeze({ dev: root.rootIdentity.dev, ino: root.rootIdentity.ino }),
        nativeMode: getFsSafeNativeConfig().mode,
        target,
    });
}
export async function prepareSharedRootWriteTarget(root, params) {
    const { guardedTarget } = params;
    const resolvedPath = guardedTarget.resolvedPath.resolved;
    const mutationAdmission = guardedTarget.mutationAdmission;
    const beforeParentAdmission = mutationAdmission
        ? getFsSafeTestHooks()?.beforePinnedWriteParentAdmission
        : undefined;
    if (mutationAdmission)
        await beforeParentAdmission?.(resolvedPath);
    const preparedParent = params.mkdir !== false &&
        canReuseParentWithMutationAssertion(params.assertBeforeMutation, root.rootReal, guardedTarget.targetPath) &&
        beforeParentAdmission === undefined
        ? await prepareCompleteRootWriteParent(root, guardedTarget, params.relativePath)
        : undefined;
    const targetPath = params.mkdir === false
        ? guardedTarget.targetPath
        : preparedParent?.selectedTargetPath ?? await prepareRootWriteTarget(root, resolvedPath, params.assertBeforeMutation, mutationAdmission);
    return { targetPath, mutationAdmission, preparedParent };
}
