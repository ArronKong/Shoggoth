import { isUtf8 } from "node:buffer";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { assertAsyncDirectoryGuard, assertDirectoryObservationGuardSync, assertDirectoryObservationSync, createAsyncDirectoryGuard, extendDirectoryObservationGuard, } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { inspectNativeDirectoryObservation, isNativeDirectoryObservationGuard, } from "./native-directory-observation.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent } from "./root-context.js";
import { errorCauseOptions, rootPathChangedError } from "./root-errors.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { createSuppressedError } from "./suppressed-error.js";
import { realpathSync } from "./realpath.js";
import { inspectStatObservationSync } from "./stat-observation.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
const METADATA_BATCH_SIZE = 32;
function directoryEntryName(bytes) {
    if (!isUtf8(bytes)) {
        throw new FsSafeError("invalid-path", "directory entry name is not valid UTF-8");
    }
    return bytes.toString("utf8");
}
async function readDirectoryEntryName(handle, synchronous = false) {
    const entry = synchronous ? handle.readSync() : await handle.read();
    // Bun returns the raw Buffer directly; Node returns a Dirent whose name is a Buffer.
    // Node's Dir types still declare only string names.
    return entry === null ? undefined
        : directoryEntryName(Buffer.isBuffer(entry) ? entry : entry.name);
}
function openDirectoryNames(directory) {
    return fs.opendir(directory, { bufferSize: 1, encoding: "buffer" });
}
export function pathStatFromStats(stat, name) {
    const mtimeMs = typeof stat.mtimeMs === "bigint"
        ? "mtimeNs" in stat && typeof stat.mtimeNs === "bigint"
            ? Number(stat.mtimeNs) / 1_000_000
            : stat.mtime.getTime()
        : stat.mtimeMs;
    const dev = Number(stat.dev), gid = Number(stat.gid), ino = Number(stat.ino);
    const isDirectory = stat.isDirectory(), isFile = stat.isFile(), isSymbolicLink = stat.isSymbolicLink();
    const mode = Number(stat.mode), nlink = Number(stat.nlink), size = Number(stat.size), uid = Number(stat.uid);
    // Construct named metadata directly, preserving property order without a spread copy.
    return name === undefined
        ? { dev, gid, ino, isDirectory, isFile, isSymbolicLink, mode, mtimeMs, nlink, size, uid }
        : { name, dev, gid, ino, isDirectory, isFile, isSymbolicLink, mode, mtimeMs, nlink, size, uid };
}
export async function createRootDirectoryObservationGuard(root, directory) {
    const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
    const admittedRealPath = admitPathInsideRoot({
        rootPath: root.rootReal,
        candidatePath: guard.realPath,
        rootIdentity: root.rootIdentity,
    });
    if (!admittedRealPath) {
        throw new FsSafeError("outside-workspace", "directory is outside workspace root");
    }
    guard.dir = admittedRealPath.path;
    guard.realPath = admittedRealPath.path;
    return guard;
}
function directoryChangedError(error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch")
        return error;
    return new FsSafeError("path-mismatch", "directory changed during operation", errorCauseOptions(error));
}
export async function assertRootDirectoryObservationGuard(root, guard) {
    if (isNativeDirectoryObservationGuard(guard)) {
        throw new FsSafeError("path-mismatch", "native directory observation cannot be revalidated");
    }
    const identity = "identity" in guard ? guard.identity : guard.stat;
    const guardPinsRoot = guard.dir === root.rootReal &&
        identity.dev === root.rootIdentity.dev && identity.ino === root.rootIdentity.ino;
    if (guardPinsRoot) {
        try {
            if ("identity" in guard)
                assertDirectoryObservationGuardSync(guard);
            else
                await assertAsyncDirectoryGuard(guard);
        }
        catch (error) {
            throw rootPathChangedError(error instanceof Error ? error : undefined);
        }
        return;
    }
    if ("identity" in guard && typeof root.rootIdentity.dev === "bigint" &&
        typeof root.rootIdentity.ino === "bigint") {
        try {
            assertDirectoryObservationSync(root.rootReal, root.rootIdentity);
        }
        catch (error) {
            throw rootPathChangedError(error instanceof Error ? error : undefined);
        }
    }
    else {
        await assertRootIdentityCurrent(root);
    }
    try {
        if ("identity" in guard)
            assertDirectoryObservationGuardSync(guard);
        else
            await assertAsyncDirectoryGuard(guard);
    }
    catch (error) {
        throw directoryChangedError(error);
    }
}
function sameObservationDirectory(left, right) {
    return left.dir === right.dir && left.realPath === right.realPath &&
        left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino;
}
function assertReceiptDirectoryGuardSync(root, guard, backend) {
    if (backend) {
        const observed = inspectNativeDirectoryObservation(backend, guard.dir, guard.identity);
        const admitted = admitPathInsideRoot({
            rootPath: root.rootReal,
            candidatePath: observed.realPath,
            rootIdentity: root.rootIdentity,
        });
        if (!admitted || admitted.path !== guard.realPath) {
            throw new FsSafeError("path-mismatch", "directory changed during operation");
        }
        return;
    }
    if (isNativeDirectoryObservationGuard(guard)) {
        throw new FsSafeError("path-mismatch", "native directory observation cannot be revalidated");
    }
    assertDirectoryObservationGuardSync(guard);
}
/**
 * Close an operation-local traversal receipt with fresh exact observations.
 * Descendant canonical paths are admitted while the receipt is created. The
 * final directory check repeats canonical admission; the Root-only case does
 * both its identity and canonical check here.
 */
export function assertRootPathObservationReceiptCurrent(root, receipt, finalTarget) {
    const { rootGuard, directoryGuard } = receipt;
    if (rootGuard.dir !== root.rootReal || rootGuard.realPath !== root.rootReal ||
        rootGuard.identity.dev !== root.rootIdentity.dev || rootGuard.identity.ino !== root.rootIdentity.ino) {
        throw rootPathChangedError();
    }
    if (sameObservationDirectory(rootGuard, directoryGuard)) {
        try {
            if (receipt.kind === "stat" && receipt.target === rootGuard && finalTarget &&
                !receipt.directoryObserver) {
                if (finalTarget.isSymbolicLink() || !finalTarget.isDirectory() ||
                    realpathSync.native(rootGuard.dir) !== rootGuard.realPath) {
                    throw new FsSafeError("path-mismatch", "root path changed during operation");
                }
            }
            else {
                assertReceiptDirectoryGuardSync(root, directoryGuard, receipt.directoryObserver);
            }
        }
        catch (error) {
            throw rootPathChangedError(error instanceof Error ? error : undefined);
        }
        return;
    }
    try {
        assertDirectoryObservationSync(rootGuard.dir, rootGuard.identity);
    }
    catch (error) {
        throw rootPathChangedError(error instanceof Error ? error : undefined);
    }
    try {
        assertReceiptDirectoryGuardSync(root, directoryGuard, receipt.directoryObserver);
    }
    catch (error) {
        throw directoryChangedError(error);
    }
}
function normalizeDirectoryError(error) {
    if (isNotFoundPathError(error)) {
        return new FsSafeError("not-found", "directory not found", errorCauseOptions(error));
    }
    return error;
}
function normalizeInitialDirectoryError(error) {
    if (error instanceof FsSafeError && error.code === "not-file") {
        return new FsSafeError("not-found", "directory not found", { cause: error });
    }
    return normalizeDirectoryError(error);
}
export async function listDirectoryPath(root, directory, withFileTypes, receipt) {
    let guard;
    if (receipt) {
        guard = directoryGuardFromReceipt(directory, receipt);
    }
    else {
        try {
            guard = await createRootDirectoryObservationGuard(root, directory);
        }
        catch (error) {
            throw normalizeInitialDirectoryError(error);
        }
    }
    return await listGuardedDirectoryPath(root, guard, withFileTypes, receipt);
}
function directoryGuardFromReceipt(directory, receipt) {
    if (receipt.kind !== "directory" || receipt.targetPath !== directory ||
        receipt.directoryGuard.dir !== directory ||
        receipt.target !== receipt.directoryGuard ||
        (!isNativeDirectoryObservationGuard(receipt.directoryGuard) &&
            !receipt.directoryGuard.stat.isDirectory())) {
        throw new FsSafeError("path-mismatch", "directory observation receipt does not match target");
    }
    return receipt.directoryGuard;
}
async function listGuardedDirectoryPath(root, guard, withFileTypes, receipt) {
    let entries;
    try {
        const beforeObservation = getFsSafeTestHooks()?.beforeRootListObservation;
        if (beforeObservation)
            await beforeObservation(guard.realPath, withFileTypes);
        const names = (await fs.readdir(guard.realPath, { encoding: "buffer" })).map(directoryEntryName).sort();
        if (withFileTypes) {
            // readdir supplies literal child names beneath the already-canonical directory.
            const prefix = guard.realPath.endsWith(path.sep) ? guard.realPath : `${guard.realPath}${path.sep}`;
            entries = names.map(name => pathStatFromStats(fsSync.lstatSync(`${prefix}${name}`), name));
        }
        else {
            entries = names;
        }
    }
    catch (error) {
        // Preserve ordinary observation errors only while the admitted directory is
        // still current. A post-admission replacement is an identity failure.
        if (receipt)
            assertRootPathObservationReceiptCurrent(root, receipt);
        else
            await assertRootDirectoryObservationGuard(root, guard);
        throw normalizeDirectoryError(error);
    }
    if (receipt)
        assertRootPathObservationReceiptCurrent(root, receipt);
    else
        await assertRootDirectoryObservationGuard(root, guard);
    return entries;
}
export async function openRootDirectoryListing(root, directory, options, receipt) {
    if (options.exactIdentity && options.order !== "filesystem")
        throw new TypeError("exact entry identities require filesystem order");
    let guard;
    if (receipt) {
        guard = directoryGuardFromReceipt(directory, receipt);
    }
    else {
        const admitted = await createRootDirectoryObservationGuard(root, directory).catch((error) => {
            throw normalizeDirectoryError(error);
        });
        // Retain exact admission identities; metadata rechecks can use numeric Stats
        // only when every identity component is losslessly representable.
        guard = extendDirectoryObservationGuard({
            stat: admitted.stat,
            identity: { dev: admitted.stat.dev, ino: admitted.stat.ino },
        }, admitted.dir, admitted.realPath);
    }
    const assertCurrent = async () => {
        options.signal?.throwIfAborted();
        if (receipt)
            assertRootPathObservationReceiptCurrent(root, receipt);
        else
            await assertRootDirectoryObservationGuard(root, guard);
        options.signal?.throwIfAborted();
    };
    const paths = { directory: guard.realPath, names: new Map() };
    const previousPaths = options.previousPaths?.directory === guard.realPath ? options.previousPaths.names : undefined;
    let handle;
    let names;
    let snapshot;
    let index = 0, preparedIndex = 0;
    let prepared = [];
    const synchronousNames = options.exactIdentity && !process.versions.bun && !process.versions.deno;
    let pendingFailure;
    let pendingLimit;
    let preparedBatch = false;
    const close = async () => {
        const owned = handle;
        handle = undefined;
        try {
            await owned?.close();
        }
        catch (error) {
            options.onCleanupFailure?.(error);
            throw error;
        }
    };
    try {
        await assertCurrent();
        if (options.order === "filesystem") {
            // A one-entry buffer keeps the truncation lookahead independent of width.
            handle = await openDirectoryNames(guard.realPath);
        }
        else if (options.snapshot) {
            snapshot = await listGuardedDirectoryPath(root, guard, true, receipt);
        }
        else if (options.maxNames !== undefined) {
            names = [];
            handle = await openDirectoryNames(guard.realPath);
            while (true) {
                await assertCurrent();
                const name = await readDirectoryEntryName(handle);
                await assertCurrent();
                if (name === undefined)
                    break;
                if (names.length >= options.maxNames) {
                    throw new FsSafeError("too-large", "directory entry budget exceeded");
                }
                names.push(name);
            }
            await close();
        }
        else {
            names = (await fs.readdir(guard.realPath, { encoding: "buffer" })).map(directoryEntryName);
        }
        await assertCurrent();
        names?.sort();
    }
    catch (error) {
        const operationError = normalizeDirectoryError(error);
        try {
            await close();
        }
        catch (closeError) {
            throw createSuppressedError(closeError, operationError, "directory setup and close both failed");
        }
        throw operationError;
    }
    const prepareBatch = async (sortedNames) => {
        let name = sortedNames[index++];
        if (name === undefined) {
            await assertCurrent();
            return;
        }
        if (!options.admitEntry()) {
            pendingLimit = name;
            return;
        }
        if (preparedBatch)
            await yieldToEventLoop();
        await assertCurrent();
        preparedBatch = true;
        prepared = [];
        preparedIndex = 0;
        while (true) {
            try {
                const entry = pathStatFromStats(fsSync.lstatSync(path.join(guard.realPath, name)), name);
                prepared.push(entry);
                // No later sibling can be observed before a possible recursive descent.
                if (entry.isDirectory || entry.isSymbolicLink || prepared.length >= (options.metadataBatchSize ?? METADATA_BATCH_SIZE))
                    break;
            }
            catch (error) {
                pendingFailure = { error: normalizeDirectoryError(error) };
                break;
            }
            name = sortedNames[index++];
            if (name === undefined)
                break;
            if (!options.admitEntry()) {
                pendingLimit = name;
                break;
            }
        }
        try {
            await assertCurrent();
        }
        catch (error) {
            if (pendingFailure) {
                throw createSuppressedError(error, pendingFailure.error, "directory observation and identity checks both failed");
            }
            throw error;
        }
    };
    return {
        paths,
        assertCurrent,
        async next() {
            try {
                options.signal?.throwIfAborted();
                if (snapshot) {
                    const entry = snapshot[index++];
                    if (!entry)
                        return;
                    return options.admitEntry() ? { kind: "entry", entry } : { kind: "limit", name: entry.name };
                }
                if (names) {
                    if (preparedIndex >= prepared.length && !pendingFailure && pendingLimit === undefined) {
                        await prepareBatch(names);
                    }
                    const entry = prepared[preparedIndex++];
                    if (entry)
                        return { kind: "entry", entry };
                    if (pendingFailure)
                        throw pendingFailure.error;
                    if (pendingLimit !== undefined)
                        return { kind: "limit", name: pendingLimit };
                    return;
                }
                for (;;) {
                    if (synchronousNames && index++ % METADATA_BATCH_SIZE === METADATA_BATCH_SIZE - 1)
                        await yieldToEventLoop();
                    await assertCurrent();
                    const name = await readDirectoryEntryName(handle, synchronousNames);
                    await assertCurrent();
                    if (name === undefined)
                        return;
                    if (!options.admitEntry())
                        return { kind: "limit", name };
                    // The stream's post-read fence is also the pre-stat fence in this owned operation.
                    const pathname = previousPaths?.get(name) ?? path.join(guard.realPath, name);
                    if (options.exactIdentity)
                        paths.names.set(name, pathname);
                    let observed;
                    try {
                        observed = options.exactIdentity ? inspectStatObservationSync(bigint => bigint
                            ? fsSync.lstatSync(pathname, { bigint: true }) : fsSync.lstatSync(pathname)) : { stat: fsSync.lstatSync(pathname) };
                    }
                    catch (error) {
                        await assertCurrent();
                        if (options.skipVanished && isNotFoundPathError(error))
                            continue;
                        throw error;
                    }
                    await assertCurrent();
                    return { kind: "entry", entry: pathStatFromStats(observed.stat, name), identity: observed.identity };
                }
            }
            catch (error) {
                throw normalizeDirectoryError(error);
            }
        },
        [Symbol.asyncDispose]: close,
    };
}
