import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode, isPathRelativeEscape } from "./path.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot, } from "./windows-path-alias.js";
function outsideRootError(params, root) {
    return new Error(`${params.messagePrefix ?? "Path"} must stay under ${root}.`);
}
function pathSegments(value) {
    return value.split(process.platform === "win32" ? /[/\\]+/ : /\/+/)
        .filter((segment) => segment.length > 0 && segment !== ".");
}
function rawTargetSegments(root, targetPath) {
    // Resolve only the drive/root or cwd, never the caller's dotdot segments.
    const targetRoot = path.parse(targetPath).root;
    const base = resolvePathPreservingWindowsRoot(targetRoot || ".");
    const absoluteTarget = `${base}${path.sep}${targetPath.slice(targetRoot.length)}`;
    const rootSegments = pathSegments(root);
    const targetSegments = pathSegments(absoluteTarget);
    const fold = (segment) => process.platform === "win32" ? segment.toLowerCase() : segment;
    if (rootSegments.some((segment, index) => fold(segment) !== fold(targetSegments[index] ?? ""))) {
        return undefined;
    }
    return targetSegments.slice(rootSegments.length);
}
function resolvePathWalk(params) {
    const rawRootDir = params.rootDir;
    assertNoWindowsPathAlias(rawRootDir, "filesystem", "root dir uses a Windows filesystem namespace alias");
    const rawTargetPath = params.targetPath;
    assertNoWindowsPathAlias(rawTargetPath, "filesystem", "target path uses a Windows filesystem namespace alias");
    const root = resolvePathPreservingWindowsRoot(rawRootDir);
    const lexicalTarget = resolvePathPreservingWindowsRoot(rawTargetPath);
    const relative = path.relative(root, lexicalTarget);
    if (isPathRelativeEscape(relative)) {
        if (params.allowOutsideRoot) {
            return null;
        }
        throw outsideRootError(params, root);
    }
    const segments = rawTargetSegments(root, rawTargetPath);
    // A spelling outside the root must not fall back to a normalized walk that
    // could erase a symlink before the filesystem receives the original path.
    if (!segments)
        throw outsideRootError(params, root);
    return { root, segments };
}
function formatUnsafePath(params, current) {
    return `${params.messagePrefix ?? "Path"} must not traverse symlinked directory: ${current}`;
}
export async function assertNoSymlinkParents(params) {
    assertNoSymlinkParentsSync(params);
}
function isFilesystemRoot(root) {
    return root === path.parse(root).root;
}
export function assertNoSymlinkParentsSync(params) {
    const walk = resolvePathWalk(params);
    if (!walk) {
        return;
    }
    let current = walk.root;
    // `..` may only undo a real directory this walk already lstat'd.
    const walked = [];
    for (const [index, segment] of walk.segments.entries()) {
        if (segment === "..") {
            const top = walked[walked.length - 1];
            if (top?.kind === "dir") {
                walked.pop();
                current = walked[walked.length - 1]?.path ?? walk.root;
                continue;
            }
            if (top?.kind === "symlink") {
                throw new Error(formatUnsafePath(params, top.path));
            }
            if (!isFilesystemRoot(walk.root)) {
                throw outsideRootError(params, walk.root);
            }
            continue;
        }
        current = path.join(current, segment);
        try {
            const stat = fsSync.lstatSync(current);
            if (stat.isSymbolicLink()) {
                if (params.allowRootChildSymlink && path.dirname(current) === walk.root) {
                    walked.push({ path: current, kind: "symlink" });
                    continue;
                }
                throw new Error(formatUnsafePath(params, current));
            }
            if ((params.requireDirectories || index < walk.segments.length - 1) && !stat.isDirectory()) {
                throw new FsSafeError("not-file", `${params.messagePrefix ?? "Path"} must traverse directories: ${current}`);
            }
            if (stat.isDirectory()) {
                walked.push({ path: current, kind: "dir" });
            }
        }
        catch (err) {
            if (hasNodeErrorCode(err, "ENOENT") && params.allowMissing !== false) {
                // Win32 can cancel a nonexistent component before filesystem lookup.
                // Returning early would leave later, reachable symlinks unchecked.
                if (process.platform === "win32" && walk.segments.slice(index + 1).includes("..")) {
                    throw new FsSafeError("invalid-path", `${params.messagePrefix ?? "Path"} must not cancel a missing directory: ${current}`);
                }
                return;
            }
            throw err;
        }
    }
}
