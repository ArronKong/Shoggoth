import fsSync, {} from "node:fs";
import { assertDirectoryIdentitySync, } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { openNativeParentAdmission } from "./native-parent-admission.js";
import { inspectNativeDirectoryObservation } from "./native-directory-observation.js";
import { isSymlinkOpenError } from "./path.js";
import { checkedMutationDirectory } from "./pinned-mutation-observation.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
export function assertWindowsPolicyParentCurrent(parent) {
    inspectFileIdentitySync(() => fsSync.fstatSync(parent.fd, { bigint: true }), parent.guard.stat);
    assertDirectoryIdentitySync(parent.guard.dir, {
        dev: parent.guard.stat.dev,
        ino: parent.guard.stat.ino,
        realPath: parent.guard.realPath,
    });
}
export function closeWindowsPolicyParentAfterFailure(closeFd, fd, failure, report = false) {
    try {
        closeFd(fd);
    }
    catch (error) {
        if (report)
            throw failure
                ? createSuppressedError(error, failure.error, "native parent admission and close failed")
                : error;
    }
}
export function windowsParentObservation(binding, fd, guard) {
    return checkedMutationDirectory(guard.dir, guard.realPath, guard.stat, typeof binding.observeDirectory === "function" ? () => {
        const stat = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), guard.stat);
        let observed;
        try {
            observed = inspectNativeDirectoryObservation(binding, guard.dir, stat);
        }
        catch (error) {
            if (error?.code === "OBSERVATION_UNAVAILABLE")
                return undefined;
            throw error;
        }
        return { canonicalPath: observed.realPath,
            identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink } };
    } : undefined);
}
export async function openWindowsPolicyParent(binding, params, rootAdmission, fd, parentPath, relativePath) {
    try {
        const admitted = await openNativeParentAdmission(binding, {
            ...rootAdmission,
            root: { fd },
            rootPath: parentPath,
            // Policy fences retain every identity bit even with a legacy numeric root.
            exactRoot: true,
        }, relativePath, "native-directory");
        const guard = { ...admitted.guard, stat: admitted.guard.stat };
        return { fd: admitted.fd, guard, observation: windowsParentObservation(binding, admitted.fd, guard) };
    }
    catch (error) {
        if (!isSymlinkOpenError(error))
            throw error;
        throw new FsSafeError(params.mutationAdmission.rejectParentSymlinks ? "symlink" : "path-mismatch", "native write parent changed during policy admission", { cause: error instanceof Error ? error : undefined });
    }
}
