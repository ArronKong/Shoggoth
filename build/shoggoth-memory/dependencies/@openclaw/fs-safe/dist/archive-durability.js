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
import fsSync from "node:fs";
import path from "node:path";
import { ownExtractionDestinationMutation } from "./archive-deadline.js";
import { assertDirectoryIdentityGuard, assertResolvedInsideDestination, createArchiveSymlinkTraversalError, } from "./archive-staging.js";
import { pinNodeDirectoryForMode } from "./directory-mode-node.js";
import { pinDirectory, syncDirectory } from "./directory-durability.js";
import { syncFileBestEffort } from "./file-sync.js";
import { normalizePinnedWriteError } from "./root-errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { FsSafeError } from "./errors.js";
export async function finalizeArchivePublication(params) {
    const check = () => params.deadline?.check();
    const assertGuards = async (guards) => {
        for (const guard of [params.destinationGuard, ...guards, params.sourceGuard]) {
            await assertDirectoryIdentityGuard(guard);
            check();
        }
    };
    await ownExtractionDestinationMutation(params.deadline, async () => {
        if (params.durable) {
            // Join every active sync before propagating failure or starting another batch.
            for (let offset = 0; offset < params.files.length; offset += 8) {
                check();
                const results = await Promise.allSettled(params.files.slice(offset, offset + 8).map(async (file) => {
                    const env_1 = { stack: [], error: void 0, hasError: false };
                    try {
                        await assertGuards(file.guards);
                        const opened = __addDisposableResource(env_1, await params.targetRoot.open(`./${file.relativePath}`, { hardlinks: "reject", symlinks: "reject" })
                            .catch((error) => {
                            if (error instanceof FsSafeError && (error.code === "hardlink" || error.code === "path-alias")) {
                                throw createArchiveSymlinkTraversalError(file.relativePath);
                            }
                            throw error;
                        }), true);
                        check();
                        await inspectFileIdentity(() => fsSync.fstatSync(opened.handle.fd, { bigint: true }), file.identity);
                        check();
                        await syncFileBestEffort(opened.handle).catch((error) => { throw normalizePinnedWriteError(error); });
                        check();
                        await assertGuards(file.guards);
                        await inspectFileIdentity(async () => {
                            const stat = fsSync.lstatSync(opened.realPath, { bigint: true });
                            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n) {
                                throw new FsSafeError("path-mismatch", "archive file changed during durability pass");
                            }
                            return stat;
                        }, file.identity);
                        check();
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
                }));
                const failure = results.find((result) => result.status === "rejected");
                if (failure?.status === "rejected")
                    throw failure.reason;
            }
        }
        // Leave working modes intact until file syncing finishes. Re-pin one directory
        // at a time against its original guard, so wide archives do not exhaust fds.
        const directories = [...params.directories].sort((a, b) => b.guard.dir.split(path.sep).length - a.guard.dir.split(path.sep).length);
        for (const directory of directories) {
            const guards = [...directory.parents, directory.guard];
            await assertGuards(guards);
            const owner = await pinNodeDirectoryForMode(directory.guard.dir);
            let pinned;
            try {
                check();
                await assertGuards(guards);
                if (params.durable && process.platform !== "win32") {
                    // An existing search-only directory may become readable in its final mode.
                    try {
                        pinned = await pinDirectory(directory.guard.dir);
                    }
                    catch (error) {
                        if (error.code !== "EACCES")
                            throw error;
                    }
                    check();
                }
                await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("chmod", directory.guard.dir);
                check();
                await assertGuards(guards);
                await owner.apply(directory.mode, { check, beforeChmod: async () => {
                        await assertGuards(guards);
                        await assertResolvedInsideDestination({ destinationRealDir: params.destinationGuard.realPath,
                            targetPath: directory.guard.dir, originalPath: path.relative(params.targetRoot.rootDir, directory.guard.dir) });
                        check();
                    } });
                check();
                await assertGuards(guards);
                if (params.durable) {
                    if (process.platform === "win32") {
                        await syncDirectory(directory.guard.dir).catch((error) => { throw normalizePinnedWriteError(error); });
                    }
                    else {
                        pinned ??= await pinDirectory(directory.guard.dir);
                        check();
                        await pinned.sync().catch((error) => { throw normalizePinnedWriteError(error); });
                    }
                    check();
                    await assertGuards(guards);
                }
            }
            finally {
                try {
                    await pinned?.close();
                }
                finally {
                    await owner.close();
                }
            }
        }
        if (params.durable) {
            await assertGuards([]);
            await syncDirectory(params.destinationGuard.realPath).catch((error) => { throw normalizePinnedWriteError(error); });
            check();
            await assertGuards([]);
        }
    });
}
