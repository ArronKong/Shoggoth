import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
export function readSymlinkResolution(symlinks) {
    return {
        rejectSymlinks: symlinks !== "follow-within-root" && symlinks !== "follow-parents-within-root",
        rejectFinalSymlink: symlinks === "follow-parents-within-root",
    };
}
export function mutationSymlinkResolution(symlinks) {
    if (symlinks !== undefined && symlinks !== "reject" && symlinks !== "follow-parents-within-root") {
        throw new RangeError("mutationSymlinks must be reject or follow-parents-within-root");
    }
    return {
        rejectSymlinks: symlinks === "reject",
        rejectFinalSymlink: symlinks !== undefined,
        resolveCanonical: symlinks !== undefined,
    };
}
// Call after parent fences and immediately before the mutation. This is a
// final-component check, not an atomic conditional rename against another process.
export function assertFinalSymlinkRejected(targetPath, reject, details) {
    if (!reject)
        return;
    try {
        if (fs.lstatSync(targetPath).isSymbolicLink()) {
            throw new FsSafeError("symlink", "final symlink not allowed", { details });
        }
    }
    catch (error) {
        if (!isNotFoundPathError(error))
            throw error;
    }
}
