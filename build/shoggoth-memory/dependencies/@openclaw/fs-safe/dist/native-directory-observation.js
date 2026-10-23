import path from "node:path";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
export function getNativeDirectoryObservationBackend(enabled = true) {
    if (!enabled)
        return undefined;
    const binding = getNativeBinding();
    return binding && typeof binding.observeDirectory === "function"
        ? binding
        : undefined;
}
function validateNativeDirectoryObservation(observation) {
    if (!observation || typeof observation.dev !== "bigint" || observation.dev < 0n ||
        typeof observation.ino !== "bigint" || observation.ino < 0n ||
        typeof observation.realPath !== "string" ||
        observation.realPath.includes("\0") ||
        (!path.isAbsolute(observation.realPath) && !path.win32.isAbsolute(observation.realPath))) {
        throw new FsSafeError("path-mismatch", "native directory observation is invalid");
    }
    return observation;
}
/** Exact identity, type, and canonical path captured from one retained handle. */
export function inspectNativeDirectoryObservation(backend, pathname, expected, platform = process.platform) {
    return inspectFileIdentitySync(() => validateNativeDirectoryObservation(backend.observeDirectory(pathname)), expected, platform);
}
export function extendNativeDirectoryObservationGuard(observation, dir) {
    const guard = observation;
    guard.dir = dir;
    guard.identity = guard;
    guard.nativeDirectoryObservation = true;
    return guard;
}
export function isNativeDirectoryObservationGuard(guard) {
    return typeof guard === "object" && guard !== null &&
        guard.nativeDirectoryObservation === true;
}
