import fs from "node:fs";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import { assertSyncDirectoryGuard } from "./directory-guard.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { getNativeBinding } from "./native.js";
import { openNativeParentAdmission, openNativeRootAdmission } from "./native-parent-admission.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { assertRootIdentityCurrentSync } from "./root-context.js";
import { normalizeRemoveGuardError, normalizeRemovePathError } from "./root-errors.js";
import { captureNonrecursiveRemovalAdmission, nonrecursiveRemovalKind } from "./root-remove.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
function unavailable() {
    throw new FsSafeError("helper-unavailable", "native confined removal is unavailable on this platform");
}
function normalize(error, details) {
    if (error instanceof FsSafeError || error instanceof MutationAuthorityError ||
        (error instanceof Error && error.name === "SuppressedError"))
        return error;
    const code = error?.code;
    if (code === "path-mismatch")
        return new FsSafeError("path-mismatch", "removal identity changed", { cause: error, details });
    if (["ENOTSUP", "ENOSYS", "EOPNOTSUPP"].includes(code ?? "")) {
        return new FsSafeError("helper-unavailable", "native confined removal is unavailable", { cause: error, details });
    }
    return normalizeRemovePathError(error, details);
}
export async function removePathInRootNative(root, target, options, receipts) {
    const binding = getNativeBinding();
    if (!binding?.rootRemovalStat || !binding.rootRemovalUnlink) {
        unavailable();
    }
    const inspect = binding.rootRemovalStat.bind(binding);
    const unlink = binding.rootRemovalUnlink.bind(binding);
    const openDirectory = binding.openRootRemovalDirectory?.bind(binding);
    const boundary = await captureNonrecursiveRemovalAdmission(root, target, options, receipts);
    if (!boundary)
        return;
    const rootAdmission = await openNativeRootAdmission(binding, {
        rootPath: root.rootReal, rootIdentity: root.rootIdentity, operation: "remove", reportCloseErrors: true, searchOnly: true,
    }).catch(error => { throw normalizeRemoveGuardError(error); });
    let parent;
    let initialEntry;
    let initialDirectory;
    let initialDirectoryAttempted = false;
    let operationError;
    let failed = false;
    try {
        const parentPath = path.dirname(target);
        if (!isPathInside(root.rootReal, parentPath))
            throw new FsSafeError("outside-workspace", "removal parent is outside root");
        try {
            parent = await openNativeParentAdmission(binding, rootAdmission, path.relative(root.rootReal, parentPath).split(path.sep).join("/"));
        }
        catch (error) {
            assertRootIdentityCurrentSync(root);
            boundary.assertCurrent();
            if (!(options.force && isNotFoundPathError(error)))
                throw error;
        }
        if (parent) {
            // Bind the native descriptor to the parent admitted before opening it;
            // an in-root redirect must not inherit another directory's approval.
            if (parent.guard.stat.dev !== boundary.parentIdentity.dev || parent.guard.stat.ino !== boundary.parentIdentity.ino) {
                throw new FsSafeError("path-mismatch", "removal parent identity changed");
            }
            if (options.recursive) {
                boundary.assertCurrent();
                try {
                    initialEntry = inspect(parent.fd, path.basename(target));
                }
                catch (error) {
                    boundary.assertCurrent();
                    if (!(options.force && isNotFoundPathError(error)))
                        throw error;
                }
                if (initialEntry?.directory) {
                    if (!openDirectory)
                        unavailable();
                    initialDirectoryAttempted = true;
                    try {
                        initialDirectory = openDirectory(parent.fd, path.basename(target), initialEntry.dev, initialEntry.ino);
                    }
                    catch (error) {
                        boundary.assertCurrent();
                        const code = error?.code;
                        if (["ENOTSUP", "ENOSYS", "EOPNOTSUPP"].includes(code ?? ""))
                            unavailable();
                        else if (!(options.force && isNotFoundPathError(error))) {
                            throw normalize(error, { operation: "remove", phase: "enumerate", relativePath: "" });
                        }
                    }
                }
            }
            if (!options.recursive || initialEntry)
                await removeEntries(parent);
        }
    }
    catch (error) {
        failed = true;
        operationError = error instanceof MutationAuthorityError ? error : normalize(error);
    }
    const closeErrors = [];
    try {
        initialDirectory?.close();
    }
    catch (error) {
        closeErrors.push(error);
    }
    try {
        parent?.close();
    }
    catch (error) {
        closeErrors.push(error);
    }
    try {
        await rootAdmission.root.close();
    }
    catch (error) {
        closeErrors.push(error);
    }
    if (closeErrors.length) {
        const error = closeErrors.length === 1 ? closeErrors[0] : new AggregateError(closeErrors, "removal descriptors could not close");
        if (failed)
            throw createSuppressedError(error, operationError instanceof MutationAuthorityError ? operationError.rejection : operationError, "removal and descriptor close failed");
        throw error;
    }
    if (failed)
        throw operationError;
    async function removeEntries(admitted) {
        // The admission already checks Root through the retained parent. This list
        // adds only traversal descendants, avoiding duplicate ancestry fences.
        const guards = [];
        const maxEntries = options.maxEntries ?? 100_000;
        const maxDepth = options.maxDepth ?? 64;
        let examined = 0;
        const details = (entryPath, phase) => ({
            operation: "remove", relativePath: path.relative(target, entryPath), phase,
        });
        async function beforeMutation(entryPath) {
            try {
                await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", entryPath);
            }
            catch (error) {
                throw normalizeRemoveGuardError(error);
            }
        }
        function assertNotAborted() {
            try {
                options.signal?.throwIfAborted();
            }
            catch (error) {
                throw new MutationAuthorityError(error);
            }
        }
        function assertTraversalCurrent() {
            for (const guard of guards) {
                try {
                    assertSyncDirectoryGuard(guard);
                }
                catch (cause) {
                    throw new FsSafeError("path-mismatch", "removal ancestor changed", { cause });
                }
            }
        }
        function assertCurrent() {
            assertNotAborted();
            boundary.assertCurrent();
            assertTraversalCurrent();
        }
        function observe(fd, name, entryPath, expected) {
            assertCurrent();
            try {
                const entry = inspect(fd, name);
                if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino || entry.directory !== expected.directory)) {
                    throw new FsSafeError("path-mismatch", "removal entry changed");
                }
                if (entry.symlink && options.mutationSymlinks !== undefined) {
                    throw new FsSafeError("symlink", "symlink not allowed", { details: details(entryPath, expected ? "remove" : "inspect") });
                }
                return entry;
            }
            catch (error) {
                if (options.force && isNotFoundPathError(error))
                    return undefined;
                throw normalize(error, details(entryPath, expected ? "remove" : "inspect"));
            }
        }
        async function visit(fd, name, entryPath, depth, counted = false) {
            assertNotAborted();
            if (options.recursive && ((!counted && examined >= maxEntries) || depth > maxDepth)) {
                throw new FsSafeError("too-large", "recursive removal budget exceeded", { details: details(entryPath, "inspect") });
            }
            if (!counted)
                examined++;
            if (!options.recursive)
                await beforeMutation(entryPath);
            await assertMutationNotDenied(entryPath, options.denyMutations, { protectAncestors: true });
            const initial = observe(fd, name, entryPath, depth === 0 ? initialEntry : undefined);
            if (!initial)
                return;
            if (!initial.directory && options[nonrecursiveRemovalKind] === "directory") {
                throw new FsSafeError("path-mismatch", "store entry is no longer a directory");
            }
            if (initial.directory && options.recursive) {
                let directory;
                try {
                    if (depth === 0 && initialDirectoryAttempted) {
                        directory = initialDirectory;
                        initialDirectory = undefined;
                    }
                    else
                        directory = openDirectory(fd, name, initial.dev, initial.ino);
                }
                catch (error) {
                    assertCurrent();
                    if (!(options.force && isNotFoundPathError(error)))
                        throw normalize(error, details(entryPath, "enumerate"));
                    if (!observe(fd, name, entryPath, initial))
                        return;
                }
                if (directory) {
                    let failure;
                    try {
                        const stat = fs.fstatSync(directory.fd, { bigint: true });
                        const read = () => {
                            try {
                                return directory.read();
                            }
                            catch (error) {
                                throw normalize(error, details(entryPath, "enumerate"));
                            }
                        };
                        guards.push({ dir: entryPath, realPath: entryPath, stat });
                        try {
                            assertCurrent();
                            if (options.order === "sorted") {
                                const names = [];
                                for (let child = read(); child !== null; child = read()) {
                                    await scheduler.yield();
                                    assertCurrent();
                                    if (examined >= maxEntries)
                                        throw new FsSafeError("too-large", "recursive removal budget exceeded", {
                                            details: details(path.join(entryPath, child), "enumerate"),
                                        });
                                    examined++;
                                    names.push(child);
                                }
                                for (const child of names.sort())
                                    await visit(directory.fd, child, path.join(entryPath, child), depth + 1, true);
                            }
                            else {
                                for (let child = read(); child !== null; child = read()) {
                                    await scheduler.yield();
                                    await visit(directory.fd, child, path.join(entryPath, child), depth + 1);
                                }
                            }
                        }
                        finally {
                            guards.pop();
                        }
                    }
                    catch (error) {
                        failure = { error: error instanceof MutationAuthorityError ? error.rejection : error };
                        throw error;
                    }
                    finally {
                        try {
                            directory.close();
                        }
                        catch (error) {
                            const closeError = normalize(error, details(entryPath, "enumerate"));
                            if (failure)
                                throw createSuppressedError(closeError, failure.error, "removal and directory close failed");
                            throw closeError;
                        }
                    }
                }
            }
            if (options.recursive) {
                await beforeMutation(entryPath);
                await assertMutationNotDenied(entryPath, options.denyMutations, { protectAncestors: true });
                if (!observe(fd, name, entryPath, initial))
                    return;
            }
            if (options.assertBeforeMutation) {
                options.assertBeforeMutation();
                if (!observe(fd, name, entryPath, initial))
                    return;
            }
            // No await separates the final admission from native identity-checked unlink.
            try {
                unlink(fd, name, initial.dev, initial.ino, initial.directory);
            }
            catch (error) {
                if (!(options.force && isNotFoundPathError(error)))
                    throw normalize(error, details(entryPath, "remove"));
            }
            if (options.recursive)
                boundary.assertCurrent();
            else
                boundary.assertAfterMutation();
            assertTraversalCurrent();
            assertNotAborted();
        }
        await visit(admitted.fd, path.basename(target), target, 0);
    }
}
