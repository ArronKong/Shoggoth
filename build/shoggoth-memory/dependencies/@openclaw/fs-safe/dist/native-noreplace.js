import fs from "node:fs";
import { FsSafeError } from "./errors.js";
export const NATIVE_NOREPLACE_UNSUPPORTED = "FS_SAFE_INTERNAL_RENAME_NOREPLACE_UNSUPPORTED";
const unsupported = new WeakMap();
const capabilityErrors = new WeakMap();
const MAX_DEVICES = 128;
function unavailable(operation, detail, cause) {
    const error = new FsSafeError("helper-unavailable", `native no-replace ${operation} is unsupported on this filesystem (${detail})`, { cause, details: { capability: "rename-noreplace" } });
    capabilityErrors.set(error, detail);
    return error;
}
export function isNoReplaceUnavailable(error) {
    return error instanceof FsSafeError && capabilityErrors.has(error);
}
export function noReplaceUnavailable(error, operation, syscallOnly = false) {
    try {
        const code = error?.code;
        if (code !== NATIVE_NOREPLACE_UNSUPPORTED &&
            !(syscallOnly && ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")))
            return;
        const capability = process.platform === "darwin" ? "renameatx_np RENAME_EXCL"
            : process.platform === "win32" ? "native no-replace rename" : "renameat2 RENAME_NOREPLACE";
        const detail = code === NATIVE_NOREPLACE_UNSUPPORTED
            ? error.message : `${capability}: ${code}`;
        return unavailable(operation, detail, error);
    }
    catch {
        // Diagnostic getters do not establish non-publication.
        return;
    }
}
export function rememberNoReplaceUnavailable(binding, parentFd, error) {
    const detail = capabilityErrors.get(error);
    if (!detail)
        return;
    const device = fs.fstatSync(parentFd, { bigint: true }).dev;
    let devices = unsupported.get(binding);
    if (!devices)
        unsupported.set(binding, devices = new Map());
    if (!devices.has(device) && devices.size >= MAX_DEVICES)
        devices.delete(devices.keys().next().value);
    devices.set(device, detail);
}
export function cachedNoReplaceUnavailable(binding, parentFd, operation = "publication") {
    if (!unsupported.has(binding))
        return;
    return cachedNoReplaceDevice(binding, fs.fstatSync(parentFd, { bigint: true }).dev, operation);
}
export function cachedNoReplaceDevice(binding, device, operation) {
    const devices = unsupported.get(binding);
    if (!devices)
        return;
    const detail = devices.get(device);
    return detail ? unavailable(operation, detail) : undefined;
}
