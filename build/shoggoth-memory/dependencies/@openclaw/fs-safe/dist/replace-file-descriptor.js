import syncFs, {} from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { ownDirectoryMode } from "./directory-mode-node.js";
import { inspectAtomicIdentity, wait } from "./atomic-io.js";
function parentCloseFailure(primary, closeError) {
    return primary ? new AggregateError([primary.error, closeError], "Atomic parent preparation and close failed") : closeError;
}
export function* syncDirectoryBestEffort(io, dirPath) {
    let file;
    try {
        file = yield* io.open(dirPath, "r");
        yield* file.sync();
    }
    catch {
        // Directory synchronization and close remain best-effort.
    }
    finally {
        try {
            const closing = file?.close();
            if (file && io.asynchronous)
                yield closing;
        }
        catch {
            // Preserve the operation's best-effort contract.
        }
    }
}
function directoryOpenFlags() {
    return (syncFs.constants.O_RDONLY |
        syncFs.constants.O_DIRECTORY |
        syncFs.constants.O_NOFOLLOW |
        syncFs.constants.O_NONBLOCK);
}
function assertDirectory(identity, dirPath) {
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new FsSafeError("not-file", `Atomic replace parent must be a real directory: ${dirPath}`);
    }
    return identity;
}
async function pinDirectoryForMode(params) {
    // Node does not enforce POSIX directory modes on Windows, and its directory
    // descriptors are not consistently openable. mkdir(mode) remains the only
    // bounded behavior there; never fall back to a pathname chmod.
    if (process.platform === "win32") {
        return;
    }
    const expected = params.fsModule === fs
        ? inspectFileIdentitySync(() => assertDirectory(syncFs.lstatSync(params.dirPath, { bigint: true }), params.dirPath))
        : await inspectFileIdentity(async () => assertDirectory(await params.fsModule.lstat(params.dirPath, { bigint: true }), params.dirPath));
    const handle = await params.fsModule.open(params.dirPath, directoryOpenFlags());
    try {
        const owner = ownDirectoryMode({
            async inspect() {
                const opened = params.fsModule === fs
                    ? inspectFileIdentitySync(() => assertDirectory(syncFs.fstatSync(handle.fd, { bigint: true }), params.dirPath), expected)
                    : await inspectFileIdentity(async () => assertDirectory(await handle.stat({ bigint: true }), params.dirPath), expected);
                return Number(opened.mode & 4095n);
            },
            chmod: (mode) => {
                params.mutation?.assert();
                return handle.chmod(mode);
            },
            close: () => handle.close(),
            ignoreChmodError: params.ignoreChmodError,
        });
        await owner.verify();
        return owner;
    }
    catch (error) {
        try {
            await handle.close();
        }
        catch (closeError) {
            throw parentCloseFailure({ error }, closeError);
        }
        throw error;
    }
}
export function* applyDirectoryMode(io, params) {
    if (io.asynchronous) {
        const owner = yield* wait(pinDirectoryForMode({
            ...params,
            fsModule: io.asyncFs,
        }));
        let primary;
        try {
            if (owner)
                yield* wait(owner.apply(params.mode));
        }
        catch (error) {
            primary = { error };
            throw error;
        }
        finally {
            try {
                if (owner)
                    yield* wait(owner.close());
            }
            catch (closeError) {
                throw parentCloseFailure(primary, closeError);
            }
        }
        return;
    }
    if (process.platform === "win32")
        return;
    const admit = (stat) => assertDirectory(stat, params.dirPath);
    const expected = inspectAtomicIdentity(io, () => io.lstatExact(params.dirPath), undefined, false, admit);
    const file = yield* io.open(params.dirPath, directoryOpenFlags());
    let primary;
    try {
        inspectAtomicIdentity(io, () => file.statExact(), expected, false, admit);
        params.mutation?.assert();
        file.chmod(params.mode & 0o7777);
    }
    catch (error) {
        primary = { error };
        throw error;
    }
    finally {
        try {
            file.close();
        }
        catch (closeError) {
            throw parentCloseFailure(primary, closeError);
        }
    }
}
export function* writeTempFile(io, params) {
    params.mutation?.assert();
    const file = yield* io.open(params.tempPath, "wx", params.mode);
    try {
        const openedInspection = inspectAtomicIdentity(io, () => file.statExact());
        const identity = (io.asynchronous ? (yield openedInspection) : openedInspection);
        params.onIdentity?.(identity);
        params.mutation?.assert();
        const writing = file.writeFile(params.content, true);
        if (io.asynchronous)
            yield writing;
        const chmod = file.chmod(params.mode);
        if (io.asynchronous)
            yield chmod;
        if (params.sync)
            yield* file.syncBestEffort();
        const currentInspection = inspectAtomicIdentity(io, () => file.statExact(), identity);
        if (io.asynchronous)
            yield currentInspection;
        return { file, identity };
    }
    catch (error) {
        try {
            const closing = file.close();
            if (io.asynchronous)
                yield closing;
        }
        catch (closeError) {
            throw new AggregateError([error, closeError], "Atomic temp write and close failed");
        }
        throw error;
    }
}
