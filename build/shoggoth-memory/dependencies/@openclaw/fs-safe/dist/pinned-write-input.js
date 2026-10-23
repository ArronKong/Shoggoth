import { readSync } from "node:fs";
import { types } from "node:util";
import { snapshotByteView } from "./byte-view.js";
import { writeCopyFileToFd } from "./copy-file-input.js";
import { FsSafeError } from "./errors.js";
import { writeAllToFile } from "./write-file-handle.js";
/** Replay a consumed stream from an owned, readable stage descriptor. */
export function replayPinnedInput(fd, input) {
    if (input.kind !== "stream")
        return input;
    return { kind: "stream", stageBeforePublish: true, stream: (async function* () {
            let position = 0;
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
                const bytes = readSync(fd, buffer, 0, buffer.length, position);
                if (!bytes)
                    return;
                position += bytes;
                yield buffer.subarray(0, bytes);
            }
        })() };
}
const isUint8Array = types.isUint8Array;
function streamChunkBytes(chunk) {
    if (Buffer.isBuffer(chunk))
        return chunk;
    if (!isUint8Array(chunk))
        return Buffer.from(chunk);
    return snapshotByteView(chunk);
}
export async function writePinnedInput(target, input, maxBytes, assertBeforeMutation) {
    if (input.kind === "file") {
        await writeCopyFileToFd(typeof target === "number" ? target : target.fd, input, maxBytes, assertBeforeMutation);
        return;
    }
    let bytes = 0;
    const write = async (data) => {
        bytes += data.byteLength;
        if (maxBytes !== undefined && bytes > maxBytes) {
            throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`);
        }
        await writeAllToFile(target, data, { assertBeforeMutation });
    };
    if (input.kind === "buffer") {
        await write(typeof input.data === "string" ? Buffer.from(input.data, input.encoding ?? "utf8") : input.data);
    }
    else {
        for await (const chunk of input.stream) {
            await write(streamChunkBytes(chunk));
        }
    }
}
