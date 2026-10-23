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
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { assertSyncDirectoryGuard } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { assertDarwinCreationAcl, assertPrivateDirectory } from "./creation-boundary.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { openNativeRootAdmission } from "./native-parent-admission.js";
import { capturePolicyAwareNativeParent } from "./native-policy-parent.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { preparePinnedWriteMutationAdmission } from "./pinned-mutation-admission.js";
import { resolvePathViaExistingAncestor } from "./root-path-existing.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync } from "./root-context.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { createSuppressedError } from "./suppressed-error.js";
export function rootWriteQueueKey(root, relativePath) {
    return `${root.rootReal}\0${relativePath}`;
}
export function buildAtomicWriteTempPath(targetPath) {
    return path.join(path.dirname(targetPath), `.fs-safe-${randomUUID()}.tmp`);
}
function unavailable() {
    throw new FsSafeError("helper-unavailable", "native confined creation is unavailable");
}
async function withNativeDirectory(params, operation, discard) {
    const binding = getNativeBinding();
    if (!binding?.openBeneath || !binding.mkdirChildBeneath || (params.private && process.platform === "win32"))
        return unavailable();
    const directoryTarget = params.directory === params.target;
    const canonicalTarget = async (target) => directoryTarget
        ? await resolvePathViaExistingAncestor(target)
        : path.join(await resolvePathViaExistingAncestor(path.dirname(target)), path.basename(target));
    const resolveCurrent = params.resolveCurrent;
    params = { ...params,
        directory: await resolvePathViaExistingAncestor(params.directory),
        target: await canonicalTarget(params.target),
        resolveCurrent: async () => await canonicalTarget(await resolveCurrent()),
    };
    if (!isPathInside(params.root.rootReal, params.directory)) {
        throw new FsSafeError("outside-workspace", "creation parent is outside root");
    }
    const close = captureNativeFdClose(binding);
    let pending;
    try {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const admitted = await openNativeRootAdmission(binding, {
                rootPath: params.root.rootReal, rootIdentity: params.root.rootIdentity, operation: "create", reportCloseErrors: true, searchOnly: true,
            });
            const rootOwner = __addDisposableResource(env_1, admitted.root, true);
            const descriptors = [];
            const directoryOwner = __addDisposableResource(env_1, { [Symbol.dispose]() {
                    const errors = [];
                    for (const fd of descriptors.reverse())
                        try {
                            close(fd);
                        }
                        catch (error) {
                            errors.push(error);
                        }
                    if (errors.length)
                        throw new AggregateError(errors, "creation directory close failed");
                } }, false);
            const guards = [];
            function assertCurrent() {
                assertRootIdentityCurrentSync(params.root);
                for (const guard of guards)
                    assertSyncDirectoryGuard(guard);
            }
            async function authorize(mutation) {
                if (path.relative(params.target, await params.resolveCurrent()) !== "") {
                    throw new FsSafeError("path-mismatch", "creation route changed during admission");
                }
                await assertMutationNotDenied(params.target, params.policy?.denyMutations);
                await assertMutationNotDenied(mutation, params.policy?.denyMutations);
                assertCurrent();
            }
            let current = rootOwner.fd;
            let currentPath = params.root.rootReal;
            const flags = (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) |
                (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
            if (!params.private && !(directoryTarget && params.directory === params.root.rootReal)) {
                if (!admitPathInsideRoot({ rootPath: params.root.rootReal, candidatePath: params.target, rootIdentity: params.root.rootIdentity })) {
                    throw new FsSafeError("outside-workspace", "creation target is outside root");
                }
                const relativeParentPath = path.relative(params.root.rootReal, params.directory).split(path.sep).join("/");
                const prepared = await preparePinnedWriteMutationAdmission({
                    rootReal: params.root.rootReal, rootIdentity: params.root.rootIdentity,
                    resolvedTargetPath: params.target, defaultRelativeParentPath: relativeParentPath,
                    originalPath: params.originalPath, policy: params.policy ?? {},
                    resolveCurrent: async () => ({ resolved: await params.resolveCurrent() }),
                });
                const parent = await capturePolicyAwareNativeParent(binding, {
                    rootPath: params.root.rootReal, rootIdentity: params.root.rootIdentity,
                    relativeParentPath, basename: directoryTarget ? "" : path.basename(params.target),
                    mkdir: params.mkdir, mode: 0o600, input: { kind: "buffer", data: "" },
                    mutationAdmission: prepared.mutationAdmission, assertBeforeMutation: params.assertBeforeMutation,
                }, admitted, process.platform === "win32", flags, true);
                descriptors.push(parent.fd);
                guards.push(parent.guard);
                assertCurrent();
                pending = { value: await operation(binding, parent.fd, assertCurrent) };
                return pending.value;
            }
            for (const segment of path.relative(currentPath, params.directory).split(path.sep).filter(Boolean)) {
                const childPath = path.join(currentPath, segment);
                let child;
                let created = false;
                try {
                    child = binding.openBeneath(current, segment, flags).fd;
                }
                catch (error) {
                    if (!params.mkdir || !isNotFoundPathError(error))
                        throw error;
                    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", childPath);
                    await authorize(childPath);
                    if (params.private)
                        assertDarwinCreationAcl(current, "directory");
                    params.assertBeforeMutation?.();
                    assertCurrent();
                    if (binding.mkdirOpenChildBeneath) {
                        const opened = binding.mkdirOpenChildBeneath(current, segment, params.private ? 0o700 : 0o777, flags);
                        created = opened.created;
                        child = opened.fd;
                    }
                    else {
                        created = binding.mkdirChildBeneath(current, segment, params.private ? 0o700 : 0o777);
                        child = binding.openBeneath(current, segment, flags).fd;
                    }
                }
                descriptors.push(child);
                const stat = inspectFileIdentitySync(() => fs.fstatSync(child, { bigint: true }));
                if (!stat.isDirectory())
                    throw new FsSafeError("not-file", "creation parent is not a directory");
                guards.push({ dir: childPath, realPath: childPath, stat });
                assertCurrent();
                if (created && params.private)
                    await assertPrivateDirectory(childPath);
                current = child;
                currentPath = childPath;
            }
            await authorize(params.target);
            if (params.private) {
                await assertPrivateDirectory(currentPath);
                assertCurrent();
            }
            pending = { value: await operation(binding, current, assertCurrent) };
            return pending.value;
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
    catch (error) {
        if (pending && discard) {
            try {
                await discard(pending.value);
            }
            catch (cleanupError) {
                throw createSuppressedError(cleanupError, error, "creation handoff and cleanup failed");
            }
        }
        throw error;
    }
}
export async function tryMkdirRootNative(params) {
    // The protected Windows creator already verifies the admitted parent identity
    // and uses handle-relative NtCreateFile with its protected security descriptor.
    if (params.private && process.platform === "win32")
        return false;
    return await withNativeDirectory(params, async (_binding, _fd, assertCurrent) => { assertCurrent(); return true; });
}
export async function tryOpenCreateRootNative(params) {
    const binding = getNativeBinding();
    if (!binding?.removeStagedFile || !binding.openCreateBeneath)
        return unavailable();
    const access = (params.existingFlags & fs.constants.O_RDWR) ? 0o600 : 0o200;
    if (typeof params.mode !== "number")
        throw Object.assign(new TypeError("mode must be a number"), { code: "ERR_INVALID_ARG_TYPE" });
    if (!Number.isInteger(params.mode) || params.mode < 0 || params.mode > 0xffffffff) {
        throw Object.assign(new RangeError("mode must be an unsigned 32-bit integer"), { code: "ERR_OUT_OF_RANGE" });
    }
    const creationMode = () => {
        const mask = process.umask();
        const desired = params.mode & 0o7777 & ~mask;
        return (desired & access) === access ? desired : undefined;
    };
    // A public FileHandle reopen must not require widening creation permissions.
    if (creationMode() === undefined)
        return unavailable();
    return await withNativeDirectory(params, async (binding, parent, assertCurrent) => {
        const env_2 = { stack: [], error: void 0, hasError: false };
        try {
            params.assertBeforeMutation?.();
            assertCurrent();
            const mode = creationMode();
            if (mode === undefined)
                throw new FsSafeError("helper-unavailable", "native creation cannot preserve the requested permissions during handoff");
            // Native creation owns the only O_CREAT dispatch. The subsequent Node open
            // carries neither O_CREAT nor O_TRUNC and must match this retained inode.
            const close = captureNativeFdClose(binding);
            const fd = binding.openCreateBeneath(parent, path.basename(params.target), params.flags, params.mode & 0o7777);
            let rawOpen = true;
            const closeRaw = () => { if (rawOpen) {
                rawOpen = false;
                close(fd);
            } };
            const owner = __addDisposableResource(env_2, { [Symbol.dispose]: closeRaw }, false);
            try {
                const identity = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }));
                if (!identity.isFile() || identity.nlink !== 1n)
                    throw new FsSafeError("path-mismatch", "created file changed");
                // Keep the kernel's creation-time ACL and umask decisions. chmod here
                // could widen inherited ACL restrictions, even for ordinary mode bits.
                if (process.platform !== "win32" && (Number(identity.mode) & access) !== access) {
                    throw new FsSafeError("helper-unavailable", "created permissions do not permit a FileHandle handoff");
                }
                assertCurrent();
                const handle = await fsAsync.open(params.target, params.existingFlags);
                let validatedHandle = false;
                try {
                    inspectFileIdentitySync(() => fs.fstatSync(handle.fd, { bigint: true }), identity);
                    validatedHandle = true;
                    assertCurrent();
                    // Close failures still belong to this scope, before transferring either owner.
                    closeRaw();
                    // Empty relative paths duplicate the admitted descriptor without reopening its name.
                    const retainedParent = binding.openBeneath(parent, "", (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) | (fs.constants.O_DIRECTORY ?? 0)).fd;
                    let held = true;
                    return { handle, async cleanupCreated() {
                            if (!held)
                                return;
                            inspectFileIdentitySync(() => fs.fstatSync(handle.fd, { bigint: true }), identity);
                            binding.removeStagedFile(retainedParent, path.basename(params.target), handle.fd);
                        }, releaseCreationParent() {
                            if (!held)
                                return;
                            held = false;
                            close(retainedParent);
                        } };
                }
                catch (error) {
                    if (!rawOpen && validatedHandle) {
                        try {
                            binding.removeStagedFile(parent, path.basename(params.target), handle.fd);
                        }
                        catch { /* Preserve handoff failure. */ }
                    }
                    await handle.close();
                    throw error;
                }
            }
            catch (error) {
                if (rawOpen)
                    try {
                        binding.removeStagedFile(parent, path.basename(params.target), fd);
                    }
                    catch { /* Preserve the admission failure. */ }
                throw error;
            }
        }
        catch (e_2) {
            env_2.error = e_2;
            env_2.hasError = true;
        }
        finally {
            __disposeResources(env_2);
        }
    }, async (created) => {
        const env_3 = { stack: [], error: void 0, hasError: false };
        try {
            const handle = __addDisposableResource(env_3, created.handle, true);
            const parent = __addDisposableResource(env_3, { [Symbol.dispose]: created.releaseCreationParent }, false);
            await created.cleanupCreated();
        }
        catch (e_3) {
            env_3.error = e_3;
            env_3.hasError = true;
        }
        finally {
            const result_2 = __disposeResources(env_3);
            if (result_2)
                await result_2;
        }
    });
}
