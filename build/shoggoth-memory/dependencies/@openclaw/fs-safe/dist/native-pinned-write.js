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
import fsSync, {} from "node:fs";
import path from "node:path";
import { runPinnedWriteWindows } from "./native-pinned-write-windows.js";
import { capturePolicyAwareNativeParent } from "./native-policy-parent.js";
import { openNativeParentAdmission, openNativeRootAdmission } from "./native-parent-admission.js";
import { assertNativeStaging, writeNativeStage } from "./native-staged-file.js";
import { captureNativeFdClose } from "./native-binding.js";
import { cachedNoReplaceUnavailable } from "./native-noreplace.js";
import { isFsSafeNativeRequired } from "./native-config.js";
export async function runPinnedWriteNative(binding, params, fallback) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const closeFd = captureNativeFdClose(binding);
        const windows = process.platform === "win32";
        if (!windows) {
            assertNativeStaging(binding);
        }
        const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
        const completeCreate = params.overwrite === false && params.input.kind !== "file" && params.input.stageBeforePublish === true;
        const rootAdmission = await openNativeRootAdmission(binding, {
            rootPath: params.rootPath,
            rootIdentity: params.rootIdentity,
            operation: "native write",
            reportCloseErrors: completeCreate,
        });
        const root = rootAdmission.root;
        const posixRoot = __addDisposableResource(env_1, windows ? undefined : root, true);
        let parentFd;
        let windowsOwnsDirectories = false;
        let admissionFailure;
        // Until stage construction takes ownership, even admission failures must close
        // the raw POSIX parent. Disposal preserves both admission and close failures.
        const parentGuard = __addDisposableResource(env_1, {
            [Symbol.dispose]() {
                if (!windows && parentFd !== undefined) {
                    closeFd(parentFd);
                }
            },
        }, false);
        try {
            let parentPath;
            let directory;
            let parentPathStat;
            if (params.mutationAdmission) {
                const admitted = await capturePolicyAwareNativeParent(binding, params, rootAdmission, windows, directoryFlags);
                parentFd = admitted.fd;
                parentPath = admitted.guard.realPath;
                directory = admitted.stagedDirectory;
                parentPathStat = admitted.guard.stat;
            }
            else {
                if (params.mkdir) {
                    params.assertBeforeMutation?.();
                    binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
                }
                const admitted = await openNativeParentAdmission(binding, rootAdmission, params.relativeParentPath);
                parentFd = admitted.fd;
                parentPath = admitted.guard.realPath;
                directory = admitted.stagedDirectory;
                parentPathStat = admitted.guard.stat;
            }
            const verificationGuard = { dir: parentPath, realPath: parentPath, stat: parentPathStat };
            if (params.overwrite === false) {
                try {
                    fsSync.lstatSync(path.join(parentPath, params.basename));
                    throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
                }
                catch (error) {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                }
            }
            if (windows) {
                // The Windows leaf owns both directories after admission.
                windowsOwnsDirectories = true;
                return await runPinnedWriteWindows(binding, params, root, parentFd, verificationGuard);
            }
            if (params.overwrite === false && !(params.input.kind === "buffer" && params.input.stageBeforePublish === false)) {
                const unavailable = cachedNoReplaceUnavailable(binding, parentFd);
                if (unavailable) {
                    if (isFsSafeNativeRequired() || (params.input.kind === "file" && params.input.clone === "always"))
                        throw unavailable;
                    return await fallback(params.input);
                }
            }
            const ownedParent = parentFd;
            parentFd = undefined;
            return await writeNativeStage(binding, ownedParent, closeFd, directory, params, verificationGuard, fallback);
        }
        catch (error) {
            admissionFailure = { error };
            throw error;
        }
        finally {
            if (windows && !windowsOwnsDirectories) {
                const closeErrors = [];
                if (parentFd !== undefined) {
                    // Match the Windows leaf cleanup contract: an admission or identity
                    // failure remains primary, while every owned directory is still given
                    // a close attempt. In particular, a parent close failure must not skip
                    // the root FileHandle close.
                    try {
                        closeFd(parentFd);
                    }
                    catch (error) {
                        closeErrors.push(error);
                    }
                }
                try {
                    await root.close();
                }
                catch (error) {
                    closeErrors.push(error);
                }
                if (completeCreate && closeErrors.length > 0) {
                    throw new AggregateError([...(admissionFailure ? [admissionFailure.error] : []), ...closeErrors], "native create admission and close failed");
                }
            }
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
