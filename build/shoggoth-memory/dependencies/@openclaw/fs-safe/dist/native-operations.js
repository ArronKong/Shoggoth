import fsSync, {} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { getNativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
export function nativeOpenFlags(flags) {
    const closeOnExec = fsSync.constants.O_CLOEXEC;
    return (flags |
        (closeOnExec ?? 0) |
        (typeof fsSync.constants.O_NOFOLLOW === "number" ? fsSync.constants.O_NOFOLLOW : 0));
}
export function writeNativeFd(fd, data) {
    let offset = 0;
    while (offset < data.byteLength) {
        const written = fsSync.writeSync(fd, data, offset, data.byteLength - offset);
        if (written <= 0) {
            throw Object.assign(new Error("native file write made no progress"), { code: "EIO" });
        }
        offset += written;
    }
}
function wrapNativeFd(fd, closeFd) {
    let open = true;
    return {
        fd,
        async close() {
            if (open) {
                open = false;
                closeFd(fd);
            }
        },
        async writeFile(data, encoding) {
            writeNativeFd(fd, Buffer.isBuffer(data) ? data : Buffer.from(data, encoding ?? "utf8"));
        },
    };
}
export function removeNativeCreatedFileIfStillPinned(params) {
    if (!params.created) {
        return;
    }
    try {
        const parentPathStat = fsSync.lstatSync(params.parentPath, { bigint: true });
        const parentFdStat = fsSync.fstatSync(params.parentFd, { bigint: true });
        const targetPath = path.join(params.parentPath, params.basename);
        const target = fsSync.lstatSync(targetPath, { bigint: true });
        if (!parentPathStat.isSymbolicLink() && parentPathStat.isDirectory() &&
            sameFileIdentityForCleanup(parentPathStat, parentFdStat) &&
            !target.isSymbolicLink() && target.isFile() &&
            sameFileIdentityForCleanup(target, params.created)) {
            fsSync.rmSync(targetPath);
        }
    }
    catch {
        // Failed cleanup leaves a fail-closed artifact instead of deleting an
        // unverified pathname.
    }
}
export async function createNativeExclusiveFile(targetPath, mode) {
    const binding = getNativeBinding();
    if (!binding) {
        return undefined;
    }
    const closeFd = captureNativeFdClose(binding);
    const parentPath = path.dirname(targetPath);
    const basename = path.basename(targetPath);
    const parent = await fs.open(parentPath, fsSync.constants.O_RDONLY |
        (typeof fsSync.constants.O_DIRECTORY === "number" ? fsSync.constants.O_DIRECTORY : 0));
    let fd;
    let created;
    try {
        let opened;
        try {
            opened = binding.openBeneath(parent.fd, basename, nativeOpenFlags(fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL));
        }
        catch (error) {
            // The parent open above and every post-create operation remain untagged.
            // Only this exclusive-open failure has enough provenance for a caller to
            // classify a Windows lock-file denial without swallowing setup failures.
            const openError = error;
            if (process.platform === "win32" && openError.code === "EPERM") {
                openError.path = targetPath;
            }
            throw error;
        }
        fd = opened.fd;
        fsSync.fchmodSync(fd, mode);
        created = fsSync.fstatSync(fd, { bigint: true });
        return wrapNativeFd(fd, closeFd);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeFd(fd);
            }
            catch {
                // Preserve the original error.
            }
            removeNativeCreatedFileIfStillPinned({
                parentPath,
                parentFd: parent.fd,
                basename,
                created,
            });
        }
        throw error;
    }
    finally {
        await parent.close().catch(() => undefined);
    }
}
