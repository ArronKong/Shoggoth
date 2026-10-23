import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openedPathResolutionError } from "./opened-file-failure.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
export async function resolveOpenedFileRealPathForHandle(handle, ioPath) {
    const fd = handle.fd;
    const identity = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }));
    const resolved = await resolveOpenedFileRealPathForFd(fd, identity, ioPath);
    let first = resolved.stat;
    inspectFileIdentitySync(() => {
        const current = first ?? fsSync.statSync(resolved.realPath, { bigint: true });
        first = undefined;
        return current;
    }, identity);
    return resolved.realPath;
}
export async function resolveOpenedFileRealPathForFd(fd, handleStat, ioPath) {
    const statOptions = typeof handleStat.dev === "bigint" || typeof handleStat.ino === "bigint"
        ? { bigint: true } : undefined;
    const fdCandidates = process.platform === "linux"
        ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]
        : [];
    for (const fdPath of fdCandidates) {
        try {
            const fdRealPath = realpathSync.native(fdPath);
            const fdRealStat = statOptions ? fsSync.statSync(fdRealPath, statOptions) : fsSync.statSync(fdRealPath);
            if (sameFileIdentity(handleStat, fdRealStat)) {
                return { realPath: fdRealPath, stat: fdRealStat };
            }
        }
        catch {
            // try next fd path
        }
    }
    try {
        const ioRealPath = realpathSync.native(ioPath);
        const ioRealStat = statOptions ? fsSync.statSync(ioRealPath, statOptions) : fsSync.statSync(ioRealPath);
        if (sameFileIdentity(handleStat, ioRealStat)) {
            return { realPath: ioRealPath, stat: ioRealStat };
        }
    }
    catch (err) {
        if (!isNotFoundPathError(err)) {
            // Windows can fail here on a deleted-but-open file. Brand only this
            // resolver operation; the caller must still prove unlink on the same fd.
            if (process.platform === "win32" && err instanceof Error &&
                ["EPERM", "EBADF"].includes(err.code ?? "")) {
                throw openedPathResolutionError(err);
            }
            throw err;
        }
    }
    const parentResolved = await resolveOpenedFileRealPathFromParent(handleStat, ioPath, statOptions);
    if (parentResolved) {
        return parentResolved;
    }
    throw openedPathResolutionError();
}
async function resolveOpenedFileRealPathFromParent(handleStat, ioPath, statOptions) {
    let parentReal;
    try {
        parentReal = realpathSync.native(path.dirname(ioPath));
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return null;
        }
        throw err;
    }
    let entries;
    try {
        entries = await fs.readdir(parentReal);
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            return null;
        }
        throw err;
    }
    for (const entry of entries.toSorted()) {
        const candidatePath = path.join(parentReal, entry);
        try {
            const candidateStat = statOptions ? fsSync.lstatSync(candidatePath, statOptions) : fsSync.lstatSync(candidatePath);
            if (candidateStat.isFile() && sameFileIdentity(handleStat, candidateStat)) {
                const realPath = realpathSync.native(candidatePath);
                const stat = statOptions ? fsSync.statSync(realPath, statOptions) : fsSync.statSync(realPath);
                if (sameFileIdentity(handleStat, stat))
                    return { realPath, stat };
            }
        }
        catch (err) {
            if (!isNotFoundPathError(err)) {
                throw err;
            }
        }
    }
    return null;
}
