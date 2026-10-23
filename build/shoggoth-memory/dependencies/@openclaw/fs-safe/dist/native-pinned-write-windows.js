import { syncFileBestEffortSync } from "./file-sync.js";
import { randomUUID } from "node:crypto";
import fsSync, {} from "node:fs";
import path from "node:path";
import { createFileHandle } from "./create.js";
import { hasPreservedCreationArtifacts } from "./creation-boundary.js";
import { assertSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { nativeOpenFlags, removeNativeCreatedFileIfStillPinned, } from "./native-operations.js";
import { writePinnedInput } from "./pinned-write-input.js";
import { captureNativeFdClose } from "./native-binding.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { classifyNativeRenameFailure } from "./native-rename-outcome.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { createStagedFileReceipt, settleStagedFile } from "./staged-file-settlement.js";
import { exactIdentityMatches } from "./staged-directory.js";
import { inspectNativeDirectoryObservation } from "./native-directory-observation.js";
function closeWriteFd(closeFd, fd) {
    if (fd === undefined)
        return;
    try {
        closeFd(fd);
    }
    catch (error) {
        return { error };
    }
}
function readParentIdentity(parentFd, guard) {
    const stat = inspectFileIdentitySync(() => fsSync.fstatSync(parentFd, { bigint: true }));
    if (!stat.isDirectory() || !exactIdentityMatches(guard.stat, stat)) {
        throw new FsSafeError("path-mismatch", "native write parent identity changed");
    }
    return stat;
}
function assertNamedParentCurrent(binding, guard, identity) {
    if (typeof binding.observeDirectory === "function") {
        try {
            const observed = inspectNativeDirectoryObservation(binding, guard.dir, identity);
            if (observed.realPath !== guard.realPath) {
                throw new FsSafeError("path-mismatch", "native write parent pathname changed");
            }
            return;
        }
        catch (error) {
            if (error?.code !== "OBSERVATION_UNAVAILABLE")
                throw error;
        }
    }
    assertSyncDirectoryGuard({ ...guard, stat: identity });
}
export async function runPinnedWriteWindows(binding, params, root, parentFd, parentGuard) {
    const closeFd = captureNativeFdClose(binding);
    const parentPath = parentGuard.realPath;
    let tempFd;
    let privateHandle;
    let targetFd;
    let publicationProbeFd;
    let tempIdentity;
    let tempName = "";
    let renamed = false;
    let completed = false;
    const completeCreate = params.overwrite === false && params.input.kind !== "file" && params.input.stageBeforePublish === true;
    let receipt;
    let publication = Object.freeze({ status: "not-published" });
    let phase = "prepare";
    let failure;
    const closeTemp = async () => {
        const handle = privateHandle;
        const fd = tempFd;
        privateHandle = undefined;
        tempFd = undefined;
        if (handle)
            await handle.close();
        else if (fd !== undefined)
            closeFd(fd);
    };
    try {
        tempName = `.fs-safe-${randomUUID()}.tmp`;
        params.assertBeforeMutation?.();
        if (params.private) {
            const parentIdentity = fsSync.fstatSync(parentFd, { bigint: true });
            privateHandle = await createFileHandle(path.join(parentPath, tempName), {
                private: true,
                mode: 0o600,
                assertBeforeMutation: params.assertBeforeMutation,
            }, {
                expectedParentIdentity: {
                    dev: parentIdentity.dev, ino: parentIdentity.ino, realPath: parentPath,
                },
            });
            tempFd = privateHandle.fd;
        }
        else {
            tempFd = binding.openBeneath(parentFd, tempName, nativeOpenFlags(fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL)).fd;
        }
        const verificationIdentity = inspectFileIdentitySync(() => fsSync.fstatSync(tempFd, { bigint: true }));
        tempIdentity = verificationIdentity;
        // Creation is requested at 0600 in the binding, but a restrictive umask
        // can remove owner access. Keep the unpublished inode private and
        // reopenable until the published name has been identity-fenced.
        fsSync.fchmodSync(tempFd, 0o600);
        await writePinnedInput(tempFd, params.input, params.maxBytes, params.assertBeforeMutation);
        if (params.sync !== false) {
            if (params.strictFileSync)
                fsSync.fsyncSync(tempFd);
            else
                syncFileBestEffortSync(tempFd);
        }
        if (params.input.kind === "file")
            await params.input.verifySource();
        if (completeCreate) {
            const parentIdentity = readParentIdentity(parentFd, parentGuard);
            receipt = createStagedFileReceipt(Object.freeze({
                path: parentGuard.dir,
                realPath: parentGuard.realPath,
                identity: Object.freeze({ dev: parentIdentity.dev, ino: parentIdentity.ino }),
            }), tempName, fsSync.fstatSync(tempFd, { bigint: true }));
        }
        phase = "publish";
        assertFinalSymlinkRejected(path.join(parentPath, params.basename), params.rejectFinalSymlink);
        params.assertBeforeMutation?.();
        if (params.assertBeforeMutation) {
            // Callbacks can replace names synchronously. Fence the named parent and
            // stage against retained descriptors before the rename can expose bytes.
            assertNamedParentCurrent(binding, parentGuard, readParentIdentity(parentFd, parentGuard));
            publicationProbeFd = binding.openBeneath(parentFd, tempName, nativeOpenFlags(fsSync.constants.O_RDONLY)).fd;
            const named = inspectFileIdentitySync(() => fsSync.fstatSync(publicationProbeFd, { bigint: true }), verificationIdentity);
            const retained = inspectFileIdentitySync(() => fsSync.fstatSync(tempFd, { bigint: true }), verificationIdentity);
            if (!named.isFile() || !retained.isFile() || named.nlink !== 1n || retained.nlink !== 1n) {
                throw new FsSafeError("path-mismatch", "native write stage changed before publication");
            }
            assertFinalSymlinkRejected(path.join(parentPath, params.basename), params.rejectFinalSymlink);
        }
        try {
            if (params.overwrite === false) {
                binding.renameNoReplace(parentFd, tempName, parentFd, params.basename);
            }
            else {
                binding.renameReplace(parentFd, tempName, parentFd, params.basename);
            }
        }
        catch (error) {
            if (completeCreate && classifyNativeRenameFailure(error) === "indeterminate") {
                publication = Object.freeze({ status: "indeterminate", basename: params.basename, overwrite: false });
            }
            throw error;
        }
        renamed = true;
        if (receipt)
            publication = Object.freeze({ status: "published", staged: receipt, basename: params.basename, overwrite: false });
        params.onPublished?.(verificationIdentity);
        targetFd = binding.openBeneath(parentFd, params.basename, nativeOpenFlags(fsSync.constants.O_RDONLY)).fd;
        const targetStat = inspectFileIdentitySync(() => fsSync.fstatSync(targetFd, { bigint: true }), verificationIdentity);
        const targetIdentity = binding.fstatIdentity(targetFd);
        if (!targetStat.isFile()) {
            throw new FsSafeError("path-mismatch", "native write target changed after rename");
        }
        // Native exclusive creation starts at 0600. Apply the requested mode only
        // after reopening and fencing the published name, both so mode 000 stays
        // verifiable and so broader modes are never exposed before that fence.
        try {
            fsSync.fchmodSync(targetFd, params.mode);
            // Windows FlushFileBuffers needs write access; the verification reopen is read-only.
            if (params.sync !== false) {
                if (params.strictFileSync)
                    fsSync.fsyncSync(tempFd);
                else
                    syncFileBestEffortSync(tempFd);
            }
        }
        catch (error) {
            if (!completeCreate) {
                closeWriteFd(closeFd, targetFd);
                targetFd = undefined;
            }
            // Staged copies and streamed creates preserve publication for caller recovery.
            if (params.input.kind !== "file" && !params.input.stageBeforePublish) {
                removeNativeCreatedFileIfStillPinned({
                    parentPath,
                    parentFd,
                    basename: params.basename,
                    created: tempIdentity,
                });
            }
            throw error;
        }
        if (params.sync !== false)
            syncFileBestEffortSync(parentFd);
        // Verification follows publication and final chmod, outside rollback handling.
        await params.verifyPublished?.(targetFd, verificationIdentity, parentGuard);
        completed = true;
        return { dev: targetIdentity.dev, ino: targetIdentity.ino };
    }
    catch (error) {
        failure = { error };
        throw error;
    }
    finally {
        const preservedPreparation = params.private && tempFd === undefined && hasPreservedCreationArtifacts(failure?.error);
        if (completeCreate || preservedPreparation) {
            await settleStagedFile({
                temporaryBasename: tempName, publication, phase, failure,
                cleanup: async () => {
                    if (preservedPreparation)
                        return "preserved";
                    if (publication.status === "indeterminate")
                        return "preserved";
                    if (renamed || tempFd === undefined)
                        return "not-needed";
                    return await cleanupPinnedFilePath({
                        pathname: path.join(parentPath, tempName), handle: { fd: tempFd },
                        identity: tempIdentity, parentGuard, throwOnCleanupError: true,
                    });
                },
                close: [
                    () => { if (targetFd !== undefined)
                        closeFd(targetFd); },
                    () => { if (publicationProbeFd !== undefined)
                        closeFd(publicationProbeFd); },
                    closeTemp,
                    () => closeFd(parentFd),
                    () => root.close(),
                ],
            });
        }
        else {
            const targetCloseFailure = closeWriteFd(closeFd, targetFd);
            const probeCloseFailure = closeWriteFd(closeFd, publicationProbeFd);
            let tempCloseFailure;
            try {
                await closeTemp();
            }
            catch (error) {
                tempCloseFailure = { error };
            }
            if (!renamed) {
                removeNativeCreatedFileIfStillPinned({
                    parentPath,
                    parentFd,
                    basename: tempName,
                    created: tempIdentity,
                });
            }
            const parentCloseFailure = closeWriteFd(closeFd, parentFd);
            await root.close().catch(() => undefined);
            const closeFailure = targetCloseFailure ?? probeCloseFailure ?? tempCloseFailure ?? parentCloseFailure;
            if (completed && closeFailure)
                throw closeFailure.error;
        }
    }
}
