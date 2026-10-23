import fs from "node:fs";
// Node's synchronous read length is a signed 32-bit value on supported runtimes.
const MAX_READ_BYTES = 0x7fffffff;
function validateWindow(buffer, position) {
    if (!Number.isSafeInteger(position) || position < 0 ||
        !Number.isSafeInteger(position + buffer.length)) {
        throw new RangeError("read position and window end must be non-negative safe integers");
    }
}
/** Fills a caller-owned buffer from an explicit position, stopping at EOF. */
export async function readFileWindowFully(handle, buffer, position, { signal } = {}) {
    validateWindow(buffer, position);
    signal?.throwIfAborted();
    let total = 0;
    while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, Math.min(buffer.length - total, MAX_READ_BYTES), position + total);
        // Settle the pending read before cancellation lets the caller reuse its buffer or handle.
        signal?.throwIfAborted();
        if (bytesRead === 0)
            break;
        total += bytesRead;
    }
    return total;
}
/** Synchronous positional read; neither variant advances or closes its descriptor. */
export function readFileWindowFullySync(fd, buffer, position) {
    validateWindow(buffer, position);
    let total = 0;
    while (total < buffer.length) {
        const bytesRead = fs.readSync(fd, buffer, total, Math.min(buffer.length - total, MAX_READ_BYTES), position + total);
        if (bytesRead === 0)
            break;
        total += bytesRead;
    }
    return total;
}
