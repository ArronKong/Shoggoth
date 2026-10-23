var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
// Idle storage is bounded independently of caller concurrency. A pending read
// retains its exclusive borrow until the async hasher settles.
const hashScratchBuffers = [];
function takeHashScratch(size) {
    const index = hashScratchBuffers.findIndex((buffer) => buffer.length >= size);
    return index < 0 ? Buffer.allocUnsafe(size) : hashScratchBuffers.splice(index, 1)[0];
}
class HashScratch {
    #storage;
    buffer;
    constructor(size) {
        this.#storage = takeHashScratch(size);
        this.buffer = this.#storage.subarray(0, size);
    }
    grow(size) {
        const storage = takeHashScratch(size);
        this[Symbol.dispose]();
        this.#storage = storage;
        return this.buffer = storage.subarray(0, size);
    }
    [Symbol.dispose]() {
        // Clear the used view before retention; a larger unused tail was cleared
        // by its previous borrower, without making tiny hashes clear large buffers.
        this.buffer.fill(0);
        hashScratchBuffers.push(this.#storage);
        hashScratchBuffers.sort((left, right) => left.length - right.length);
        if (hashScratchBuffers.length > 4)
            hashScratchBuffers.shift();
    }
}
export async function hashFileHandle(handle, native = getNativeBinding(), { maxBytes = Infinity, signal } = {}) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        signal?.throwIfAborted();
        const stat = fsSync.fstatSync(handle.fd);
        if (!stat.isFile()) {
            throw new FsSafeError("not-file", "SHA-256 input is not a regular file");
        }
        if (stat.size > maxBytes) {
            throw new FsSafeError("too-large", `SHA-256 input exceeds ${maxBytes} bytes`);
        }
        if (native) {
            // A completed N-API task can mask later aborts on the same signal.
            const nativeSignal = signal ? AbortSignal.any([signal]) : undefined;
            try {
                const result = await native.sha256File(handle.fd, Number.isFinite(maxBytes) ? maxBytes : undefined, nativeSignal);
                signal?.throwIfAborted();
                return result;
            }
            catch (error) {
                // N-API settles only after compute stops; never race descriptor cleanup.
                signal?.throwIfAborted();
                if (error?.code === "too-large") {
                    throw new FsSafeError("too-large", `SHA-256 input exceeds ${maxBytes} bytes`, { cause: error });
                }
                throw error;
            }
            finally {
                // Node retains composite signals while N-API's abort listener is attached.
                if (nativeSignal)
                    nativeSignal.onabort = null;
            }
        }
        const hash = createHash("sha256");
        const scratch = __addDisposableResource(env_1, new HashScratch(Math.min(256 * 1024, Math.max(1, stat.size + 1), maxBytes + 1)), false);
        let buffer = scratch.buffer;
        let position = 0;
        while (true) {
            signal?.throwIfAborted();
            const length = Math.min(buffer.length, maxBytes - position + 1);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            signal?.throwIfAborted();
            if (bytesRead > maxBytes - position) {
                throw new FsSafeError("too-large", `SHA-256 input exceeds ${maxBytes} bytes`);
            }
            if (bytesRead === 0) {
                return { bytes: position, digest: hash.digest("hex") };
            }
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
            // A full small buffer can mean growth or a virtual file with an unhelpful size.
            if (bytesRead === buffer.length && buffer.length < 64 * 1024) {
                buffer = scratch.grow(Math.min(64 * 1024, maxBytes + 1));
            }
        }
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        __disposeResources(env_1);
    }
}
function hashPathIdentity(filePath, afterOpen = false) {
    const stat = fsSync.lstatSync(filePath, { bigint: true });
    if (afterOpen && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new FsSafeError("path-mismatch", "SHA-256 path changed while opening");
    }
    if (stat.isSymbolicLink()) {
        throw new FsSafeError("symlink", "SHA-256 path must not be a symbolic link");
    }
    if (!stat.isFile()) {
        throw new FsSafeError("not-file", "SHA-256 path is not a regular file");
    }
    return stat;
}
function hashDescriptorIdentity(fd) {
    const stat = fsSync.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {
        throw new FsSafeError("not-file", "SHA-256 path is not a regular file");
    }
    return stat;
}
function rethrowHashOpenError(error) {
    if (error?.code === "ELOOP") {
        throw new FsSafeError("symlink", "SHA-256 path must not be a symbolic link", {
            cause: error,
        });
    }
    throw error;
}
async function hashPath(filePath, options) {
    assertNoWindowsPathAlias(filePath, "filesystem", "SHA-256 path uses a Windows filesystem namespace alias");
    const before = await inspectFileIdentity(() => hashPathIdentity(filePath));
    let handle;
    try {
        options.signal?.throwIfAborted();
        handle = await fs.open(filePath, resolveReadOpenFlags());
    }
    catch (error) {
        rethrowHashOpenError(error);
    }
    let completed = false;
    try {
        options.signal?.throwIfAborted();
        const opened = await inspectFileIdentity(() => hashDescriptorIdentity(handle.fd), before);
        await inspectFileIdentity(() => hashPathIdentity(filePath, true), opened);
        const result = await hashFileHandle(handle, getNativeBinding(), options);
        completed = true;
        return result;
    }
    finally {
        if (completed)
            await handle.close();
        else
            await handle.close().catch(() => undefined);
    }
}
export async function sha256File(input, options = {}) {
    options.signal?.throwIfAborted();
    const normalized = { maxBytes: normalizeMaxBytes(options.maxBytes), signal: options.signal };
    return typeof input === "string"
        ? await hashPath(input, normalized)
        : await hashFileHandle(input, getNativeBinding(), normalized);
}
function hashDescriptorSync(fd, { maxBytes = Infinity, signal }) {
    const env_2 = { stack: [], error: void 0, hasError: false };
    try {
        signal?.throwIfAborted();
        const stat = fsSync.fstatSync(fd);
        if (!stat.isFile()) {
            throw new FsSafeError("not-file", "SHA-256 input is not a regular file");
        }
        if (stat.size > maxBytes) {
            throw new FsSafeError("too-large", `SHA-256 input exceeds ${maxBytes} bytes`);
        }
        const hash = createHash("sha256");
        const scratch = __addDisposableResource(env_2, new HashScratch(Math.min(256 * 1024, Math.max(1, stat.size + 1), maxBytes + 1)), false);
        let buffer = scratch.buffer;
        let position = 0;
        while (true) {
            signal?.throwIfAborted();
            const length = Math.min(buffer.length, maxBytes - position + 1);
            const bytesRead = fsSync.readSync(fd, buffer, 0, length, position);
            signal?.throwIfAborted();
            if (bytesRead > maxBytes - position) {
                throw new FsSafeError("too-large", `SHA-256 input exceeds ${maxBytes} bytes`);
            }
            if (bytesRead === 0) {
                return { bytes: position, digest: hash.digest("hex") };
            }
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
            if (bytesRead === buffer.length && buffer.length < 64 * 1024) {
                buffer = scratch.grow(Math.min(64 * 1024, maxBytes + 1));
            }
        }
    }
    catch (e_2) {
        env_2.error = e_2;
        env_2.hasError = true;
    }
    finally {
        __disposeResources(env_2);
    }
}
function hashPathSync(filePath, options) {
    assertNoWindowsPathAlias(filePath, "filesystem", "SHA-256 path uses a Windows filesystem namespace alias");
    const before = inspectFileIdentitySync(() => hashPathIdentity(filePath));
    let fd;
    try {
        options.signal?.throwIfAborted();
        fd = fsSync.openSync(filePath, resolveReadOpenFlags());
    }
    catch (error) {
        rethrowHashOpenError(error);
    }
    let completed = false;
    try {
        options.signal?.throwIfAborted();
        const opened = inspectFileIdentitySync(() => hashDescriptorIdentity(fd), before);
        inspectFileIdentitySync(() => hashPathIdentity(filePath, true), opened);
        const result = hashDescriptorSync(fd, options);
        completed = true;
        return result;
    }
    finally {
        try {
            fsSync.closeSync(fd);
        }
        catch (error) {
            if (completed)
                throw error;
        }
    }
}
/** Hash synchronously from offset zero, retaining ownership and position of a borrowed fd. */
export function sha256FileSync(input, options = {}) {
    options.signal?.throwIfAborted();
    const normalized = { maxBytes: normalizeMaxBytes(options.maxBytes), signal: options.signal };
    return typeof input === "string"
        ? hashPathSync(input, normalized)
        : hashDescriptorSync(input, normalized);
}
