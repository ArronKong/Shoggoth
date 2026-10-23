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
import { registerRootHandleContext } from "./root-handle-context.js";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertCopySourceCurrent, resolveFileCopyCloneMode } from "./copy-file-input.js";
import { assertPrivateFileCreationAvailable, resolveCreationPermissions } from "./creation-boundary.js";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard, createAsyncDirectoryGuard, createNearestExistingDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { openLocalFileDescriptor } from "./local-file-descriptor.js";
import { assertMutationNotDenied, mergeDenyMutationPolicies } from "./deny-mutations.js";
import { resolveOpenedFileRealPathForFd } from "./opened-realpath.js";
import { openedPathResolutionError, recordExclusiveCreateFailure, recordOpenedFileFailure } from "./opened-file-failure.js";
import { runPinnedWriteHelper, runPinnedWriteWithRenamePolicy } from "./pinned-write.js";
import { preparePinnedWriteMutationAdmission, snapshotPinnedMutationPolicy } from "./pinned-mutation-admission.js";
import { getNativeBinding } from "./native.js";
import { isFsSafeNativeRequired } from "./native-config.js";
import { validatePinnedRelativePath } from "./pinned-operation.js";
import { PATH_ALIAS_POLICIES } from "./path-policy.js";
import { assertNoNulPathInput, hasNodeErrorCode, isNotFoundPathError, isSymlinkOpenError, } from "./path.js";
import { readOpenedFileSafely } from "./read-opened-file.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { sameFileIdentity } from "./file-identity.js";
import { removePathIfIdentityUnchanged } from "./replace-file-temp-owner.js";
import { realpathSync } from "./realpath.js";
import { mkdirPathFallback, prepareRootWriteTarget, tryMkdirAtExactParent } from "./root-directory-creation.js";
import { buildAtomicWriteTempPath, rootWriteQueueKey, tryMkdirRootNative, tryOpenCreateRootNative } from "./root-create-native.js";
import { isNonRegularWriteOpenError, resolveNonblockingWriteFlag } from "./write-open-flags.js";
import { resolveRootPath, resolveRootPathSync, resolveRootPathForRemoval } from "./root-path.js";
import { RemovalPathReceipts } from "./root-remove-receipt.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { listDirectoryPath, openRootDirectoryListing } from "./root-directory-list.js";
import { statResolvedPathInRoot } from "./root-path-stat.js";
import { entriesInRoot } from "./root-entries.js";
import { assertMoveMutationAllowed } from "./root-move-preflight.js";
import { assertRootIdentityCurrent, assertRootIdentityCurrentSync, assertValidRootDestinationPath, assertValidRootRelativePath, createRootObservationGuard, ensureTrailingSep, expandRelativePathWithHome, resolvePathInRoot, resolveRootContext, rootRelativeReadPath, } from "./root-context.js";
import { errorCauseOptions, fileNotFoundError, hardlinkedPathNotAllowedError, isAlreadyExistsError, normalizePinnedPathError, normalizePinnedWriteError, outsideWorkspaceError, } from "./root-errors.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { walkRoot } from "./root-walk.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { removePathInRootFallback, validateRemoveOptions } from "./root-remove.js";
import { removePathInRootNative } from "./root-remove-native.js";
import { serializePathWrite } from "./write-queue.js";
import { verifyAtomicWriteResult } from "./root-write-verification.js";
import { assertRootWritePathSelectionSync, assertRootWriteSelectionSync, createRootWriteSelectionForFd, prepareGuardedRootWritePathSelection, resolveGuardedWritePathInRoot, resolveGuardedWriteTargetInRoot, resolvePinnedWriteTargetInRoot, refreshRetainedRootWriteAdmission, refreshRootWritePathSelection, } from "./root-write-admission.js";
import { prepareSharedRootWriteTarget } from "./root-write-complete-parent.js";
import { finishRootFallbackWrite } from "./root-write-publication.js";
import { withRootFallbackCompatibilityLock } from "./root-write-compatibility.js";
import { assertRootFallbackWritePath } from "./root-write-lock-binding.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { admitMoveSourceStat, movePathNative } from "./root-move-noreplace.js";
import { admitRootReadHandle, inspectOpenedPathIdentitySync } from "./root-read-admission.js";
import { createCopyPublicationObserver, onCopyPublication, onCopySourceAdmission } from "./copy-publication.js";
import { writeAllToFile } from "./write-file-handle.js";
import { createInputOptions, rethrowCreateInputError, rootWriteInput } from "./root-create-input.js";
import { assertFinalSymlinkRejected, mutationSymlinkResolution, readSymlinkResolution } from "./root-symlink-policy.js";
import { assertExclusiveCreateLeaf } from "./exclusive-create.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";
import { resolvePinnedObservedPathInRoot } from "./root-observed-path.js";
import { registerFileLockSyncRootAdapter } from "./file-lock-sync-root.js";
import { mergeReadOptions, readDefaults, } from "./root-options.js";
import { composeMutationAssertions, MutationAuthorityError, rethrowMutationAuthorityError } from "./mutation-authority.js";
export { DEFAULT_ROOT_MAX_BYTES } from "./root-options.js";
export { resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
function logWarn(message) {
    if (process.env.FS_SAFE_DEBUG_WARNINGS === "1") {
        console.warn(message);
    }
}
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_EXISTING_FLAGS = fsConstants.O_WRONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0) |
    resolveNonblockingWriteFlag();
const OPEN_WRITE_CREATE_FLAGS = fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS = fsConstants.O_RDWR | fsConstants.O_APPEND | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0) |
    resolveNonblockingWriteFlag();
const OPEN_APPEND_CREATE_FLAGS = fsConstants.O_RDWR |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
function openResult(params) {
    return {
        handle: params.handle,
        containment: "best-effort",
        realPath: params.realPath,
        stat: params.stat,
        [Symbol.asyncDispose]: () => params.handle.close().catch(() => undefined),
    };
}
async function openVerifiedLocalFile(filePath, options) {
    const fsSafeTestHooks = getFsSafeTestHooks();
    const { handle, stat, identity, preOpenStat } = await openLocalFileDescriptor(filePath, options);
    try {
        const inspectPathIdentity = async (inspect) => {
            try {
                return await inspectFileIdentity(inspect, identity);
            }
            catch (error) {
                const failure = isNotFoundPathError(error) ? openedPathResolutionError(fileNotFoundError()) : error;
                if (stat.nlink <= 1 && (!preOpenStat || preOpenStat.nlink <= 1n)) {
                    await recordOpenedFileFailure(failure, handle, filePath, identity);
                }
                throw failure;
            }
        };
        await inspectPathIdentity(async () => inspectOpenedPathIdentitySync(filePath, options?.symlinks));
        await fsSafeTestHooks?.afterOpenedPathIdentityCheck?.(filePath, handle);
        const resolved = await resolveOpenedFileRealPathForFd(handle.fd, identity, filePath)
            .catch(async (error) => {
            if (stat.nlink <= 1 && (!preOpenStat || preOpenStat.nlink <= 1n)) {
                await recordOpenedFileFailure(error, handle, filePath, identity);
            }
            throw error;
        });
        const { realPath } = resolved;
        assertNoWindowsPathAlias(realPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
        let resolvedStat = resolved.stat;
        await inspectPathIdentity(async () => {
            // Reuse the post-realpath observation; unknown Windows identities still
            // get a fresh observation on inspectFileIdentity's retry.
            const realStat = resolvedStat ?? fsSync.statSync(realPath, { bigint: true });
            resolvedStat = undefined;
            if (options?.hardlinks === "reject" && realStat.nlink > 1n) {
                throw hardlinkedPathNotAllowedError();
            }
            return realStat;
        });
        return { opened: openResult({ handle, realPath, stat }), identity };
    }
    catch (err) {
        await handle.close().catch(() => { });
        throw err;
    }
}
export class RootHandle {
    context;
    rootDir;
    rootReal;
    rootWithSep;
    defaults;
    constructor(context, defaults = {}) {
        this.context = context;
        this.rootDir = context.rootDir;
        this.rootReal = context.rootReal;
        this.rootWithSep = context.rootWithSep;
        this.defaults = defaults;
        registerFileLockSyncRootAdapter(this, context, defaults);
        registerRootHandleContext(this, context);
    }
    mutationOptions(options) {
        return {
            ...options,
            assertBeforeMutation: composeMutationAssertions(this.defaults.assertBeforeMutation, options.assertBeforeMutation),
            mutationSymlinks: options.mutationSymlinks ?? this.defaults.mutationSymlinks,
            denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
        };
    }
    async resolve(relativePath) {
        assertValidRootDestinationPath(relativePath);
        return (await resolvePathInRoot(this.context, relativePath, { allowFinalSymlink: true, resolveCanonical: true })).resolved;
    }
    async open(relativePath, options = {}) {
        return await openFileInRoot(this.context, {
            ...readDefaults(this.defaults),
            ...options,
            relativePath,
        });
    }
    async read(relativePath, options = {}) {
        return await readFileInRoot(this.context, {
            relativePath,
            ...mergeReadOptions(this.defaults, options),
        });
    }
    async readBytes(relativePath, options = {}) {
        return (await this.read(relativePath, options)).buffer;
    }
    async readText(relativePath, options = {}) {
        const { encoding = "utf8", ...readOptions } = options;
        return (await this.read(relativePath, readOptions)).buffer.toString(encoding);
    }
    async readJson(relativePath, options = {}) {
        return JSON.parse(await this.readText(relativePath, options));
    }
    async readAbsolute(filePath, options = {}) {
        const context = this.context;
        const readOptions = mergeReadOptions(this.defaults, options);
        return await readFileInRoot(context, {
            relativePath: rootRelativeReadPath(context, filePath),
            ...readOptions,
        });
    }
    reader(options = {}) {
        return async (filePath) => {
            return (await this.readAbsolute(filePath, options)).buffer;
        };
    }
    async openWritable(relativePath, options = {}) {
        assertValidRootDestinationPath(relativePath);
        const writeMode = options.writeMode ?? "replace";
        const target = await openWritableFileInRoot(this.context, {
            mkdir: this.defaults.mkdir,
            mode: this.defaults.mode,
            ...this.mutationOptions(options),
            relativePath,
            expectedWritePath: undefined,
            append: writeMode === "append",
            truncateExisting: writeMode === "replace",
        }).catch(rethrowMutationAuthorityError);
        return target.opened;
    }
    async append(relativePath, data, options = {}) {
        assertValidRootDestinationPath(relativePath);
        await appendFileInRoot(this.context, {
            mkdir: this.defaults.mkdir,
            mode: this.defaults.mode,
            ...this.mutationOptions(options),
            relativePath,
            data,
            durable: options.durable ?? this.defaults.durable ?? true,
        }).catch(rethrowMutationAuthorityError);
    }
    async remove(relativePath, options = {}) {
        assertValidRootRelativePath(relativePath);
        validateRemoveOptions(options);
        options.signal?.throwIfAborted();
        await removePathInRoot(this.context, {
            ...this.mutationOptions(options),
            relativePath,
        }).catch(rethrowMutationAuthorityError);
    }
    async mkdir(relativePath, options = {}) {
        assertValidRootDestinationPath(relativePath);
        await mkdirPathInRoot(this.context, {
            ...this.mutationOptions(options),
            relativePath,
            allowRoot: false,
        }).catch(rethrowMutationAuthorityError);
    }
    async ensureRoot(options = {}) {
        await mkdirPathInRoot(this.context, {
            ...this.mutationOptions(options),
            relativePath: "",
            allowRoot: true,
        }).catch(rethrowMutationAuthorityError);
    }
    async write(relativePath, data, options = {}) {
        assertValidRootDestinationPath(relativePath);
        await writeFileInRoot(this.context, {
            mkdir: this.defaults.mkdir,
            mode: this.defaults.mode,
            renameIdentity: this.defaults.renameIdentity,
            ...this.mutationOptions(options),
            atomic: undefined,
            private: undefined,
            strictFileSync: undefined,
            relativePath,
            data,
            durable: options.durable ?? this.defaults.durable ?? true,
        }).catch(rethrowMutationAuthorityError);
    }
    async create(relativePath, data, options = {}) {
        assertValidRootDestinationPath(relativePath);
        const durable = options.durable ?? this.defaults.durable ?? true;
        await writeFileInRoot(this.context, {
            mkdir: this.defaults.mkdir,
            mode: this.defaults.mode,
            ...this.mutationOptions(createInputOptions(data, options, this.defaults.maxBytes)),
            relativePath,
            data,
            durable: durable !== false,
            strictFileSync: durable === "file",
            overwrite: false,
        }).catch(rethrowMutationAuthorityError).catch(rethrowCreateInputError);
    }
    async writeJson(relativePath, data, options = {}) {
        const { replacer, space, trailingNewline = true, ...writeOptions } = options;
        const json = stringifyJsonDocument(data, replacer, space);
        await this.write(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
    }
    async createJson(relativePath, data, options = {}) {
        const { replacer, space, trailingNewline = true, ...writeOptions } = options;
        const json = stringifyJsonDocument(data, replacer, space);
        await this.create(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
    }
    async copyIn(relativePath, source, options = {}) {
        options.signal?.throwIfAborted();
        assertValidRootDestinationPath(relativePath);
        const { maxBytes, ...copyOptions } = this.mutationOptions(options);
        const copySource = typeof source === "string" ? source : { root: source.root, relativePath: source.relativePath };
        await copyFileInRoot(this.context, {
            maxBytes: normalizeMaxBytes(maxBytes, { defaultValue: this.defaults.maxBytes }),
            mkdir: this.defaults.mkdir,
            ...copyOptions,
            source: copySource,
            relativePath,
            mode: options.mode ?? this.defaults.mode,
            durable: options.durable ?? this.defaults.durable ?? true,
            verifyPublished: options[onCopyPublication],
            admitSource: options[onCopySourceAdmission],
        }).catch(rethrowMutationAuthorityError);
    }
    async exists(relativePath) {
        try {
            await this.stat(relativePath);
            return true;
        }
        catch (err) {
            if (err instanceof FsSafeError && err.code === "not-found") {
                return false;
            }
            throw err;
        }
    }
    async stat(relativePath) {
        assertValidRootRelativePath(relativePath);
        validatePinnedRelativePath(relativePath);
        return await statPathFallback(this.context, relativePath);
    }
    async list(relativePath, options = {}) {
        assertValidRootRelativePath(relativePath);
        validatePinnedRelativePath(relativePath);
        return await listPathFallback(this.context, relativePath, options.withFileTypes === true);
    }
    async move(fromRelative, toRelative, options = {}) {
        assertValidRootRelativePath(fromRelative);
        assertValidRootDestinationPath(toRelative);
        validatePinnedRelativePath(fromRelative);
        validatePinnedRelativePath(toRelative);
        const mutationOptions = this.mutationOptions(options);
        const { assertBeforeMutation } = mutationOptions;
        const { denyMutations, mutationSymlinks } = snapshotPinnedMutationPolicy(mutationOptions.denyMutations, mutationOptions.mutationSymlinks) ?? {};
        const overwrite = options.overwrite ?? false;
        const requireNative = isFsSafeNativeRequired();
        await assertMoveMutationAllowed(this.context, {
            fromRelative,
            toRelative,
            denyMutations,
        });
        await movePathFallback(this.context, {
            requireNative,
            fromRelative,
            denyMutations,
            assertBeforeMutation,
            mutationSymlinks,
            overwrite,
            toRelative,
        }).catch(rethrowMutationAuthorityError);
    }
    entries(relativePath, options = {}) {
        assertValidRootRelativePath(relativePath);
        return entriesInRoot(this.context, relativePath, {
            ...options,
            symlinks: options.symlinks ?? this.defaults.symlinks,
        });
    }
    walk(relativePath, options) {
        assertValidRootRelativePath(relativePath);
        return walkRoot({
            rootReal: this.context.rootReal,
            observeRoot: () => createRootObservationGuard(this.context),
            stat: relative => this.stat(relative),
            list: async (relative, listingOptions, receipt) => {
                validatePinnedRelativePath(relative);
                if (receipt) {
                    return await openRootDirectoryListing(this.context, receipt.targetPath, listingOptions, receipt);
                }
                const resolved = await resolvePinnedPathInRoot(this.context, { relativePath: relative, allowRoot: true });
                return await openRootDirectoryListing(this.context, resolved.resolved, listingOptions);
            },
        }, relativePath, options);
    }
}
export async function root(rootDir, defaults = {}) {
    normalizeMaxBytes(defaults.maxBytes);
    return new RootHandle(await resolveRootContext(rootDir), defaults);
}
// Internal callers that already hold an exact admitted directory capability must
// not recapture a different filesystem object while constructing the Root.
export function rootFromDirectoryGuard(guard, defaults = {}) {
    normalizeMaxBytes(defaults.maxBytes);
    return new RootHandle({
        rootDir: resolvePathPreservingWindowsRoot(guard.dir),
        rootGuard: { dir: guard.realPath, realPath: guard.realPath, stat: guard.stat },
        rootIdentity: { dev: guard.stat.dev, ino: guard.stat.ino },
        rootReal: guard.realPath,
        rootWithSep: ensureTrailingSep(guard.realPath),
    }, defaults);
}
async function openFileInRoot(root, params) {
    const { resolved } = await resolvePathInRoot(root, params.relativePath, {
        allowFinalSymlink: true,
        rejectUnsafeDeviceReads: true,
        ...readSymlinkResolution(params.symlinks),
        resolveCanonical: true,
    });
    const fsSafeTestHooks = getFsSafeTestHooks();
    if (fsSafeTestHooks?.afterRootReadPathResolution) {
        await fsSafeTestHooks.afterRootReadPathResolution(resolved);
    }
    const { handle, stat, identity } = await openLocalFileDescriptor(resolved, {
        symlinks: params.symlinks,
    });
    // The admission helper owns the descriptor until the complete root/file/root
    // fence succeeds, then transfers that still-open handle to the caller.
    const admitted = await admitRootReadHandle({
        root, filePath: resolved, opened: { handle, stat }, identity,
        hardlinks: params.hardlinks, symlinks: params.symlinks,
        beforeFinalFence: fsSafeTestHooks?.beforeRootReadFinalFence,
        afterPathIdentityCheck: fsSafeTestHooks?.afterRootReadFinalPathIdentityCheck,
    });
    return openResult(admitted);
}
async function readFileInRoot(root, params) {
    const opened = await openFileInRoot(root, params);
    try {
        return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
    }
    finally {
        await opened.handle.close().catch(() => { });
    }
}
export async function readLocalFileSafely(params) {
    const maxBytes = normalizeMaxBytes(params.maxBytes);
    const opened = await openLocalFileSafely({ filePath: params.filePath });
    try {
        return await readOpenedFileSafely({ opened, maxBytes });
    }
    finally {
        await opened.handle.close().catch(() => { });
    }
}
export async function openLocalFileSafely(params) {
    const filePath = params.filePath;
    assertNoNulPathInput(filePath, "file path contains a NUL byte");
    assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
    return (await openVerifiedLocalFile(filePath)).opened;
}
function emitWriteBoundaryWarning(reason) {
    logWarn(`security: fs-safe write boundary warning (${reason})`);
}
async function openWritableFileInRoot(root, params, options) {
    const requireNative = isFsSafeNativeRequired();
    const policy = requireNative ? snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks) : undefined;
    if (policy)
        params = { ...params, ...policy };
    const guardedTarget = params.denyMutations === undefined && params.mutationSymlinks === undefined
        ? undefined
        : await resolveGuardedWriteTargetInRoot(root, {
            relativePath: params.relativePath,
            denyMutations: params.denyMutations,
            mutationSymlinks: params.mutationSymlinks,
        });
    const { resolved } = guardedTarget?.resolvedPath ?? await resolveGuardedWritePathInRoot(root, {
        relativePath: params.relativePath,
    });
    const resolveCurrent = async () => (await resolveGuardedWritePathInRoot(root, {
        relativePath: params.relativePath, ...policy,
    })).resolved;
    const nativeParent = requireNative && params.mkdir !== false && await tryMkdirRootNative({
        originalPath: params.relativePath,
        root, directory: path.dirname(resolved), target: resolved, mkdir: true, policy,
        resolveCurrent, assertBeforeMutation: params.assertBeforeMutation,
    });
    const prepared = !nativeParent && guardedTarget ? await prepareSharedRootWriteTarget(root, {
        relativePath: params.relativePath, guardedTarget, mkdir: params.mkdir,
        assertBeforeMutation: params.assertBeforeMutation,
    }) : undefined;
    const preparedParent = prepared?.preparedParent;
    let ioPath = nativeParent ? resolved : prepared?.targetPath ?? (params.mkdir === false ? resolved :
        await prepareRootWriteTarget(root, resolved, params.assertBeforeMutation));
    const operationTargetPath = ioPath;
    try {
        assertFinalSymlinkRejected(ioPath, params.mutationSymlinks !== undefined);
        const resolvedRealPath = params.mutationSymlinks === undefined ? realpathSync.native(ioPath) : ioPath;
        const admittedRealPath = admitPathInsideRoot({
            rootPath: root.rootReal,
            candidatePath: resolvedRealPath,
            rootIdentity: root.rootIdentity,
        });
        if (!admittedRealPath) {
            throw outsideWorkspaceError();
        }
        ioPath = admittedRealPath.path;
    }
    catch (err) {
        if (err instanceof FsSafeError) {
            throw err;
        }
        if (!isNotFoundPathError(err)) {
            throw err;
        }
    }
    assertRootFallbackWritePath(params.expectedWritePath, ioPath);
    const mode = params.mode ?? 0o600;
    let handle;
    let createdForWrite = false;
    let cleanupCreated;
    let releaseCreationParent;
    let writePathSelection = undefined;
    const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
    const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
    try {
        writePathSelection = guardedTarget
            ? await prepareGuardedRootWritePathSelection(guardedTarget, ioPath, operationTargetPath, preparedParent)
            : undefined;
        try {
            if (writePathSelection)
                assertRootWritePathSelectionSync(root, writePathSelection);
            handle = await fs.open(ioPath, existingFlags, mode);
        }
        catch (err) {
            if (await isNonRegularWriteOpenError(err, ioPath, existingFlags)) {
                throw new FsSafeError("not-file", "path is not a regular file under root");
            }
            if (!isNotFoundPathError(err)) {
                throw err;
            }
            if (options?.createIfMissing === false) {
                const parentGuard = writePathSelection?.parentGuard ??
                    await createAsyncDirectoryGuard(path.dirname(ioPath), { bigint: true });
                assertRootIdentityCurrentSync(root);
                if (!admitPathInsideRoot({
                    rootPath: root.rootReal, candidatePath: parentGuard.realPath, rootIdentity: root.rootIdentity,
                }))
                    throw outsideWorkspaceError();
                assertSyncDirectoryGuard(parentGuard);
                return { missing: true, targetPath: ioPath, parentGuard, writeSelection: writePathSelection };
            }
            if (writePathSelection)
                await refreshRootWritePathSelection(writePathSelection);
            const nativeCreated = requireNative ? await tryOpenCreateRootNative({
                originalPath: params.relativePath,
                root, directory: path.dirname(ioPath), target: ioPath, mkdir: false, policy,
                resolveCurrent, assertBeforeMutation() {
                    params.assertBeforeMutation?.();
                    if (writePathSelection)
                        assertRootWritePathSelectionSync(root, writePathSelection);
                },
                flags: createFlags, existingFlags, mode,
            }) : undefined;
            if (nativeCreated)
                handle = nativeCreated.handle;
            else {
                params.assertBeforeMutation?.();
                if (writePathSelection)
                    assertRootWritePathSelectionSync(root, writePathSelection);
                // Windows can follow a dangling symlink even with O_EXCL.
                if (!SUPPORTS_NOFOLLOW)
                    assertFinalSymlinkRejected(ioPath, true);
                handle = await fs.open(ioPath, createFlags, mode);
            }
            cleanupCreated = nativeCreated?.cleanupCreated;
            releaseCreationParent = nativeCreated?.releaseCreationParent;
            createdForWrite = true;
        }
    }
    catch (err) {
        if (isNotFoundPathError(err)) {
            throw fileNotFoundError();
        }
        if (isSymlinkOpenError(err)) {
            throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
        }
        if (hasNodeErrorCode(err, "EISDIR")) {
            throw new FsSafeError("not-file", "not a file", { cause: err });
        }
        throw err;
    }
    let realPathForCleanup = null;
    let createdIdentity = null;
    try {
        const stat = fsSync.fstatSync(handle.fd);
        const identity = inspectFileIdentitySync(() => {
            const observed = fsSync.fstatSync(handle.fd, { bigint: true });
            if (!observed.isFile()) {
                throw new FsSafeError("not-file", "path is not a regular file under root");
            }
            if (observed.nlink > 1n)
                throw hardlinkedPathNotAllowedError();
            return observed;
        });
        if (createdForWrite)
            createdIdentity = identity;
        let observedIoPath = false;
        try {
            inspectFileIdentitySync(() => {
                const lstat = fsSync.lstatSync(ioPath, { bigint: true });
                observedIoPath = true;
                if (lstat.isSymbolicLink() || !lstat.isFile()) {
                    throw new FsSafeError(lstat.isSymbolicLink() ? "symlink" : "not-file", "path is not a regular file under root");
                }
                if (lstat.nlink > 1n)
                    throw hardlinkedPathNotAllowedError();
                return lstat;
            }, identity);
        }
        catch (err) {
            if (isNotFoundPathError(err) && !observedIoPath) {
                // The opened file may have been renamed before its first pathname
                // observation. The descriptor-bound resolver below must still find it.
            }
            else if (err instanceof FsSafeError && err.code === "path-mismatch") {
                throw new FsSafeError("path-mismatch", "path changed during write", { cause: err });
            }
            else {
                throw err;
            }
        }
        let realPath = (await resolveOpenedFileRealPathForFd(handle.fd, identity, ioPath)).realPath;
        assertNoWindowsPathAlias(realPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
        try {
            inspectFileIdentitySync(() => {
                const realStat = fsSync.statSync(realPath, { bigint: true });
                if (!realStat.isFile()) {
                    throw new FsSafeError("not-file", "path is not a regular file under root");
                }
                if (realStat.nlink > 1n)
                    throw hardlinkedPathNotAllowedError();
                return realStat;
            }, identity);
        }
        catch (err) {
            if (err instanceof FsSafeError && err.code === "path-mismatch") {
                throw new FsSafeError("path-mismatch", "path mismatch", { cause: err });
            }
            throw err;
        }
        const admittedRealPath = admitPathInsideRoot({
            rootPath: root.rootReal,
            candidatePath: realPath,
            rootIdentity: root.rootIdentity,
        });
        if (!admittedRealPath) {
            throw outsideWorkspaceError();
        }
        realPath = admittedRealPath.path;
        realPathForCleanup = realPath;
        assertRootFallbackWritePath(params.expectedWritePath, realPath);
        const writeSelection = writePathSelection
            ? createRootWriteSelectionForFd(writePathSelection, handle.fd)
            : undefined;
        // Truncate only after boundary and identity checks complete. This avoids
        // irreversible side effects if a symlink target changes before validation.
        if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {
            if (writeSelection)
                await refreshRetainedRootWriteAdmission(root, writeSelection, handle.fd);
            assertFinalSymlinkRejected(ioPath, params.mutationSymlinks !== undefined);
            params.assertBeforeMutation?.();
            if (writeSelection)
                assertRootWriteSelectionSync(root, writeSelection, handle.fd);
            await handle.truncate(0);
        }
        if (writeSelection) {
            await refreshRetainedRootWriteAdmission(root, writeSelection, handle.fd);
            assertRootWriteSelectionSync(root, writeSelection, handle.fd);
        }
        const result = {
            handle,
            containment: "best-effort",
            createdForWrite,
            realPath,
            stat,
            [Symbol.asyncDispose]: () => handle.close().catch(() => undefined),
        };
        if (!params.keepCreationParent)
            releaseCreationParent?.();
        return { opened: result, identity, writeSelection, cleanupCreated, releaseCreationParent };
    }
    catch (err) {
        const cleanupCreatedPath = createdForWrite && err instanceof FsSafeError;
        const cleanupPath = realPathForCleanup ?? ioPath;
        if (cleanupCreatedPath && cleanupCreated)
            await cleanupCreated().catch(() => { });
        try {
            releaseCreationParent?.();
        }
        catch { /* Preserve the admission failure. */ }
        await handle.close().catch(() => { });
        if (cleanupCreatedPath && createdIdentity && !cleanupCreated) {
            await removePathIfIdentityUnchanged(cleanupPath, createdIdentity).catch(() => { });
        }
        throw err;
    }
}
async function appendFileInRoot(root, params) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const { opened: target, identity, cleanupCreated, releaseCreationParent } = await openWritableFileInRoot(root, {
            relativePath: params.relativePath,
            mkdir: params.mkdir,
            mode: params.mode,
            denyMutations: params.denyMutations,
            assertBeforeMutation: params.assertBeforeMutation,
            mutationSymlinks: params.mutationSymlinks,
            truncateExisting: false,
            append: true,
            keepCreationParent: true,
        });
        const creationParent = __addDisposableResource(env_1, { [Symbol.dispose]() { releaseCreationParent?.(); } }, false);
        let dispatched = false;
        // Reverse disposal order closes the handle before path cleanup and retains both failures.
        const cleanup = __addDisposableResource(env_1, {
            async [Symbol.asyncDispose]() {
                if (!dispatched && target.createdForWrite && !cleanupCreated) {
                    await removePathIfIdentityUnchanged(target.realPath, identity);
                }
            },
        }, true);
        const handle = __addDisposableResource(env_1, target.handle, true);
        const nativeCleanup = __addDisposableResource(env_1, { async [Symbol.asyncDispose]() {
                if (!dispatched && target.createdForWrite)
                    await cleanupCreated?.();
            } }, true);
        try {
            let prefix = "";
            if (params.prependNewlineIfNeeded === true &&
                !target.createdForWrite &&
                target.stat.size > 0 &&
                params.data.length > 0 &&
                ((typeof params.data === "string" && !params.data.startsWith("\n")) ||
                    (Buffer.isBuffer(params.data) && params.data[0] !== 0x0a))) {
                const newline = Buffer.from("\n", typeof params.data === "string" ? params.encoding : "utf8");
                const tail = Buffer.alloc(newline.length);
                const { bytesRead } = await target.handle.read(tail, 0, tail.length, Math.max(0, target.stat.size - tail.length));
                if (bytesRead > 0 && (bytesRead !== newline.length || !tail.equals(newline))) {
                    prefix = "\n";
                }
            }
            const payload = typeof params.data === "string" ? `${prefix}${params.data}`
                : prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
            await writeAllToFile(target.handle, payload, {
                encoding: params.encoding,
                assertBeforeMutation: () => {
                    assertFinalSymlinkRejected(target.realPath, params.mutationSymlinks !== undefined);
                    params.assertBeforeMutation?.();
                    dispatched = true;
                },
            });
            // A successful empty append still creates the file, as Node's appendFile does.
            dispatched = true;
            if (params.durable !== false)
                await target.handle.sync();
            if (params.durable !== false && target.createdForWrite) {
                await syncDirectoryBestEffort(path.dirname(target.realPath));
            }
        }
        catch (error) {
            rethrowMutationAuthorityError(error);
        }
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        const result_1 = __disposeResources(env_1);
        if (result_1)
            await result_1;
    }
}
async function removePathInRoot(root, params) {
    validatePinnedRelativePath(params.relativePath);
    const requireNative = isFsSafeNativeRequired();
    if (requireNative)
        params = { ...params, ...snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks) };
    const removalReceipts = params.recursive ? undefined : new RemovalPathReceipts();
    const resolved = await resolvePinnedPathInRoot(root, {
        relativePath: params.relativePath,
        denyMutations: params.denyMutations,
        mutationSymlinks: params.mutationSymlinks,
        remove: true,
        removalReceipts,
    });
    try {
        if (requireNative)
            await removePathInRootNative(root, resolved.resolved, params, removalReceipts);
        else
            await removePathInRootFallback(root, resolved.resolved, params, removalReceipts);
    }
    catch (error) {
        if (params.recursive)
            throw error;
        throw normalizePinnedPathError(error);
    }
}
async function mkdirPathInRoot(root, params) {
    const requireNative = isFsSafeNativeRequired();
    const privateMode = resolveCreationPermissions(params, true).private;
    validatePinnedRelativePath(params.relativePath);
    const policy = params.denyMutations === undefined && params.mutationSymlinks === undefined
        ? undefined
        : snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks);
    const resolution = { relativePath: params.relativePath, allowRoot: params.allowRoot, ...policy };
    const resolveCurrent = policy
        ? async () => await resolvePinnedPathInRoot(root, resolution)
        : undefined;
    const resolved = await resolvePinnedPathInRoot(root, resolution);
    if (requireNative && await tryMkdirRootNative({
        originalPath: params.relativePath,
        root, directory: resolved.resolved, target: resolved.resolved, mkdir: true, private: privateMode,
        policy, resolveCurrent: async () => (await resolvePinnedPathInRoot(root, resolution)).resolved,
        assertBeforeMutation: params.assertBeforeMutation,
    }))
        return;
    const prepared = policy && resolved.relativePosix !== ""
        ? await preparePinnedWriteMutationAdmission({
            rootReal: resolved.rootReal,
            rootIdentity: root.rootIdentity,
            resolvedTargetPath: resolved.resolved,
            originalPath: params.relativePath,
            defaultRelativeParentPath: path.posix.dirname(resolved.relativePosix) === "."
                ? ""
                : path.posix.dirname(resolved.relativePosix),
            policy,
            resolveCurrent: resolveCurrent,
        })
        : undefined;
    if (prepared?.mutationAdmission) {
        await getFsSafeTestHooks()?.beforePinnedWriteParentAdmission?.(resolved.resolved);
    }
    try {
        if (!privateMode && prepared?.mutationAdmission && params.assertBeforeMutation === undefined &&
            await tryMkdirAtExactParent(root, resolved.resolved, prepared.mutationAdmission))
            return;
        await mkdirPathFallback(root, resolved, params.assertBeforeMutation, policy?.mutationSymlinks !== undefined, prepared?.mutationAdmission, privateMode);
    }
    catch (error) {
        throw normalizePinnedPathError(error);
    }
}
async function writeFileInRoot(root, params) {
    if (params.private !== undefined) {
        const permissions = resolveCreationPermissions(params, false);
        params = { ...params, private: permissions.private, mode: permissions.mode };
    }
    const input = rootWriteInput(params);
    await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
        if (!params.private && input.kind === "buffer" && !input.stageBeforePublish && process.platform === "win32" &&
            (params.renameIdentity === "verify-content-with-lock" || !getNativeBinding())) {
            await writeFileFallback(root, { ...params, data: input.data });
            return;
        }
        const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath, params.mode, params.denyMutations, params.overwrite, params.mutationSymlinks);
        await serializePathWrite(pinned.targetPath, async () => {
            await commitPinnedWriteInRoot(root, pinned, params, input);
        });
    });
}
async function commitPinnedWriteInRoot(root, pinned, params, input) {
    let verifyingPublication = false;
    try {
        if (params.private)
            assertPrivateFileCreationAvailable();
        if (params.private && params.mkdir !== false) {
            const target = await prepareRootWriteTarget(root, pinned.targetPath, params.assertBeforeMutation, pinned.mutationAdmission, true);
            if (target !== pinned.targetPath) {
                throw new FsSafeError("path-mismatch", "private creation parent changed during admission");
            }
        }
        await runPinnedWriteWithRenamePolicy({
            rootPath: pinned.rootReal,
            relativeParentPath: pinned.relativeParentPath,
            basename: pinned.basename,
            targetPath: pinned.targetPath,
            renameIdentity: params.renameIdentity,
            mkdir: !params.private && params.mkdir !== false,
            private: params.private,
            mode: params.mode ?? pinned.mode,
            sync: params.durable !== false,
            strictFileSync: params.strictFileSync,
            overwrite: params.overwrite,
            rejectFinalSymlink: params.mutationSymlinks !== undefined,
            input,
            maxBytes: input.kind === "buffer" ? undefined : params.maxBytes,
            rootIdentity: root.rootIdentity,
            mutationAdmission: pinned.mutationAdmission,
            assertBeforeMutation: params.assertBeforeMutation,
            verifyPublished: async (fd, expectedIdentity, parentGuard) => {
                verifyingPublication = true;
                try {
                    await verifyAtomicWriteResult({
                        root,
                        targetPath: pinned.targetPath,
                        fd,
                        expectedIdentity,
                        parentGuard,
                    });
                }
                catch (error) {
                    emitWriteBoundaryWarning(`post-write verification failed: ${String(error)}`);
                    throw error;
                }
            },
        });
    }
    catch (error) {
        if (verifyingPublication)
            throw error;
        const errorCode = error?.code;
        if (errorCode === "file_lock_stale" || errorCode === "file_lock_timeout") {
            throw error;
        }
        if (params.overwrite === false && isAlreadyExistsError(error)) {
            throw new FsSafeError("already-exists", "file already exists", errorCauseOptions(error));
        }
        throw normalizePinnedWriteError(error);
    }
}
async function copyFileInRoot(root, params) {
    params.signal?.throwIfAborted();
    const clone = resolveFileCopyCloneMode(params.clone);
    let source;
    let sourceIdentity;
    if (typeof params.source === "string") {
        assertNoNulPathInput(params.source, "source path contains a NUL byte");
        assertNoWindowsPathAlias(params.source, "filesystem", "source path uses a Windows filesystem namespace alias");
        ({ opened: source, identity: sourceIdentity } = await openVerifiedLocalFile(params.source, {
            hardlinks: params.sourceHardlinks,
        }));
    }
    else {
        source = await params.source.root.open(params.source.relativePath, params.sourceHardlinks === undefined ? undefined : { hardlinks: params.sourceHardlinks });
        try {
            sourceIdentity = await inspectFileIdentity(() => fsSync.fstatSync(source.handle.fd, { bigint: true }));
        }
        catch (error) {
            await source.handle.close().catch(() => undefined);
            throw error;
        }
    }
    if (params.maxBytes !== undefined && source.stat.size > params.maxBytes) {
        await source.handle.close().catch(() => { });
        throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`);
    }
    try {
        const sourceAdmission = params.admitSource?.(sourceIdentity, source.realPath);
        const mode = sourceAdmission?.mode ?? params.mode;
        await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
            const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath, mode ?? (params.preserveSourceMode ? Number(sourceIdentity.mode & 4095n) : undefined), params.denyMutations, params.overwrite !== false, params.mutationSymlinks);
            await serializePathWrite(pinned.targetPath, async () => {
                await assertCopySourceCurrent(source, sourceIdentity);
                const verifySource = async () => {
                    params.signal?.throwIfAborted();
                    try {
                        sourceAdmission?.verify();
                    }
                    catch (error) {
                        throw new MutationAuthorityError(error);
                    }
                    if (typeof params.source !== "string") {
                        await params.source.root.stat(".");
                    }
                    await assertCopySourceCurrent(source, sourceIdentity);
                };
                const observer = createCopyPublicationObserver(pinned.targetPath, params.onDestinationPublished);
                try {
                    await runPinnedWriteHelper({
                        rootPath: pinned.rootReal,
                        relativeParentPath: pinned.relativeParentPath,
                        basename: pinned.basename,
                        mkdir: params.mkdir !== false,
                        mode: pinned.mode,
                        overwrite: params.overwrite !== false,
                        rejectFinalSymlink: params.mutationSymlinks !== undefined,
                        maxBytes: params.maxBytes,
                        sync: params.durable !== false,
                        assertBeforeMutation: params.signal || params.assertBeforeMutation ? () => {
                            if (params.signal?.aborted)
                                throw new MutationAuthorityError(params.signal.reason);
                            params.assertBeforeMutation?.();
                        } : undefined,
                        verifyPublished: params.verifyPublished,
                        onPublished: observer.onPublished,
                        input: { kind: "file", handle: source.handle, size: source.stat.size, clone, signal: params.signal, verifySource },
                        rootIdentity: root.rootIdentity,
                        mutationAdmission: pinned.mutationAdmission,
                    });
                }
                catch (error) {
                    observer.rethrowObserverFailure(error);
                    if (params.signal?.aborted && error === params.signal.reason)
                        throw error;
                    if (isAlreadyExistsError(error)) {
                        throw new FsSafeError("already-exists", "copy destination already exists", { cause: error });
                    }
                    throw normalizePinnedWriteError(error);
                }
                await verifySource();
            });
        });
    }
    finally {
        await source.handle.close().catch(() => { });
    }
}
async function resolvePinnedPathInRoot(root, params) {
    const resolved = await resolvePinnedRootPathInRoot(root, {
        relativePath: params.relativePath,
        policy: params.remove ? PATH_ALIAS_POLICIES.unlinkTarget : PATH_ALIAS_POLICIES.strict,
        mutationSymlinks: params.mutationSymlinks,
        removalReceipts: params.removalReceipts,
    });
    const relativeResolved = path.relative(resolved.rootReal, resolved.canonicalPath);
    if ((relativeResolved === "" || relativeResolved === ".") && params.allowRoot === true) {
        await assertMutationNotDenied(resolved.canonicalPath, params.denyMutations);
        return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix: "" };
    }
    const firstSegment = relativeResolved.split(path.sep)[0];
    if (relativeResolved === "" ||
        relativeResolved === "." ||
        firstSegment === ".." ||
        path.isAbsolute(relativeResolved)) {
        throw outsideWorkspaceError();
    }
    const relativePosix = relativeResolved.split(path.sep).join(path.posix.sep);
    const admittedCanonicalPath = admitPathInsideRoot({
        rootPath: resolved.rootReal,
        candidatePath: resolved.canonicalPath,
        rootIdentity: root.rootIdentity,
    });
    if (!admittedCanonicalPath) {
        throw outsideWorkspaceError();
    }
    resolved.canonicalPath = admittedCanonicalPath.path;
    await assertMutationNotDenied(resolved.canonicalPath, params.denyMutations, {
        protectAncestors: params.remove === true,
    });
    return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix };
}
async function resolvePinnedRootPathInRoot(root, params) {
    await assertRootIdentityCurrent(root, params.removalReceipts?.observeRoot);
    const rootReal = root.rootReal;
    let resolved;
    try {
        const expandedPath = await expandRelativePathWithHome(params.relativePath);
        const resolution = {
            absolutePath: path.isAbsolute(expandedPath)
                ? expandedPath
                : `${ensureTrailingSep(rootReal)}${expandedPath}`,
            rootPath: rootReal,
            rootCanonicalPath: rootReal,
            rootIdentity: root.rootIdentity,
            boundaryLabel: "root",
            policy: params.policy,
            ...mutationSymlinkResolution(params.mutationSymlinks),
        };
        resolved = await (params.removalReceipts ? resolveRootPathForRemoval(resolution, params.removalReceipts) : resolveRootPath(resolution));
    }
    catch (err) {
        if (err instanceof FsSafeError && err.code === "symlink")
            throw err;
        throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
    }
    return {
        rootReal: resolved.rootCanonicalPath,
        canonicalPath: resolved.canonicalPath,
    };
}
async function statPathFallback(root, relativePath) {
    const initialObservationHook = getFsSafeTestHooks()?.beforeRootStatInitialObservation;
    const resolved = initialObservationHook
        ? await resolvePinnedPathInRoot(root, { relativePath, allowRoot: true })
        : await resolvePinnedObservedPathInRoot(root, relativePath, "stat");
    return await statResolvedPathInRoot(root, resolved.resolved, resolved.receipt);
}
async function listPathFallback(root, relativePath, withFileTypes) {
    const resolved = await resolvePinnedObservedPathInRoot(root, relativePath, "directory");
    return await listDirectoryPath(root, resolved.resolved, withFileTypes, resolved.receipt);
}
async function movePathFallback(root, params) {
    const originalRoutes = params.overwrite && params.assertBeforeMutation
        ? await Promise.all([params.fromRelative, params.toRelative].map(expandRelativePathWithHome)) : undefined;
    const source = await resolvePathInRoot(root, params.fromRelative, {
        aliasErrorCode: "path-alias",
        allowFinalSymlink: true,
        ...mutationSymlinkResolution(params.mutationSymlinks),
    });
    await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
    const pinnedSource = await resolvePinnedRootPathInRoot(root, {
        relativePath: params.fromRelative,
        policy: PATH_ALIAS_POLICIES.strict,
        mutationSymlinks: params.mutationSymlinks,
    });
    let pinnedTarget;
    const target = await resolveGuardedWritePathInRoot(root, {
        relativePath: params.toRelative,
        denyMutations: params.denyMutations,
        mutationSymlinks: params.mutationSymlinks,
        allowFinalSymlink: true,
        protectDeniedAncestors: true,
        shouldAssertNoPathAlias: async (resolvedTarget) => {
            pinnedTarget = await resolvePinnedRootPathInRoot(root, {
                relativePath: params.toRelative,
                policy: PATH_ALIAS_POLICIES.unlinkTarget,
            });
            if (!params.overwrite)
                return true;
            let targetStat;
            try {
                targetStat = fsSync.lstatSync(resolvedTarget.resolved);
            }
            catch { /* Advisory lookup. */ }
            return !(process.platform !== "win32" &&
                params.overwrite &&
                targetStat?.isSymbolicLink() === true);
        },
    });
    let sourceIdentity;
    try {
        if (params.overwrite && params.assertBeforeMutation) {
            sourceIdentity = inspectFileIdentitySync(() => admitMoveSourceStat(fsSync.lstatSync(source.resolved, { bigint: true })));
        }
        else {
            admitMoveSourceStat(fsSync.lstatSync(source.resolved));
        }
    }
    catch (error) {
        if (isNotFoundPathError(error)) {
            throw fileNotFoundError(error instanceof Error ? error : undefined);
        }
        throw error;
    }
    if (!pinnedTarget) {
        throw new FsSafeError("path-mismatch", "destination admission was not completed");
    }
    const nativeReplace = params.overwrite && params.requireNative
        ? getNativeBinding()?.renameReplaceWithIdentity : undefined;
    if (params.overwrite && !nativeReplace && params.requireNative) {
        throw new FsSafeError("helper-unavailable", "native overwrite move is unavailable");
    }
    if (!params.overwrite || nativeReplace) {
        await movePathNative(root, params, {
            sourcePath: source.resolved,
            sourceParentPath: path.dirname(pinnedSource.canonicalPath),
            targetPath: target.resolved,
            targetParentPath: path.dirname(pinnedTarget.canonicalPath),
            sourceOriginalPath: originalRoutes?.[0],
            targetOriginalPath: originalRoutes?.[1],
            sourceCanonicalPath: pinnedSource.canonicalPath,
            targetCanonicalPath: pinnedTarget.canonicalPath,
            expectedSourceIdentity: sourceIdentity,
        }, params.overwrite);
        return;
    }
    const guardOptions = { bigint: sourceIdentity !== undefined };
    const sourceParentGuard = await createAsyncDirectoryGuard(path.dirname(source.resolved), guardOptions);
    const targetParentGuard = await createNearestExistingDirectoryGuard(target.rootReal, path.dirname(target.resolved), guardOptions);
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", target.resolved);
    await assertAsyncDirectoryGuard(sourceParentGuard);
    await assertAsyncDirectoryGuard(targetParentGuard);
    try {
        assertFinalSymlinkRejected(source.resolved, params.mutationSymlinks !== undefined);
        assertFinalSymlinkRejected(target.resolved, params.mutationSymlinks !== undefined);
        params.assertBeforeMutation?.();
        if (sourceIdentity) {
            assertRootIdentityCurrentSync(root);
            assertSyncDirectoryGuard(sourceParentGuard);
            assertSyncDirectoryGuard(targetParentGuard);
            for (const [route, selected, expected, policy] of [
                [originalRoutes[0], source.resolved, pinnedSource.canonicalPath, PATH_ALIAS_POLICIES.strict],
                [originalRoutes[1], target.resolved, pinnedTarget.canonicalPath, PATH_ALIAS_POLICIES.unlinkTarget],
            ]) {
                for (const absolutePath of new Set([path.isAbsolute(route) ? route : `${root.rootWithSep}${route}`, selected])) {
                    try {
                        const current = resolveRootPathSync({
                            absolutePath, rootPath: root.rootReal, rootCanonicalPath: root.rootReal,
                            rootIdentity: root.rootIdentity, boundaryLabel: "root", policy,
                            ...mutationSymlinkResolution(params.mutationSymlinks),
                        });
                        if (current.canonicalPath !== expected)
                            throw new FsSafeError("path-mismatch", "move route changed during authorization");
                    }
                    catch (error) {
                        throw normalizePinnedPathError(error);
                    }
                }
            }
            inspectFileIdentitySync(() => admitMoveSourceStat(fsSync.lstatSync(source.resolved, { bigint: true })), sourceIdentity);
        }
        await fs.rename(source.resolved, target.resolved);
    }
    catch (error) {
        if (isNotFoundPathError(error)) {
            throw fileNotFoundError(error instanceof Error ? error : undefined);
        }
        if (hasNodeErrorCode(error, "EEXIST")) {
            throw new FsSafeError("already-exists", "destination exists", errorCauseOptions(error));
        }
        throw error;
    }
    try {
        await assertAsyncDirectoryGuard(sourceParentGuard);
        await assertAsyncDirectoryGuard(targetParentGuard);
    }
    catch (error) {
        throw normalizePinnedPathError(error);
    }
}
async function writeFileFallback(root, params) {
    if (params.renameIdentity !== "verify-content-with-lock")
        return await writeFileFallbackUnlocked(root, params);
    const policy = snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks);
    if (policy)
        params = { ...params, ...policy };
    const { rootReal, resolved } = await resolveGuardedWritePathInRoot(root, {
        relativePath: params.relativePath,
        denyMutations: params.denyMutations,
        mutationSymlinks: params.mutationSymlinks,
    });
    await withRootFallbackCompatibilityLock({
        rootPath: rootReal, rootIdentity: root.rootIdentity, targetPath: resolved, assertBeforeMutation: params.assertBeforeMutation,
    }, async ({ targetPath, ...binding }) => await writeFileFallbackUnlocked(root, { ...params, ...binding }, targetPath));
}
async function writeFileFallbackUnlocked(root, params, expectedWritePath) {
    if (params.overwrite === false) {
        await writeMissingFileFallback(root, params, expectedWritePath);
        return;
    }
    const admissionParams = {
        relativePath: params.relativePath,
        mkdir: params.mkdir,
        denyMutations: params.denyMutations,
        assertBeforeMutation: params.assertBeforeMutation,
        mutationSymlinks: params.mutationSymlinks,
        truncateExisting: false,
        expectedWritePath,
    };
    const admission = await openWritableFileInRoot(root, admissionParams, { createIfMissing: false });
    const existing = "missing" in admission ? undefined : admission;
    const target = existing?.opened;
    const retainedSelection = existing?.writeSelection;
    const missingSelection = "missing" in admission ? admission.writeSelection : undefined;
    const policyEnabled = params.denyMutations !== undefined || params.mutationSymlinks !== undefined;
    const destinationPath = "missing" in admission ? admission.targetPath
        : retainedSelection?.selectedPath ?? admission.opened.realPath;
    let mode = params.mode ?? (target ? target.stat.mode & 0o777 : undefined);
    if (policyEnabled && !retainedSelection && !missingSelection) {
        await target?.handle.close().catch(() => undefined);
        throw new FsSafeError("path-mismatch", "write admission state was not retained");
    }
    const destinationGuard = "missing" in admission ? admission.parentGuard : retainedSelection?.parentGuard ??
        await createAsyncDirectoryGuard(path.dirname(destinationPath), { bigint: true }).catch(async (error) => {
            await target?.handle.close().catch(() => undefined);
            throw error;
        });
    let tempPath = null;
    let unregisterTempPath = null;
    let writtenHandle;
    let writtenIdentity;
    let lateTargetHandle;
    try {
        tempPath = buildAtomicWriteTempPath(destinationPath);
        if (retainedSelection) {
            await refreshRetainedRootWriteAdmission(root, retainedSelection, target?.handle.fd);
        }
        else if (missingSelection) {
            await refreshRootWritePathSelection(missingSelection);
        }
        params.assertBeforeMutation?.();
        if (retainedSelection) {
            assertRootWriteSelectionSync(root, retainedSelection, target?.handle.fd);
        }
        else if (missingSelection) {
            assertRootWritePathSelectionSync(root, missingSelection);
        }
        assertRootIdentityCurrentSync(root);
        assertSyncDirectoryGuard(destinationGuard);
        assertExclusiveCreateLeaf(tempPath);
        writtenHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, 0o600);
        writtenIdentity = fsSync.fstatSync(writtenHandle.fd, { bigint: true });
        // Preserve the creation mask when no existing destination supplies a mode.
        mode ??= Number(writtenIdentity.mode & 511n);
        unregisterTempPath = registerTempPathForExit(tempPath, { identity: writtenIdentity, singleLinkFile: true });
        await writeAllToFile(writtenHandle, params.data, {
            encoding: params.encoding, assertBeforeMutation: params.assertBeforeMutation,
        });
        if (params.durable !== false)
            await writtenHandle.sync();
        const commitTempPath = tempPath;
        const commitHandle = writtenHandle;
        const commitIdentity = writtenIdentity;
        await withAsyncDirectoryGuards([destinationGuard], async () => {
            await verifyAtomicWriteResult({
                root, targetPath: commitTempPath, fd: commitHandle.fd,
                expectedIdentity: commitIdentity, parentGuard: destinationGuard,
            });
            assertRootIdentityCurrentSync(root);
            assertSyncDirectoryGuard(destinationGuard);
            let publicationIdentity = inspectFallbackReplacementDestination(destinationPath);
            // A raced file needs its own access admission, not the old handle's rights.
            if (publicationIdentity && (!existing || !sameFileIdentity(publicationIdentity, existing.identity))) {
                const admitted = await openWritableFileInRoot(root, {
                    ...admissionParams, mkdir: false, expectedWritePath: destinationPath,
                }, { createIfMissing: false });
                lateTargetHandle = "missing" in admitted ? undefined : admitted.opened.handle;
                publicationIdentity = "missing" in admitted ? undefined : admitted.identity;
                await lateTargetHandle?.close();
            }
            // Windows cannot replace a destination while its old handle remains open.
            await target?.handle.close();
            if (retainedSelection) {
                await refreshRetainedRootWriteAdmission(root, retainedSelection);
            }
            else if (missingSelection) {
                await refreshRootWritePathSelection(missingSelection);
            }
            assertFinalSymlinkRejected(destinationPath, params.mutationSymlinks !== undefined);
            params.assertBeforeMutation?.();
            if (retainedSelection) {
                assertRootWriteSelectionSync(root, retainedSelection);
            }
            else if (missingSelection) {
                assertRootWritePathSelectionSync(root, missingSelection);
            }
            assertRootIdentityCurrentSync(root);
            assertSyncDirectoryGuard(destinationGuard);
            const current = inspectFallbackReplacementDestination(destinationPath);
            if (publicationIdentity ? !current || !sameFileIdentity(current, publicationIdentity) : current) {
                throw new FsSafeError("path-mismatch", "write destination changed before publication");
            }
            await fs.rename(commitTempPath, destinationPath);
            tempPath = null;
        });
        unregisterTempPath();
        unregisterTempPath = null;
        await finishRootFallbackWrite({
            root, targetPath: destinationPath, handle: writtenHandle, identity: writtenIdentity,
            parentGuard: destinationGuard, mode, options: params,
            // Read/write access is needed to sync the accepted destination on Windows.
            openForCompatibility: () => openVerifiedLocalFile(destinationPath, { hardlinks: "reject", readWrite: true }),
            onVerificationFailure: err => emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`),
        });
    }
    finally {
        await target?.handle.close().catch(() => undefined);
        await lateTargetHandle?.close().catch(() => undefined);
        if (tempPath && writtenHandle) {
            await cleanupPinnedFilePath({
                pathname: tempPath, handle: writtenHandle, identity: writtenIdentity, parentGuard: destinationGuard,
            });
        }
        await writtenHandle?.close().catch(() => undefined);
        unregisterTempPath?.();
    }
}
function inspectFallbackReplacementDestination(targetPath) {
    let current;
    try {
        current = inspectFileIdentitySync(() => fsSync.lstatSync(targetPath, { bigint: true }));
    }
    catch (error) {
        if (isNotFoundPathError(error))
            return;
        throw error;
    }
    if (current.isSymbolicLink() || !current.isFile()) {
        throw new FsSafeError("path-mismatch", "write destination changed before publication");
    }
    if (current.nlink > 1n)
        throw hardlinkedPathNotAllowedError();
    return current;
}
async function writeMissingFileFallback(root, params, expectedWritePath) {
    const guardedTarget = params.denyMutations === undefined && params.mutationSymlinks === undefined
        ? undefined
        : await resolveGuardedWriteTargetInRoot(root, {
            relativePath: params.relativePath,
            denyMutations: params.denyMutations,
            mutationSymlinks: params.mutationSymlinks,
        });
    const { resolved } = guardedTarget?.resolvedPath ?? await resolveGuardedWritePathInRoot(root, {
        relativePath: params.relativePath,
    });
    const prepared = guardedTarget ? await prepareSharedRootWriteTarget(root, {
        relativePath: params.relativePath, guardedTarget, mkdir: params.mkdir,
        assertBeforeMutation: params.assertBeforeMutation,
    }) : undefined;
    const mutationAdmission = prepared?.mutationAdmission;
    const preparedParent = prepared?.preparedParent;
    const targetPath = prepared?.targetPath ?? (params.mkdir === false ? resolved :
        await prepareRootWriteTarget(root, resolved, params.assertBeforeMutation));
    assertRootFallbackWritePath(expectedWritePath, targetPath);
    const pathSelection = guardedTarget
        ? await prepareGuardedRootWritePathSelection(guardedTarget, targetPath, targetPath, preparedParent)
        : undefined;
    const parentGuard = pathSelection?.parentGuard ??
        await createAsyncDirectoryGuard(path.dirname(targetPath), { bigint: true });
    let created = false;
    let completed = false;
    let createdIdentity;
    let writtenHandle;
    let verifyingPublication = false;
    try {
        const { handle, writtenStat } = await withAsyncDirectoryGuards([parentGuard], async () => {
            assertFinalSymlinkRejected(targetPath, params.mutationSymlinks !== undefined);
            params.assertBeforeMutation?.();
            if (mutationAdmission)
                assertSyncDirectoryGuard(parentGuard);
            assertExclusiveCreateLeaf(targetPath);
            const handle = await fs.open(targetPath, OPEN_WRITE_CREATE_FLAGS, params.mode ?? 0o600).catch((error) => recordExclusiveCreateFailure(error, targetPath));
            writtenHandle = handle;
            created = true;
            const writtenStat = fsSync.fstatSync(handle.fd, { bigint: true });
            createdIdentity = writtenStat;
            await writeAllToFile(handle, params.data, {
                encoding: params.encoding,
                assertBeforeMutation: () => {
                    assertFinalSymlinkRejected(targetPath, params.mutationSymlinks !== undefined);
                    params.assertBeforeMutation?.();
                    if (mutationAdmission)
                        assertSyncDirectoryGuard(parentGuard);
                },
            });
            if (params.durable !== false)
                await handle.sync();
            return { handle, writtenStat };
        }, {
            onPostGuardFailure: () => {
                created = false; // Parent is untrusted now; skip outer path cleanup by name.
            },
        });
        writtenHandle = handle;
        created = false;
        verifyingPublication = true;
        await verifyAtomicWriteResult({
            root,
            targetPath,
            expectedIdentity: writtenStat,
            fd: handle.fd,
            parentGuard,
        });
        if (params.durable !== false)
            await syncDirectoryBestEffort(path.dirname(targetPath));
        completed = true;
    }
    catch (err) {
        if (verifyingPublication)
            throw err;
        if (hasNodeErrorCode(err, "EEXIST")) {
            throw new FsSafeError("already-exists", "file already exists", errorCauseOptions(err));
        }
        throw err;
    }
    finally {
        if (created && writtenHandle) {
            await cleanupPinnedFilePath({
                pathname: targetPath, handle: writtenHandle, identity: createdIdentity, parentGuard,
            });
        }
        if (completed)
            await writtenHandle?.close();
        else
            await writtenHandle?.close().catch(() => undefined);
    }
}
