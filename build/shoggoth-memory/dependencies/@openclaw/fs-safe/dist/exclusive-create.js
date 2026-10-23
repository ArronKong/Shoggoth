import fs from "node:fs";
import { hasNodeErrorCode } from "./path.js";
export function assertExclusiveCreateStat(pathname, stat) {
    if (stat.isSymbolicLink()) {
        throw Object.assign(new Error("exclusive creation target already exists"), {
            code: "EEXIST", syscall: "open", path: pathname,
        });
    }
}
// Windows O_EXCL can create a dangling file symlink's referent. Keep the
// exclusive-open collision contract; this preflight cannot prevent a later swap.
export function assertExclusiveCreateLeaf(pathname) {
    if (process.platform !== "win32")
        return;
    try {
        assertExclusiveCreateStat(pathname, fs.lstatSync(pathname));
    }
    catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT"))
            throw error;
    }
}
