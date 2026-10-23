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
import { inspectDirectoryIdentity, inspectDirectoryIdentitySync, } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { captureNativeFdClose } from "./native-binding.js";
import { NativePolicyDirectoryMismatch } from "./native-policy-directory-observation.js";
import { assertWindowsPolicyParentCurrent, closeWindowsPolicyParentAfterFailure, openWindowsPolicyParent, windowsParentObservation, } from "./native-policy-parent-windows.js";
import { assertPolicyStagedDirectoryCurrent, assertStagedDirectoryCurrent, describePolicyStagedDirectory, describeStagedDirectory, refreshPolicyStagedDirectoryObservation, } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { realpathSync } from "./realpath.js";
import { errorCauseOptions } from "./root-errors.js";
import { isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import { checkedMutationDirectory, } from "./pinned-mutation-observation.js";
import { createPathSegmentRoute, joinPathSegmentRoute, sameAbsolutePath } from "./path-segment-route.js";
import { canReuseParentWithMutationAssertion } from "./root-write-lock-binding.js";
function mkdirPosixPolicyChild(binding, parentFd, basename) {
    if (!basename || basename === "." || basename === ".." || basename.includes("/") ||
        basename.includes("\0") || (process.platform === "win32" && basename.includes("\\"))) {
        throw new FsSafeError("invalid-path", "native parent creation requires one direct-child basename");
    }
    const mkdirChild = binding.mkdirChildBeneath;
    if (typeof mkdirChild === "function") {
        const created = mkdirChild.call(binding, parentFd, basename, 0o777);
        if (typeof created === "boolean")
            return created;
    }
    binding.mkdirBeneath(parentFd, basename, 0o777);
    return false;
}
function normalizePosixParentOpenError(error, params) {
    if (!isSymlinkOpenError(error))
        return error;
    return params.mutationAdmission?.rejectParentSymlinks
        ? new FsSafeError("symlink", "symlink path component not allowed", errorCauseOptions(error))
        : new FsSafeError("path-mismatch", "native write parent changed during policy admission", errorCauseOptions(error));
}
async function describePosixParent(fd, pathname) {
    const parentPath = realpathSync.native(pathname);
    const stagedDirectory = describeStagedDirectory(fd, parentPath);
    const stat = await inspectDirectoryIdentity(parentPath, stagedDirectory.identity);
    return {
        fd,
        guard: { dir: parentPath, realPath: parentPath, stat },
        stagedDirectory,
        observation: checkedMutationDirectory(parentPath, stagedDirectory.realPath, stat),
    };
}
function tryDescribePolicyPosixParent(binding, fd, pathname) {
    try {
        const policyDirectory = describePolicyStagedDirectory(fd, pathname, binding);
        return {
            fd,
            guard: {
                dir: policyDirectory.directory.realPath,
                realPath: policyDirectory.directory.realPath,
                stat: policyDirectory.stat,
            },
            stagedDirectory: policyDirectory.directory,
            observation: policyDirectory.observation,
            policyDirectory,
        };
    }
    catch (error) {
        if (!(error instanceof FsSafeError) || error instanceof NativePolicyDirectoryMismatch ||
            (error.code !== "path-mismatch" && error.code !== "not-file"))
            throw error;
        return undefined;
    }
}
export async function capturePolicyAwareNativeParent(binding, params, rootAdmission, windows, directoryFlags, fuseChildCreation = false) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const rootFd = rootAdmission.root.fd;
        const closeFd = captureNativeFdClose(binding);
        const observationDisposers = windows ? undefined : new Map();
        const disposeObservation = (fd) => {
            const dispose = observationDisposers?.get(fd);
            observationDisposers?.delete(fd);
            dispose?.();
        };
        const observationScope = __addDisposableResource(env_1, {
            [Symbol.dispose]() { for (const dispose of observationDisposers?.values() ?? [])
                dispose(); },
        }, false);
        const capturePolicyParent = (fd, pathname) => {
            const captured = tryDescribePolicyPosixParent(binding, fd, pathname);
            const dispose = captured?.policyDirectory?.disposeObservation;
            if (dispose)
                observationDisposers.set(fd, dispose);
            return captured;
        };
        const assertCurrent = (parent) => windows
            ? assertWindowsPolicyParentCurrent(parent)
            : parent.policyDirectory
                ? assertPolicyStagedDirectoryCurrent(parent.policyDirectory)
                : assertStagedDirectoryCurrent(parent.stagedDirectory);
        const closeAfterFailure = (fd, failure) => {
            disposeObservation(fd);
            if (windows)
                closeWindowsPolicyParentAfterFailure(closeFd, fd, failure, rootAdmission.reportCloseErrors);
            else
                closeFd(fd);
        };
        let session;
        async function authorize(request) {
            const frozen = Object.freeze(request);
            return await (session ? session.authorize(frozen) : windows
                ? params.mutationAdmission.authorize(frozen)
                : params.mutationAdmission?.authorize(frozen));
        }
        // POSIX begins its retained observation before the complete-parent open;
        // Windows starts a walk session only after that fast path misses.
        let segments = windows ? undefined : params.relativeParentPath.split("/").filter(Boolean);
        let route = segments && createPathSegmentRoute(segments);
        let initialTarget = route && joinPathSegmentRoute(params.rootPath, route, 0, params.basename);
        const parentSpelling = segments?.length ? path.join(params.rootPath, ...segments) : params.rootPath;
        let retainedTargetPath = windows ? undefined : params.mutationAdmission?.beginParentWalk?.();
        if (retainedTargetPath && !sameAbsolutePath(retainedTargetPath, initialTarget)) {
            retainedTargetPath = undefined;
        }
        let complete;
        let completeFd;
        try {
            if (windows) {
                complete = await openWindowsPolicyParent(binding, params, rootAdmission, rootFd, params.rootPath, params.relativeParentPath);
                completeFd = complete.fd;
            }
            else {
                completeFd = binding.openBeneath(rootFd, params.relativeParentPath, directoryFlags).fd;
            }
        }
        catch (error) {
            if (error?.code !== "ENOENT" || !params.mkdir) {
                if (windows)
                    throw error;
                await authorize({ targetPath: initialTarget, mutationPath: initialTarget, phase: "parent" });
                throw normalizePosixParentOpenError(error, params);
            }
        }
        if (completeFd !== undefined) {
            try {
                complete ??= retainedTargetPath ? capturePolicyParent(completeFd, parentSpelling) : undefined;
                if (!complete) {
                    retainedTargetPath = undefined;
                    complete = await describePosixParent(completeFd, parentSpelling);
                }
                const targetPath = path.join(complete.guard.realPath, params.basename);
                await authorize({ targetPath, mutationPath: targetPath, phase: "parent" });
                assertCurrent(complete);
                return complete;
            }
            catch (error) {
                closeAfterFailure(completeFd, { error });
                throw error;
            }
        }
        segments ??= params.relativeParentPath.split("/").filter(Boolean);
        route ??= createPathSegmentRoute(segments);
        let current;
        if (windows) {
            const rootStat = inspectDirectoryIdentitySync(params.rootPath, inspectFileIdentitySync(() => fsSync.fstatSync(rootFd, { bigint: true })));
            const guard = { dir: params.rootPath, realPath: params.rootPath, stat: rootStat };
            current = { fd: rootFd, guard, observation: windowsParentObservation(binding, rootFd, guard) };
        }
        else {
            const captured = retainedTargetPath ? capturePolicyParent(rootFd, params.rootPath) : undefined;
            if (!captured)
                retainedTargetPath = undefined;
            current = captured ?? await describePosixParent(rootFd, params.rootPath);
        }
        let ownedFd;
        let currentPath = params.rootPath;
        let failure;
        initialTarget ??= joinPathSegmentRoute(params.rootPath, route, 0, params.basename);
        if (windows && canReuseParentWithMutationAssertion(params.assertBeforeMutation, params.rootPath, initialTarget)) {
            session = params.mutationAdmission?.beginNativeParentWalk?.() ?? params.mutationAdmission?.beginSharedParentWalk?.();
            if (session && session.retainedTargetPath !== initialTarget) {
                session.dispose();
                session = undefined;
            }
        }
        const secureDirectoryFlags = directoryFlags | (fsSync.constants.O_NOFOLLOW ?? 0);
        try {
            if (!windows) {
                const targetPath = retainedTargetPath ?? initialTarget;
                await authorize({ targetPath, mutationPath: targetPath, phase: "parent" });
                assertCurrent(current);
            }
            for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index];
                let childPath = windows ? undefined : path.join(currentPath, segment);
                let child;
                let childFd;
                let createdByMkdir = false;
                let createReceipt;
                try {
                    if (windows) {
                        child = await openWindowsPolicyParent(binding, params, rootAdmission, current.fd, currentPath, segment);
                        childFd = child.fd;
                    }
                    else {
                        childFd = binding.openBeneath(current.fd, segment, secureDirectoryFlags).fd;
                    }
                }
                catch (error) {
                    const missing = windows
                        ? error?.code === "ENOENT"
                        : isNotFoundPathError(error);
                    if (!missing)
                        throw windows ? error : normalizePosixParentOpenError(error, params);
                    const targetPath = (windows ? session?.retainedTargetPath : retainedTargetPath) ??
                        joinPathSegmentRoute(currentPath, route, index, params.basename);
                    childPath ??= path.join(currentPath, segment);
                    const request = Object.freeze({
                        targetPath, mutationPath: childPath, phase: "parent-create",
                    });
                    createReceipt = windows
                        ? session?.tryAuthorizeAtParent(request, current.observation)
                        : params.mutationAdmission?.tryAuthorizeAtParent?.(request, current.observation);
                    if (!createReceipt) {
                        createReceipt = await authorize(windows ? { ...request } : request);
                        assertCurrent(current);
                    }
                    // POSIX always refreshes here; Windows refreshes only after a live callback.
                    if (windows) {
                        if (params.assertBeforeMutation) {
                            params.assertBeforeMutation();
                            assertCurrent(current);
                        }
                    }
                    else {
                        params.assertBeforeMutation?.();
                        assertCurrent(current);
                    }
                    if (windows) {
                        const mkdirChild = binding.mkdirChildBeneath;
                        if (typeof mkdirChild !== "function") {
                            throw new FsSafeError("helper-unavailable", "native direct-child parent creation is unavailable");
                        }
                        createdByMkdir = mkdirChild.call(binding, current.fd, segment, 0o777) === true;
                        child = await openWindowsPolicyParent(binding, params, rootAdmission, current.fd, currentPath, segment);
                        childFd = child.fd;
                    }
                    else {
                        if (fuseChildCreation && binding.mkdirOpenChildBeneath) {
                            try {
                                const child = binding.mkdirOpenChildBeneath(current.fd, segment, 0o777, secureDirectoryFlags);
                                childFd = child.fd;
                                createdByMkdir = child.created;
                            }
                            catch (error) {
                                throw normalizePosixParentOpenError(error, params);
                            }
                        }
                        else {
                            createdByMkdir = mkdirPosixPolicyChild(binding, current.fd, segment);
                            try {
                                childFd = binding.openBeneath(current.fd, segment, secureDirectoryFlags).fd;
                            }
                            catch (error) {
                                throw normalizePosixParentOpenError(error, params);
                            }
                        }
                    }
                }
                try {
                    if (!child) {
                        child = retainedTargetPath ? capturePolicyParent(childFd, childPath) : undefined;
                        if (!child) {
                            retainedTargetPath = undefined;
                            child = await describePosixParent(childFd, childPath);
                        }
                        if (!sameAbsolutePath(child.guard.realPath, childPath))
                            retainedTargetPath = undefined;
                    }
                    const windowsTarget = windows
                        ? joinPathSegmentRoute(child.guard.realPath, route, index + 1, params.basename)
                        : undefined;
                    if (session && windowsTarget !== session.retainedTargetPath) {
                        session.dispose();
                        session = undefined;
                    }
                    let childAuthorization;
                    if (createdByMkdir && createReceipt &&
                        (windows ? session : params.mutationAdmission?.advanceCreatedDirectory)) {
                        let evidence;
                        try {
                            const parent = windows
                                ? windowsParentObservation(binding, current.fd, { ...current.guard,
                                    stat: inspectFileIdentitySync(() => fsSync.fstatSync(current.fd, { bigint: true }), current.guard.stat),
                                })
                                : current.policyDirectory
                                    ? refreshPolicyStagedDirectoryObservation(current.policyDirectory)
                                    : checkedMutationDirectory(currentPath, current.stagedDirectory.realPath, assertStagedDirectoryCurrent(current.stagedDirectory));
                            evidence = Object.freeze({
                                admission: createReceipt,
                                parent,
                                child: child.observation,
                            });
                        }
                        catch {
                            // Failed optional evidence falls back to the existing ordered admission.
                        }
                        if (evidence) {
                            childAuthorization = windows
                                ? session.advanceCreatedDirectory(evidence)
                                : params.mutationAdmission.advanceCreatedDirectory(evidence);
                        }
                    }
                    const targetPath = windowsTarget ?? retainedTargetPath ??
                        joinPathSegmentRoute(child.guard.realPath, route, index + 1, params.basename);
                    if (!windows || !childAuthorization) {
                        const request = {
                            targetPath, mutationPath: targetPath, phase: "parent",
                        };
                        if (!windows) {
                            Object.freeze(request);
                            // Existing prefixes are not the epoch's nearest parent. Their
                            // admission uses the full epoch fence below; offering an unrelated
                            // parent receipt would discard otherwise-current target evidence.
                            if (createdByMkdir) {
                                childAuthorization ??= params.mutationAdmission?.tryAuthorizeAtParent?.(request, child.observation);
                            }
                        }
                        if (!childAuthorization) {
                            await authorize(request);
                            assertCurrent(child);
                        }
                    }
                }
                catch (error) {
                    closeAfterFailure(childFd, { error });
                    throw error;
                }
                const previousFd = ownedFd;
                disposeObservation(current.fd);
                current = child;
                ownedFd = child.fd;
                currentPath = child.guard.realPath;
                if (previousFd !== undefined)
                    closeFd(previousFd);
            }
            if (ownedFd === undefined) {
                throw new FsSafeError("path-mismatch", "native write parent admission did not complete");
            }
            ownedFd = undefined;
            return current;
        }
        catch (error) {
            failure = { error };
            throw error;
        }
        finally {
            session?.dispose();
            if (ownedFd !== undefined)
                closeAfterFailure(ownedFd, failure);
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
