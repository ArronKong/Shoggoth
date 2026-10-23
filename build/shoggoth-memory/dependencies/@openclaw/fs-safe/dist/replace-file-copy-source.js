import { inspectAtomicIdentity } from "./atomic-io.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { hasErrorCode } from "./file-cleanup.js";
const OPEN_READ_FLAGS = resolveReadOpenFlags();
function assertSourcePreview(source, src) {
    if (source.isSymbolicLink()) {
        throw new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`);
    }
    if (!source.isFile()) {
        throw new FsSafeError("not-file", `Refusing copy fallback from non-file source: ${src}`);
    }
    if (source.nlink !== 1) {
        throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${src}`);
    }
}
function assertOpenedSource(opened, current, src) {
    if (!opened.isFile() || current.isSymbolicLink()) {
        throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${src}`);
    }
    if (opened.nlink !== 1n) {
        throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${src}`);
    }
}
export function* readOwnedCopySource(io, params) {
    assertSourcePreview(yield* io.lstat(params.src), params.src);
    const handle = yield* openSource(io, params.src);
    try {
        const openedInspection = inspectAtomicIdentity(io, () => handle.statExact(), params.expectedIdentity);
        const opened = (io.asynchronous ? (yield openedInspection) : openedInspection);
        const currentInspection = inspectAtomicIdentity(io, () => io.lstatExact(params.src), opened);
        const current = (io.asynchronous ? (yield currentInspection) : currentInspection);
        assertOpenedSource(opened, current, params.src);
        const replacement = yield* handle.readFile(io.asynchronous ? undefined : Number(opened.size));
        return { replacement, mode: Number(opened.mode) };
    }
    finally {
        try {
            const closing = handle.close();
            if (io.asynchronous)
                yield closing;
        }
        catch {
            // Source close never replaces the selected read or admission result.
        }
    }
}
function* openSource(io, src) {
    try {
        return yield* io.open(src, OPEN_READ_FLAGS);
    }
    catch (error) {
        if (hasErrorCode(error, "ELOOP")) {
            throw new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`, {
                cause: error,
            });
        }
        throw error;
    }
}
