import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { GzipInput, isGzipBuffer, validateGzipBufferTail, validateGzipContainerTail } from "./archive-gzip-tail.js";
import { ArchiveFormatError } from "./archive-errors.js";
import { TarParserStream, TarWasmSession } from "./archive-tar-wasm.js";
import { readFileWindowFully } from "./positional-read.js";
function* bufferChunks(buffer) {
    for (let offset = 0; offset < buffer.length; offset += 65536)
        yield buffer.subarray(offset, offset + 65536);
}
async function gzipFile(filePath) {
    const handle = await fs.promises.open(filePath, "r");
    try {
        const magic = Buffer.alloc(2);
        const bytesRead = await readFileWindowFully(handle, magic, 0);
        return bytesRead === 2 && isGzipBuffer(magic);
    }
    finally {
        await handle.close();
    }
}
async function withTarStream(params, consume) {
    const buffer = params.archiveBuffer;
    const kind = params.kind ?? "tar";
    const gzip = kind === "tar" && (buffer !== undefined ? isGzipBuffer(buffer) : await gzipFile(params.archivePath));
    const session = new TarWasmSession(params.limits);
    try {
        const parser = new TarParserStream(params.limits, params.onMember, session);
        const input = buffer !== undefined
            ? Readable.from(bufferChunks(buffer), { objectMode: false, highWaterMark: 65536 })
            : fs.createReadStream(params.archivePath, { highWaterMark: 65536 });
        // Match the WASM input window for both staged files and buffered reads.
        const decoder = gzip ? createGunzip({ chunkSize: 65536 }) : undefined;
        const gzipInput = decoder ? new GzipInput(decoder) : undefined;
        const destroy = (error) => {
            input.destroy(error);
            gzipInput?.destroy(error);
            decoder?.destroy(error);
            parser.destroy(error);
        };
        // A pipeline with an async-generator stage can settle before its file's
        // asynchronous close. Join the actual close events before freeing WASM.
        const closed = Promise.all([input, parser, ...(decoder ? [decoder] : []), ...(gzipInput ? [gzipInput] : [])].map(stream => {
            const closing = new Promise(resolve => { stream.once("close", resolve); });
            return finished(stream, { cleanup: true }).then(() => undefined, (cause) => cause instanceof Error ? cause : new Error(String(cause))).then(async (error) => { await closing; return error; });
        }));
        const pumps = decoder && gzipInput
            ? [pipeline(decoder, parser, { signal: params.signal }), pipeline(input, gzipInput, { signal: params.signal })]
            : kind !== "tar"
                ? [pipeline(input, (source) => session.decode(source, kind, params.signal), parser, { signal: params.signal })]
                : [pipeline(input, parser, { signal: params.signal })];
        // Either pump tears down both routes; join every pump even after the first failure.
        const settled = Promise.all(pumps.map((pump) => pump.then(() => undefined, (cause) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            destroy(error);
            return error;
        }))).then((errors) => errors.find((error) => error !== undefined));
        try {
            const result = await consume(parser);
            const error = await settled;
            if (error)
                throw error;
            const closeError = (await closed).find(error => error !== undefined);
            if (closeError)
                throw closeError;
            if (gzipInput) {
                if (buffer !== undefined)
                    await validateGzipBufferTail(buffer, gzipInput.tailOffset, params.signal);
                else
                    await validateGzipContainerTail(params.archivePath, gzipInput.tailOffset, params.signal);
            }
            return result;
        }
        finally {
            destroy();
            await settled;
            await closed;
        }
    }
    finally {
        session.dispose();
    }
}
export async function inspectTar(params) {
    await withTarStream(params, async (parser) => {
        await pipeline(parser, new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    });
}
/** Replay in physical order, retaining at most one decoded chunk. Every range
 * comes from complete admission of the immutable input. */
export async function replayTar(params) {
    await withTarStream(params, async (parser) => {
        const iterator = parser[Symbol.asyncIterator]();
        let chunk = Buffer.alloc(0);
        let position = 0;
        async function* take(length) {
            while (length > 0) {
                if (!chunk.length) {
                    const next = await iterator.next();
                    if (next.done)
                        throw new ArchiveFormatError("truncated admitted TAR range");
                    chunk = next.value;
                }
                const count = Math.min(length, chunk.length);
                const bytes = chunk.subarray(0, count);
                chunk = chunk.subarray(count);
                position += count;
                length -= count;
                yield bytes;
            }
        }
        for (const member of params.members) {
            if (member.offset < position)
                throw new ArchiveFormatError("invalid admitted TAR range order");
            for await (const _ of take(member.offset - position)) { /* Skip admitted gaps. */ }
            const payload = take(member.size);
            await params.consume(member, payload);
            for await (const _ of payload) { /* Directories may carry ignored dump data. */ }
            if (position !== member.offset + member.size)
                throw new ArchiveFormatError("incomplete TAR range consumption");
        }
        // Includes unrequested/skipped members, trailer checks, and physical EOF.
        while (!(await iterator.next()).done) { /* Drain the bounded parser stream. */ }
    });
}
