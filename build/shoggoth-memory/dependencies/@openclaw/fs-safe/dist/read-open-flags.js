import fs from "node:fs";
export function resolveReadOpenFlags(options) {
    const constants = options?.constants ?? fs.constants;
    const noFollow = process.platform !== "win32" &&
        options?.followSymlinks !== true &&
        typeof constants.O_NOFOLLOW === "number"
        ? constants.O_NOFOLLOW
        : 0;
    const nonBlocking = process.platform !== "win32" && typeof constants.O_NONBLOCK === "number"
        ? constants.O_NONBLOCK
        : 0;
    return constants.O_RDONLY | noFollow | nonBlocking;
}
