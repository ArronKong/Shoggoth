import { normalizeMaxBytes } from "./byte-budget.js";
import { readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
export async function readOpenedFileSafely(params) {
    const maxBytes = normalizeMaxBytes(params.maxBytes);
    if (maxBytes !== undefined && params.opened.stat.size > maxBytes) {
        throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got ${params.opened.stat.size})`);
    }
    const buffer = maxBytes === undefined
        ? await params.opened.handle.readFile()
        : await readFileHandleBounded(params.opened.handle, maxBytes);
    return {
        buffer,
        containment: params.opened.containment,
        realPath: params.opened.realPath,
        stat: params.opened.stat,
    };
}
