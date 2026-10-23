import fsSync from "node:fs";
import { hasNodeErrorCode } from "./path.js";
export function resolveNonblockingWriteFlag(constants = fsSync.constants) {
    return process.platform !== "win32" && typeof constants.O_NONBLOCK === "number"
        ? constants.O_NONBLOCK
        : 0;
}
function isNonblockingWriteEnxio(error, flags) {
    return hasNodeErrorCode(error, "ENXIO") &&
        (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === fsSync.constants.O_WRONLY &&
        (flags & resolveNonblockingWriteFlag()) !== 0;
}
// A no-reader FIFO rejects a nonblocking write-only open before fstat is possible.
// Reclassify only a confirmed non-regular path; inconclusive races keep the errno.
export async function isNonRegularWriteOpenError(error, filePath, flags) {
    return isNonRegularWriteOpenErrorSync(error, filePath, flags);
}
export function isNonRegularWriteOpenErrorSync(error, filePath, flags) {
    if (!isNonblockingWriteEnxio(error, flags))
        return false;
    try {
        return !fsSync.lstatSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
