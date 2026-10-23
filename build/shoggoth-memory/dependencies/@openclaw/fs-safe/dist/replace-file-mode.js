import { FsSafeError } from "./errors.js";
export function inheritedRegularFileMode(stat) {
    if (stat.isSymbolicLink()) {
        throw new FsSafeError("symlink", "atomic replace destination must not be a symbolic link");
    }
    if (!stat.isFile()) {
        throw new FsSafeError("not-file", "atomic replace destination must be a regular file");
    }
    return stat.mode & 0o777;
}
