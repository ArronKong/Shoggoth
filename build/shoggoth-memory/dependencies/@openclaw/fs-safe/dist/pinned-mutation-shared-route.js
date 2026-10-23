import path from "node:path";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./device-path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { isSafePathSegment } from "./safe-path-segment.js";
function windowsReservedDeviceSegment(segment) {
    const extension = segment.indexOf(".");
    const stem = segment.slice(0, extension < 0 ? segment.length : extension).toUpperCase();
    return WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
}
export function ordinaryWindowsSegments(relativePath) {
    if (relativePath === "" || relativePath.includes("/") || relativePath.includes("\0"))
        return false;
    const segments = relativePath.split("\\");
    return segments.every((segment) => isSafePathSegment(segment, { allowDotPrefix: true }) &&
        !segment.endsWith(".") && !segment.endsWith(" ") &&
        !windowsReservedDeviceSegment(segment));
}
function ordinaryPosixSegments(relativePath) {
    return relativePath !== "" && !relativePath.includes("\\") &&
        relativePath.split("/").every((segment) => isSafePathSegment(segment, { allowDotPrefix: true }));
}
function exactNonzeroRootIdentity(identity) {
    return typeof identity?.dev === "bigint" && typeof identity.ino === "bigint" &&
        identity.dev !== 0n && identity.ino !== 0n
        ? Object.freeze({ dev: identity.dev, ino: identity.ino })
        : undefined;
}
export function ordinarySharedAbsoluteInsideRoot(rootReal, candidatePath, rootIdentity) {
    if (!path.isAbsolute(candidatePath) || candidatePath.includes("\0") ||
        path.resolve(candidatePath) !== candidatePath ||
        (process.platform === "win32"
            ? candidatePath.startsWith("\\\\") || candidatePath.includes("/")
            : candidatePath.includes("\\")))
        return false;
    const admitted = admitPathInsideRoot({
        rootPath: rootReal,
        candidatePath,
        rootIdentity,
    });
    return admitted?.admission === "exact" && admitted.path === candidatePath &&
        (admitted.relativePath === "" || (process.platform === "win32"
            ? ordinaryWindowsSegments(admitted.relativePath)
            : ordinaryPosixSegments(admitted.relativePath)));
}
export function simpleSharedRoute(params) {
    if (process.versions.bun ||
        params.policy.mutationSymlinks !== "reject" || !params.originalPath ||
        params.originalPath.startsWith("~") || path.isAbsolute(params.originalPath) ||
        !(process.platform === "win32"
            ? ordinaryWindowsSegments(params.originalPath) &&
                !params.rootReal.startsWith("\\\\") && !params.rootReal.includes("/")
            : ordinaryPosixSegments(params.originalPath) && !params.rootReal.includes("\\")) ||
        path.resolve(params.rootReal) !== params.rootReal)
        return undefined;
    const rootIdentity = exactNonzeroRootIdentity(params.rootIdentity);
    if (!rootIdentity)
        return undefined;
    const route = path.resolve(params.rootReal, params.originalPath);
    if (route !== params.selectedTarget ||
        !ordinarySharedAbsoluteInsideRoot(params.rootReal, route, rootIdentity))
        return undefined;
    const policyEntries = [
        ...(params.policy.denyMutations?.paths ?? []),
        ...(params.policy.denyMutations?.prefixes ?? []),
    ];
    if (policyEntries.some((entry) => entry !== path.resolve(entry) ||
        !ordinarySharedAbsoluteInsideRoot(params.rootReal, entry, rootIdentity)))
        return undefined;
    return { route, rootIdentity };
}
