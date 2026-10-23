import fs from "node:fs";
import path from "node:path";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isNotFoundPathError } from "./path.js";
import { sameAbsolutePath } from "./path-segment-route.js";
import { resolveRootPathSync } from "./root-path.js";
import { isRootPathEscapeError } from "./root-path-errors.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync, } from "./root-context.js";
import { directoryComponentNotDirectoryError, outsideWorkspaceError, } from "./root-errors.js";
import { mutationSymlinkResolution, readSymlinkResolution, } from "./root-symlink-policy.js";
import { realpathSync } from "./realpath.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem, resolvePathPreservingWindowsRoot, } from "./windows-path-alias.js";
const retainedRootContexts = new WeakMap();
const retainedRootDefaults = new WeakMap();
/** @internal Registers only instances constructed by RootHandle itself. */
export function registerFileLockSyncRootAdapter(handle, context, defaults) {
    const identity = context.rootIdentity;
    if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint")
        return;
    // Retain the already-created Root inputs directly. Registration adds no
    // per-Root wrapper/context allocations for callers that never use sync locks.
    retainedRootContexts.set(handle, context);
    retainedRootDefaults.set(handle, defaults);
}
function snapshotPolicy(policy) {
    if (policy === undefined)
        return undefined;
    const paths = policy.paths;
    const prefixes = policy.prefixes;
    return Object.freeze({
        paths: paths === undefined ? undefined : Object.freeze([...paths]),
        prefixes: prefixes === undefined ? undefined : Object.freeze([...prefixes]),
    });
}
export function captureFileLockSyncRootAuthority(lockRoot) {
    const adapter = lockRoot;
    const retainedContext = retainedRootContexts.get(adapter);
    const retainedDefaults = retainedRootDefaults.get(adapter);
    if (!retainedContext || !retainedDefaults) {
        throw new FsSafeError("helper-unavailable", "synchronous Root-backed file locks require a genuine fs-safe Root handle");
    }
    const identity = retainedContext.rootIdentity;
    if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
        throw new FsSafeError("helper-unavailable", "synchronous Root identity is unavailable");
    }
    const context = Object.freeze({
        rootDir: retainedContext.rootDir,
        rootGuard: retainedContext.rootGuard,
        rootIdentity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
        rootReal: retainedContext.rootReal,
        rootWithSep: retainedContext.rootWithSep,
    });
    const defaults = retainedDefaults;
    const assertBeforeMutation = defaults.assertBeforeMutation;
    const denyMutations = snapshotPolicy(defaults.denyMutations);
    const hardlinks = defaults.hardlinks;
    const mutationSymlinks = defaults.mutationSymlinks;
    const symlinks = defaults.symlinks;
    // Snapshot all defaults before the Root check and mutation-policy validation.
    assertRootIdentityCurrentSync(context);
    const mutation = mutationSymlinkResolution(mutationSymlinks);
    const mutationPolicy = Object.freeze({
        rejectSymlinks: mutation.rejectSymlinks,
        rejectFinalSymlink: mutation.rejectFinalSymlink,
        rejectUnresolvedSymlinks: true,
    });
    const readPolicy = Object.freeze({
        ...readSymlinkResolution(symlinks),
        rejectUnresolvedSymlinks: true,
    });
    return Object.freeze({
        adapter,
        context,
        assertBeforeMutation,
        denyMutations,
        hardlinks,
        mutationPolicy,
        readPolicy,
        policiesMatch: mutationPolicy.rejectSymlinks === readPolicy.rejectSymlinks &&
            mutationPolicy.rejectFinalSymlink === readPolicy.rejectFinalSymlink,
    });
}
export function invokeFileLockSyncRootMutationAuthority(authority) {
    const assertion = authority.assertBeforeMutation;
    if (!assertion)
        return false;
    // Match Root mutation semantics: callbacks are invoked unbound and a
    // thenable result cannot authorize a synchronous filesystem mutation.
    assertSynchronousCallbackResult(assertion(), "assertBeforeMutation");
    return true;
}
function absoluteRootPath(authority, relativePath) {
    const segments = relativePath.split(path.posix.sep);
    const absolute = path.join(authority.context.rootReal, ...segments);
    assertNoWindowsPathAlias(absolute, "filesystem", "sidecar lock path uses a Windows filesystem namespace alias");
    return absolute;
}
export function assertFileLockSyncRootMutationAllowed(pathname, policy, protectAncestors = false) {
    assertMutationNotDenied(pathname, policy, { protectAncestors }, "sync-root-lock");
}
function resolveAdmittedPath(authority, absolutePath, policy, rootPath) {
    const context = authority.context;
    let resolved;
    try {
        resolved = resolveRootPathSync({
            absolutePath,
            // The shared resolver identity-gates ambiguous Windows matches against the
            // original Root spelling before rebasing them to the retained canonical root.
            rootPath,
            rootCanonicalPath: context.rootReal,
            rootIdentity: context.rootIdentity,
            boundaryLabel: "sidecar lock root",
            ...policy,
        });
    }
    catch (error) {
        if (isRootPathEscapeError(error)) {
            throw new FsSafeError("outside-workspace", "sidecar lock path is outside lockRoot", { cause: error });
        }
        throw error;
    }
    const admitted = admitPathInsideRoot({
        rootPath: context.rootReal,
        candidatePath: resolved.canonicalPath,
        rootIdentity: context.rootIdentity,
    });
    if (!admitted || admitted.relativePath === "" || sameAbsolutePath(admitted.path, context.rootReal)) {
        throw outsideWorkspaceError();
    }
    return {
        path: admitted.path,
        relativePath: admitted.relativePath.split(path.sep).join(path.posix.sep),
    };
}
function resolveBothPolicies(authority, absolutePath, rootPath) {
    const { mutationPolicy, readPolicy, policiesMatch } = authority;
    const mutation = resolveAdmittedPath(authority, absolutePath, mutationPolicy, rootPath);
    const readable = policiesMatch
        ? mutation
        : resolveAdmittedPath(authority, absolutePath, readPolicy, rootPath);
    if (!sameAbsolutePath(mutation.path, readable.path)) {
        throw new FsSafeError("path-mismatch", "sidecar read and mutation paths resolve differently");
    }
    assertFileLockSyncRootMutationAllowed(mutation.path, authority.denyMutations);
    return mutation;
}
function admitRequestedRootPrefix(authority, requestedPath) {
    const context = authority.context;
    const identityCache = process.platform === "win32" ? new Map() : undefined;
    const original = admitPathInsideRoot({
        rootPath: context.rootDir,
        candidatePath: requestedPath,
        rootIdentity: context.rootIdentity,
        resolveCandidateRoot: context.rootDir !== context.rootReal,
        identityCache,
    });
    if (original && original.relativePath !== "") {
        return { path: original.path, rootPath: context.rootDir };
    }
    const canonical = context.rootDir === context.rootReal ? undefined : admitPathInsideRoot({
        rootPath: context.rootReal,
        candidatePath: requestedPath,
        rootIdentity: context.rootIdentity,
        identityCache,
    });
    if (!canonical || canonical.relativePath === "")
        throw outsideWorkspaceError();
    return { path: canonical.path, rootPath: context.rootReal };
}
export function admitFileLockSyncRootPath(authority, requestedPath) {
    assertNoNulPathInput(requestedPath, "sidecar lock path contains a NUL byte");
    const resolved = resolvePathPreservingWindowsRoot(requestedPath);
    assertNoWindowsPathAlias(resolved, "filesystem", "sidecar lock path uses a Windows filesystem namespace alias");
    assertRootIdentityCurrentSync(authority.context);
    const prefixed = admitRequestedRootPrefix(authority, resolved);
    const selected = resolveBothPolicies(authority, prefixed.path, prefixed.rootPath);
    assertRootIdentityCurrentSync(authority.context);
    const admitted = Object.freeze({
        authority,
        path: selected.path,
        relativePath: selected.relativePath,
    });
    assertMissingParentMutationsAllowed(admitted);
    return admitted;
}
export function assertFileLockSyncRootResolvedPathCurrent(pathAuthority) {
    const resolved = resolveBothPolicies(pathAuthority.authority, absoluteRootPath(pathAuthority.authority, pathAuthority.relativePath), pathAuthority.authority.context.rootReal);
    if (!sameAbsolutePath(resolved.path, pathAuthority.path)) {
        throw new FsSafeError("path-mismatch", "sidecar lock path changed during operation");
    }
}
function assertMissingParentMutationsAllowed(pathAuthority) {
    const authority = pathAuthority.authority;
    const context = authority.context;
    const relativeParent = path.posix.dirname(pathAuthority.relativePath);
    const relative = relativeParent === "." ? "" : relativeParent;
    let current = context.rootReal;
    let missing = false;
    for (const segment of relative.split(path.posix.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (!missing) {
            try {
                const stat = fs.lstatSync(pathForWindowsFilesystem(current), { bigint: true });
                if (stat.isSymbolicLink() || !stat.isDirectory())
                    throw directoryComponentNotDirectoryError();
            }
            catch (error) {
                if (!isNotFoundPathError(error))
                    throw error;
                missing = true;
            }
        }
        if (missing)
            assertFileLockSyncRootMutationAllowed(current, authority.denyMutations);
    }
}
export function assertFileLockSyncRootPathsCurrent(paths) {
    const authority = paths[0]?.authority;
    for (const pathAuthority of paths) {
        if (authority && pathAuthority.authority !== authority) {
            throw new FsSafeError("path-mismatch", "sidecar paths use different Root authority");
        }
    }
    if (authority && invokeFileLockSyncRootMutationAuthority(authority)) {
        assertRootIdentityCurrentSync(authority.context);
        for (const pathAuthority of paths) {
            assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
            assertMissingParentMutationsAllowed(pathAuthority);
        }
        assertRootIdentityCurrentSync(authority.context);
    }
}
function resolveTargetPathViaExistingAncestorSync(targetPath) {
    const normalized = resolvePathPreservingWindowsRoot(targetPath);
    const canonicalize = process.platform === "win32" ? realpathSync.native : realpathSync;
    let cursor = normalized;
    let canonicalAncestor;
    while (true) {
        try {
            fs.lstatSync(pathForWindowsFilesystem(cursor));
            try {
                canonicalAncestor = canonicalize(pathForWindowsFilesystem(cursor));
                break;
            }
            catch (error) {
                if (!isNotFoundPathError(error))
                    throw error;
                // A dangling link is an existing lexical entry but not a canonical
                // ancestor. Continue at its parent instead of abandoning native
                // long/short-name normalization for the rest of the target path.
            }
        }
        catch (error) {
            if (!isNotFoundPathError(error))
                throw error;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            // Filesystem roots are expected to exist; preserve the underlying
            // not-found diagnosis if a synthetic namespace violates that premise.
            canonicalAncestor = canonicalize(pathForWindowsFilesystem(cursor));
            break;
        }
        cursor = parent;
    }
    assertNoWindowsPathAlias(canonicalAncestor, "filesystem", "file-lock target ancestor uses a Windows filesystem namespace alias");
    return resolvePathPreservingWindowsRoot(cursor === normalized
        ? canonicalAncestor
        : path.resolve(canonicalAncestor, `.${path.sep}${normalized.slice(cursor.length)}`));
}
export function normalizeFileLockSyncTargetWithRoot(authority, resolvedTargetPath) {
    assertNoNulPathInput(resolvedTargetPath, "file-lock target contains a NUL byte");
    assertNoWindowsPathAlias(resolvedTargetPath, "filesystem", "file-lock target uses a Windows filesystem namespace alias");
    assertRootIdentityCurrentSync(authority.context);
    // Preserve POSIX's pathname-key behavior while making Windows resolve the
    // complete existing prefix (including an existing 8.3-spelled filename).
    const normalized = process.platform === "win32"
        ? resolveTargetPathViaExistingAncestorSync(resolvedTargetPath)
        : path.join(resolveTargetPathViaExistingAncestorSync(path.dirname(resolvedTargetPath)), path.basename(resolvedTargetPath));
    assertNoWindowsPathAlias(normalized, "filesystem", "file-lock target uses a Windows filesystem namespace alias");
    assertRootIdentityCurrentSync(authority.context);
    return normalized;
}
