import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Writable } from "node:stream";
import { ArchiveFormatError } from "./archive-errors.js";
const PADDING_WINDOW_BYTES = 65536;
let zeroPadding;
function assertZeroPadding(bytes) {
    zeroPadding ??= Buffer.alloc(PADDING_WINDOW_BYTES);
    if (!bytes.equals(zeroPadding.subarray(0, bytes.length))) {
        throw new ArchiveFormatError("nonzero gzip container padding");
    }
}
export function isGzipBuffer(input) {
    return input[0] === 31 && input[1] === 139;
}
function assertConsumedBoundary(consumed, size) {
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > size) {
        throw new ArchiveFormatError("invalid gzip consumed-input boundary");
    }
}
/** Validate the same physical suffix when admission owns an in-memory input. */
export async function validateGzipBufferTail(input, consumed, signal) {
    signal?.throwIfAborted();
    assertConsumedBoundary(consumed, input.length);
    for (let position = consumed; position < input.length; position += PADDING_WINDOW_BYTES) {
        signal?.throwIfAborted();
        assertZeroPadding(input.subarray(position, position + PADDING_WINDOW_BYTES));
        if (position + PADDING_WINDOW_BYTES < input.length)
            await new Promise(resolve => setImmediate(resolve));
    }
    signal?.throwIfAborted();
}
/** Track physical input, not the sum of bytes consumed across separate writes:
 * gunzip can resume on a later chunk after leaving an earlier padding gap. */
export class GzipInput extends Writable {
    decoder;
    position = 0;
    firstUnused;
    constructor(decoder) {
        super({ highWaterMark: 65536 });
        this.decoder = decoder;
    }
    get tailOffset() {
        return this.firstUnused ?? this.position;
    }
    _write(chunk, _encoding, callback) {
        const before = this.decoder.bytesWritten;
        this.decoder.write(chunk, (error) => {
            if (error) {
                callback(error);
                return;
            }
            const used = this.decoder.bytesWritten - before;
            if (!Number.isSafeInteger(used) || used < 0 || used > chunk.length ||
                !Number.isSafeInteger(this.position + chunk.length)) {
                callback(new ArchiveFormatError("invalid gzip consumed-input boundary"));
                return;
            }
            if (used < chunk.length)
                this.firstUnused ??= this.position + used;
            this.position += chunk.length;
            callback();
        });
    }
    _final(callback) {
        this.decoder.end(callback);
    }
    _destroy(error, callback) {
        if (error || !this.writableFinished)
            this.decoder.destroy(error ?? undefined);
        callback(error);
    }
}
/** Check the immutable staged suffix from the first unused physical byte,
 * including later chunks the decoder may have consumed, before returning. */
export async function validateGzipContainerTail(filePath, consumed, signal) {
    signal?.throwIfAborted();
    const handle = await fs.open(filePath, "r");
    try {
        const { size } = fsSync.fstatSync(handle.fd);
        assertConsumedBoundary(consumed, size);
        if (consumed === size)
            return;
        const buffer = Buffer.allocUnsafe(PADDING_WINDOW_BYTES);
        let position = consumed;
        while (position < size) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
            signal?.throwIfAborted();
            if (bytesRead === 0)
                throw new ArchiveFormatError("truncated gzip container padding");
            assertZeroPadding(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
    }
    finally {
        await handle.close();
    }
}
