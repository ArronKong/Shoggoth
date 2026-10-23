import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "./realpath.js";
import { pathForWindowsFilesystem, resolvePathPreservingWindowsRoot, } from "./windows-path-alias.js";
function validateWalkBudget(name, value) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
}
function validateWalkOptions(options) {
    validateWalkBudget("maxDepth", options.maxDepth);
    validateWalkBudget("maxEntries", options.maxEntries);
    if (options.symlinks !== undefined &&
        !["skip", "follow", "include"].includes(options.symlinks)) {
        throw new TypeError(`invalid walk symlink policy: ${String(options.symlinks)}`);
    }
}
function isObjectResult(result) {
    return result !== null &&
        (typeof result === "object" || typeof result === "function");
}
function kindForDirent(dirent) {
    if (dirent.isDirectory())
        return "directory";
    if (dirent.isFile())
        return "file";
    if (dirent.isSymbolicLink())
        return "symlink";
    return "other";
}
function shouldStop(result, options) {
    return options.maxEntries !== undefined && result.scannedEntryCount >= Math.max(0, options.maxEntries);
}
function buildEntry(params) {
    const fullPath = params.fullPath;
    return {
        name: params.dirent.name,
        path: fullPath,
        relativePath: params.relativePath,
        depth: params.depth,
        kind: params.kind,
        dirent: params.dirent,
    };
}
function recordFailedDir(result, root, dir, depth, error) {
    const relativePath = path.relative(root, dir);
    result.failedDirs.push({
        path: dir,
        relativePath,
        depth: relativePath === "" ? 0 : depth - 1,
        error,
    });
}
function resolveKind(fullPath, dirent, symlinks) {
    const kind = kindForDirent(dirent);
    if (kind !== "symlink")
        return kind;
    if (symlinks === "skip")
        return null;
    if (symlinks === "include")
        return "symlink";
    try {
        const stat = fsSync.statSync(fullPath);
        if (stat.isDirectory())
            return "directory";
        if (stat.isFile())
            return "file";
    }
    catch {
        return null;
    }
    return "other";
}
export function walkDirectorySync(rootDir, options = {}) {
    validateWalkOptions(options);
    const root = resolvePathPreservingWindowsRoot(rootDir);
    const symlinks = options.symlinks ?? "skip";
    const result = {
        entries: [],
        scannedEntryCount: 0,
        truncated: false,
        failedDirs: [],
    };
    const visitedDirs = new Set();
    function visit(dir, relativeDir, depth) {
        if (options.maxDepth !== undefined && depth > options.maxDepth)
            return;
        let realDir;
        const operationPath = pathForWindowsFilesystem(dir);
        try {
            if (depth > 1 && symlinks !== "follow" && fsSync.lstatSync(operationPath).isSymbolicLink())
                return;
            realDir = realpathSync(operationPath);
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        if (visitedDirs.has(realDir))
            return;
        visitedDirs.add(realDir);
        let entries;
        let handle;
        try {
            if (options.maxEntries === undefined) {
                entries = fsSync.readdirSync(operationPath, { withFileTypes: true });
            }
            else {
                handle = fsSync.opendirSync(operationPath);
            }
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        const childPrefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
        let index = 0;
        try {
            while (true) {
                let dirent;
                try {
                    dirent = handle ? handle.readSync() : entries[index++];
                }
                catch (error) {
                    recordFailedDir(result, root, dir, depth, error);
                    return;
                }
                if (!dirent)
                    return;
                if (shouldStop(result, options)) {
                    result.truncated = true;
                    return;
                }
                result.scannedEntryCount += 1;
                const fullPath = childPrefix + dirent.name;
                const kind = resolveKind(fullPath, dirent, symlinks);
                if (!kind)
                    continue;
                const relativePath = relativeDir ? `${relativeDir}${path.sep}${dirent.name}` : dirent.name;
                const entry = buildEntry({ relativePath, fullPath, dirent, depth, kind });
                if (options.include?.(entry) ?? true) {
                    result.entries.push(entry);
                }
                if (kind === "directory" &&
                    (options.maxDepth === undefined || depth < options.maxDepth) &&
                    (options.descend?.(entry) ?? true)) {
                    visit(fullPath, relativePath, depth + 1);
                    if (result.truncated)
                        return;
                }
            }
        }
        finally {
            try {
                handle?.closeSync();
            }
            catch (error) {
                recordFailedDir(result, root, dir, depth, error);
            }
        }
    }
    visit(root, "", 1);
    return result;
}
export async function walkDirectory(rootDir, options = {}) {
    validateWalkOptions(options);
    const root = resolvePathPreservingWindowsRoot(rootDir);
    const symlinks = options.symlinks ?? "skip";
    const result = {
        entries: [],
        scannedEntryCount: 0,
        truncated: false,
        failedDirs: [],
    };
    const visitedDirs = new Set();
    async function visit(dir, relativeDir, depth) {
        if (options.maxDepth !== undefined && depth > options.maxDepth)
            return;
        let realDir;
        const operationPath = pathForWindowsFilesystem(dir);
        try {
            if (depth > 1 && symlinks !== "follow" && fsSync.lstatSync(operationPath).isSymbolicLink())
                return;
            realDir = realpathSync.native(operationPath);
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        if (visitedDirs.has(realDir))
            return;
        visitedDirs.add(realDir);
        let entries;
        let handle;
        try {
            if (options.maxEntries === undefined) {
                entries = await fs.readdir(operationPath, { withFileTypes: true });
            }
            else {
                handle = await fs.opendir(operationPath);
            }
        }
        catch (error) {
            recordFailedDir(result, root, dir, depth, error);
            return;
        }
        const childPrefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
        let index = 0;
        try {
            while (true) {
                let dirent;
                try {
                    dirent = handle ? await handle.read() : entries[index++];
                }
                catch (error) {
                    recordFailedDir(result, root, dir, depth, error);
                    return;
                }
                if (!dirent)
                    return;
                if (shouldStop(result, options)) {
                    result.truncated = true;
                    return;
                }
                result.scannedEntryCount += 1;
                const fullPath = childPrefix + dirent.name;
                const kind = resolveKind(fullPath, dirent, symlinks);
                if (!kind)
                    continue;
                const relativePath = relativeDir ? `${relativeDir}${path.sep}${dirent.name}` : dirent.name;
                const entry = buildEntry({ relativePath, fullPath, dirent, depth, kind });
                const include = options.include;
                const included = include == null ? true : Reflect.apply(include, options, [entry]);
                if ((isObjectResult(included) ? await included : included) ?? true) {
                    result.entries.push(entry);
                }
                if (kind === "directory" &&
                    (options.maxDepth === undefined || depth < options.maxDepth)) {
                    const descend = options.descend;
                    const descended = descend == null ? true : Reflect.apply(descend, options, [entry]);
                    if ((isObjectResult(descended) ? await descended : descended) ?? true) {
                        await visit(fullPath, relativePath, depth + 1);
                        if (result.truncated)
                            return;
                    }
                }
            }
        }
        finally {
            try {
                await handle?.close();
            }
            catch (error) {
                recordFailedDir(result, root, dir, depth, error);
            }
        }
    }
    await visit(root, "", 1);
    return result;
}
