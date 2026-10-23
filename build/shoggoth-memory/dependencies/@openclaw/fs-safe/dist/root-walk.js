import path from "node:path";
import { FsSafeError } from "./errors.js";
import { expandRelativePathWithHome } from "./root-context.js";
import { resolveRootPath, resolveRootPathWithObservation, ROOT_PATH_ALIAS_POLICIES, RootPathObservationError, } from "./root-path.js";
import { createSuppressedError } from "./suppressed-error.js";
function filterEntry(options, entry) {
    if (entry.kind === "symlink") {
        return options.symlinkPolicy === "include" ? options.entryFilter?.(entry) ?? "include" : "skip";
    }
    return options.entryFilter?.(entry) ?? "include";
}
function validateBudget(name, value) {
    if (value === undefined)
        return Number.POSITIVE_INFINITY;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}
function entryKind(entry) {
    if (entry.isSymbolicLink)
        return "symlink";
    if (entry.isDirectory)
        return "directory";
    if (entry.isFile)
        return "file";
    return "other";
}
function limitEntry(relativePath) {
    return { relativePath, kind: "truncated", size: 0 };
}
export async function* walkRoot(root, relativePath, options) {
    if (!["skip", "follow-within-root", "include"].includes(options.symlinkPolicy)) {
        throw new TypeError(`invalid root walk symlink policy: ${String(options.symlinkPolicy)}`);
    }
    if (options.order !== undefined && !["sorted", "filesystem"].includes(options.order)) {
        throw new TypeError(`invalid root walk order: ${String(options.order)}`);
    }
    if (options.limitBehavior !== undefined &&
        !["truncate", "throw"].includes(options.limitBehavior)) {
        throw new TypeError(`invalid root walk limit behavior: ${String(options.limitBehavior)}`);
    }
    if (options.onDirectoryError !== undefined &&
        !["throw", "skip-and-report"].includes(options.onDirectoryError)) {
        throw new TypeError(`invalid root walk directory error behavior: ${String(options.onDirectoryError)}`);
    }
    const maxDepth = validateBudget("maxDepth", options.maxDepth);
    const maxEntries = validateBudget("maxEntries", options.maxEntries);
    const visitedDirectories = new Set();
    let examined = 0;
    let truncated = false;
    const admitEntry = () => {
        if (examined >= maxEntries)
            return false;
        examined += 1;
        return true;
    };
    const onLimit = (atPath) => {
        if ((options.limitBehavior ?? "truncate") === "throw") {
            throw new FsSafeError("too-large", `root walk budget exceeded at ${atPath || "."}`);
        }
        truncated = true;
        return limitEntry(atPath);
    };
    const onDirectoryError = (directory, error) => {
        // Rethrow cancellation with any disposal failure already attached.
        if (options.signal?.aborted || (options.onDirectoryError ?? "throw") === "throw")
            throw error;
        return { relativePath: directory, kind: "directory-error", size: 0, error };
    };
    async function* visit(directory, depth, admittedChildPath) {
        options.signal?.throwIfAborted();
        let listing;
        let canonicalDirectory;
        try {
            const expandedDirectory = depth === 0 ? await expandRelativePathWithHome(directory) : directory;
            const noFollowChildSymlinks = depth > 0 && options.symlinkPolicy !== "follow-within-root";
            const includeChild = depth > 0 && options.symlinkPolicy === "include";
            const resolution = {
                absolutePath: admittedChildPath ?? path.resolve(root.rootReal, expandedDirectory),
                rootPath: root.rootReal,
                rootCanonicalPath: root.rootReal,
                boundaryLabel: "root walk",
                policy: noFollowChildSymlinks ? ROOT_PATH_ALIAS_POLICIES.unlinkTarget : undefined,
            };
            let receipt;
            let resolvedDirectory;
            if (includeChild) {
                const rootGuard = await root.observeRoot();
                const observed = await resolveRootPathWithObservation({
                    ...resolution,
                    rootIdentity: rootGuard.identity,
                }, { kind: "directory", rootGuard });
                resolvedDirectory = observed.resolved;
                receipt = observed.receipt;
            }
            else {
                resolvedDirectory = await resolveRootPath(resolution);
            }
            if (noFollowChildSymlinks && resolvedDirectory.kind === "symlink") {
                if (options.symlinkPolicy === "skip")
                    return;
                throw new FsSafeError("path-mismatch", `root walk directory became a symlink: ${directory}`);
            }
            if (!resolvedDirectory.exists || resolvedDirectory.kind !== "directory") {
                throw new FsSafeError("not-file", `root walk path is not a directory: ${directory || "."}`);
            }
            if (includeChild && (!receipt || receipt.directoryGuard.realPath !== resolvedDirectory.canonicalPath)) {
                throw new FsSafeError("path-mismatch", "root walk directory observation was not retained");
            }
            canonicalDirectory = resolvedDirectory.canonicalPath;
            if (visitedDirectories.has(resolvedDirectory.canonicalPath)) {
                return;
            }
            visitedDirectories.add(resolvedDirectory.canonicalPath);
            options.signal?.throwIfAborted();
            const listingDirectory = path
                .relative(root.rootReal, resolvedDirectory.canonicalPath)
                .split(path.sep)
                .join(path.posix.sep);
            if (depth === 0 && expandedDirectory !== directory)
                directory = listingDirectory;
            // Resolved filesystem names are literal, not caller home-directory shorthand.
            listing = await root.list(`./${listingDirectory}`, {
                order: options.order ?? "sorted",
                signal: options.signal,
                snapshot: maxEntries === Number.POSITIVE_INFINITY,
                admitEntry,
            }, receipt);
        }
        catch (error) {
            yield onDirectoryError(directory, error instanceof RootPathObservationError ? error.error : error);
            return;
        }
        // A thrown undefined still needs to be retained if closing also fails.
        let failed = false;
        let operationError;
        try {
            const relativeDirectory = directory.split(path.sep).join(path.posix.sep);
            while (true) {
                let next;
                try {
                    next = await listing.next();
                    options.signal?.throwIfAborted();
                }
                catch (error) {
                    yield onDirectoryError(directory, error);
                    return;
                }
                if (next === undefined)
                    return;
                const name = next.kind === "entry" ? next.entry.name : next.name;
                const child = directory
                    ? path.posix.join(relativeDirectory, name)
                    : name;
                if (next.kind === "limit") {
                    yield onLimit(child);
                    return;
                }
                const entry = next.entry;
                let kind = entryKind(entry);
                let size = entry.size;
                if (kind === "symlink" && options.symlinkPolicy === "skip")
                    continue;
                if (kind === "symlink" && options.symlinkPolicy === "follow-within-root") {
                    const resolved = await resolveRootPath({
                        absolutePath: path.resolve(root.rootReal, child),
                        rootPath: root.rootReal,
                        rootCanonicalPath: root.rootReal,
                        boundaryLabel: "root walk",
                    });
                    if (!resolved.exists) {
                        continue;
                    }
                    const target = await root.stat(`./${path.relative(root.rootReal, resolved.canonicalPath)}`);
                    kind = target.isDirectory ? "directory" : target.isFile ? "file" : "other";
                    size = target.size;
                }
                const walkEntry = { relativePath: child, kind, size };
                let filterResult = filterEntry(options, walkEntry);
                if (typeof filterResult !== "string") {
                    filterResult = (await filterResult) ?? "include";
                    options.signal?.throwIfAborted();
                    try {
                        await listing.assertCurrent();
                    }
                    catch (error) {
                        yield onDirectoryError(directory, error);
                        return;
                    }
                }
                options.signal?.throwIfAborted();
                if (!["include", "skip", "skip-subtree"].includes(filterResult)) {
                    throw new TypeError(`invalid root walk entryFilter result: ${String(filterResult)}`);
                }
                if (filterResult === "include") {
                    yield walkEntry;
                }
                if (kind !== "directory") {
                    continue;
                }
                if (filterResult === "skip-subtree") {
                    continue;
                }
                if (depth >= maxDepth) {
                    yield onLimit(child);
                    return;
                }
                yield* visit(child, depth + 1, options.symlinkPolicy === "include" ? path.join(canonicalDirectory, name) : undefined);
                if (truncated)
                    return;
            }
        }
        catch (error) {
            failed = true;
            operationError = error;
            throw error;
        }
        finally {
            try {
                await listing[Symbol.asyncDispose]();
            }
            catch (closeError) {
                if (failed) {
                    throw createSuppressedError(closeError, operationError, "directory walk and close both failed");
                }
                throw closeError;
            }
        }
    }
    yield* visit(relativePath, 0);
}
