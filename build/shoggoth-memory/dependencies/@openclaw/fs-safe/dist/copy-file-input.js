import fs, {} from "node:fs";
import { resolveCopyCloneMode } from "./copy-policy.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { transferFileHandle } from "./file-handle-transfer.js";
export function resolveFileCopyCloneMode(mode) {
    const clone = resolveCopyCloneMode(mode, "never");
    if (clone === "always" && !getNativeBinding()?.copyFileExclusive) {
        throw new FsSafeError("helper-unavailable", "native file cloning is unavailable");
    }
    return clone;
}
export async function assertCopySourceCurrent(source, identity) {
    await inspectFileIdentity(() => fs.fstatSync(source.handle.fd, { bigint: true }), identity);
    await inspectFileIdentity(() => {
        const current = fs.lstatSync(source.realPath, { bigint: true });
        if (current.isSymbolicLink() || !current.isFile()) {
            throw new FsSafeError("path-mismatch", "copy source path changed");
        }
        return current;
    }, identity);
}
export async function writeCopyFileToFd(fd, input, maxBytes, assertBeforeMutation) {
    await transferFileHandle(input.handle, fd, {
        maxBytes, sizeHint: input.size, signal: input.signal, assertBeforeMutation,
    });
}
export async function createNativeCopyFile(native, input, parentFd, basename, maxBytes) {
    input.signal?.throwIfAborted();
    if (!native.copyFileExclusive) {
        if (input.clone === "always") {
            throw new FsSafeError("helper-unavailable", "native file cloning is unavailable");
        }
        return undefined;
    }
    captureNativeFdClose(native);
    const nativeSignal = input.signal ? AbortSignal.any([input.signal]) : undefined;
    try {
        // The caller adopts this descriptor before observing a later cancellation.
        return await native.copyFileExclusive(input.handle.fd, parentFd, basename, input.clone, maxBytes !== undefined && Number.isFinite(maxBytes) ? maxBytes : undefined, nativeSignal);
    }
    catch (error) {
        const code = error?.code;
        if (code === "Cancelled" || code === "ABORT_ERR")
            input.signal?.throwIfAborted();
        if (code === "too-large") {
            throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes`, { cause: error });
        }
        if (code === "ENOTSUP" && input.clone !== "always")
            return undefined;
        if (code === "ENOTSUP") {
            throw new FsSafeError("unsupported-platform", "native file cloning is unsupported", { cause: error });
        }
        throw new FsSafeError("helper-failed", "native file copy failed", { cause: error });
    }
    finally {
        if (nativeSignal)
            nativeSignal.onabort = null;
    }
}
export function assertNativeCopyCompleted(input, copied) {
    if (copied?.errorCode) {
        if (copied.errorCode === "Cancelled" || copied.errorCode === "ABORT_ERR")
            input.signal?.throwIfAborted();
        const unsupported = ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"].includes(copied.errorCode);
        throw new FsSafeError(copied.errorCode === "too-large" ? "too-large" : unsupported ? "unsupported-platform" : "helper-failed", copied.errorMessage ?? "native file copy failed", { cause: Object.assign(new Error(copied.errorMessage ?? "native file copy failed"), { code: copied.errorCode }) });
    }
    input.signal?.throwIfAborted();
}
